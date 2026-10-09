/** Git 真实启动的测试 helper：先装好 TERM 处理，再主动通知父测试，保持 Git 的管道。 */
import { connect } from 'node:net'

process.on('SIGTERM', () => {})
const hold = setInterval(() => {}, 1000)
const socket = connect({ host: '127.0.0.1', port: Number(process.argv[2]) })
socket.once('connect', () => socket.end(JSON.stringify({ gitPid: process.ppid, helperPid: process.pid }) + '\n'))
socket.once('error', () => {
  clearInterval(hold)
  process.exitCode = 1
})
