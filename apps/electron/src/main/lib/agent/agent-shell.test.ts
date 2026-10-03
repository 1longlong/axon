import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveAgentShell } from './agent-shell'

let directory: string

beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'axon-shell-resolution-')) })
afterEach(() => rmSync(directory, { recursive: true, force: true }))

function executable(parent: string, name: string): string {
  mkdirSync(parent, { recursive: true })
  const path = join(parent, name)
  writeFileSync(path, '#!/bin/sh\nexit 0\n')
  chmodSync(path, 0o755)
  return path
}

describe('宿主用户 Shell 选择', () => {
  test('优先账户默认类型和路径，而不是 PATH 中的同名 Shell', () => {
    const account = executable(join(directory, 'account shell'), 'bash')
    executable(join(directory, 'bin'), 'bash')
    executable(join(directory, 'bin'), 'zsh')
    expect(resolveAgentShell({
      userShellPath: account, path: join(directory, 'bin'), platform: 'darwin',
    })).toEqual({ type: 'bash', path: account })
  })

  test('账户路径不可用时先找同类型，再按 macOS 默认顺序回退', () => {
    const path = join(directory, 'bin')
    const bash = executable(path, 'bash')
    const zsh = executable(path, 'zsh')
    expect(resolveAgentShell({ userShellPath: join(directory, 'missing', 'bash'), path, platform: 'darwin' }))
      .toEqual({ type: 'bash', path: bash })
    expect(resolveAgentShell({ userShellPath: '/unsupported/fish', path, platform: 'darwin' }))
      .toEqual({ type: 'zsh', path: zsh })
  })

  test('非 macOS 默认优先 bash，账户中的 sh 仍可被识别', () => {
    const path = join(directory, 'bin')
    const bash = executable(path, 'bash')
    executable(path, 'zsh')
    const sh = executable(join(directory, 'account'), 'sh')
    expect(resolveAgentShell({ userShellPath: null, path, platform: 'linux' }))
      .toEqual({ type: 'bash', path: bash })
    expect(resolveAgentShell({ userShellPath: sh, path, platform: 'darwin' }))
      .toEqual({ type: 'sh', path: sh })
  })

  test('跳过没有执行权限的账户文件与 PATH 目录，再使用可执行 Shell', () => {
    const account = executable(join(directory, 'account'), 'zsh')
    chmodSync(account, 0o644)
    const first = join(directory, 'first')
    mkdirSync(join(first, 'zsh'), { recursive: true })
    const second = join(directory, 'second')
    const zsh = executable(second, 'zsh')
    expect(resolveAgentShell({ userShellPath: account, path: `${first}:${second}`, platform: 'darwin' }))
      .toEqual({ type: 'zsh', path: zsh })
  })
})
