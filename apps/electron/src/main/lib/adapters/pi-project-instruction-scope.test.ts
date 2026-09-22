import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveProjectInstructions } from '../project/project-instruction-resolver'
import { PiProjectInstructionScope } from './pi-project-instruction-scope'

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'axon-pi-instruction-scope-'))
  mkdirSync(join(directory, 'frontend', 'src'), { recursive: true })
  writeFileSync(join(directory, 'AGENTS.md'), '根规则')
  writeFileSync(join(directory, 'frontend', 'AGENTS.md'), '前端规则')
  writeFileSync(join(directory, 'frontend', 'src', 'App.tsx'), 'export {}')
})

afterEach(() => rmSync(directory, { recursive: true, force: true }))

describe('Pi read 项目指令作用域', () => {
  test('read 激活未下发的子目录规则，同一路径同一内容不重复注入', () => {
    const initial = resolveProjectInstructions({ projectRoot: directory })
    const scope = new PiProjectInstructionScope({
      projectRoot: directory,
      initialSources: initial.sources,
    })

    scope.observeRead('read', { path: 'frontend/src/App.tsx' })
    const first = scope.appendPending('已有系统提示词')
    expect(first).toContain('前端规则')
    expect(first).not.toContain('根规则')

    scope.observeRead('read', { path: 'frontend/src/App.tsx' })
    expect(scope.appendPending(first)).toBe(first)
  })

  test('非 read 工具和项目外路径都不会激活子目录规则', () => {
    const initial = resolveProjectInstructions({ projectRoot: directory })
    const scope = new PiProjectInstructionScope({
      projectRoot: directory,
      initialSources: initial.sources,
    })

    scope.observeRead('write', { path: 'frontend/src/App.tsx' })
    scope.observeRead('read', { path: join(directory, '..', 'outside.ts') })

    expect(scope.appendPending('原提示词')).toBe('原提示词')
  })
})
