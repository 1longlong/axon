import { expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

test('专用进程 console 与直接写 stdout/stderr 均脱敏，只有私有输出写协议', async () => {
  const child = spawn(process.execPath, [join(import.meta.dir, '../test-support/stdio-isolation-fixture.ts')], { stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  const closed = new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject) })
  try {
    child.stdin.end()
    expect(await closed).toBe(0)
    expect(stdout).toBe('{"protocol":true}\n')
    expect(stderr).toContain('运行诊断已脱敏')
    expect(stderr).not.toContain('sk-fixture-secret')
    expect(stderr).not.toContain('/private/data')
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy()
  }
})
