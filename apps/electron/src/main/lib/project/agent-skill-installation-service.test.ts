import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentSkillInstallationState,
  InstallableSkillFile,
  InstallableSkillPackage,
} from '@axon/shared'
import {
  AgentSkillInstallationService,
  validateInstallableSkillPackage,
} from './agent-skill-installation-service'

let directory: string
let desired: string[]

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'axon-skill-install-'))
  desired = []
})

afterEach(() => rmSync(directory, { recursive: true, force: true }))

function file(path: string, content: string, executable = false): InstallableSkillFile {
  const bytes = Buffer.from(content)
  return {
    path,
    contentBase64: bytes.toString('base64'),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    ...(executable ? { executable: true } : {}),
  }
}

function skillPackage(version = '1.0.0', body = '# 审查步骤'): InstallableSkillPackage {
  const files = [
    file('SKILL.md', [
      '---',
      'name: review-code',
      'description: 审查关键代码',
      '---',
      '',
      body,
    ].join('\n')),
    file('references/rules.md', '# 规则'),
  ]
  const canonical = [...files]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((entry) => `${entry.path}\0${entry.sha256}\n`)
    .join('')
  return {
    catalogId: 'official/review-code',
    name: 'review-code',
    version,
    description: '审查关键代码',
    contentHash: createHash('sha256').update(canonical).digest('hex'),
    files,
  }
}

function createService(
  statePath = join(directory, 'skill-installations.json'),
  writeState?: (path: string, state: AgentSkillInstallationState) => void,
): AgentSkillInstallationService {
  return new AgentSkillInstallationService({
    managedSkillsRoot: join(directory, '.axon', 'skills'),
    statePath,
    getDesiredCatalogIds: () => desired,
    setDesiredCatalogIds: (ids) => { desired = [...ids] },
    now: () => 100,
    ...(writeState ? { writeState } : {}),
  })
}

describe('AgentSkillInstallationService', () => {
  test('安装经过校验的包，并分别持久化期望 ID 和实际清单', () => {
    const service = createService()
    const result = service.reconcile({ packages: [skillPackage()] }, ['official/review-code'])

    expect(desired).toEqual(['official/review-code'])
    expect(result.failures).toEqual([])
    expect(result.installed).toMatchObject([{
      catalogId: 'official/review-code', name: 'review-code', version: '1.0.0', installedAt: 100,
    }])
    expect(readFileSync(join(directory, '.axon', 'skills', 'review-code', 'SKILL.md'), 'utf8'))
      .toContain('# 审查步骤')
    expect(service.getState()).toEqual({ version: 1, installed: result.installed })
  })

  test('相同内容幂等跳过，版本变化原子替换；磁盘损坏时按期望状态修复', () => {
    const service = createService()
    const first = service.reconcile({ packages: [skillPackage()] }, ['official/review-code'])
    expect(service.reconcile({ packages: [skillPackage()] }).installed).toEqual(first.installed)

    const entry = join(directory, '.axon', 'skills', 'review-code', 'SKILL.md')
    writeFileSync(entry, '损坏内容')
    service.reconcile({ packages: [skillPackage()] })
    expect(readFileSync(entry, 'utf8')).toContain('# 审查步骤')

    const updated = service.reconcile(
      { packages: [skillPackage('2.0.0', '# 新审查步骤')] },
      ['official/review-code'],
    )
    expect(updated.installed[0]?.version).toBe('2.0.0')
    expect(readFileSync(entry, 'utf8')).toContain('# 新审查步骤')
  })

  test('取消选择只卸载清单登记项，未知目录保持原样', () => {
    const service = createService()
    service.reconcile({ packages: [skillPackage()] }, ['official/review-code'])
    const unknown = join(directory, '.axon', 'skills', 'manual-skill')
    mkdirSync(unknown, { recursive: true })
    writeFileSync(join(unknown, 'SKILL.md'), 'manual')

    const result = service.reconcile({ packages: [skillPackage()] }, [])
    expect(result.installed).toEqual([])
    expect(existsSync(join(directory, '.axon', 'skills', 'review-code'))).toBe(false)
    expect(readFileSync(join(unknown, 'SKILL.md'), 'utf8')).toBe('manual')
  })

  test('拒绝路径穿越、文件哈希错误和未登记的同名目录', () => {
    const invalidPath = skillPackage()
    invalidPath.files[1] = file('../escape.md', 'escape')
    expect(() => validateInstallableSkillPackage(invalidPath)).toThrow('非法文件路径')

    const invalidHash = skillPackage()
    invalidHash.files[0]!.sha256 = '0'.repeat(64)
    expect(() => validateInstallableSkillPackage(invalidHash)).toThrow('文件哈希不匹配')

    const target = join(directory, '.axon', 'skills', 'review-code')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'keep.txt'), 'keep')
    const result = createService().reconcile({ packages: [skillPackage()] }, ['official/review-code'])
    expect(result.failures[0]?.message).toContain('不属于 Axon 安装清单')
    expect(readFileSync(join(target, 'keep.txt'), 'utf8')).toBe('keep')
  })

  test('清单提交失败会移除新目录，但保留已写入的期望状态以供重试', () => {
    const invalidStatePath = join(directory, 'state-as-directory')
    mkdirSync(invalidStatePath)
    writeFileSync(join(invalidStatePath, 'keep'), 'x')
    const result = createService(invalidStatePath).reconcile(
      { packages: [skillPackage()] },
      ['official/review-code'],
    )

    expect(desired).toEqual(['official/review-code'])
    expect(result.failures).toHaveLength(1)
    expect(existsSync(join(directory, '.axon', 'skills', 'review-code'))).toBe(false)
  })

  test('更新时清单提交失败会恢复旧目录和旧清单', () => {
    const statePath = join(directory, 'skill-installations.json')
    const service = createService(statePath)
    service.reconcile({ packages: [skillPackage()] }, ['official/review-code'])
    const beforeState = service.getState()

    const failing = createService(statePath, () => { throw new Error('模拟清单写入失败') })
    const result = failing.reconcile(
      { packages: [skillPackage('2.0.0', '# 新审查步骤')] },
      ['official/review-code'],
    )

    expect(result.failures[0]?.message).toContain('模拟清单写入失败')
    expect(readFileSync(join(directory, '.axon', 'skills', 'review-code', 'SKILL.md'), 'utf8'))
      .toContain('# 审查步骤')
    expect(service.getState()).toEqual(beforeState)
  })
})
