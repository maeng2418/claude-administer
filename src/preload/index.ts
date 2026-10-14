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
  listProjects: () => ipcRenderer.invoke('admin:listProjects'),
  addProject: () => ipcRenderer.invoke('admin:addProject'),
  removeProject: (path) => ipcRenderer.invoke('admin:removeProject', path),
  toggleAsset: (request) => ipcRenderer.invoke('admin:toggleAsset', request),
  openPath: (path) => ipcRenderer.invoke('admin:openPath', path),
  revealPath: (path) => ipcRenderer.invoke('admin:revealPath', path)
}

contextBridge.exposeInMainWorld('api', api)
