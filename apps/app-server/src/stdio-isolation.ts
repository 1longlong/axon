/** 专用子进程先隔离日志，再加载业务/SDK；原 stdout 写入口只交给协议输出。 */
import { Console } from 'node:console'
import { Writable } from 'node:stream'

export interface AppServerStdio {
  protocolOutput: Writable
  diagnostic: (kind: 'ready' | 'startup_failed' | 'runtime_log' | 'shutdown_failed') => void
}

/** 不尝试从未知 SDK 日志中猜密钥：诊断只输出固定类别，正文不跨 stderr 边界。 */
export function isolateAppServerStdio(): AppServerStdio {
  const stdoutWrite = process.stdout.write.bind(process.stdout)
  const stderrWrite = process.stderr.write.bind(process.stderr)
  const messages = { ready: '协议入口已准备', startup_failed: '启动失败', runtime_log: '运行诊断已脱敏', shutdown_failed: '退出异常' }
  const diagnostic: AppServerStdio['diagnostic'] = (kind) => { stderrWrite(`[应用服务] ${messages[kind]}\n`) }
  const protocolOutput = new Writable({ write(chunk: Buffer, encoding, callback) { stdoutWrite(chunk, encoding, callback) } })
  const sanitizedWrite: typeof process.stdout.write = (_chunk: string | Uint8Array,
    encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) =>
    stderrWrite('[应用服务] 运行诊断已脱敏\n', 'utf8', typeof encoding === 'function' ? encoding : callback)
  process.stdout.write = sanitizedWrite
  process.stderr.write = sanitizedWrite
  const logs = new Writable({ write(_chunk, _encoding, callback) { diagnostic('runtime_log'); callback() } })
  // 保留执行器特有的 console 扩展；标准方法替换为脱敏输出，直接 write 也已隔离。
  Object.assign(globalThis.console, new Console({ stdout: logs, stderr: logs }))
  return { protocolOutput, diagnostic }
}
