import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
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

describe('AgentSandboxCommandService', () => {
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
