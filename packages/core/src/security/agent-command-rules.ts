/** Bash 命令的显式硬规则；未命中时必须交给 Seatbelt，而不是按白名单请求审批。 */

export type AgentCommandRuleDecision = 'allow' | 'prompt' | 'forbidden'

export interface AgentCommandRuleResult {
  decision: AgentCommandRuleDecision
  reason: string
}

const FORBIDDEN_COMMANDS = new Set(['sudo', 'su', 'doas', 'osascript', 'launchctl'])
const NETWORK_COMMANDS = new Set([
  'curl', 'wget', 'ssh', 'scp', 'sftp', 'ftp', 'nc', 'netcat', 'telnet',
  'ping', 'ping6', 'dig', 'host', 'nslookup', 'gh', 'glab',
])
const NETWORK_GIT_COMMANDS = new Set(['clone', 'fetch', 'pull', 'push', 'ls-remote'])
const COMPLEX_SHELL_CHARACTERS = /[<>$`\\*?()[\]{}#]/
const SHELL_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

interface ParsedCommands {
  commands: string[][]
  complex: boolean
}

/**
 * 只拆分没有展开语义的引号与 `; | && ||`；其余 Shell 语法标为 complex。
 * complex 只影响静态意图识别，不能因此绕过或扩大后续 Seatbelt 策略。
 */
function parseSimpleCommands(command: string): ParsedCommands {
  const commands: string[][] = []
  let argv: string[] = []
  let token = ''
  let quote: "'" | '"' | undefined
  let tokenStarted = false

  const flushToken = (): void => {
    if (!tokenStarted) return
    argv.push(token)
    token = ''
    tokenStarted = false
  }
  const flushCommand = (): boolean => {
    flushToken()
    if (argv.length === 0) return false
    commands.push(argv)
    argv = []
    return true
  }

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!
    if (quote) {
      if (char === quote) quote = undefined
      else {
        // 双引号中的展开与转义仍有 Shell 语义，不能按普通 argv 做静态判断。
        if (quote === '"' && /[$`\\]/.test(char)) return { commands: [], complex: true }
        token += char
        tokenStarted = true
      }
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      tokenStarted = true
      continue
    }
    if (/\s/.test(char)) {
      if (char === '\n') {
        if (!flushCommand()) return { commands: [], complex: true }
      } else flushToken()
      continue
    }
    if (char === ';' || char === '|') {
      if (!flushCommand()) return { commands: [], complex: true }
      if (char === '|' && command[index + 1] === '|') index += 1
      continue
    }
    if (char === '&') {
      if (command[index + 1] !== '&' || !flushCommand()) return { commands: [], complex: true }
      index += 1
      continue
    }
    if (COMPLEX_SHELL_CHARACTERS.test(char)) return { commands: [], complex: true }
    token += char
    tokenStarted = true
  }
  if (quote || !flushCommand()) return { commands: [], complex: true }
  return { commands, complex: false }
}

function normalizedExecutable(value: string): string {
  return value.includes('/') ? value.slice(value.lastIndexOf('/') + 1) : value
}

function forbiddenExecutableForArgv(argv: string[]): string | undefined {
  let index = 0
  while (index < argv.length) {
    const executable = normalizedExecutable(argv[index] ?? '')
    if (FORBIDDEN_COMMANDS.has(executable)) return executable
    if (['command', 'exec', 'nohup', 'time'].includes(executable)) {
      index += 1
      continue
    }
    if (executable === 'env') {
      index += 1
      while (index < argv.length) {
        const value = argv[index] ?? ''
        if (!value.startsWith('-') && !SHELL_ASSIGNMENT.test(value)) break
        index += 1
      }
      continue
    }
    return undefined
  }
  return undefined
}

/**
 * 复杂 Shell 无法用轻量词法器完整拆分时，只识别控制符后的明确禁止命令。
 * 这不是资源安全边界；其余内容仍必须进入 Seatbelt，由 OS 决定是否需要升级。
 */
function forbiddenExecutableInComplexCommand(command: string): string | undefined {
  const names = [...FORBIDDEN_COMMANDS].join('|')
  const match = new RegExp(
    `(?:^|[;|&()\\n]|\\$\\(|\u0060)\\s*(?:(?:command|exec|nohup|time)\\s+)*(?:env(?:\\s+(?:-[^\\s]+|[A-Za-z_][A-Za-z0-9_]*=[^\\s]+))*\\s+)?(?:/(?:usr/)?bin/)?(${names})(?=\\s|$|[;|&()])`,
  ).exec(command)
  return match?.[1]
}

/** 未命中显式禁止规则的命令一律先在基础沙箱中运行，不再维护易漏报的只读白名单。 */
export function evaluateAgentCommandRule(command: string): AgentCommandRuleResult {
  if (!command.trim()) return { decision: 'forbidden', reason: '命令为空' }
  const parsed = parseSimpleCommands(command)
  if (parsed.complex) {
    const forbidden = forbiddenExecutableInComplexCommand(command)
    return forbidden
      ? { decision: 'forbidden', reason: `命令 ${forbidden} 会越过当前本地工具边界` }
      : { decision: 'allow', reason: '未命中显式限制，交由基础沙箱执行' }
  }
  for (const argv of parsed.commands) {
    const forbidden = forbiddenExecutableForArgv(argv)
    if (forbidden) {
      return { decision: 'forbidden', reason: `命令 ${forbidden} 会越过当前本地工具边界` }
    }
  }
  return { decision: 'allow', reason: '未命中显式限制，交由基础沙箱执行' }
}

/** 只识别能从简单 argv 明确得出的联网意图；复杂 Shell 或解释器代码不做猜测。 */
export function hasAgentCommandNetworkIntent(command: string): boolean {
  const parsed = parseSimpleCommands(command)
  if (parsed.complex) return false
  return parsed.commands.some((argv) => {
    const executable = normalizedExecutable(argv[0] ?? '')
    if (NETWORK_COMMANDS.has(executable)) return true
    return executable === 'git' && NETWORK_GIT_COMMANDS.has(argv[1] ?? '')
  })
}
