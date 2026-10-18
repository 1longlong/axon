/** 唯一 CLI 客户端实现；独立 CLI 与桌面生成的受控入口复用此函数。 */
export async function runLoopCli(argv: readonly string[], environment: Record<string, string | undefined> = process.env): Promise<number> {
  // 本函数须保持自包含，以便可信装配把编译后的函数写为无需第三方依赖的脚本。
  const { createConnection } = await import('node:net')
  const { StringDecoder } = await import('node:string_decoder')
  const { openSync, fstatSync, readFileSync, closeSync, constants } = await import('node:fs')
  const args = argv[0] === 'loop' ? argv.slice(1) : [...argv]
  if (args[0] === '--help' || args[0] === '-h' || !args.length && !environment.AXON_LOOP_TOKEN) {
    process.stdout.write('用法：axon loop report|finish|show|log|trace|reschedule|set-cron|set-task|set-ui|set-workflow|set-schema\n此命令仅在 Axon Loop 执行中可用。\n')
    return 0
  }
  const path = environment.AXON_LOOP_SOCKET, token = environment.AXON_LOOP_TOKEN
  if (!path?.startsWith('/') || path.length > 100 || !token || !/^[a-f0-9]{64}$/.test(token)) {
    process.stderr.write('当前 Shell 没有有效的 Axon Loop 控制上下文。\n'); return 2
  }
  try {
    const flags: Record<string, string> = { '--message-file': '--message', '--state-file': '--state', '--file': '--body' }
    const normalized = [...args]
    for (let i = 0; i < normalized.length; i++) {
      const mapped = flags[normalized[i]!]
      if (!mapped) continue
      const file = normalized[i + 1]
      if (!file) throw new Error('文件参数缺少路径')
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const info = fstatSync(fd)
        if (!info.isFile() || info.size > 64 * 1024) throw new Error('文件须为不超过 64K 的普通文件')
        const bytes = readFileSync(fd)
        if (bytes.length > 64 * 1024) throw new Error('文件读取长度超限')
        normalized[i] = mapped; normalized[++i] = bytes.toString('utf8')
      } finally { closeSync(fd) }
    }
    const request = JSON.stringify({ token, argv: normalized }) + '\n'
    if (Buffer.byteLength(request) > 256 * 1024) throw new Error('Loop 命令过大')
    const response = await new Promise<{ text: string; exitCode: number }>((done, failed) => {
      const socket = createConnection({ path })
      let buffer = '', settled = false, received = 0
      const decoder = new StringDecoder('utf8')
      const fail = (error: Error): void => { if (!settled) { settled = true; failed(error) }; socket.destroy() }
      socket.setTimeout(10_000, () => fail(new Error('Loop 回报超时，交付结果未知；请查看任务记录，不要自动重发')))
      socket.once('error', () => fail(new Error('Loop 控制通道不可用；没有创建或启动新后端')))
      socket.once('connect', () => socket.write(request))
      socket.on('data', (bytes: Buffer) => {
        received += bytes.length; buffer += decoder.write(bytes)
        if (received > 512 * 1024) { fail(new Error('Loop 应答过大')); return }
        const newline = buffer.indexOf('\n')
        if (newline < 0) return
        try {
          const value: unknown = JSON.parse(buffer.slice(0, newline))
          if (!value || typeof value !== 'object' || !('text' in value) || typeof value.text !== 'string'
            || !('exitCode' in value) || ![0, 1, 2].includes(value.exitCode as number)) throw new Error('Loop 应答无效')
          settled = true; done(value as { text: string; exitCode: number }); socket.destroy()
        } catch { fail(new Error('Loop 应答无效，不能确定交付结果')) }
      })
      socket.once('close', () => { if (!settled) fail(new Error('Loop 通道提前关闭，交付结果未知')) })
    })
    const target = response.exitCode === 0 ? process.stdout : process.stderr
    target.write(response.text + (response.text.endsWith('\n') ? '' : '\n'))
    return response.exitCode
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : 'Loop 命令失败') + '\n')
    return 1
  }
}

/** 只编码客户端代码，不嵌入通道地址、凭据或业务数据。 */
export function createLoopCliScript(): string {
  return `(${runLoopCli.toString()})(process.argv.slice(2), process.env).then(code => { process.exitCode = code }, () => { process.stderr.write('Axon Loop CLI 失败\\n'); process.exitCode = 1 })\n`
}
