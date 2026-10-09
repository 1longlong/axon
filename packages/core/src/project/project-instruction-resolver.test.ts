import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildProjectInstructionSystemPrompt,
  resolveProjectInstructions,
} from './project-instruction-resolver'

let directory: string
let projectRoot: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'axon-project-instructions-'))
  projectRoot = join(directory, 'project')
  mkdirSync(projectRoot)
})

afterEach(() => rmSync(directory, { recursive: true, force: true }))

describe('项目指令解析', () => {
  test('从项目根到目标目录按作用域顺序合并 AGENTS.md', () => {
    const nested = join(projectRoot, 'packages', 'app')
    mkdirSync(nested, { recursive: true })
    const target = join(nested, 'index.ts')
    writeFileSync(join(projectRoot, 'AGENTS.md'), '根规则')
    writeFileSync(join(projectRoot, 'packages', 'AGENTS.md'), '包规则')
    writeFileSync(target, 'export {}')

    const manifest = resolveProjectInstructions({ projectRoot, targetPath: target })

    expect(manifest.sources.map((source) => [source.relativePath, source.scopeRoot])).toEqual([
      ['AGENTS.md', '.'],
      ['packages/AGENTS.md', 'packages'],
    ])
    expect(buildProjectInstructionSystemPrompt('全局规则', manifest)).toContain(
      '全局规则\n\n## 项目指令',
    )
    expect(manifest.totalBytes).toBe(Buffer.byteLength('根规则包规则'))
  })

  test('拒绝项目根外目标路径', () => {
    expect(() => resolveProjectInstructions({
      projectRoot,
      targetPath: join(directory, 'outside.ts'),
    })).toThrow('项目指令目标路径必须位于已授权项目根目录内')
  })

  test('忽略指向项目根外的符号链接指令', () => {
    const outside = join(directory, 'outside.md')
    writeFileSync(outside, '外部规则')
    symlinkSync(outside, join(projectRoot, 'AGENTS.md'))

    const manifest = resolveProjectInstructions({ projectRoot })

    expect(manifest.sources).toEqual([])
    expect(manifest.diagnostics[0]?.message).toContain('项目根目录外')
  })

  test('超大指令只产生诊断，不进入提示词', () => {
    writeFileSync(join(projectRoot, 'AGENTS.md'), 'x'.repeat(64 * 1024 + 1))

    const manifest = resolveProjectInstructions({ projectRoot })

    expect(manifest.sources).toEqual([])
    expect(manifest.diagnostics[0]?.message).toContain('64 KB')
  })
})
