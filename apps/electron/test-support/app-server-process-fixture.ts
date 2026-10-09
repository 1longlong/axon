/** 真实父管道失败/取消夹具；不装配业务，不作为完整 app-server 验收。 */
import { randomUUID } from 'node:crypto'
import { JsonRpcPeer, toWireValue } from '@axon/app-server'
import { AGENT_RUNTIME_CAPABILITIES, APP_SERVER_METHODS as methods, APP_SERVER_PROTOCOL_VERSION, APP_SERVER_RPC_OPTIONS } from '@axon/shared'

const mode = process.env.AXON_PROCESS_TEST_MODE
const peer = new JsonRpcPeer(process.stdin, process.stdout, APP_SERVER_RPC_OPTIONS)
const clients = new Set<string>()
const value = (flag: string) => process.argv[process.argv.indexOf(flag) + 1]
peer.handle(methods.INITIALIZE, (params) => {
  if (mode === 'init-hang') {
    peer.notify('axon/test/init-hanging')
    return new Promise<never>(() => undefined)
  }
  if (mode === 'pollution') { process.stdout.write('not-json\n'); return null }
  return toWireValue({ protocolVersion: mode === 'bad-version' ? 999 : APP_SERVER_PROTOCOL_VERSION,
    connectionId: randomUUID(), applicationVersion: value('--application-version')!, dataDirectory: value('--data-dir')!,
    capabilities: { ...(Array.isArray(params) ? {} : params.hostCapabilities as { credentialStorage: string; channelTargetConfirmation: boolean }),
      runtimes: (['pi', 'zima'] as const).map((runtimeId) => ({ runtimeId, configured: runtimeId === 'pi',
        capabilities: AGENT_RUNTIME_CAPABILITIES[runtimeId], sandbox: { supported: false, modes: [], sandboxedTools: [], limitation: 'hostExecutorUnavailable' } })) } })
})
peer.handle(methods.REGISTER_CLIENT, async (params) => {
  const clientId = randomUUID()
  clients.add(clientId)
  if (mode === 'late-registration') {
    peer.notify('axon/test/client-registered', { clientId })
    await new Promise((done) => setTimeout(done, 60))
  }
  return { clientId, kind: Array.isArray(params) ? null : params.kind! }
})
peer.handle(methods.DETACH_CLIENT, (params) => clients.delete(String(Array.isArray(params) ? '' : params.clientId)))
peer.handle(methods.CHANNEL_LIST, () => [...clients])
peer.handle(methods.AGENT_SEND, () => new Promise(() => {
  if (mode === 'crash') process.exit(7)
}))
peer.onClose(() => {
  if (mode === 'ignore-eof') {
    process.on('SIGTERM', () => undefined)
    setInterval(() => undefined, 1000)
  } else process.exit(mode === 'failed-shutdown' ? 1 : 0)
})
