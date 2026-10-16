import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveAgentShellWorkdir } from './agent-shell-workdir'

describe('单次 Shell 工作目录', () => {
  test('相对、绝对与链接解析本次目录，允许项目外目录但拒绝无效输入', () => {
    const directory = mkdtempSync(join(tmpdir(), 'axon-workdir-'))
    const root = join(directory, 'project')
    mkdirSync(root)
    mkdirSync(join(root, 'child'))
    mkdirSync(join(root, '..valid'))
    symlinkSync(join(root, 'child'), join(root, 'inside'))
    symlinkSync(directory, join(root, 'escape'))
    writeFileSync(join(root, 'file.txt'), 'test')
    try {
      expect(resolveAgentShellWorkdir(root, undefined)).toBe(realpathSync(root))
      expect(resolveAgentShellWorkdir(root, '')).toBe(realpathSync(root))
      for (const value of ['child', join(root, 'child'), 'inside']) {
        expect(resolveAgentShellWorkdir(root, value)).toBe(realpathSync(join(root, 'child')))
      }
      expect(resolveAgentShellWorkdir(root, '..valid')).toBe(realpathSync(join(root, '..valid')))
      for (const value of ['..', directory, 'escape']) {
        expect(resolveAgentShellWorkdir(root, value)).toBe(realpathSync(directory))
      }
      for (const value of ['missing', 'file.txt', 1, null, 'x\0y']) {
        expect(() => resolveAgentShellWorkdir(root, value)).toThrow()
      }
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})
