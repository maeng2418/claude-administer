import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: resolve('src/main/index.ts') } } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
        // preload 는 sandbox 환경 제약으로 CommonJS 로 내보낸다.
        // package.json 에 "type": "module" 이 있어 .js 는 ES 모듈로 취급되므로,
        // 확장자를 .cjs 로 명시해야 require 가 동작한다. main 의 로드 경로도 .cjs 다.
        output: { entryFileNames: '[name].cjs', format: 'cjs' }
      }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    plugins: [react()],
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: { rollupOptions: { input: { index: resolve('src/renderer/index.html') } } }
  }
})
