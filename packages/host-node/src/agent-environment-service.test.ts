import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { checkAgentEnvironment } from './agent-environment-service'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'axon-agent-env-'))
  directories.push(directory)
  return directory
}

describe('Agent 环境检查', () => {
  test('返回工作目录和命令可用性，不泄露底层异常', async () => {
    const directory = temporaryDirectory()
    const result = await checkAgentEnvironment({ cwd: directory })
    expect(result.cwd).toBe(directory)
    expect(result.directory).toEqual({ available: true, writable: true, message: '工作目录可用' })
    expect(result.git.message).toMatch(/可用|不可用/)
    expect(JSON.stringify(result)).not.toContain('ENOENT')
  })

  test('非法目录返回稳定失败项但仍完成命令检查', async () => {
    const result = await checkAgentEnvironment({ cwd: join(tmpdir(), 'axon-no-such-directory') })
    expect(result.directory).toMatchObject({ available: false, writable: false })
    expect(result.directory.message).toContain('不存在')
    expect(result.node.message).toMatch(/可用|不可用/)
  })

  test('预先取消或目录读取期间取消，不交付工具缺失报告', async () => {
    const signal = new AbortController()
    signal.abort()
    await expect(checkAgentEnvironment({}, signal.signal)).rejects.toMatchObject({ name: 'AbortError' })
    const during = new AbortController()
    const pending = checkAgentEnvironment({ cwd: temporaryDirectory() }, during.signal)
    during.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  test('三个真实版本命令忽略 TERM，端口必须等全部 PID 消失才返回取消', async () => {
    if (process.platform === 'win32') return
    const directory = temporaryDirectory(), names = ['git', 'node', 'bun']
    const markers = names.map((name) => join(directory, `${name}-pid`))
    const quote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`
    for (const [index, name] of names.entries()) {
      const native = `import { writeFileSync } from 'node:fs'; process.on('SIGTERM', () => {});
        writeFileSync(${JSON.stringify(markers[index])}, String(process.pid)); setInterval(() => {}, 1000);`
      writeFileSync(join(directory, name), `#!/bin/sh\nexec ${quote(process.execPath)} -e ${quote(native)}\n`, { mode: 0o700 })
    }
    // 独立探测进程使用隔离 PATH，避免改动整个测试进程的命令环境。
    const source = `import { readFileSync } from 'node:fs';
      import { checkAgentEnvironment } from ${JSON.stringify(pathToFileURL(join(import.meta.dir, 'agent-environment-service.ts')).href)};
      const abort = new AbortController(); process.stdin.once('data', () => abort.abort());
      try { await checkAgentEnvironment({ cwd: ${JSON.stringify(directory)} }, abort.signal); process.stdout.write('unexpected'); }
      catch (error) {
        const gone = ${JSON.stringify(markers)}.map(path => {
          try { process.kill(Number(readFileSync(path, 'utf8')), 0); return 'still-running'; }
          catch (error) { return error.code; }
        });
        process.stdout.write(JSON.stringify({ aborted: abort.signal.aborted, name: error.name, gone }));
      }
      process.stdin.destroy();`
    const child = Bun.spawn([process.execPath, '--eval', source], { env: { ...process.env, PATH: directory }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
    try {
      const deadline = Date.now() + 3_000
      while (markers.some((marker) => !existsSync(marker)) && Date.now() < deadline) await Bun.sleep(5)
      expect(markers.every((marker) => existsSync(marker))).toBe(true)
      const pids = markers.map((marker) => Number(readFileSync(marker, 'utf8')))
      child.stdin.write('cancel'); child.stdin.end()
      expect(await child.exited).toBe(0)
      expect(JSON.parse(await new Response(child.stdout).text())).toEqual({ aborted: true, name: 'AbortError', gone: ['ESRCH', 'ESRCH', 'ESRCH'] })
      expect(await new Response(child.stderr).text()).toBe('')
      for (const pid of pids) {
        let error: unknown
        try { process.kill(pid, 0) } catch (caught) { error = caught }
        expect(error).toMatchObject({ code: 'ESRCH' })
      }
    } finally {
      child.stdin.end(); if (child.exitCode === null) child.kill()
      await child.exited
    }
  }, 8_000)
})
