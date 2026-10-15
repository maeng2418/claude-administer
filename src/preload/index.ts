import { contextBridge, ipcRenderer } from 'electron'
import type { AdminApi } from '../shared/types.js'

/**
 * preload: renderer 와 main 사이의 유일한 통로.
 *
 * contextBridge 로 노출하는 것은 아래 함수들뿐이다. ipcRenderer 자체나
 * Node 모듈은 넘기지 않는다 — 넘기면 renderer 가 임의 채널을 호출할 수 있다.
 */
const api: AdminApi = {
  scan: (projectPath) => ipcRenderer.invoke('admin:scan', projectPath ?? null),
  listProjects: (refresh) => ipcRenderer.invoke('admin:listProjects', refresh === true),
  addProject: () => ipcRenderer.invoke('admin:addProject'),
  removeProject: (path) => ipcRenderer.invoke('admin:removeProject', path),
  restoreProject: (path) => ipcRenderer.invoke('admin:restoreProject', path),
  toggleAsset: (request) => ipcRenderer.invoke('admin:toggleAsset', request),
  removeAsset: (request) => ipcRenderer.invoke('admin:removeAsset', request),
  listCatalog: (refresh) => ipcRenderer.invoke('admin:listCatalog', refresh === true),
  addMarketplace: (source) => ipcRenderer.invoke('admin:addMarketplace', source),
  // 이름을 생략하면 전체 갱신이다. undefined 를 그대로 넘기지 않고 null 로 바꿔
  // 보내는 이유: IPC 직렬화에서 undefined 는 인자 자체가 사라져 arity 가 달라진다.
  updateMarketplace: (name) => ipcRenderer.invoke('admin:updateMarketplace', name ?? null),
  installPlugin: (plugin) => ipcRenderer.invoke('admin:installPlugin', plugin),
  updatePlugin: (plugin) => ipcRenderer.invoke('admin:updatePlugin', plugin),
  revealPath: (path) => ipcRenderer.invoke('admin:revealPath', path),
  readUsage: () => ipcRenderer.invoke('admin:readUsage'),
  openSettings: () => ipcRenderer.invoke('admin:openSettings'),
  quitApp: () => ipcRenderer.invoke('admin:quitApp'),
  /*
    main → renderer 방향 알림. 핸들러를 그대로 넘기지 않고 감싸는 이유는
    두 가지다. 첫째, IpcRendererEvent 가 renderer 로 새어 나가면 그것을
    통해 sender 에 닿을 수 있다. 둘째, 구독을 끊을 때 removeListener 에
    같은 참조를 넘겨야 하는데 감싼 함수를 여기서 붙잡아 두면 호출하는
    쪽이 그 사정을 몰라도 된다.
  */
  onPopoverShown: (handler) => {
    const listener = (): void => handler()
    ipcRenderer.on('popover:shown', listener)
    return () => ipcRenderer.removeListener('popover:shown', listener)
  },
  // 응답이 필요 없는 통지라 invoke 가 아니라 send 를 쓴다.
  resizePopover: (height) => ipcRenderer.send('popover:resize', height)
}

contextBridge.exposeInMainWorld('api', api)
