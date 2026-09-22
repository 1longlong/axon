/** Axon 管理 Skill 的校验、原子安装、卸载与期望状态核对。 */

import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type {
  AgentSkillInstallationState,
  AgentSkillReconcileResult,
  InstallableSkillCatalog,
  InstallableSkillFile,
  InstallableSkillPackage,
  InstalledAgentSkill,
} from '@axon/shared'
import { readJsonFileSafe, writeJsonFileAtomic } from '../core/safe-file'
import { renameIfDestinationAbsentWithRetry, rmSyncWithRetry } from '../core/fs-retry'
import { parseSkillFrontmatter } from './project-skill-discovery'

const MAX_PACKAGE_FILES = 256
const MAX_PACKAGE_BYTES = 8 * 1024 * 1024
const MAX_FILE_BYTES = 2 * 1024 * 1024
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export interface AgentSkillInstallationServiceOptions {
  managedSkillsRoot: string
  statePath: string
  getDesiredCatalogIds: () => string[]
  setDesiredCatalogIds: (ids: string[]) => void
  now?: () => number
  /** 测试可注入提交失败；产品默认使用 safe-file 原子写。 */
  writeState?: (path: string, state: AgentSkillInstallationState) => void
}

interface ValidatedFile {
  path: string
  content: Buffer
  sha256: string
  executable?: boolean
}

interface ValidatedPackage {
  definition: InstallableSkillPackage
  files: ValidatedFile[]
}

function comparisonKey(value: string): string {
  return process.platform === 'win32' || process.platform === 'darwin' ? value.toLowerCase() : value
}

function validateRelativePath(value: string): string {
  if (!value || value.includes('\\') || value.includes('\0') || isAbsolute(value)) {
    throw new Error('安装包包含非法文件路径')
  }
  const segments = value.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('安装包包含非法文件路径')
  }
  return segments.join('/')
}

function decodeFile(file: InstallableSkillFile): ValidatedFile {
  const path = validateRelativePath(file.path)
  if (!SHA256_PATTERN.test(file.sha256)) throw new Error(`文件哈希无效：${path}`)
  const content = Buffer.from(file.contentBase64, 'base64')
  if (content.toString('base64') !== file.contentBase64 || content.byteLength > MAX_FILE_BYTES) {
    throw new Error(`文件内容编码无效或超过 2 MB：${path}`)
  }
  const actualHash = createHash('sha256').update(content).digest('hex')
  if (actualHash !== file.sha256) throw new Error(`文件哈希不匹配：${path}`)
  return { path, content, sha256: file.sha256, ...(file.executable ? { executable: true } : {}) }
}

function packageContentHash(files: readonly ValidatedFile[]): string {
  const canonical = [...files]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((file) => `${file.path}\0${file.sha256}\n`)
    .join('')
  return createHash('sha256').update(canonical).digest('hex')
}

/** 校验 catalog 包的身份、文件集合、哈希和 SKILL.md，再允许进入暂存目录。 */
export function validateInstallableSkillPackage(value: InstallableSkillPackage): ValidatedPackage {
  if (
    !value || typeof value !== 'object'
    || typeof value.catalogId !== 'string' || !value.catalogId.trim() || value.catalogId.length > 200
    || !SKILL_NAME_PATTERN.test(value.name)
    || typeof value.version !== 'string' || !value.version.trim() || value.version.length > 100
    || typeof value.description !== 'string' || !value.description.trim() || value.description.length > 1024
    || !SHA256_PATTERN.test(value.contentHash)
    || !Array.isArray(value.files) || value.files.length === 0 || value.files.length > MAX_PACKAGE_FILES
  ) throw new Error('可安装 Skill 包字段无效')

  const files = value.files.map(decodeFile)
  const paths = new Set<string>()
  let totalBytes = 0
  for (const file of files) {
    const key = comparisonKey(file.path)
    if (paths.has(key)) throw new Error(`安装包文件路径重复：${file.path}`)
    paths.add(key)
    totalBytes += file.content.byteLength
  }
  if (totalBytes > MAX_PACKAGE_BYTES) throw new Error('安装包总大小超过 8 MB')
  const sortedPaths = [...paths].sort()
  for (let index = 1; index < sortedPaths.length; index += 1) {
    if (sortedPaths[index]!.startsWith(`${sortedPaths[index - 1]!}/`)) {
      throw new Error('安装包同时包含文件及其子路径')
    }
  }
  if (packageContentHash(files) !== value.contentHash) throw new Error('安装包内容哈希不匹配')

  const instruction = files.find((file) => comparisonKey(file.path) === comparisonKey('SKILL.md'))
  if (!instruction || instruction.path !== 'SKILL.md' || instruction.content.includes(0)) {
    throw new Error('安装包缺少有效的 SKILL.md')
  }
  const frontmatter = parseSkillFrontmatter(instruction.content.toString('utf8'), value.name)
  if (frontmatter.description !== value.description.trim()) {
    throw new Error('安装包描述与 SKILL.md 不一致')
  }
  return { definition: { ...value, catalogId: value.catalogId.trim(), version: value.version.trim() }, files }
}

