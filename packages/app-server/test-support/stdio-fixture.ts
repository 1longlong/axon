/** 真实管道夹具：仅验证传输，不装配 backend、不读取正式数据或调用模型。 */
import { JsonRpcPeer } from '../src/index'

const peer = new JsonRpcPeer(process.stdin, process.stdout)
let canceled = 0
peer.handle('ping', () => ({ pid: process.pid, electron: Boolean(process.versions.electron) }))
peer.handle('work', async () => {
  peer.notify('fixture/event', { phase: 'waiting' })
  const result = await peer.request('host/confirm', { target: 'fixture' })
  peer.notify('fixture/event', { phase: 'finished' })
  return result
})
peer.handle('control', () => ({ accepted: true }))
peer.handle('wait', (_params, { signal }) => new Promise((resolve) => {
  peer.notify('fixture/event', { phase: 'cancelable' })
  signal.addEventListener('abort', () => { canceled += 1; resolve(null) }, { once: true })
}))
peer.handle('canceled', () => canceled)
// EOF 是父连接终止，不把测试子进程变成后台常驻服务。
peer.onClose(() => process.exit(0))
process.stderr.write('[应用协议夹具] 已就绪\n')
