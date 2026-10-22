/** 沙箱内独立文档进程；不启动 app-server，不加载用户配置或接触应用凭据。 */
import { extractAgentDocument } from '@axon/core'

const HELP = '用法：axon-doc extract --input <PDF/DOCX路径> [--start 1] [--end 20] [--max-chars 20000]\n输出有页/段/表格行编号的 JSON。只读文档，不提供 OCR、宏、外部链接加载或排版渲染。\n'

// 解析器诊断不能混入 stdout 的 JSON，也不能泄露原文或形成无界日志。
let diagnosticWritten = false
const parserDiagnostic = (): void => {
  if (diagnosticWritten) return
  diagnosticWritten = true
  process.stderr.write('Axon：文档解析器产生诊断；请核对提取内容及范围。\n')
}
console.log = console.info = console.warn = console.error = parserDiagnostic

/** 固定参数解析后只执行提取，错误写 stderr 且非零退出，不回传原文或内部堆栈。 */
async function main(argv: string[]): Promise<void> {
  delete process.env.ELECTRON_RUN_AS_NODE
  if (argv.length === 0 || argv.length === 1 && ['--help', '-h'].includes(argv[0]!)) { process.stdout.write(HELP); return }
  if (argv[0] !== 'extract') throw new Error('仅支持 extract 子命令')
  const fields = new Map<string, string>()
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index]!, value = argv[index + 1]
    if (!['--input', '--start', '--end', '--max-chars'].includes(key) || fields.has(key) || value === undefined || value.includes('\0')) throw new Error('文档命令参数无效')
    fields.set(key, value)
  }
  const path = fields.get('--input')
  if (!path || !path.trim()) throw new Error('缺少 --input 文档路径')
  const number = (key: string): number | undefined => {
    const value = fields.get(key)
    if (value === undefined) return undefined
    if (!/^\d+$/.test(value)) throw new Error('范围参数必须是正整数')
    return Number(value)
  }
  const result = await extractAgentDocument({ path, start: number('--start'), end: number('--end'), maxChars: number('--max-chars') })
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
}

void main(process.argv.slice(2)).catch((error: unknown) => {
  const safe = error instanceof Error && /^(此命令|文件内容|仅支持|每次最多|文档|范围参数|缺少|部分 PDF)/.test(error.message)
    ? error.message : '文档读取失败；请检查路径、权限、文档是否损坏或加密'
  process.stderr.write(`Axon：${safe}\n`)
  process.exitCode = 1
})
