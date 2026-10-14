import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { scanInventory, userClaudeRoot } from './scanner.js'
import { ProjectRegistry, storePathFor } from './projects.js'
import { toggleAsset } from './settings.js'
import { removeAsset } from './remove.js'
import type {
  Inventory,
  ProjectListResult,
  ProjectRef,
  RemoveMechanism,
  RemoveRequest,
  RemoveResult,
  ToggleMechanism,
  ToggleRequest,
  ToggleResult
} from '../shared/types.js'

/**
 * Electron main 프로세스.
 *
 * 보안 자세: renderer 에는 Node 를 주지 않는다(nodeIntegration: false,
 * contextIsolation: true). 파일 접근은 전부 아래 IPC 핸들러를 거치며,
 * 핸들러가 받는 인자는 신뢰하지 않고 검사한다.
 */

/**
 * 프로젝트 레지스트리. 앱 전용 저장 파일을 쓴다.
 *
 * app.getPath('userData') 는 whenReady 이후에만 안정적이므로 지연 생성한다.
 */
let registry: ProjectRegistry | null = null

function projects(): ProjectRegistry {
  if (!registry) {
    registry = new ProjectRegistry(storePathFor(app.getPath('userData')))
  }
  return registry
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    title: 'Claude Administer',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0b0d12',
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // 흰 화면 깜빡임을 막기 위해 렌더가 준비된 뒤 보여준다.
  window.once('ready-to-show', () => window.show())

  // 외부 링크는 앱 안에서 열지 않고 기본 브라우저로 넘긴다.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void window.loadURL(devUrl)
  } else {
    void window.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
}

/**
 * 경로 인자가 우리가 다루는 범위 안인지 확인한다.
 *
 * renderer 가 임의 경로를 열도록 두면 IPC 가 파일 열기 우회로가 된다.
 * 허용 범위는 두 가지뿐이다:
 *  - 사용자 홈의 .claude
 *  - 레지스트리가 알고 있는 프로젝트 (발견된 것 + 직접 추가한 것)
 *
 * 프로젝트 목록이 런타임에 늘어나므로 허용 목록도 매번 다시 읽는다.
 * 문자열 접두사 비교 전에 반드시 resolve() 로 정규화한다 — 하지 않으면
 * `~/.claude/../.ssh/id_rsa` 같은 경로가 검사를 통과한다.
 */
async function isAllowedPath(target: unknown): Promise<boolean> {
  if (typeof target !== 'string' || target === '') return false
  if (!isAbsolute(target)) return false

  const normalized = resolve(target)
  const roots = [resolve(userClaudeRoot()), ...(await projects().allowedRoots())]

  // 경로 구분자까지 비교해 `/foo/.claude-evil` 이 `/foo/.claude` 로 통과하지 않게 한다.
  return roots.some(
    (root) => normalized === root || normalized.startsWith(`${root}${sep}`)
  )
}

/** 토글 요청이 올바른 모양인지 검사한다. renderer 가 보낸 값은 신뢰하지 않는다. */
const TOGGLE_MECHANISMS: ToggleMechanism[] = ['skillOverrides', 'enabledPlugins']

function parseToggleRequest(raw: unknown): ToggleRequest | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return '토글 요청 형식이 올바르지 않습니다.'
  }
  const value = raw as Record<string, unknown>
  const mechanism = value['mechanism']
  if (typeof mechanism !== 'string' || !TOGGLE_MECHANISMS.includes(mechanism as ToggleMechanism)) {
    return '지원하지 않는 토글 방식입니다.'
  }
  const key = value['key']
  if (typeof key !== 'string' || key === '') {
    return '토글 대상 이름이 올바르지 않습니다.'
  }
  const enabled = value['enabled']
  if (typeof enabled !== 'boolean') {
    return '활성 상태 값이 올바르지 않습니다.'
  }
  return { mechanism: mechanism as ToggleMechanism, key, enabled }
}

const REMOVE_MECHANISMS: RemoveMechanism[] = ['trash', 'pluginUninstall']

function parseRemoveRequest(raw: unknown): RemoveRequest | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return '제거 요청 형식이 올바르지 않습니다.'
  }
  const value = raw as Record<string, unknown>
  const mechanism = value['mechanism']
  if (
    typeof mechanism !== 'string' ||
    !REMOVE_MECHANISMS.includes(mechanism as RemoveMechanism)
  ) {
    return '지원하지 않는 제거 방식입니다.'
  }
  const target = value['target']
  if (typeof target !== 'string' || target === '') {
    return '제거 대상이 올바르지 않습니다.'
  }
  const label = value['label']
  return {
    mechanism: mechanism as RemoveMechanism,
    target,
    label: typeof label === 'string' && label !== '' ? label : target
  }
}

