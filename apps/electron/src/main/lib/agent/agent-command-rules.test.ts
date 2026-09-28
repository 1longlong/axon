import { describe, expect, test } from 'bun:test'
import { evaluateAgentCommandRule, hasAgentCommandNetworkIntent } from './agent-command-rules'

describe('Agent 命令规则', () => {
  test('普通、未知和复合命令都先交给基础沙箱', () => {
    expect(evaluateAgentCommandRule('pwd').decision).toBe('allow')
    expect(evaluateAgentCommandRule("find . -name '*.ts' | grep adapter && git status").decision).toBe('allow')
    expect(evaluateAgentCommandRule('git diff\ngit status').decision).toBe('allow')
    expect(evaluateAgentCommandRule(
      "cd /Users/covenant/Workspace/Github/Proma && find docs -type f -not -path '*/node_modules/*' | sort",
    ).decision).toBe('allow')
    expect(evaluateAgentCommandRule('bun test').decision).toBe('allow')
    expect(evaluateAgentCommandRule('/tmp/custom-project-cli inspect').decision).toBe('allow')
  })

  test('任一简单命令禁止时采用最严格结果', () => {
    const result = evaluateAgentCommandRule('git status && /usr/bin/osascript -e "return 1"')
    expect(result.decision).toBe('forbidden')
    expect(result.reason).toContain('osascript')
    expect(evaluateAgentCommandRule('/tmp/sudo echo hi').decision).toBe('forbidden')
  })

  test('副作用和复杂语法也由 Seatbelt 判断资源边界', () => {
    expect(evaluateAgentCommandRule('find . -delete').decision).toBe('allow')
    expect(evaluateAgentCommandRule('cat "$TARGET"').decision).toBe('allow')
    expect(evaluateAgentCommandRule('cat a > output.txt').decision).toBe('allow')
    expect(evaluateAgentCommandRule('echo $(whoami)').decision).toBe('allow')
  })

  test('包装器和复杂子命令不能绕过显式禁止规则', () => {
    expect(evaluateAgentCommandRule('env MODE=test sudo cat /etc/hosts').decision).toBe('forbidden')
    expect(evaluateAgentCommandRule('command /usr/bin/osascript -e "return $VALUE"').decision).toBe('forbidden')
    expect(evaluateAgentCommandRule('echo $(launchctl list)').decision).toBe('forbidden')
  })

  test('只为可静态确认的直接联网命令标注意图', () => {
    expect(hasAgentCommandNetworkIntent('curl https://example.com')).toBe(true)
    expect(hasAgentCommandNetworkIntent('git status && git fetch origin')).toBe(true)
    expect(hasAgentCommandNetworkIntent('/usr/bin/ssh host')).toBe(true)
    expect(hasAgentCommandNetworkIntent("python -c 'import socket'")).toBe(false)
    expect(hasAgentCommandNetworkIntent('echo $(curl https://example.com)')).toBe(false)
  })
})