function emptyState(): AgentSkillInstallationState {
  return { version: 1, installed: [] }
}

function normalizeInstalled(value: unknown): InstalledAgentSkill | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (
    typeof record.catalogId !== 'string' || !record.catalogId
    || typeof record.name !== 'string' || !SKILL_NAME_PATTERN.test(record.name)
    || typeof record.version !== 'string' || !record.version
    || typeof record.contentHash !== 'string' || !SHA256_PATTERN.test(record.contentHash)
    || typeof record.installedAt !== 'number' || !Number.isFinite(record.installedAt)
    || !Array.isArray(record.files)
  ) return undefined
  const files = record.files.filter((file): file is InstalledAgentSkill['files'][number] => {
    if (!file || typeof file !== 'object' || Array.isArray(file)) return false
    const item = file as Record<string, unknown>
    return typeof item.path === 'string' && typeof item.sha256 === 'string' && SHA256_PATTERN.test(item.sha256)
      && (item.executable === undefined || typeof item.executable === 'boolean')
  })
  if (files.length !== record.files.length) return undefined
  return {
    catalogId: record.catalogId,
    name: record.name,
    version: record.version,
    contentHash: record.contentHash,
    files,
    installedAt: record.installedAt,
  }
}

/** 安装清单损坏时回到空清单；不会据此认领或删除磁盘上未知目录。 */
function readState(path: string): AgentSkillInstallationState {
  const raw = readJsonFileSafe<unknown>(path)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyState()
  const record = raw as Record<string, unknown>
  if (record.version !== 1 || !Array.isArray(record.installed)) return emptyState()
  const installed = record.installed.map(normalizeInstalled)
  if (!installed.every((item): item is InstalledAgentSkill => item !== undefined)) return emptyState()
  const names = new Set(installed.map((item) => comparisonKey(item.name)))
  const catalogIds = new Set(installed.map((item) => item.catalogId))
  return names.size === installed.length && catalogIds.size === installed.length
    ? { version: 1, installed }
    : emptyState()
}

function sameInstalledContent(root: string, installed: InstalledAgentSkill): boolean {
  const target = join(root, installed.name)
  if (!existsSync(target)) return false
  try {
    const canonicalRoot = realpathSync.native(target)
    for (const file of installed.files) {
      const candidate = realpathSync.native(resolve(canonicalRoot, file.path))
      const pathRelative = relative(canonicalRoot, candidate)
      const metadata = statSync(candidate)
      if (pathRelative.startsWith('..') || isAbsolute(pathRelative) || !metadata.isFile()) return false
      const hash = createHash('sha256').update(readFileSync(candidate)).digest('hex')
      if (hash !== file.sha256 || Boolean(metadata.mode & 0o111) !== Boolean(file.executable)) return false
    }
    return true
  } catch {
    return false
  }
}

export class AgentSkillInstallationService {
  private readonly now: () => number

  constructor(private readonly options: AgentSkillInstallationServiceOptions) {
    this.now = options.now ?? Date.now
  }

  private writeState(state: AgentSkillInstallationState): void {
    const write = this.options.writeState ?? writeJsonFileAtomic
    write(this.options.statePath, state)
  }

  getState(): AgentSkillInstallationState {
    return readState(this.options.statePath)
  }

  getDesiredCatalogIds(): string[] {
    return [...this.options.getDesiredCatalogIds()]
  }

  /**
   * 先持久化期望 catalog ID，再逐项安装/更新并移除不再期望的受管项。
   * 单项失败不会伪造 installed 记录，返回失败供设置页展示并允许下次核对重试。
   */
  reconcile(catalog: InstallableSkillCatalog, requestedIds = this.getDesiredCatalogIds()): AgentSkillReconcileResult {
    const packages = new Map<string, ValidatedPackage>()
    for (const entry of catalog.packages) {
      const validated = validateInstallableSkillPackage(entry)
      if (packages.has(validated.definition.catalogId)) throw new Error('可安装 Skill catalog ID 重复')
      packages.set(validated.definition.catalogId, validated)
    }
    const desired = [...new Set(requestedIds.map((id) => id.trim()).filter(Boolean))]
    if (desired.length !== requestedIds.length || desired.some((id) => !packages.has(id))) {
      throw new Error('期望 Skill 列表包含重复或未知 catalog ID')
    }
    const desiredNames = new Set<string>()
    for (const id of desired) {
      const name = packages.get(id)!.definition.name
      if (desiredNames.has(name)) throw new Error('期望 Skill 列表包含同名安装包')
      desiredNames.add(name)
    }

    this.options.setDesiredCatalogIds(desired)
    mkdirSync(this.options.managedSkillsRoot, { recursive: true })
    mkdirSync(dirname(this.options.statePath), { recursive: true })
    let state = this.getState()
    const failures: AgentSkillReconcileResult['failures'] = []

    for (const id of desired) {
      const skillPackage = packages.get(id)!
      try { state = this.install(skillPackage, state) }
      catch (error) {
        failures.push({ catalogId: id, message: error instanceof Error ? error.message : 'Skill 安装失败' })
      }
    }
    for (const installed of [...state.installed]) {
      if (desired.includes(installed.catalogId)) continue
      try { state = this.uninstall(installed, state) }
      catch (error) {
        failures.push({
          catalogId: installed.catalogId,
          message: error instanceof Error ? error.message : 'Skill 卸载失败',
        })
      }
    }
    return { desiredCatalogIds: desired, installed: state.installed, failures }
  }

