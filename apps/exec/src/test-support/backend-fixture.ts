/** 仅用于父端边界测试；真实进程提供受控 RPC，不代表 Runtime/Seatbelt 已执行。 */
import { JsonRpcPeer } from '@axon/app-server'
import { spawn } from 'node:child_process'
import { APP_SERVER_HOST_METHODS as host, APP_SERVER_METHODS as methods, APP_SERVER_RPC_OPTIONS } from '@axon/shared'
import { version } from '../../package.json'

const mode = process.argv[2]!
const args = process.argv.slice(3)
const dataDirectory = args[args.indexOf('--data-dir') + 1]!
const peer = new JsonRpcPeer(process.stdin, process.stdout, APP_SERVER_RPC_OPTIONS)
let initializeCount = 0
const sandboxedTools = ['bash', 'read', 'write', 'edit', 'grep', 'glob', 'ls']
peer.handle(methods.INITIALIZE, async () => {
  initializeCount++
  if (mode === 'stall-initialize') {
    peer.notify('axon/test/entered', {})
    return await new Promise<never>(() => {})
  }
  if (mode === 'polluted') { process.stdout.write('fixture-secret\n'); return null }
  const bootstrap = await peer.request(host.GET_EXEC_BOOTSTRAP, {})
  if (JSON.stringify(bootstrap).includes('apiKey') || JSON.stringify(bootstrap).includes('fixture-secret')
    || JSON.stringify(bootstrap).includes('foreign-secret')) throw new Error('启动配置不得包含密钥')
  const supported = mode !== 'unsupported'
  return { protocolVersion: 1, connectionId: 'fixture', applicationVersion: mode === 'bad-version' ? '0' : version,
    dataDirectory, capabilities: { credentialStorage: 'unavailable', channelTargetConfirmation: false,
      runtimes: [{ runtimeId: 'pi', configured: true,
        capabilities: { thinkingLevel: true, nestedProjectInstructions: 'automatic', osSandbox: supported },
        sandbox: { supported, modes: ['readOnly', 'workspaceWrite'], sandboxedTools } },
      { runtimeId: 'zima', configured: false, capabilities: { thinkingLevel: true, nestedProjectInstructions: 'manual', osSandbox: false },
        sandbox: { supported: false, modes: [], sandboxedTools: [] } }] } }
})
peer.handle(methods.REGISTER_CLIENT, async () => {
  if (mode === 'stall-register') {
    peer.notify('axon/test/entered', {})
    return await new Promise<never>(() => {})
  }
  return { clientId: 'external-fixture', kind: 'external' }
})
peer.handle(methods.GET_SETTINGS, async (params) => {
  if (mode === 'crash') process.exit(7)
  const results: Record<string, string> = {}
  for (const [label, target] of Object.entries({ selected: { channelId: 'selected', provider: 'custom', baseUrl: 'http://localhost:8123/v1' },
    foreign: { channelId: 'foreign', provider: 'custom', baseUrl: 'http://localhost:8124/v1' },
    wrongAddress: { channelId: 'selected', provider: 'custom', baseUrl: 'http://localhost:8124/v1' } })) {
    try { results[label] = String(await peer.request(host.RESOLVE_RUNTIME_CREDENTIAL, target)) }
    catch { results[label] = 'denied' }
  }
  return { clientId: Array.isArray(params) ? null : params.clientId ?? null, initializeCount,
    inheritedKey: process.env.AXON_API_KEY ?? null, results }
})
if (mode === 'stubborn') {
  process.on('SIGTERM', () => {})
  setInterval(() => {}, 1000)
} else process.stdin.on('end', () => {
  if (mode === 'inherited-stdio') {
    // 有界自退后代模拟直接 child 已退出但管道仍未关闭，不能依靠 close 事件无限等。
    spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600)'], { stdio: ['ignore', 'inherit', 'inherit'] })
  }
  process.exit(mode === 'shutdown-nonzero' ? 9 : 0)
})
process.stderr.write('fixture-secret: internal diagnostic must not be forwarded\n')
