/** 桌面装配选择数据目录；后端只能消费已确定的路径，不能自行探测打包状态。 */
import { app } from 'electron'
import { join } from 'node:path'
interface DesktopBackendPaths { dataDir: string; homeDir: string }
let paths: DesktopBackendPaths | undefined

/** 一个桌面进程使用一个目录实例；后续由启动握手将同一 dataDir 交给独立服务。 */
export function getDesktopBackendPaths(): DesktopBackendPaths {
  if (!paths) {
    const homeDir = app.getPath('home')
    const directoryName = process.env.AXON_DEV === '1' || !app.isPackaged ? '.axon-dev' : '.axon'
    paths = { dataDir: join(homeDir, directoryName), homeDir }
    // 父端只决定路径；创建与写入业务目录统一发生在有效握手后的子进程。
  }
  return paths
}
