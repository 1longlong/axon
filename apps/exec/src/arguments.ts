import { parseArgs } from 'node:util'

export class ExecInputError extends Error {
  constructor(message: string) { super(message); this.name = 'ExecInputError' }
}

const options = {
  help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'V' },
  cd: { type: 'string', short: 'C' }, channel: { type: 'string' }, model: { type: 'string', short: 'm' },
  runtime: { type: 'string' }, sandbox: { type: 'string', short: 's' },
  'ask-for-approval': { type: 'string', short: 'a' }, json: { type: 'boolean' },
  'output-last-message': { type: 'string', short: 'o' }, 'output-schema': { type: 'string' },
  profile: { type: 'string', short: 'p' }, config: { type: 'string', short: 'c', multiple: true },
  'ignore-user-config': { type: 'boolean' }, 'config-file': { type: 'string' }, 'data-dir': { type: 'string' },
  ephemeral: { type: 'boolean' }, timeout: { type: 'string' }, 'skip-git-repo-check': { type: 'boolean' },
  color: { type: 'string' }, last: { type: 'boolean' }, all: { type: 'boolean' },
} as const

export interface ExecFlags {
  cd?: string
  channel?: string
  model?: string
  runtime?: string
  sandbox?: string
  approval?: string
  json: boolean
  outputLastMessage?: string
  outputSchema?: string
  profile?: string
  ignoreUserConfig: boolean
  configFile?: string
  dataDir?: string
  ephemeral: boolean
  timeout?: string
  skipGitRepoCheck: boolean
  color?: string
  last: boolean
  all: boolean
}

export interface ExecArguments {
  kind: 'exec' | 'resume'
  help: boolean
  version: boolean
  prompt?: string
  sessionId?: string
  flags: ExecFlags
  overrides: string[]
}

/** 只解析参数，不读配置/环境、不装配后端；帮助与版本走同一严格参数入口。 */
export function parseExecArguments(argv: string[]): ExecArguments {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof options; allowPositionals: true; strict: true }>>
  try { parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true }) }
  catch { throw new ExecInputError('未知参数或参数缺少值；请使用 --help 查看用法') }
  const values = parsed.values
  const positionals = [...parsed.positionals]
  const help = values.help === true
  const version = values.version === true
  if (positionals.shift() !== 'exec' && !(argv.length > 0 && (help || version) && parsed.positionals.length === 0)) {
    throw new ExecInputError('仅支持 exec 子命令；请使用 --help 查看用法')
  }
  const kind = positionals[0] === 'resume' ? 'resume' : 'exec'
  if (kind === 'resume') positionals.shift()
  const sessionId = kind === 'resume' && !values.last ? positionals.shift() : undefined
  if (kind === 'resume' && !values.last && !sessionId && !help && !version) {
    throw new ExecInputError('resume 需要 sessionId 或 --last')
  }
  if (sessionId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionId)) throw new ExecInputError('resume 会话 ID 格式无效')
  if (values.all && (kind !== 'resume' || !values.last)) throw new ExecInputError('--all 仅可与 resume --last 同用')
  if (values.last && kind !== 'resume') throw new ExecInputError('--last 仅用于 resume')
  if (kind === 'resume' && values.ephemeral) throw new ExecInputError('resume 不支持 --ephemeral')
  if (positionals.length > 1) throw new ExecInputError('任务正文必须作为一个参数传入，或使用 - 读取 stdin')
  const flags: ExecFlags = {
    cd: values.cd, channel: values.channel, model: values.model, runtime: values.runtime,
    sandbox: values.sandbox, approval: values['ask-for-approval'], json: values.json === true,
    outputLastMessage: values['output-last-message'], outputSchema: values['output-schema'],
    profile: values.profile, ignoreUserConfig: values['ignore-user-config'] === true,
    configFile: values['config-file'], dataDir: values['data-dir'], ephemeral: values.ephemeral === true,
    timeout: values.timeout, skipGitRepoCheck: values['skip-git-repo-check'] === true,
    color: values.color, last: values.last === true, all: values.all === true,
  }
  return { kind, help, version, prompt: positionals[0], sessionId, flags, overrides: values.config ?? [] }
}

export const EXEC_HELP = `Axon 通用非交互 Agent 入口

用法：axon exec [选项] [PROMPT|-]
      axon exec resume <sessionId> [选项] [PROMPT|-]
      axon exec resume --last [--all] [选项] [PROMPT|-]

  -C, --cd <path>                  工作区（默认调用目录）
      --channel <id>               配置中的启用渠道
  -m, --model <id>                 渠道中的启用模型
      --runtime <id>               默认 pi；首版仅支持 macOS/Pi
  -s, --sandbox <mode>             read-only（默认）或 workspace-write
  -a, --ask-for-approval never      不申请额外批准，不关闭沙箱
      --json                      stdout 输出版本化 JSONL 事件
  -o, --output-last-message <path>  原子保存最终回复正文
      --output-schema <path>       最终 JSON 输出的 Schema
  -p, --profile <name>             命名 CLI 运行预设
  -c, --config key=value           可重复的已知字段覆盖（不保存）
      --config-file <path>         显式可信 JSON 配置
      --ignore-user-config        跳过默认配置，但仍读取显式文件
      --data-dir <path>            独立业务目录/临时容器（默认 ~/.axon-exec）
      --ephemeral                 仅保留工作区修改和指定输出，不保留会话
      --timeout <seconds>          正整数总执行期限；默认不限
      --skip-git-repo-check        允许非 Git 工作区，不扩大权限
      --color <mode>              auto / always / never（仅诊断）
      --last [--all]              恢复当前工作区最新会话，all 扩大选择范围
  -h, --help                      显示帮助，不启动后端
  -V, --version                   显示版本，不启动后端

无任务且 stdin 为管道时读取 stdin；TTY 缺少任务报错。文本任务与管道输入同用时追加用户输入。
默认配置：~/.axon-exec/config.json；不自动读取项目配置或桌面密钥。
配置优先级：内置默认 → 配置文件 → profile → -c → 专用参数。
凭据：仅使用所选 channels 条目的 apiKey；不读取环境变量或桌面密钥，不接受 argv 密钥。
当前支持新任务/CLI 根会话恢复、正文/JSONL、最终正文原子文件、Schema 本地校验、never、总期限及信号退出。
Schema 支持 draft-07（默认）/2019-09/2020-12；不读取外部引用，不修补或重跑不合格输出。
恢复默认保留原渠道/模型；profile、-c 或专用参数可明确覆盖，但不能切换 Runtime。
--all 仅扩大最新会话的选择范围，执行仍用原项目目录；文件参数仍相对 -C/调用工作区。
输出父目录须已存在；ephemeral 使用数据目录下的私有临时业务根，不保留会话。
`
