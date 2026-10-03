import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import type { AgentSandboxCommandRequest, AgentSandboxFileContext } from '@axon/shared'
import { buildAgentSandboxPolicy } from './agent-sandbox-policy'
import {
  AgentSandboxCommandService,
  AgentSandboxExecutionError,
} from './agent-sandbox-command-service'

let directory: string
let workspace: string
let fakeSandboxExecutable: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'axon-sandbox-command-'))
  workspace = join(directory, 'workspace')
  mkdirSync(workspace)
  fakeSandboxExecutable = join(directory, 'fake-sandbox-exec')
  writeFileSync(fakeSandboxExecutable, '#!/bin/sh\nshift\nshift\nexec "$@"\n', 'utf8')
  chmodSync(fakeSandboxExecutable, 0o755)
})

afterEach(() => rmSync(directory, { recursive: true, force: true }))

function request(argv: string[], overrides: Partial<AgentSandboxCommandRequest> = {}): AgentSandboxCommandRequest {
  return {
    argv,
    cwd: workspace,
    policy: buildAgentSandboxPolicy({ projectRoot: workspace, mode: 'workspaceWrite' }),
    grants: [],
    ...overrides,
  }
}

function service(overrides: ConstructorParameters<typeof AgentSandboxCommandService>[0] = {}): AgentSandboxCommandService {
  return new AgentSandboxCommandService({
    capability: { available: true, executablePath: fakeSandboxExecutable },
    killGraceMs: 10,
    ...overrides,
  })
}

