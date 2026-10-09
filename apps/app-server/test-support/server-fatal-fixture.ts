/** 仅在隔离测试进程注入致命异常；运行生产 server/装配，不添加生产 RPC 或启动开关。 */
import { existsSync } from 'node:fs'
import { isolateAppServerStdio } from '../src/stdio-isolation'
import { parseAppServerStartupConfig } from '../src/startup-config'

const io = isolateAppServerStdio()
delete process.env.ELECTRON_RUN_AS_NODE
const config = parseAppServerStartupConfig(process.argv.slice(2), process.env)
const { runAppServer } = await import('../src/server')
runAppServer(config, io)
const mode = process.env.AXON_SERVER_TEST_FATAL
const marker = process.env.AXON_SERVER_TEST_MARKER
if (!marker || !['uncaughtException', 'unhandledRejection'].includes(mode ?? '')) throw new Error('测试夹具参数缺失')
const interval = setInterval(() => {
  if (!existsSync(`${marker}.eof`)) return
  clearInterval(interval)
  if (mode === 'uncaughtException') setImmediate(() => { throw new Error('sk-fatal-fixture-secret') })
  else void Promise.reject(new Error('sk-fatal-fixture-secret'))
}, 10)
