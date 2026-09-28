import { describe, expect, test } from 'bun:test'
import type { AgentSandboxPolicy } from '@axon/shared'
import { compileSeatbeltProfile, detectSeatbeltCapability } from './agent-seatbelt-profile'

function policy(overrides: Partial<AgentSandboxPolicy> = {}): AgentSandboxPolicy {
  return {
    platform: 'macos',
    mode: 'workspaceWrite',
    workingDirectory: '/Users/example/Project "A"',
    readAccess: { type: 'fullAccess' },
    writableRoots: ['/Users/example/Project "A"'],
    protectedReadOnlyRoots: ['/Users/example/Project "A"/.git'],
    networkAccess: false,
    ...overrides,
  }
}

describe('Seatbelt profile 编译', () => {
  test('先关闭全部写入和网络，再开放工作区并重新封闭保护目录', () => {
    expect(compileSeatbeltProfile(policy())).toBe([
      '(version 1)',
      '(allow default)',
      '(deny file-write*)',
      '(allow file-write* (literal "/dev/null"))',
      '(deny network*)',
      '(allow file-write* (subpath "/Users/example/Project \\"A\\""))',
      '(deny file-write* (subpath "/Users/example/Project \\"A\\"/.git"))',
      '',
    ].join('\n'))
  })

  test('readOnly 只保留运行 shell 必需的 /dev/null 精确写权限', () => {
    const profile = compileSeatbeltProfile(policy({ mode: 'readOnly', writableRoots: [] }))
    expect(profile).toContain('(deny file-write*)')
    expect(profile).toContain('(allow file-write* (literal "/dev/null"))')
    expect(profile).not.toContain('(allow file-write* (subpath')
  })

  test('拒绝矛盾策略、根目录写入和 profile 注入路径', () => {
    expect(() => compileSeatbeltProfile(policy({ mode: 'readOnly' }))).toThrow()
    expect(() => compileSeatbeltProfile(policy({ writableRoots: ['/'] }))).toThrow()
    expect(() => compileSeatbeltProfile(policy({ writableRoots: ['/tmp/x\n(allow network*)'] }))).toThrow()
    expect(() => compileSeatbeltProfile(policy({ writableRoots: ['relative'] }))).toThrow()
  })

  test('允许联网的后续策略不会生成网络拒绝规则', () => {
    expect(compileSeatbeltProfile(policy({ networkAccess: true }))).not.toContain('(deny network*)')
  })

  test('临时写授权在保护目录规则之后精确开放，并可仅为本次命令开放网络', () => {
    const profile = compileSeatbeltProfile(policy(), {
      additionalWritableRoots: ['/Users/example/Project "A"/.git/objects'],
      networkAccess: true,
    })
    expect(profile).not.toContain('(deny network*)')
    expect(profile.indexOf('(deny file-write* (subpath "/Users/example/Project \\"A\\"/.git"))'))
      .toBeLessThan(profile.indexOf('(allow file-write* (subpath "/Users/example/Project \\"A\\"/.git/objects"))'))
  })
})

describe('Seatbelt 宿主能力检测', () => {
  test('非 macOS 与不可执行路径直接 fail closed', () => {
    expect(detectSeatbeltCapability({ platform: 'linux' })).toEqual({
      available: false, reason: 'platformUnsupported',
    })
    expect(detectSeatbeltCapability({
      platform: 'darwin',
      accessExecutable: () => { throw new Error('missing') },
    })).toEqual({ available: false, reason: 'executableUnavailable' })
  })

  test('必须成功应用最小 profile 才报告可用', () => {
    let receivedArgs: string[] = []
    expect(detectSeatbeltCapability({
      platform: 'darwin',
      accessExecutable: () => {},
      runProbe: (_path, args) => { receivedArgs = args; return { status: 0 } },
    })).toEqual({ available: true, executablePath: '/usr/bin/sandbox-exec' })
    expect(receivedArgs).toEqual(['-p', '(version 1)\n(allow default)', '/usr/bin/true'])

    expect(detectSeatbeltCapability({
      platform: 'darwin',
      accessExecutable: () => {},
      runProbe: () => ({ status: 1 }),
    })).toEqual({ available: false, reason: 'profileProbeFailed' })
  })
})
