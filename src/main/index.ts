import { BrowserWindow, app, ipcMain, shell } from 'electron'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { scanInventory } from './scanner.js'
import { togglePlugin } from './settings.js'
import type { Inventory, ToggleResult } from '../shared/types.js'

/**
 * Electron main 프로세스.
 *
 * 보안 자세: renderer 에는 Node 를 주지 않는다(nodeIntegration: false,
 * contextIsolation: true). 파일 접근은 전부 아래 IPC 핸들러를 거치며,
 * 핸들러가 받는 인자는 신뢰하지 않고 검사한다.
 */

/** 스캔 대상 프로젝트. 앱을 띄운 디렉토리를 프로젝트로 본다. */
function projectDir(): string {
  return process.cwd()
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
 * 사용자 홈의 .claude 와 프로젝트 디렉토리 아래만 허용한다.
 */
function isAllowedPath(target: unknown): target is string {
  if (typeof target !== 'string' || target === '') return false

  // 반드시 정규화 먼저. 하지 않으면 `~/.claude/../.ssh/id_rsa` 처럼
  // `..` 로 허용 범위를 빠져나가는 경로가 문자열 접두사 검사를 통과한다.
  const normalized = resolve(target)
  if (normalized !== target && !isAbsolute(target)) return false

  const allowedRoots = [
    resolve(join(app.getPath('home'), '.claude')),
    resolve(projectDir())
  ]
  // 경로 구분자까지 비교해 `/foo/.claude-evil` 이 `/foo/.claude` 로 통과하지 않게 한다.
  return allowedRoots.some(
    (root) => normalized === root || normalized.startsWith(`${root}${sep}`)
  )
}

function registerHandlers(): void {
  ipcMain.handle('admin:scan', async (): Promise<Inventory> => {
    return scanInventory(projectDir())
  })

  ipcMain.handle(
    'admin:togglePlugin',
    async (_event, pluginId: unknown, enabled: unknown): Promise<ToggleResult> => {
      if (typeof pluginId !== 'string' || pluginId === '') {
        return {
          ok: false,
          pluginId: String(pluginId),
          enabled: Boolean(enabled),
          error: '플러그인 ID 가 올바르지 않습니다.'
        }
      }
      if (typeof enabled !== 'boolean') {
        return {
          ok: false,
          pluginId,
          enabled: false,
          error: '활성 상태 값이 올바르지 않습니다.'
        }
      }
      return togglePlugin(pluginId, enabled)
    }
  )

  ipcMain.handle(
    'admin:openPath',
    async (_event, target: unknown): Promise<{ ok: boolean; error?: string }> => {
      if (!isAllowedPath(target)) {
        return { ok: false, error: '허용되지 않은 경로입니다.' }
      }
      // openPath 는 실패 시 예외가 아니라 사유 문자열을 돌려준다.
      const failure = await shell.openPath(target)
      return failure === '' ? { ok: true } : { ok: false, error: failure }
    }
  )

  ipcMain.handle(
    'admin:revealPath',
    async (_event, target: unknown): Promise<{ ok: boolean; error?: string }> => {
      if (!isAllowedPath(target)) {
        return { ok: false, error: '허용되지 않은 경로입니다.' }
      }
      shell.showItemInFolder(target)
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
