import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { version } from '../package.json'
import { sourceExecRuntimeArguments } from './backend-launch'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
const entry = fileURLToPath(new URL('./main.ts', import.meta.url))

/** 实际 CLI 子进程仅检验基础预检/输出；stdin 由夹具提供，不启动模型或业务 child。 */
async function run(args: string[], homeDir: string, stdin = '', cwd = homeDir) {
  const process = Bun.spawn([globalThis.process.execPath, ...sourceExecRuntimeArguments(entry), ...args], {
    cwd, env: { ...globalThis.process.env, HOME: homeDir, AXON_API_KEY: 'fixture-secret' },
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  })
  process.stdin.write(stdin)
  process.stdin.end()
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited])
    return { stdout, stderr, code }
  } finally {
    if (process.exitCode === null) { process.kill(); await process.exited }
  }
}

function home(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'axon-exec-main-')))
  directories.push(directory)
  return directory
}

describe('exec 真实源码 CLI 基础入口', () => {
  test('帮助/版本无需配置、凭据或模型，不创建任何业务文件', async () => {
    const directory = home()
    for (const args of [['--help'], ['exec', '--help'], ['--version']]) {
      const result = await run(args, directory)
      expect(result.code).toBe(0)
      expect(result.stderr).toBe('')
      expect(result.stdout).not.toContain('fixture-secret')
      expect(result.stdout).toContain(args.includes('--version') ? `axon ${version}` : 'Axon 通用非交互')
      // Bun 的源码转译器可创建自身缓存；除此之外不允许任何 Axon 业务目录/文件。
      const generated = readdirSync(directory, { recursive: true })
      expect(generated.filter((path) => !['Library', 'Library/Caches', 'Library/Caches/bun'].includes(String(path))
        && !String(path).startsWith('Library/Caches/bun/'))).toEqual([])
    }
  })

  test('非法参数/配置/模型为 2，不启动任务、不修改配置', async () => {
    const directory = home()
    const invalid = await run(['exec', '--api-key', 'fixture-secret', '任务'], directory)
    expect(invalid).toMatchObject({ code: 2, stdout: '' })
    expect(invalid.stderr).not.toContain('fixture-secret')
    mkdirSync(join(directory, '.axon-exec'))
    const configPath = join(directory, '.axon-exec', 'config.json')
    writeFileSync(configPath, '{invalid')
    const badConfig = await run(['exec', '--skip-git-repo-check', '任务'], directory)
    expect(badConfig).toMatchObject({ code: 2, stdout: '' })
    expect(readFileSync(configPath, 'utf8')).toBe('{invalid')
    const content = JSON.stringify({ defaults: { channel: 'local' }, channels: [{ id: 'local', provider: 'custom',
      baseUrl: 'http://localhost:8123/v1', models: [{ id: 'fixture' }], defaultModel: 'fixture', apiKeyRequired: true }] })
    writeFileSync(configPath, content)
    const project = join(directory, 'project')
    mkdirSync(project)
    const prepared = await run(['exec', '--skip-git-repo-check', '--model', 'missing', '--json', '-'], directory, '原始任务\n', project)
    expect(prepared.code).toBe(2)
    expect(JSON.parse(prepared.stdout.trim().split('\n').at(-1)!)).toMatchObject({ type: 'exec_finished',
      completion: { exitCode: 2, cleanup: 'not_started' } })
    expect(prepared.stderr).not.toContain('fixture-secret')
    expect(readdirSync(join(directory, '.axon-exec'))).toEqual(['config.json'])
    expect(readFileSync(configPath, 'utf8')).toBe(content)
  })
})