function denyingService(output: string): AgentSandboxCommandService {
  const executable = join(directory, `denying-sandbox-${Math.random().toString(16).slice(2)}`)
  writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(output)} >&2\nexit 1\n`, 'utf8')
  chmodSync(executable, 0o755)
  return service({ capability: { available: true, executablePath: executable } })
}

/** 等待测试环境自己的发布文件，不等待用户环境或使用真实账户的启动配置。 */
async function waitForSnapshot(cache: string): Promise<string> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const file = existsSync(cache) ? readdirSync(cache).find((name) => name.endsWith('.sh')) : undefined
    if (file) return join(cache, file)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('测试快照未发布')
}

describe('AgentSandboxCommandService', () => {
  test('初始化清理遗留文件但排除在途引用，释放后取消预热且不晚到发布', async () => {
    const home = join(directory, 'isolated-home')
    const cache = join(directory, 'snapshots')
    mkdirSync(home)
    mkdirSync(cache)
    writeFileSync(join(home, '.zshrc'), '/bin/sleep 10\n')
    const suffix = '-12345678-1234-1234-1234-123456789abc.sh'
    const owned = join(cache, `inflight${suffix}`)
    const orphan = join(cache, `orphan${suffix}`)
    writeFileSync(owned, 'existing')
    writeFileSync(orphan, 'orphan')
    let scans = 0
    const executor = service({
      resolveShell: () => ({ type: 'zsh', path: '/bin/zsh' }), shellSnapshotDirectory: cache,
      shellInitializationEnvironment: { HOME: home, ZDOTDIR: home, PATH: '/usr/bin:/bin' },
      getShellSessionActivity: () => { scans += 1; return new Map() },
    })
    const environment = executor.initializeShellEnvironment({ sessionId: 'inflight', cwd: workspace })
    try {
      const deadline = Date.now() + 1_000
      while (existsSync(orphan) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 5))
      expect(existsSync(orphan)).toBe(false)
      expect(existsSync(owned)).toBe(true)
      expect(scans).toBe(1)
      environment.dispose()
      const next = executor.initializeShellEnvironment({ sessionId: 'next', cwd: workspace })
      try {
        while (existsSync(owned) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 5))
        expect(existsSync(owned)).toBe(false)
      } finally { next.dispose() }
      await new Promise((done) => setTimeout(done, 30))
      expect(readdirSync(cache)).toEqual([])
    } finally { environment.dispose() }
  })

  test('快照未就绪时工具不等待，固定 Shell 仍通过原始沙箱入口执行', async () => {
    const home = join(directory, 'isolated-home')
    mkdirSync(home)
    writeFileSync(join(home, '.zshrc'), '/bin/sleep 10\n')
    let resolutions = 0
    const executor = service({
      resolveShell: () => { resolutions += 1; return { type: 'zsh', path: '/bin/zsh' } },
      shellSnapshotDirectory: join(directory, 'snapshots'),
      shellInitializationEnvironment: { HOME: home, ZDOTDIR: home, PATH: '/usr/bin:/bin' },
    })
    const commands: AgentSandboxCommandRequest[] = []
    executor.executeCommand = async (input) => {
      commands.push(input)
      return { exitCode: 0, timedOut: false, aborted: false, stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false }
    }
    const environment = executor.initializeShellEnvironment({ sessionId: 'shell-session', cwd: workspace })
    try {
      const { argv: _argv, ...context } = request([])
      await environment.executeShellCommand({ ...context, command: 'echo original' })
      await environment.executeShellCommand({ ...context, command: 'echo second', login: false })
      expect(resolutions).toBe(1)
      expect(commands.map((input) => input.argv)).toEqual([
        ['/bin/zsh', '-lc', 'echo original'], ['/bin/zsh', '-c', 'echo second'],
      ])
      expect(commands[0]?.policy).toBe(context.policy)
      expect(existsSync(join(directory, 'snapshots'))).toBe(false)
    } finally { environment.dispose() }
  })

  test('就绪快照在工具执行中恢复 PATH 与变量，显式覆盖和受控临时目录保持优先', async () => {
    const home = join(directory, 'isolated-home')
    const tools = join(home, 'tools')
    const cache = join(directory, 'snapshots')
    mkdirSync(tools, { recursive: true })
    writeFileSync(join(home, '.zshrc'), 'export PATH="$HOME/tools:$PATH"\nexport AXON_FROM_PROFILE=profile\nexport TMPDIR=/old-temp\nexport TMP=/old-temp\nexport TEMP=/old-temp\n')
    writeFileSync(join(tools, 'axon-test-program'), '#!/bin/sh\nprintf found-tool\n', { mode: 0o700 })
    const executor = service({
      resolveShell: () => ({ type: 'zsh', path: '/bin/zsh' }), shellSnapshotDirectory: cache,
      shellInitializationEnvironment: { HOME: home, ZDOTDIR: home, PATH: '/usr/bin:/bin' },
    })
    const environment = executor.initializeShellEnvironment({ sessionId: 'ready-shell', cwd: workspace })
    try {
      const snapshot = await waitForSnapshot(cache)
      const { argv: _argv, ...context } = request([])
      const overrides = { AXON_FROM_PROFILE: 'explicit', AXON_DELETED: undefined }
      const result = await environment.executeShellCommand({
        ...context,
        command: 'axon-test-program; printf "\\n%s\\n%s\\n%s\\n%s\\n" "$AXON_FROM_PROFILE" "$TMPDIR" "$TMP" "$TEMP"',
        environment: { HOME: home, ZDOTDIR: home, PATH: '/usr/bin:/bin' }, environmentOverrides: overrides,
      })
      expect(result.exitCode).toBe(0)
      const lines = result.stdout.trim().split('\n')
      expect(lines.slice(0, 2)).toEqual(['found-tool', 'explicit'])
      expect(lines[2]).toContain('axon-agent-tool-')
      expect(lines.slice(2)).toEqual([lines[2]!, lines[2]!, lines[2]!])
      expect(existsSync(lines[2]!)).toBe(false)
      // 单条命令 export 不写回初始化快照，下一个工具调用仍恢复同一份基线。
      await environment.executeShellCommand({ ...context, command: 'export AXON_FROM_PROFILE=changed', environmentOverrides: {} })
      const baseline = await environment.executeShellCommand({ ...context, command: 'printf %s "$AXON_FROM_PROFILE"', environmentOverrides: {} })
      expect(baseline.stdout).toBe('profile')
      const subdirectory = join(workspace, 'child')
      mkdirSync(subdirectory)
      const mismatch = await environment.executeShellCommand({
        ...context, cwd: subdirectory, command: 'printf %s "${AXON_FROM_PROFILE-unset}"',
        environment: { HOME: home, ZDOTDIR: home }, environmentOverrides: { AXON_FROM_PROFILE: undefined },
      })
      expect(mismatch.stdout).toBe('unset')
      environment.dispose()
      expect(existsSync(snapshot)).toBe(false)
    } finally { environment.dispose() }
  })

  test('快照包装不改变网络升级归因；批准 Grant 后只重试原命令', async () => {
    const home = join(directory, 'isolated-home')
    const cache = join(directory, 'snapshots')
    mkdirSync(home)
    writeFileSync(join(home, '.zshrc'), 'export AXON_FROM_PROFILE=profile\n')
    const log = join(directory, 'spawned-script')
    const fake = join(directory, 'recording-sandbox')
    writeFileSync(fake, `#!/bin/sh\nprintf '%s' "$5" > ${JSON.stringify(log)}\ncase "$2" in *'deny network'*) printf 'curl: socket: Operation not permitted' >&2; exit 1 ;; *) printf approved; exit 0 ;; esac\n`, { mode: 0o700 })
    const executor = service({
      capability: { available: true, executablePath: fake },
      resolveShell: () => ({ type: 'zsh', path: '/bin/zsh' }), shellSnapshotDirectory: cache,
      shellInitializationEnvironment: { HOME: home, ZDOTDIR: home, PATH: '/usr/bin:/bin' },
    })
    const environment = executor.initializeShellEnvironment({ sessionId: 'network-shell', cwd: workspace })
    try {
      await waitForSnapshot(cache)
      const { argv: _argv, ...context } = request([])
      const input = { ...context, command: 'curl https://example.test', environmentOverrides: {} }
      await expect(environment.executeShellCommand(input)).rejects.toMatchObject({ escalation: { reason: 'networkAccess' } })
      const approved = await environment.executeShellCommand({ ...input, grants: [{ scope: 'once', permission: { type: 'network' } }] })
      expect(approved.stdout).toBe('approved')
      expect(input.command).toBe('curl https://example.test')
      // 实际进程拿到包装代码，而网络归因仍识别原始 curl。
      const script = readFileSync(log, 'utf8')
      expect(script).toContain('if . ')
      expect(script).toContain("exec '/bin/zsh' -c 'curl https://example.test'")
    } finally { environment.dispose() }
  })

  test('Shell 请求由宿主选解释器，保留原始命令、启动参数和环境', async () => {
    const fakeShell = join(directory, 'bash')
    writeFileSync(fakeShell, '#!/bin/sh\nprintf "%s\\n" "$1"\nexec /bin/sh -c "$2"\n')
    chmodSync(fakeShell, 0o755)
    const executor = service({ resolveShell: () => ({ type: 'bash', path: fakeShell }) })
    const context = {
      cwd: workspace,
      policy: buildAgentSandboxPolicy({ projectRoot: workspace, mode: 'workspaceWrite' }),
      grants: [],
    }
    const command = 'printf "%s" "$AXON_SHELL_TEST"'
    const input = { ...context, command, environment: { AXON_SHELL_TEST: '空格与引号\'"' } }
    expect(await executor.executeShellCommand(input)).toMatchObject({
      exitCode: 0, stdout: '-lc\n空格与引号\'"',
    })
    expect(await executor.executeShellCommand({ ...input, login: false })).toMatchObject({
      exitCode: 0, stdout: '-c\n空格与引号\'"',
    })
  })

  test('Shell 请求仍保留网络升级归因，并在取消或解析失败时不启动命令', async () => {
    const executor = denyingService('curl: socket: Operation not permitted')
    const context = {
      cwd: workspace,
      policy: buildAgentSandboxPolicy({ projectRoot: workspace, mode: 'workspaceWrite' }),
      grants: [],
    }
    await expect(executor.executeShellCommand({
      ...context, command: 'curl https://example.com', login: false,
    })).rejects.toMatchObject({ escalation: { reason: 'networkAccess' } })

    let resolved = false
    const unavailable = service({ resolveShell: () => { resolved = true; return undefined } })
    const controller = new AbortController()
    controller.abort()
    expect(await unavailable.executeShellCommand({
      ...context, command: 'true', abortSignal: controller.signal,
    })).toMatchObject({ aborted: true, stdout: '' })
    expect(resolved).toBe(false)
    await expect(unavailable.executeShellCommand({ ...context, command: 'true' }))
      .rejects.toMatchObject({ code: 'spawnFailed' })
    await expect(unavailable.executeShellCommand({ ...context, command: 'bad\0command' }))
      .rejects.toMatchObject({ code: 'invalidRequest' })
  })

  test('以 argv 执行命令、流式转发有界输出，并在结束后清理受控临时目录', async () => {
    let controlledTemp = ''
    const stdoutChunks: string[] = []
    const stderrChunks: string[] = []
    const result = await service({
      maxOutputBytes: 8,
      createTempDirectory: () => {
        controlledTemp = mkdtempSync(join(directory, 'tool-temp-'))
        return controlledTemp
      },
    }).executeCommand(request([
      '/bin/sh', '-c', 'printf 1234567890; printf error >&2; printf %s "$TMPDIR" >&2',
    ]), {
      onStdout: (chunk) => stdoutChunks.push(chunk),
      onStderr: (chunk) => stderrChunks.push(chunk),
    })

    expect(result).toMatchObject({
      exitCode: 0,
      timedOut: false,
      aborted: false,
      stdout: '12345678',
      stdoutTruncated: true,
      stderrTruncated: true,
    })
    expect(stdoutChunks.join('')).toBe('1234567890')
    expect(stderrChunks.join('')).toContain(controlledTemp)
    expect(existsSync(controlledTemp)).toBe(false)
  })

  test('超时会终止整组命令并返回稳定终态', async () => {
    const result = await service().executeCommand(request(['/bin/sh', '-c', 'sleep 5'], { timeoutMs: 30 }))
    expect(result.exitCode).toBeNull()
    expect(result.terminationSignal).toBe('SIGTERM')
    expect(result.timedOut).toBe(true)
    expect(result.aborted).toBe(false)
  })

  test('AbortSignal 会停止命令，预先取消时不启动进程', async () => {
    const controller = new AbortController()
    const running = service().executeCommand(request(['/bin/sh', '-c', 'sleep 5'], {
      abortSignal: controller.signal,
    }))
    setTimeout(() => controller.abort(), 20)
    expect(await running).toMatchObject({ aborted: true, timedOut: false })

    const preAborted = new AbortController()
    preAborted.abort()
    expect(await service().executeCommand(request(['/bin/echo', 'ignored'], {
      abortSignal: preAborted.signal,
    }))).toMatchObject({ exitCode: null, aborted: true, stdout: '' })
  })

  test('宿主能力不可用与非法 argv 都 fail closed', async () => {
    const unavailable = new AgentSandboxCommandService({
      capability: { available: false, reason: 'profileProbeFailed' },
    })
    expect(unavailable.getSandboxCapability()).toEqual({
      supported: false, modes: [], sandboxedTools: [], limitation: 'hostExecutorUnavailable',
    })
    expect(service().getSandboxCapability()).toMatchObject({
      supported: true, modes: ['readOnly', 'workspaceWrite'], sandboxedTools: expect.arrayContaining(['bash', 'write']),
    })
    await expect(unavailable.executeCommand(request(['/bin/true']))).rejects.toMatchObject({
      name: 'AgentSandboxExecutionError', code: 'sandboxUnavailable',
    })
    await expect(service().executeCommand(request(['sh', '-c', 'true']))).rejects.toBeInstanceOf(
      AgentSandboxExecutionError,
    )
    await expect(service().executeCommand(request(['/bin/true'], { cwd: directory }))).rejects.toMatchObject({
      code: 'invalidRequest',
    })
  })

  test('Bash 只把可归因的文件或网络 Seatbelt 拒绝提升为精确审批', async () => {
    const outside = join(directory, 'outside.txt')
    try {
      await denyingService(`touch: ${outside}: Operation not permitted`).executeCommand(
        request(['/bin/zsh', '-lc', `touch ${outside}`]),
      )
      throw new Error('预期文件写入触发沙箱升级')
    } catch (error) {
      expect(error).toHaveProperty('escalation')
      expect((error as { escalation: unknown }).escalation).toMatchObject({
        reason: 'filesystemWriteOutsideWorkspace',
        permission: { type: 'filesystemWrite', roots: [join(realpathSync(directory), 'outside.txt')] },
      })
    }

    try {
      await denyingService('curl: socket: Operation not permitted').executeCommand(
        request(['/bin/zsh', '-lc', 'curl https://example.com']),
      )
      throw new Error('预期网络访问触发沙箱升级')
    } catch (error) {
      expect(error).toHaveProperty('escalation')
      expect((error as { escalation: unknown }).escalation).toMatchObject({
        reason: 'networkAccess', permission: { type: 'network' },
      })
    }

    const ordinary = await denyingService('tool: Operation not permitted').executeCommand(
      request(['/bin/zsh', '-lc', 'bun test']),
    )
    expect(ordinary).toMatchObject({ exitCode: 1, timedOut: false, aborted: false })
  })

  test('Shell 和程序的两种 errno 顺序都只提升明确绝对路径，模糊相对路径不申请授权', async () => {
    const outside = join(directory, 'outside file.txt')
    const context = request(['/bin/zsh', '-lc', `printf x > ${JSON.stringify(outside)}`])
    for (const output of [
      `zsh:1: operation not permitted: ${outside}`,
      `/bin/bash: ${outside}: Operation not permitted`,
      `touch: '${outside}': Operation not permitted`,
      `shell: Operation not permitted: '${outside}'`,
    ]) {
      await expect(denyingService(output).executeCommand(context)).rejects.toMatchObject({
        escalation: { permission: { type: 'filesystemWrite', roots: [join(realpathSync(directory), 'outside file.txt')] } },
      })
    }
    for (const output of ['zsh:1: operation not permitted: relative.txt', 'tool: Operation not permitted']) {
      expect((await denyingService(output).executeCommand(context)).exitCode).toBe(1)
    }
  })

  test('已有 Bash Grant 不会为同一拒绝重复申请升级', async () => {
    const networkResult = await denyingService('curl: socket: Operation not permitted').executeCommand(
      request(['/bin/zsh', '-lc', 'curl https://example.com'], {
        grants: [{ scope: 'once', permission: { type: 'network' } }],
      }),
    )
    expect(networkResult.exitCode).toBe(1)

    const outside = join(directory, 'outside.txt')
    const fileResult = await denyingService(`touch: ${outside}: Operation not permitted`).executeCommand(
      request(['/bin/zsh', '-lc', `touch ${outside}`], {
        grants: [{ scope: 'once', permission: { type: 'filesystemWrite', roots: [outside] } }],
      }),
    )
    expect(fileResult.exitCode).toBe(1)
  })

  test('文件读取允许项目外路径，写入只允许工作区且保护目录优先拒绝', async () => {
    const executor = service()
    const policy = buildAgentSandboxPolicy({ projectRoot: workspace, mode: 'workspaceWrite' })
    const context = { policy, grants: [] }
    const outside = join(directory, 'outside.txt')
    const inside = join(workspace, 'inside.txt')
    const protectedFile = join(workspace, '.git', 'config')
    writeFileSync(outside, 'outside', 'utf8')
    mkdirSync(join(workspace, '.git'))

    expect((await executor.readFile(outside, context)).toString('utf8')).toBe('outside')
    await executor.writeFile(inside, 'inside', context)
    expect(readFileSync(inside, 'utf8')).toBe('inside')
    await expect(executor.writeFile(outside, 'blocked', context)).rejects.toMatchObject({
      escalation: {
        reason: 'filesystemWriteOutsideWorkspace',
        permission: { type: 'filesystemWrite', roots: [realpathSync(outside)] },
      },
    })
    await expect(executor.writeFile(protectedFile, 'blocked', context))
      .rejects.toMatchObject({ escalation: { reason: 'protectedPathWrite' } })
  })

  test('精确写授权可打开额外根，符号链接不能借工作区权限逃逸', async () => {
    const executor = service()
    const outsideDirectory = join(directory, 'outside')
    mkdirSync(outsideDirectory)
    const policy = buildAgentSandboxPolicy({ projectRoot: workspace, mode: 'workspaceWrite' })
    const granted: AgentSandboxFileContext = {
      policy,
      grants: [{ scope: 'once', permission: { type: 'filesystemWrite', roots: [outsideDirectory] } }],
    }
    await executor.writeFile(join(outsideDirectory, 'allowed.txt'), 'ok', granted)
    expect(readFileSync(join(outsideDirectory, 'allowed.txt'), 'utf8')).toBe('ok')

    symlinkSync(outsideDirectory, join(workspace, 'escape'))
    await expect(executor.writeFile(join(workspace, 'escape', 'blocked.txt'), 'blocked', {
      policy, grants: [],
    })).rejects.toMatchObject({ escalation: { reason: 'filesystemWriteOutsideWorkspace' } })
  })

  test('Glob 与 Grep 由宿主遍历，跳过常见依赖目录并支持上下文和上限', async () => {
    const executor = service()
    const source = join(workspace, 'src')
    mkdirSync(source)
    mkdirSync(join(workspace, 'node_modules'))
    writeFileSync(join(source, 'a.ts'), 'before\nhello Axon\nafter\n', 'utf8')
    writeFileSync(join(source, 'b.js'), 'hello js\n', 'utf8')
    writeFileSync(join(workspace, 'node_modules', 'hidden.ts'), 'hello hidden\n', 'utf8')
    const context = {
      policy: buildAgentSandboxPolicy({ projectRoot: workspace, mode: 'workspaceWrite' }),
      grants: [],
    }

    expect((await executor.glob('**/*.ts', workspace, {
      ignore: ['**/node_modules/**', '**/.git/**'], limit: 10,
    }, context)).map((path) => relative(realpathSync(workspace), path))).toEqual(['src/a.ts'])
    expect(await executor.searchText(workspace, {
      pattern: 'hello', ignoreCase: true, glob: '**/*.ts', context: 1, limit: 1,
    }, context)).toEqual({
      matches: [{ path: 'src/a.ts', line: 2, text: 'hello Axon', before: ['before'], after: ['after'] }],
      limitReached: true,
    })
  })
})
