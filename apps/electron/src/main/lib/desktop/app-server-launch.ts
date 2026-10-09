/** 独立后端启动配置只由可信父端决定；不使用 PATH 探测或 Shell 拼接。 */
import { join } from 'node:path'
import type { AppServerLaunch } from './app-server-process'

export interface DesktopAppServerLaunchOptions {
  executable: string
  packaged: boolean
  mainDirectory: string
  resourcesDirectory: string
  dataDir: string
  homeDir: string
  applicationVersion: string
  environment: NodeJS.ProcessEnv
}

/** 复用随应用的 Electron Node 执行器；入口和依赖在打包时解包，桌面进程不加载业务。 */
export function createDesktopAppServerLaunch(options: DesktopAppServerLaunchOptions): AppServerLaunch {
  return {
    executable: options.executable,
    entryArgs: [options.packaged
      ? join(options.resourcesDirectory, 'app.asar.unpacked', 'dist', 'app-server.mjs')
      : join(options.mainDirectory, 'app-server.mjs')],
    dataDir: options.dataDir, homeDir: options.homeDir, applicationVersion: options.applicationVersion,
    environment: { ...options.environment, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: undefined, NODE_PATH: undefined },
    zimaPython: options.environment.AXON_ZIMA_PYTHON?.trim() || undefined,
  }
}
