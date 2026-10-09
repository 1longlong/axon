/** 仅用于退出验证：忽略 EOF/SIGTERM，迫使 SDK 完成真实子进程关闭。 */
import { appendFileSync, writeFileSync } from 'node:fs'
const marker = process.argv[2]
const heldTool = process.argv[3] === 'held-tool'
writeFileSync(`${marker}.pid`, String(process.pid))
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let newline
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    if (!line.trim()) continue
    const request = JSON.parse(line)
    if (heldTool && request.method === 'notifications/cancelled') writeFileSync(`${marker}.canceled`, '收到调用取消')
    if (request.id === undefined) continue
    // Agent 的真实 SDK 已发现工具并调用后保持等待，让关闭发生在连接租约仍占用时。
    if (heldTool && request.method === 'tools/call') {
      appendFileSync(`${marker}.calls.jsonl`, `${JSON.stringify({ pid: process.pid, params: request.params })}\n`)
      continue
    }
    const result = request.method === 'initialize'
      ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'axon-shutdown-fixture', version: '1' } }
      : { tools: heldTool ? [{ name: 'hold', description: '保持隔离调用等待，供退出验证', inputSchema: {
        type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false,
      } }] : [] }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
  }
})
process.stdin.on('end', () => writeFileSync(`${marker}.eof`, '收到 EOF'))
process.on('SIGTERM', () => writeFileSync(`${marker}.term`, '收到 SIGTERM'))
setInterval(() => {}, 1_000)
