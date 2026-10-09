/** 分段专项夹具：实际附件仓储，不装配完整 backend、Runtime 或正式配置。 */
import { join } from 'node:path'
import { AttachmentController, AttachmentService } from '@axon/core'
import { APP_SERVER_RPC_OPTIONS } from '@axon/shared'
import { JsonRpcPeer } from '../src/index'
import { toWireValue } from '../src/wire-value'

const directory = process.argv[2]
if (!directory) throw new Error('缺少隔离目录')
console.log = (...values: unknown[]) => console.error(...values)
const attachments = new AttachmentController(new AttachmentService({ attachmentsDir: join(directory, 'attachments') }))
const peer = new JsonRpcPeer(process.stdin, process.stdout, APP_SERVER_RPC_OPTIONS)
peer.handle('ready', () => ({ pid: process.pid }))
peer.handle('echo', (params) => params)
peer.handle('save', (params) => toWireValue(attachments.save(params)))
peer.onClose(() => process.exit(0))
process.stderr.write('[分段夹具] 已就绪\n')
