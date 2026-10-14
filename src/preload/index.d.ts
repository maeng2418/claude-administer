import type { AdminApi } from '../shared/types.js'

/** preload 가 window 에 심어주는 API 의 타입 선언. renderer 쪽에서 쓴다. */
declare global {
  interface Window {
    api: AdminApi
  }
}

export {}