function registerHandlers(): void {
  ipcMain.handle(
    'admin:scan',
    async (_event, projectPath: unknown): Promise<Inventory> => {
      // 알고 있는 프로젝트만 스캔한다. 모르는 경로는 조용히 전역 스캔으로 떨어진다.
      const path = typeof projectPath === 'string' && projectPath !== '' ? projectPath : null
      const project = await projects().resolveForScan(path)
      if (project) await projects().rememberSelection(project.path)
      else if (path === null) await projects().rememberSelection(null)
      return scanInventory(project)
    }
  )

  ipcMain.handle(
    'admin:listProjects',
    async (_event, refresh: unknown): Promise<ProjectListResult> => {
      // 발견 결과는 캐시된다 — 세션 파일 탐색이 디스크를 꽤 때리는데 목록이
      // 탭 전환마다 바뀔 이유는 없다. 다만 '다시 읽기' 는 화면 전체를 최신으로
      // 만드는 동작이므로 그때는 캐시를 버리고 다시 훑는다.
      if (refresh === true) projects().invalidate()
      const { projects: list, lastSelected, issues } = await projects().list()
      const hidden = await projects().hiddenProjects()
      return { projects: list, hidden, lastSelected, issues }
    }
  )

  ipcMain.handle(
    'admin:addProject',
    async (): Promise<{ added: ProjectRef | null; error?: string }> => {
      const result = await dialog.showOpenDialog({
        title: '프로젝트 폴더 선택',
        properties: ['openDirectory', 'createDirectory'],
        message: 'Claude 자산(.claude/ 또는 .mcp.json)이 있는 프로젝트 폴더를 고르세요.'
      })
      const picked = result.filePaths[0]
      if (result.canceled || !picked) return { added: null }
      try {
        const added = await projects().add(picked)
        return { added }
      } catch (err) {
        return {
          added: null,
          error: err instanceof Error ? err.message : String(err)
        }
      }
    }
  )

  ipcMain.handle(
    'admin:removeProject',
    async (_event, target: unknown): Promise<{ ok: boolean; error?: string }> => {
      if (typeof target !== 'string' || target === '') {
        return { ok: false, error: '경로가 올바르지 않습니다.' }
      }
      try {
        await projects().remove(target)
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle(
    'admin:restoreProject',
    async (_event, target: unknown): Promise<{ ok: boolean; error?: string }> => {
      if (typeof target !== 'string' || target === '') {
        return { ok: false, error: '경로가 올바르지 않습니다.' }
      }
      try {
        await projects().unhide(target)
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle(
    'admin:toggleAsset',
    async (_event, raw: unknown): Promise<ToggleResult> => {
      const parsed = parseToggleRequest(raw)
      if (typeof parsed === 'string') {
        return {
          ok: false,
          // 형식이 깨진 요청이라 mechanism 을 신뢰할 수 없다. 플러그인으로 보고한다.
          mechanism: 'enabledPlugins',
          key: '',
          enabled: false,
          error: parsed
        }
      }
      return toggleAsset(parsed)
    }
  )

  ipcMain.handle(
    'admin:removeAsset',
    async (event, raw: unknown): Promise<RemoveResult> => {
      const parsed = parseRemoveRequest(raw)
      if (typeof parsed === 'string') {
        return { ok: false, mechanism: 'trash', target: '', error: parsed }
      }

      // 휴지통 대상은 경로 가드를 통과해야 한다. 임의 경로를 지우게 두면
      // IPC 가 파일 삭제 우회로가 된다.
      if (parsed.mechanism === 'trash' && !(await isAllowedPath(parsed.target))) {
        return {
          ok: false,
          mechanism: 'trash',
          target: parsed.target,
          error: '허용되지 않은 경로입니다.'
        }
      }

      // 되돌릴 수 있는지에 따라 안내 문구가 다르다 — 플러그인은 휴지통을
      // 거치지 않으므로 그 사실을 분명히 적는다.
      const restorable = parsed.mechanism === 'trash'
      const detail = restorable
        ? '휴지통으로 이동합니다. Finder 에서 "되돌리기" 로 복구할 수 있습니다.'
        : 'claude plugin uninstall 로 제거합니다. 휴지통을 거치지 않지만 다시 설치할 수 있습니다.'

      const window = BrowserWindow.fromWebContents(event.sender)
      const options = {
        type: 'warning' as const,
        buttons: ['제거', '취소'],
        defaultId: 1,
        cancelId: 1,
        title: '제거 확인',
        message: `${parsed.label} 을(를) 제거할까요?`,
        detail: `대상: ${parsed.target}\n\n${detail}`
      }
      const { response } = window
        ? await dialog.showMessageBox(window, options)
        : await dialog.showMessageBox(options)

      if (response !== 0) {
        return {
          ok: false,
          canceled: true,
          mechanism: parsed.mechanism,
          target: parsed.target
        }
      }

      const result = await removeAsset(parsed)
      // 플러그인을 지웠으면 프로젝트 캐시는 그대로지만 자산 목록이 바뀐다.
      return result
    }
  )

  ipcMain.handle(
    'admin:revealPath',
    async (_event, target: unknown): Promise<{ ok: boolean; error?: string }> => {
      if (!(await isAllowedPath(target))) {
        return { ok: false, error: '허용되지 않은 경로입니다.' }
      }
      shell.showItemInFolder(target as string)
      return { ok: true }
    }
  )
}

void app.whenReady().then(() => {
  registerHandlers()
  createWindow()

  // macOS 관례: Dock 아이콘 클릭 시 창이 없으면 다시 만든다.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// macOS 에서는 창을 닫아도 앱이 살아있는 것이 관례지만,
// 이 도구는 창이 전부라 같이 종료한다.
app.on('window-all-closed', () => app.quit())
