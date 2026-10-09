/** 真实 stdio 测试服务器；只使用隔离参数，不连接网络或读取用户配置。 */
import { writeFileSync } from 'node:fs'

let input = ''
let clientVersion = ''
process.stdin.setEncoding('utf8')
process.stderr.write('Axon MCP 测试服务器已启动\n')

/** 只把协议响应写 stdout；初始化信息通过工具描述/结果交给测试断言。 */
function respond(message) {
  if (message.id === undefined) return
  // 取消验证等待服务端确实收到目标请求，不以固定延时猜测连接阶段。
  if (message.method === process.argv[3]) {
    writeFileSync(`${process.argv[2]}.started`, String(process.pid))
    return
  }
  let result
  if (message.method === 'initialize') {
    clientVersion = message.params.clientInfo.version
    result = {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'axon-mcp-fixture', version: '1.0.0' },
    }
  } else if (message.method === 'tools/list') {
    result = message.params?.cursor === 'next'
      ? { tools: [{ name: 'second', inputSchema: { type: 'object' } }] }
      : {
          tools: [{
            name: 'echo',
            description: `client=${clientVersion}`,
            inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
            annotations: { readOnlyHint: true },
          }],
          nextCursor: 'next',
        }
  } else if (message.method === 'tools/call') {
    result = { content: [{ type: 'text', text: JSON.stringify({ clientVersion, ...message.params }) }] }
  } else {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: '不支持的方法' } }) + '\n')
    return
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n')
}

process.stdin.on('data', (chunk) => {
  input += chunk
  let newline
  while ((newline = input.indexOf('\n')) !== -1) {
    const frame = input.slice(0, newline)
    input = input.slice(newline + 1)
    if (frame.trim()) respond(JSON.parse(frame))
  }
})

/** 记录实际进程收束，不以父端 dispose 调用本身代替退出证据。 */
function finish() {
  writeFileSync(process.argv[2], 'closed')
  process.exit(0)
}
process.stdin.on('end', finish)
process.on('SIGTERM', finish)
