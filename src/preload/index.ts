import { contextBridge, ipcRenderer } from 'electron'
import type { AdminApi } from '../shared/types.js'

/**
 * preload: renderer 와 main 사이의 유일한 통로.
 *
 * contextBridge 로 노출하는 것은 아래 네 함수뿐이다. ipcRenderer 자체나
 * Node 모듈은 넘기지 않는다 — 넘기면 renderer 가 임의 채널을 호출할 수 있다.
 */
const api: AdminApi = {
  scan: () => ipcRenderer.invoke('admin:scan'),
  togglePlugin: (pluginId, enabled) =>
    ipcRenderer.invoke('admin:togglePlugin', pluginId, enabled),
  openPath: (path) => ipcRenderer.invoke('admin:openPath', path),
  revealPath: (path) => ipcRenderer.invoke('admin:revealPath', path)
}

contextBridge.exposeInMainWorld('api', api)
