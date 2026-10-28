import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { scanInventory, userClaudeRoot } from './scanner.js'
import { ProjectRegistry, storePathFor } from './projects.js'
import { toggleAsset } from './settings.js'
import { removeAsset } from './remove.js'
import { runPluginOp } from './plugin-cli.js'
import { collectCatalog, type CatalogTarget } from './catalog.js'
import { readUsage } from './usage.js'
import { collectUsageStats } from './usage-stats.js'
import { createTray, destroyTray } from './tray.js'
import { destroyPopover, hidePopover, preparePopover, resizePopoverTo } from './popover.js'
import type {
  CatalogResult,
  Inventory,
  PluginOpResult,
  ProjectListResult,
  ProjectRef,
  RemoveMechanism,
  RemoveRequest,
  RemoveResult,
  ToggleMechanism,
  ToggleRequest,
  ToggleResult,
  UsageReadResult,
  UsageStats
} from '../shared/types.js'
import { readFile } from 'node:fs/promises'

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

/**
 * 창은 하나뿐이고, 닫혀도 파괴하지 않고 숨긴다.
 *
 * 다시 열 때 새로 만들지 않는 이유는 비용이다 — 렌더러를 다시 띄우면
 * 프로젝트 목록과 사용량을 처음부터 다시 읽어야 한다. 숨겨둔 창을
 * 보여주면 마지막으로 보던 화면이 그대로 돌아온다.
 */
let mainWindow: BrowserWindow | null = null

/**
 * 진짜 종료 중인지.
 *
 * 창의 close 이벤트만으로는 "사용자가 닫기 버튼을 눌렀다" 와
 * "앱이 종료되는 중이라 창도 닫힌다" 를 구분할 수 없다. 전자는 숨기고
 * 후자는 통과시켜야 하므로, before-quit 에서 이 깃발을 올린다.
 */
let quitting = false

/**
 * 창을 만든다.
 *
 * @param reveal 준비되면 화면에 띄울지. 앱 시작 때는 false — 트레이에만
 *   올라가 있어야 하고, 창은 "설정" 을 누를 때까지 숨은 채로 미리 준비된다.
 *   미리 만들어 두는 이유는 체감 속도다: 렌더러 로드와 첫 스캔을 시작
 *   시점에 끝내 두면 "설정" 을 눌렀을 때 바로 내용이 있는 창이 뜬다.
 */
function createWindow(reveal: boolean): BrowserWindow {
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
  // reveal 이 false 면 준비만 하고 띄우지 않는다 — showWindow() 가 띄운다.
  if (reveal) window.once('ready-to-show', () => window.show())

  /*
    닫기는 종료가 아니라 숨기기다. 트레이에 남아 있다가 "설정" 으로 돌아온다.
    preventDefault 를 하지 않으면 창이 파괴되고, 그러면 숨겨둔 상태를
    되살릴 수 없다.
  */
  window.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    window.hide()
  })

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

  mainWindow = window
  return window
}

/**
 * 창을 앞으로 가져온다. 트레이의 "설정" 과 Dock 클릭이 모두 이 길을 쓴다.
 *
 * 숨겨진 창이 있으면 되살리고, 파괴됐으면(드문 경우) 다시 만든다.
 *
 * 아직 렌더가 끝나지 않은 창일 수 있다 — 시작 직후 "설정" 을 누른 경우다.
 * 그때 바로 show() 하면 흰 화면이 번쩍이므로 ready-to-show 를 기다린다.
 */
