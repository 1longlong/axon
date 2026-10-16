/** 后端数据目录的进程级独占租约；锁文件常驻，锁状态只由操作系统维护。 */
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

export const BACKEND_DIRECTORY_LOCK_FILE = '.axon-backend.lock'
// Darwin 的原生 open 标志；node:fs 未导出这两项，仍支持传入原始整数标志。
const O_EXLOCK = 0x20
const O_CLOEXEC = 0x01000000

export class BackendDirectoryLeaseError extends Error {
  constructor(readonly code: 'busy' | 'unavailable', message: string) {
    super(message)
    this.name = 'BackendDirectoryLeaseError'
  }
}

export interface BackendDirectoryLease {
  directory: string
  /** 只在真实后端停止写入后释放；不能登记进并行 dispose/drain 的资源清单。 */
  release(): void
}

/**
 * 可信服务在业务装配前同步取得本地目录锁，其他写入者立即失败而不等待。
 * 返回句柄由实际后端进程持有到退出；崩溃也由内核释放，不猜 PID 或删除所谓陈旧锁。
 */
export function acquireBackendDirectoryLease(dataDir: string): BackendDirectoryLease {
  if (process.platform !== 'darwin' || !isAbsolute(dataDir) || dataDir.includes('\0')) {
    throw new BackendDirectoryLeaseError('unavailable', '后端目录锁不可用')
  }
  let fd: number | undefined
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    const directory = realpathSync(dataDir)
    const lockPath = join(directory, BACKEND_DIRECTORY_LOCK_FILE)
    // 打开时原子加独占锁；禁止跟随链接/阻塞 FIFO，exec 后代不能继承锁句柄。
    fd = openSync(lockPath, constants.O_CREAT | constants.O_RDWR | constants.O_NONBLOCK
      | constants.O_NOFOLLOW | O_EXLOCK | O_CLOEXEC, 0o600)
    const opened = fstatSync(fd), current = lstatSync(lockPath)
    if (!opened.isFile() || opened.nlink !== 1 || opened.uid !== process.getuid!()
      || (opened.mode & 0o777) !== 0o600 || opened.ino !== current.ino || opened.dev !== current.dev) throw new Error()
    const ownedFd = fd
    fd = undefined
    let released = false
    return { directory, release() {
      if (released) return
      closeSync(ownedFd)
      released = true
      // 不 unlink：旧 inode 的等待者与新建文件同时存在会破坏独占性。
    } }
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EAGAIN' || code === 'EWOULDBLOCK') {
      throw new BackendDirectoryLeaseError('busy', '该数据目录已有后端运行，请使用另一个数据目录或等待原后端退出')
    }
    throw new BackendDirectoryLeaseError('unavailable', '无法取得后端数据目录锁')
  }
}
