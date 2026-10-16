import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseExecArguments, ExecInputError } from './arguments'
import { readExecJson, resolveExecConfiguration } from './config'
import { checkExecCredential, createExecChildEnvironment, prepareExec, readExecStdin, resolveExecPrompt } from './preflight'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'axon-exec-preflight-')))
  directories.push(root)
  const home = join(root, 'home')
  const cwd = join(root, 'project')
  mkdirSync(home); mkdirSync(cwd); mkdirSync(join(home, '.axon-exec'))
  const configPath = join(home, '.axon-exec', 'config.json')
  const channel = { id: 'test', provider: 'custom', baseUrl: 'http://localhost:8123/v1',
    apiKeyRequired: false, models: [{ id: 'model-1' }, { id: 'model-2' }], defaultModel: 'model-1' }
  const config = { defaults: { channel: 'test' }, channels: [channel] }
  writeFileSync(configPath, JSON.stringify(config))
  return { root, home, cwd, configPath, config, channel }
}

describe('exec 参数与配置预检', () => {
  test('帮助/版本、短参数、重复覆盖及 resume 语法', () => {
    expect(parseExecArguments(['--help']).help).toBe(true)
    expect(parseExecArguments(['--version']).version).toBe(true)
    const args = parseExecArguments(['exec', '-C', '/project', '-c', 'tasks=false', '-c', 'skills=true', '-m', 'x', '--', '-task'])
    expect(args).toMatchObject({ kind: 'exec', prompt: '-task', flags: { cd: '/project', model: 'x' },
      overrides: ['tasks=false', 'skills=true'] })
    expect(parseExecArguments(['exec', 'resume', 'session-1', '继续'])).toMatchObject({ kind: 'resume', sessionId: 'session-1', prompt: '继续' })
    expect(parseExecArguments(['exec', 'resume', '--last', '--all', '-'])).toMatchObject({ kind: 'resume', prompt: '-', flags: { last: true, all: true } })
    for (const argv of [[], ['chat'], ['exec', '--unknown', 'secret'], ['exec', '-C'], ['exec', '--last'],
      ['exec', 'resume'], ['exec', 'resume', '--all'], ['exec', 'resume', 'id', '--ephemeral'], ['exec', 'one', 'two']]) {
      expect(() => parseExecArguments(argv)).toThrow(ExecInputError)
    }
  })

  test('五层优先级与外部枚举转换；默认配置不随 data-dir 改变', () => {
    const f = fixture()
    writeFileSync(f.configPath, JSON.stringify({ ...f.config, defaults: { channel: 'test', sandbox: 'workspace-write', timeout: 10 },
      profiles: { coding: { model: 'model-2', timeout: 20, tasks: false } } }))
    const args = parseExecArguments(['exec', '-p', 'coding', '-c', 'timeout=30', '-c', 'tasks=true',
      '--timeout', '40', '-s', 'read-only', '--data-dir', 'other', '任务'])
    const config = resolveExecConfiguration(args, f.cwd, f.home)
    expect(config.settings).toEqual({ channel: 'test', model: 'model-2', sandbox: 'readOnly', runtime: 'pi',
      timeout: 40, systemPrompt: '', skills: true, mcp: true, memory: false, tasks: true })
    expect(config.configPath).toBe(f.configPath)
    expect(config.model).toBe('model-2')
    expect(config.runtimeExplicit).toBe(false)
  })

  test('ignore-user-config 不读坏默认文件，显式文件仍加载；不从项目读取预设', () => {
    const f = fixture()
    writeFileSync(f.configPath, '{broken')
    writeFileSync(join(f.cwd, 'trusted.json'), JSON.stringify({ ...f.config, profiles: { named: { tasks: false } } }))
    const explicit = parseExecArguments(['exec', '--ignore-user-config', '--config-file', 'trusted.json', '-p', 'named', '任务'])
    expect(resolveExecConfiguration(explicit, f.cwd, f.home).settings.tasks).toBe(false)
    const resume = parseExecArguments(['exec', 'resume', 'id', '--ignore-user-config', '任务'])
    expect(resolveExecConfiguration(resume, f.cwd, f.home).configPath).toBeUndefined()
    const missing = parseExecArguments(['exec', 'resume', 'id', '--ignore-user-config', '-p', 'named', '任务'])
    expect(() => resolveExecConfiguration(missing, f.cwd, f.home)).toThrow('profile')
    expect(() => resolveExecConfiguration(parseExecArguments(['exec', '任务']), f.cwd, f.home)).toThrow('UTF-8 JSON')
  })

  test('文件读取限制普通文件/有效 UTF-8/大小；FIFO 不阻塞在 open', () => {
    const f = fixture()
    expect(() => readExecJson(f.cwd)).toThrow('普通文件')
    writeFileSync(join(f.cwd, 'large.json'), 'x'.repeat(1024 * 1024 + 1))
    expect(() => readExecJson(join(f.cwd, 'large.json'))).toThrow('1 MiB')
    writeFileSync(join(f.cwd, 'invalid-utf8.json'), Buffer.from([0xff]))
    expect(() => readExecJson(join(f.cwd, 'invalid-utf8.json'))).toThrow('UTF-8')
    if (process.platform !== 'win32') {
      const fifo = join(f.cwd, 'fifo')
      execFileSync('mkfifo', [fifo])
      expect(() => readExecJson(fifo)).toThrow('普通文件')
    }
  })

  test('未知/密钥字段、非法类型、禁用渠道模型、危险地址与策略均拒绝，不回显敏感值', () => {
    const f = fixture()
    const invalidFiles: unknown[] = [
      { ...f.config, apiKey: 'fixture-secret' }, { ...f.config, defaults: { channel: 'test', apiKey: 'fixture-secret' } },
      { ...f.config, profiles: { unused: { tasks: 'false' } } },
      { ...f.config, channels: [{ ...f.channel, encryptedCredential: 'secure:secret' }] },
      { ...f.config, channels: [{ ...f.channel, enabled: false }] },
      { ...f.config, channels: [{ ...f.channel, models: [{ id: 'model-1', enabled: false }] }] },
      { ...f.config, channels: [{ ...f.channel, baseUrl: 'https://user:secret@example.test/v1' }] },
      { ...f.config, channels: [{ ...f.channel, baseUrl: 'https://example.test/v1?key=secret' }] },
      { ...f.config, channels: [f.channel, f.channel] },
    ]
    const args = parseExecArguments(['exec', '任务'])
    for (const config of invalidFiles) {
      writeFileSync(f.configPath, JSON.stringify(config))
      try { resolveExecConfiguration(args, f.cwd, f.home); throw new Error('应拒绝配置') }
      catch (error) { expect(error).toBeInstanceOf(ExecInputError); expect((error as Error).message).not.toContain('fixture-secret') }
    }
    writeFileSync(f.configPath, JSON.stringify(f.config))
    for (const override of ['apiKey=fixture-secret', 'retry.max=3', 'tasks=0', 'thinking=unknown', 'timeout=0',
      'sandbox=danger-full-access', 'model=missing', 'runtime=unknown']) {
      expect(() => resolveExecConfiguration(parseExecArguments(['exec', '-c', override, '任务']), f.cwd, f.home)).toThrow(ExecInputError)
    }
    for (const flag of [['-a', 'onRequest'], ['--color', 'blue'], ['--timeout', '1.2'], ['--timeout', '2e3']]) {
      expect(() => resolveExecConfiguration(parseExecArguments(['exec', ...flag, '任务']), f.cwd, f.home)).toThrow(ExecInputError)
    }
  })

  test('stdin 跨字节中文不损坏，换行保持；管道只是附加用户输入，空任务/超限拒绝', async () => {
    const buffer = Buffer.from('  中文\n\n')
    async function* chunks() { yield buffer.subarray(0, 3); yield buffer.subarray(3) }
    expect(await readExecStdin(chunks())).toBe('  中文\n\n')
    expect(resolveExecPrompt('-', '  中文\n\n', false)).toBe('  中文\n\n')
    expect(resolveExecPrompt('任务\n', '补充\n', false)).toBe('任务\n\n\n[附加用户输入]\n补充\n')
    expect(() => resolveExecPrompt(undefined, undefined, true)).toThrow()
    expect(() => resolveExecPrompt('-', ' \n', false)).toThrow()
    expect(() => resolveExecPrompt('a'.repeat(100_001), undefined, true)).toThrow()
    async function* tooLarge() { yield 'a'.repeat(100_001) }
    await expect(readExecStdin(tooLarge())).rejects.toThrow('100000')
  })

  test('真实工作区与调用目录分离；输出相对工作区，配置/data-dir 相对调用目录', async () => {
    const f = fixture()
    mkdirSync(join(f.cwd, 'sub'))
    symlinkSync(join(f.cwd, 'sub'), join(f.root, 'alias'))
    writeFileSync(join(f.cwd, 'trusted.json'), JSON.stringify(f.config))
    const args = parseExecArguments(['exec', '--config-file', 'trusted.json', '-C', '../alias', '--data-dir', '../isolated',
      '-o', 'reply.txt', '--skip-git-repo-check', '任务'])
    const result = await prepareExec(args, { originalCwd: f.cwd, homeDir: f.home, platform: 'darwin', isTTY: true })
    expect(result.cwd).toBe(join(f.cwd, 'sub'))
    expect(result.configuration.configPath).toBe(join(f.cwd, 'trusted.json'))
    expect(result.dataDir).toBe(join(f.root, 'isolated'))
    expect(result.outputLastMessage).toBe(join(f.cwd, 'sub', 'reply.txt'))
    expect(result.prompt).toBe('任务')
  })

  test('拒绝桌面数据重叠/符号链接及不支持平台 Runtime', async () => {
    const f = fixture()
    mkdirSync(join(f.home, '.axon'))
    symlinkSync(join(f.home, '.axon'), join(f.root, 'desktop-alias'))
    symlinkSync(f.cwd, join(f.root, 'project-alias'))
    for (const dataDir of [f.home, f.cwd, '/', join(f.cwd, 'data'), join(f.root, 'project-alias', 'data'),
      join(f.home, '.axon', 'nested'), join(f.root, 'desktop-alias', 'nested')]) {
      const args = parseExecArguments(['exec', '--data-dir', dataDir, '--skip-git-repo-check', '任务'])
      await expect(prepareExec(args, { originalCwd: f.cwd, homeDir: f.home, platform: 'darwin', isTTY: true })).rejects.toThrow(ExecInputError)
    }
    const args = parseExecArguments(['exec', '--skip-git-repo-check', '任务'])
    await expect(prepareExec(args, { originalCwd: f.cwd, homeDir: f.home, platform: 'linux', isTTY: true })).rejects.toThrow('macOS/Pi')
    await expect(prepareExec(parseExecArguments(['exec', '--runtime', 'zima', '--skip-git-repo-check', '任务']),
      { originalCwd: f.cwd, homeDir: f.home, platform: 'darwin', isTTY: true })).rejects.toThrow('macOS/Pi')
    await expect(prepareExec(parseExecArguments(['exec', '任务']),
      { originalCwd: f.cwd, homeDir: f.home, platform: 'darwin', isTTY: true })).rejects.toThrow('Git')
  })

  test('真实 Git 检查不受继承 GIT_DIR/GIT_WORK_TREE 劫持', async () => {
    const f = fixture()
    const other = join(f.root, 'other-repo')
    mkdirSync(other)
    execFileSync('git', ['init', '-q', other])
    const oldGitDir = process.env.GIT_DIR
    const oldWorkTree = process.env.GIT_WORK_TREE
    process.env.GIT_DIR = join(other, '.git')
    process.env.GIT_WORK_TREE = other
    try {
      const context = { originalCwd: f.cwd, homeDir: f.home, platform: 'darwin' as const, isTTY: true }
      await expect(prepareExec(parseExecArguments(['exec', '任务']), context)).rejects.toThrow('Git')
      const accepted = await prepareExec(parseExecArguments(['exec', '-C', other, '任务']), context)
      expect(accepted.cwd).toBe(other)
    } finally {
      if (oldGitDir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = oldGitDir
      if (oldWorkTree === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = oldWorkTree
    }
  })

  test('凭据只来自对应渠道配置；旧环境变量不消费/不继承，缺失与非法字段不回显', () => {
    const f = fixture()
    const environment = { AXON_API_KEY: 'fixture-secret', PATH: '/usr/bin', HTTPS_PROXY: 'http://localhost:1234' }
    const childEnvironment = createExecChildEnvironment(environment)
    expect(environment).not.toHaveProperty('AXON_API_KEY')
    expect(childEnvironment).toEqual({ PATH: '/usr/bin', HTTPS_PROXY: 'http://localhost:1234' })
    const config = resolveExecConfiguration(parseExecArguments(['exec', '任务']), f.cwd, f.home)
    checkExecCredential(config)
    config.channel!.apiKeyRequired = true
    expect(() => checkExecCredential(config)).toThrow('channel.apiKey')
    config.channel!.apiKey = 'fixture-config-secret'
    checkExecCredential(config)
    for (const apiKey of [null, 123, '\nfixture-secret', ' ', 'a'.repeat(16_385)]) {
      writeFileSync(f.configPath, JSON.stringify({ ...f.config, channels: [{ ...f.channel, apiKey }] }))
      expect(() => resolveExecConfiguration(parseExecArguments(['exec', '任务']), f.cwd, f.home)).toThrow(ExecInputError)
    }
    for (const apiKey of ['', 'fixture-config-secret']) {
      writeFileSync(f.configPath, JSON.stringify({ ...f.config, channels: [{ ...f.channel, apiKey }] }))
      expect(resolveExecConfiguration(parseExecArguments(['exec', '任务']), f.cwd, f.home).channel?.apiKey).toBe(apiKey)
    }
    // 即使残留环境变量非法，也不再把它作为凭据输入解析。
    expect(createExecChildEnvironment({ AXON_API_KEY: '\nignored' })).toEqual({})
  })
})