function showWindow(): void {
  const window =
    mainWindow && !mainWindow.isDestroyed() ? mainWindow : createWindow(false)

  const reveal = (): void => {
    if (window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
    // Dock 을 숨긴 상태에서는 창을 show 해도 앱이 활성화되지 않는다.
    // 이 호출 없이는 창이 다른 앱 뒤에 뜬다.
    app.focus({ steal: true })
  }

  // webContents.isLoading() 으로 판단하지 않는 이유: 로드가 끝나도
  // 첫 프레임 전일 수 있다. ready-to-show 가 그 시점을 정확히 알려준다.
  if (window.webContents.isLoadingMainFrame()) {
    window.once('ready-to-show', reveal)
  } else {
    reveal()
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
const TOGGLE_MECHANISMS: ToggleMechanism[] = [
  'skillOverrides',
  'enabledPlugins',
  'marketplaceAutoUpdate'
]

/**
 * 마켓플레이스의 source 블록을 레지스트리에서 읽는다.
 *
 * 자동 갱신을 켜려면 settings.json 에 완전한 항목이 있어야 하고, 항목이
 * 아직 없으면 source 를 채워 새로 만들어야 한다. 그 값을 renderer 에서
 * 받지 않고 여기서 다시 읽는 이유는 신뢰다 — renderer 가 보낸 source 를
 * 그대로 쓰면 임의의 저장소를 사용자 설정에 심을 수 있다.
 */
async function marketplaceSourceOf(
  name: string
): Promise<Record<string, unknown> | undefined> {
  try {
    const path = join(userClaudeRoot(), 'plugins', 'known_marketplaces.json')
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    const entry = parsed[name]
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined
    const source = (entry as { source?: unknown }).source
    return source && typeof source === 'object' && !Array.isArray(source)
      ? (source as Record<string, unknown>)
      : undefined
  } catch {
    // 레지스트리를 읽지 못하면 source 없이 진행한다 — 항목이 이미 있으면
    // 성공하고, 없으면 settings.ts 가 사유를 붙여 거부한다.
    return undefined
  }
}

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

/**
 * 카탈로그 캐시. 마켓플레이스가 바뀌는 작업 뒤에 비운다.
 *
 * null 은 "아직 안 읽었거나 무효해졌다" 는 뜻이다. 빈 결과와 구분되어야
 * 하므로 빈 객체를 쓰지 않는다 — 카탈로그가 실제로 비어 있을 수 있다.
 */
let catalogCache: CatalogResult | null = null

/** 자산 사용량 집계 캐시. 세션 기록 스캔이 느려 한 번만 돈다. */
let usageStatsCache: UsageStats | null = null

/**
 * 레지스트리에서 카탈로그 대상을 모아 읽는다.
 *
 * 설치 위치가 있는 마켓플레이스만 대상이다 — 위치가 없으면 디스크에
 * 체크아웃되지 않았고, 읽을 카탈로그 파일도 없다.
 */
async function readCatalog(): Promise<CatalogResult> {
  const root = userClaudeRoot()
  const registryPath = join(root, 'plugins', 'known_marketplaces.json')
  const installedPath = join(root, 'plugins', 'installed_plugins.json')

  const targets: CatalogTarget[] = []
  try {
    const parsed = JSON.parse(await readFile(registryPath, 'utf8')) as Record<
      string,
      unknown
    >
    for (const [name, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      const location = (value as { installLocation?: unknown }).installLocation
      if (typeof location === 'string' && location !== '') {
        targets.push({ name, installLocation: location })
      }
    }
  } catch (err) {
    return {
      plugins: [],
      issues: [
        {
          path: registryPath,
          message: err instanceof Error ? err.message : String(err)
        }
      ]
    }
  }

  // 이미 설치된 것을 표시하려면 설치 목록이 필요하다. 없으면 빈 목록으로 간다.
  let installedIds: string[] = []
  try {
    const parsed = JSON.parse(await readFile(installedPath, 'utf8')) as {
      plugins?: Record<string, unknown>
    }
    if (parsed.plugins && typeof parsed.plugins === 'object') {
      installedIds = Object.keys(parsed.plugins)
    }
  } catch {
    // 설치 목록을 못 읽으면 전부 미설치로 보인다. 카탈로그 자체는 유효하다.
  }

  return collectCatalog(targets, installedIds)
}

/**
 * 문자열 인자 검사 결과.
 *
 * 값과 오류를 같은 string 으로 돌려주면 둘을 구분할 수 없다 —
 * `typeof x === 'string'` 이 항상 참이 되어 정상 입력이 오류로 처리된다.
 * ok 플래그로 판별한다.
 */
type ParsedArg = { ok: true; value: string } | { ok: false; error: string }

/**
 * CLI 인자로 들어갈 문자열을 검사한다.
 *
 * execFile 을 쓰므로 셸을 거치지 않아 인용 문제는 없다. 그래도 세 가지를
 * 막는다:
 *
 *  - 빈 값과 과도한 길이: 실수로 보낸 요청을 CLI 까지 보내지 않는다.
 *  - 하이픈 시작: CLI 가 플래그로 읽는다. `--help` 를 출처로 넣으면
 *    추가가 아니라 도움말이 실행된다.
 *  - 개행과 NUL: 인자 하나가 여러 줄이 되는 입력 사고를 걸러낸다.
 *
 * @param label 오류 문구에 쓸 대상 이름
 * @param limit 허용 최대 길이
 */
function parseCliArg(raw: unknown, label: string, limit: number): ParsedArg {
  if (typeof raw !== 'string') return { ok: false, error: `${label} 형식이 올바르지 않습니다.` }
  const value = raw.trim()
  if (value === '') return { ok: false, error: `${label}을(를) 입력하세요.` }
  if (value.length > limit) return { ok: false, error: `${label}이(가) 너무 깁니다.` }
  if (value.startsWith('-')) {
    return { ok: false, error: `${label}은(는) 하이픈으로 시작할 수 없습니다.` }
  }
  if (/[\r\n\0]/.test(value)) {
    return { ok: false, error: `${label}에 줄바꿈을 넣을 수 없습니다.` }
  }
  return { ok: true, value }
}

/** 마켓플레이스 출처. owner/repo, git/https URL, 또는 경로. */
function parseMarketplaceSource(raw: unknown): ParsedArg {
  return parseCliArg(raw, '출처', 500)
}

/** 마켓플레이스 이름. 레지스트리 키로 쓰이는 값이다. */
function parseMarketplaceName(raw: unknown): ParsedArg {
  return parseCliArg(raw, '마켓플레이스 이름', 200)
}

/** 플러그인 ID. `<이름>` 또는 `<이름>@<마켓플레이스>`. */
function parsePluginId(raw: unknown): ParsedArg {
  return parseCliArg(raw, '플러그인 ID', 300)
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
      /*
        마켓플레이스 자동 갱신만 추가 정보가 필요하다. settings.json 에
        항목이 없을 때 source 를 채워 넣어야 유효한 선언이 된다.
      */
      if (parsed.mechanism === 'marketplaceAutoUpdate') {
        const source = await marketplaceSourceOf(parsed.key)
        return toggleAsset(parsed, source ? { marketplaceSource: source } : {})
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

  /*
    설치 가능한 플러그인 카탈로그.

    캐시하는 이유: 실측 2,619개를 11개 파일에서 읽고 정렬하는 작업이고,
    마켓플레이스를 갱신하지 않는 한 결과가 바뀌지 않는다. 모달을 여닫을
    때마다 다시 읽을 이유가 없다.
  */
  ipcMain.handle(
    'admin:listCatalog',
    async (_event, refresh: unknown): Promise<CatalogResult> => {
      if (refresh === true) catalogCache = null
      if (catalogCache) return catalogCache
      const result = await readCatalog()
      catalogCache = result
      return result
    }
  )

  ipcMain.handle(
    'admin:addMarketplace',
    async (_event, source: unknown): Promise<PluginOpResult> => {
      const parsed = parseMarketplaceSource(source)
      if (!parsed.ok) return { ok: false, op: 'marketplaceAdd', error: parsed.error }
      const result = await runPluginOp({ op: 'marketplaceAdd', source: parsed.value })
      // 새 마켓플레이스가 붙었으면 카탈로그가 달라졌다.
      if (result.ok) catalogCache = null
      return result
    }
  )

  ipcMain.handle(
    'admin:updateMarketplace',
    async (_event, name: unknown): Promise<PluginOpResult> => {
      // null 이면 전체 갱신. 그 외에는 이름 모양을 검사한다.
      if (name === null || name === undefined) {
        const result = await runPluginOp({ op: 'marketplaceUpdateAll' })
        if (result.ok) catalogCache = null
        return result
      }
      const parsed = parseMarketplaceName(name)
      if (!parsed.ok) return { ok: false, op: 'marketplaceUpdate', error: parsed.error }
      const result = await runPluginOp({ op: 'marketplaceUpdate', name: parsed.value })
      // 갱신으로 카탈로그 내용이 바뀐다(새 플러그인이 추가될 수 있다).
      if (result.ok) catalogCache = null
      return result
    }
  )

  ipcMain.handle(
    'admin:installPlugin',
    async (_event, plugin: unknown): Promise<PluginOpResult> => {
      const parsed = parsePluginId(plugin)
      if (!parsed.ok) return { ok: false, op: 'pluginInstall', error: parsed.error }
      const result = await runPluginOp({ op: 'pluginInstall', plugin: parsed.value })
      // 설치 상태가 바뀌면 카탈로그의 installed 표시도 바뀐다.
      if (result.ok) catalogCache = null
      return result
    }
  )

  ipcMain.handle(
    'admin:updatePlugin',
    async (_event, plugin: unknown): Promise<PluginOpResult> => {
      const parsed = parsePluginId(plugin)
      if (!parsed.ok) return { ok: false, op: 'pluginUpdate', error: parsed.error }
      return runPluginOp({ op: 'pluginUpdate', plugin: parsed.value })
    }
  )

  /*
    사용량은 읽기만 한다. force 는 "다시 시도" 버튼에서만 true 로 오며,
    캐시만 건너뛴다 — 429 백오프까지 건너뛰면 막힌 상태에서 사용자가
    버튼을 연타할 때 그 사이에 풀릴 것도 안 풀린다.
  */
  /*
    자산 사용량. 세션 기록 600개를 훑어 실측 5초가 걸리므로 캐시한다 —
    탭을 옮길 때마다 다시 돌 이유가 없다.
  */
  ipcMain.handle(
    'admin:readUsageStats',
    async (_event, refresh: unknown): Promise<UsageStats> => {
      if (refresh === true) usageStatsCache = null
      if (usageStatsCache) return usageStatsCache
      const stats = await collectUsageStats()
      usageStatsCache = stats
      return stats
    }
  )

  ipcMain.handle(
    'admin:readUsage',
    async (_event, force: unknown): Promise<UsageReadResult> => readUsage(force === true)
  )

  /*
    메뉴바 팝오버의 두 버튼. 팝오버를 먼저 치우는 이유는 순서다 —
    설정 창이 올라오면 팝오버가 포커스를 잃어 어차피 닫히지만, 그
    찰나에 두 판이 겹쳐 보인다.
  */
  ipcMain.handle('admin:openSettings', (): void => {
    hidePopover()
    showWindow()
  })

  ipcMain.handle('admin:quitApp', (): void => {
    hidePopover()
    app.quit()
  })

  // 팝오버가 자기 내용 높이를 알려온다. 응답이 없으므로 on 으로 받는다.
  ipcMain.on('popover:resize', (_event, height: unknown): void => {
    if (typeof height === 'number') resizePopoverTo(height)
  })

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

  /*
    메뉴바 상주로 전환한다.

    순서가 중요하다: 트레이를 먼저 띄우고, 성공했을 때만 Dock 을 숨긴다.
    반대로 하면 트레이 생성이 실패한 순간 앱을 되살릴 창구가 하나도
    남지 않는다 — Dock 도 없고 트레이도 없는 유령 프로세스가 된다.
  */
  const trayed = createTray()
  if (trayed) {
    app.dock?.hide()
    // 첫 클릭이 빠르도록 팝오버를 미리 띄워 둔다(보이지는 않는다).
    preparePopover()
  }

  /*
    창은 미리 만들지만 띄우지는 않는다. 시작 시 보이는 것은 메뉴바
    아이콘뿐이고, 창은 "설정" 을 눌렀을 때 나온다.

    트레이를 못 띄웠다면 이야기가 다르다 — 그때는 창이 유일한 접근
    경로이므로 바로 보여주어야 한다. 그러지 않으면 보이는 것도 없고
    누를 것도 없는 앱이 된다.
  */
  createWindow(!trayed)

  // Dock 을 숨기면 거의 오지 않지만, 숨김이 실패했거나 사용자가 Dock 에
  // 남긴 경우를 위해 남겨둔다. 창을 새로 만들지 않고 숨겨둔 것을 되살린다.
  app.on('activate', () => showWindow())
})

/*
  창을 모두 닫아도 종료하지 않는다 — 트레이에 남는 것이 이 앱의 기본 상태다.
  종료는 트레이의 "종료" 항목과 창이 떠 있을 때의 Cmd+Q 로만 일어난다.
*/
app.on('window-all-closed', () => {
  // 의도적으로 비워 둔다. app.quit() 을 부르면 닫기가 곧 종료가 된다.
})

// 종료가 시작됐음을 창의 close 핸들러에 알린다 — 이 깃발이 없으면
// close 가 계속 숨기기로 가로채 앱이 영원히 종료되지 않는다.
app.on('before-quit', () => {
  quitting = true
})

app.on('will-quit', () => {
  destroyTray()
  destroyPopover()
})
