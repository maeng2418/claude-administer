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
  revealPath: (path) => ipcRenderer.invoke('admin:revealPath', path)
}

contextBridge.exposeInMainWorld('api', api)