  /** 暂存完整文件集合，成功替换目录并写清单后才删除旧版本备份。 */
  private install(skillPackage: ValidatedPackage, state: AgentSkillInstallationState): AgentSkillInstallationState {
    const definition = skillPackage.definition
    const existing = state.installed.find((item) => item.name === definition.name)
    const expectedFiles = skillPackage.files.map((file) => ({
      path: file.path,
      sha256: file.sha256,
      ...(file.executable ? { executable: true } : {}),
    }))
    if (
      existing?.catalogId === definition.catalogId
      && existing.version === definition.version
      && existing.contentHash === definition.contentHash
      && JSON.stringify(existing.files) === JSON.stringify(expectedFiles)
      && sameInstalledContent(this.options.managedSkillsRoot, existing)
    ) return state

    const target = join(this.options.managedSkillsRoot, definition.name)
    if (existsSync(target) && !existing) throw new Error('目标目录已存在但不属于 Axon 安装清单')
    const stagingRoot = join(dirname(this.options.managedSkillsRoot), '.skill-install-staging')
    mkdirSync(stagingRoot, { recursive: true })
    const staging = mkdtempSync(join(stagingRoot, `${definition.name}-`))
    const backup = join(stagingRoot, `${definition.name}-backup-${this.now()}`)
    let oldMoved = false
    let newMoved = false
    let committed = false
    try {
      for (const file of skillPackage.files) {
        const output = join(staging, file.path)
        mkdirSync(dirname(output), { recursive: true })
        writeFileSync(output, file.content, { mode: file.executable ? 0o755 : 0o644 })
        chmodSync(output, file.executable ? 0o755 : 0o644)
      }
      if (existsSync(target)) {
        if (!renameIfDestinationAbsentWithRetry(target, backup)) throw new Error('无法备份现有 Skill')
        oldMoved = true
      }
      if (!renameIfDestinationAbsentWithRetry(staging, target)) throw new Error('无法提交新 Skill')
      newMoved = true

      const installed: InstalledAgentSkill = {
        catalogId: definition.catalogId,
        name: definition.name,
        version: definition.version,
        contentHash: definition.contentHash,
        files: expectedFiles,
        installedAt: this.now(),
      }
      const next = {
        version: 1 as const,
        installed: [...state.installed.filter((item) => (
          item.name !== definition.name && item.catalogId !== definition.catalogId
        )), installed],
      }
      this.writeState(next)
      committed = true
      if (oldMoved) {
        try { rmSyncWithRetry(backup, { recursive: true, force: true }) }
        catch (error) { console.warn('[Skills 安装] 旧版本备份清理失败，已保留:', error) }
      }
      return next
    } catch (error) {
      if (committed) throw error
      try {
        if (newMoved) rmSyncWithRetry(target, { recursive: true, force: true })
        if (oldMoved && !renameIfDestinationAbsentWithRetry(backup, target)) {
          throw new Error('旧版本恢复目标已被占用')
        }
      } catch {
        throw new Error('Skill 安装失败且旧版本恢复未完成，备份已保留')
      }
      throw error
    } finally {
      if (existsSync(staging)) rmSyncWithRetry(staging, { recursive: true, force: true })
    }
  }

  /** 先把受管目录移入备份，清单写成功后再删除；未登记目录永远不会进入这里。 */
  private uninstall(installed: InstalledAgentSkill, state: AgentSkillInstallationState): AgentSkillInstallationState {
    const target = join(this.options.managedSkillsRoot, installed.name)
    const stagingRoot = join(dirname(this.options.managedSkillsRoot), '.skill-install-staging')
    mkdirSync(stagingRoot, { recursive: true })
    const backup = join(stagingRoot, `${installed.name}-remove-${this.now()}`)
    let moved = false
    let committed = false
    try {
      if (existsSync(target)) {
        if (!renameIfDestinationAbsentWithRetry(target, backup)) throw new Error('无法暂存待卸载 Skill')
        moved = true
      }
      const next = {
        version: 1 as const,
        installed: state.installed.filter((item) => item.catalogId !== installed.catalogId),
      }
      this.writeState(next)
      committed = true
      if (moved) {
        try { rmSyncWithRetry(backup, { recursive: true, force: true }) }
        catch (error) { console.warn('[Skills 安装] 已卸载目录备份清理失败，已保留:', error) }
      }
      return next
    } catch (error) {
      if (committed) throw error
      if (moved) renameIfDestinationAbsentWithRetry(backup, target)
      throw error
    }
  }
}
