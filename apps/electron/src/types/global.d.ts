/**
 * 渲染进程环境类型
 *
 * window.axon 由 preload 注入（见 src/preload/index.ts 的 AxonPreloadApi）。
 */

export {}

declare global {
  interface Window {
    axon: import('../preload/index').AxonPreloadApi
  }

  /** 由 vite.config.ts 的 define 注入 */
  // eslint-disable-next-line no-var
  var __APP_VERSION__: string
}
