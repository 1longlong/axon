/** 在已授权项目根内发现并校验可渐进加载的 SKILL.md。 */

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { parseDocument } from 'yaml'
import type { AgentSkillSource } from '@axon/shared'
import { canonicalizeProjectPath } from './project-instruction-resolver'

const SKILL_FILE_NAME = 'SKILL.md'
const MAX_SKILL_FILE_BYTES = 256 * 1024
const MAX_SKILLS_PER_ROOT = 256
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export type AgentSkillDirectoryKind = AgentSkillSource['directoryKind']
export type AgentSkillDescriptor = AgentSkillSource

export type AgentSkillDiagnosticCode =
  | 'outside_project'
  | 'scan_failed'
  | 'too_many_skills'
  | 'invalid_skill_file'
  | 'invalid_frontmatter'
  | 'duplicate_skill'

export interface AgentSkillDiagnostic {
  code: AgentSkillDiagnosticCode
  path: string
  message: string
}

export interface AgentSkillCatalog {
  projectRoot: string
  skills: AgentSkillDescriptor[]
  /** 同名冲突中未生效的完整元数据，仅供设置摘要和诊断，不注入模型。 */
  shadowedSkills: AgentSkillDescriptor[]
  diagnostics: AgentSkillDiagnostic[]
}

export interface DiscoverProjectSkillsOptions {
  projectRoot: string
}

export interface DiscoverAgentSkillsOptions extends DiscoverProjectSkillsOptions {
  /** 测试和受控装配可覆盖固定目录；产品装配使用用户主目录默认值。 */
  builtinSkillsRoot?: string
  userSkillsRoot?: string
}

export interface DiscoverGlobalAgentSkillsOptions {
  builtinSkillsRoot?: string
  userSkillsRoot?: string
}

interface SkillDirectoryCandidate {
  kind: AgentSkillDirectoryKind
  rootPath: string
  /** 项目来源受项目根约束；全局来源默认以其真实 Skill 根为边界。 */
  boundaryPath?: string
  displayRoot: string
}

export interface ParsedSkillFrontmatter {
  name: string
  description: string
  compatibility?: string
  metadata?: Record<string, string>
  allowedTools?: string[]
  disableModelInvocation?: boolean
  userInvocable?: boolean
  argumentHint?: string
}

/** 构造项目级候选；数组顺序就是同名 Skill 的覆盖优先级。 */
function projectSkillDirectories(projectRoot: string): SkillDirectoryCandidate[] {
  return [
    { kind: 'axon', rootPath: join(projectRoot, '.axon', 'skills'), boundaryPath: projectRoot, displayRoot: '.axon/skills' },
    { kind: 'agents', rootPath: join(projectRoot, '.agents', 'skills'), boundaryPath: projectRoot, displayRoot: '.agents/skills' },
  ]
}

function comparisonPath(path: string): string {
  const canonical = canonicalizeProjectPath(path)
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical
}

function isWithinRoot(root: string, candidate: string): boolean {
  const pathRelative = relative(comparisonPath(root), comparisonPath(candidate))
  return pathRelative === '' || (!pathRelative.startsWith('..') && !isAbsolute(pathRelative))
}

function optionalString(value: unknown, field: string, maxLength?: number): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} 必须是非空字符串`)
  }
  const normalized = value.trim()
  if (maxLength !== undefined && normalized.length > maxLength) {
    throw new Error(`${field} 不能超过 ${maxLength} 个字符`)
  }
  return normalized
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new Error(`${field} 必须是布尔值`)
  return value
}

function parseMetadata(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('metadata 必须是字符串键值对象')
  }
  const metadata: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') throw new Error(`metadata.${key} 必须是字符串`)
    metadata[key] = entry
  }
  return metadata
}

function parseAllowedTools(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  const entries = typeof value === 'string'
    ? value.split(/\s+/)
    : Array.isArray(value) && value.every((entry) => typeof entry === 'string')
      ? value
      : undefined
  if (!entries) throw new Error('allowed-tools 必须是空格分隔字符串或字符串数组')
  const normalized = [...new Set(entries.map((entry) => entry.trim()).filter(Boolean))]
  return normalized.length > 0 ? normalized : undefined
}

/** 解析标准 frontmatter；正文不进入目录，真正激活 Skill 时才按路径读取。 */
export function parseSkillFrontmatter(content: string, directoryName: string): ParsedSkillFrontmatter {
  const normalized = content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content
  const match = normalized.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/)
  if (!match) throw new Error('文件必须以 YAML frontmatter 开始')

  const document = parseDocument(match[1] ?? '', {
    schema: 'core',
    uniqueKeys: true,
  })
  if (document.errors.length > 0) throw new Error(document.errors[0]?.message ?? 'YAML 无法解析')
  const value: unknown = document.toJS({ maxAliasCount: 0 })
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('frontmatter 必须是对象')
  }
  const fields = value as Record<string, unknown>
  const name = optionalString(fields.name, 'name', 64)
  const description = optionalString(fields.description, 'description', 1024)
  if (!name) throw new Error('缺少必填字段 name')
  if (!description) throw new Error('缺少必填字段 description')
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new Error('name 只能包含小写字母、数字和单个连字符')
  }
  if (name !== directoryName) throw new Error('name 必须与 Skill 目录名一致')

  return {
    name,
    description,
    compatibility: optionalString(fields.compatibility, 'compatibility', 500),
    metadata: parseMetadata(fields.metadata),
    allowedTools: parseAllowedTools(fields['allowed-tools']),
    disableModelInvocation: optionalBoolean(fields['disable-model-invocation'], 'disable-model-invocation'),
    userInvocable: optionalBoolean(fields['user-invocable'], 'user-invocable'),
    argumentHint: optionalString(fields['argument-hint'], 'argument-hint'),
  }
}

function toPortablePath(path: string): string {
  return path.split(/[\\/]/).join('/')
}

/**
 * 扫描一个 Skill 根目录。每个直接子目录最多贡献一个 SKILL.md，符号链接
 * 最终目标必须仍在该来源边界内，避免目录发现扩大文件读取权限。
 */
function scanSkillRoot(
  candidate: SkillDirectoryCandidate,
  diagnostics: AgentSkillDiagnostic[],
): AgentSkillDescriptor[] {
  const logicalRoot = candidate.rootPath
  if (!existsSync(logicalRoot)) return []

  let canonicalRoot: string
  let boundaryRoot: string
  try {
    canonicalRoot = realpathSync.native(logicalRoot)
    if (!statSync(canonicalRoot).isDirectory()) return []
    boundaryRoot = candidate.boundaryPath
      ? realpathSync.native(candidate.boundaryPath)
      : canonicalRoot
    if (!isWithinRoot(boundaryRoot, canonicalRoot)) {
      diagnostics.push({
        code: 'outside_project',
        path: logicalRoot,
        message: '已忽略指向来源边界外的 Skills 目录',
      })
      return []
    }
  } catch (error) {
    diagnostics.push({
      code: 'scan_failed',
      path: logicalRoot,
      message: `无法读取 Skills 目录：${error instanceof Error ? error.message : '未知错误'}`,
    })
    return []
  }

  let entries: Dirent[]
  try {
    entries = readdirSync(canonicalRoot, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))
  } catch (error) {
    diagnostics.push({
      code: 'scan_failed',
      path: logicalRoot,
      message: `无法扫描 Skills 目录：${error instanceof Error ? error.message : '未知错误'}`,
    })
    return []
  }
  if (entries.length > MAX_SKILLS_PER_ROOT) {
    diagnostics.push({
      code: 'too_many_skills',
      path: logicalRoot,
      message: `仅扫描排序后的前 ${MAX_SKILLS_PER_ROOT} 个目录项`,
    })
  }

  const skills: AgentSkillDescriptor[] = []
  for (const entry of entries.slice(0, MAX_SKILLS_PER_ROOT)) {
    const logicalDirectory = join(logicalRoot, entry.name)
    let canonicalDirectory: string
    try {
      const entryStat = lstatSync(logicalDirectory)
      if (!entryStat.isDirectory() && !entryStat.isSymbolicLink()) continue
      canonicalDirectory = realpathSync.native(logicalDirectory)
      if (!statSync(canonicalDirectory).isDirectory()) continue
      if (!isWithinRoot(boundaryRoot, canonicalDirectory)) {
        diagnostics.push({
          code: 'outside_project',
          path: logicalDirectory,
          message: '已忽略指向来源边界外的 Skill',
        })
        continue
      }
    } catch {
      continue
    }

    const logicalInstructionPath = join(logicalDirectory, SKILL_FILE_NAME)
    if (!existsSync(logicalInstructionPath)) continue
    try {
      const instructionPath = realpathSync.native(logicalInstructionPath)
      const instructionStat = statSync(instructionPath)
      if (!instructionStat.isFile()) throw new Error('SKILL.md 不是普通文件')
      if (!isWithinRoot(boundaryRoot, instructionPath)) throw new Error('SKILL.md 指向来源边界外')
      if (instructionStat.size > MAX_SKILL_FILE_BYTES) throw new Error('SKILL.md 超过 256 KB')

      const content = readFileSync(instructionPath, 'utf8')
      const parsed = parseSkillFrontmatter(content, entry.name)
      skills.push({
        ...parsed,
        directoryKind: candidate.kind,
        directoryPath: canonicalDirectory,
        instructionPath,
        relativeInstructionPath: toPortablePath(join(candidate.displayRoot, entry.name, SKILL_FILE_NAME)),
        contentHash: createHash('sha256').update(content, 'utf8').digest('hex'),
      })
    } catch (error) {
      diagnostics.push({
        code: error instanceof Error && error.message.includes('来源边界外')
          ? 'outside_project'
          : error instanceof Error && (
            error.message.includes('frontmatter') ||
            error.message.includes('字段') ||
            error.message.includes('name') ||
            error.message.includes('metadata') ||
            error.message.includes('allowed-tools') ||
            error.message.includes('YAML')
          )
            ? 'invalid_frontmatter'
            : 'invalid_skill_file',
        path: logicalInstructionPath,
        message: `已忽略无效 Skill：${error instanceof Error ? error.message : '未知错误'}`,
      })
    }
  }
  return skills
}

function resolveProjectRoot(requestedRoot: string): string {
  const resolved = resolve(requestedRoot)
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error('项目根目录不存在或不是文件夹')
  }
  return realpathSync.native(resolved)
}

/** 按候选顺序合并目录，同名时只保留最高优先级来源。 */
function discoverFromDirectories(
  projectRoot: string,
  candidates: readonly SkillDirectoryCandidate[],
): AgentSkillCatalog {
  const diagnostics: AgentSkillDiagnostic[] = []
  const selected = new Map<string, AgentSkillDescriptor>()
  const shadowedSkills: AgentSkillDescriptor[] = []
  for (const candidate of candidates) {
    for (const skill of scanSkillRoot(candidate, diagnostics)) {
      const existing = selected.get(skill.name)
      if (existing) {
        shadowedSkills.push(skill)
        diagnostics.push({
          code: 'duplicate_skill',
          path: skill.instructionPath,
          message: `同名 Skill 已由 ${existing.relativeInstructionPath} 提供，当前来源已忽略`,
        })
        continue
      }
      selected.set(skill.name, skill)
    }
  }
  return {
    projectRoot,
    skills: [...selected.values()].sort((left, right) => left.name.localeCompare(right.name)),
    shadowedSkills: shadowedSkills.sort((left, right) => left.name.localeCompare(right.name)),
    diagnostics,
  }
}

/**
 * 汇总项目内 `.axon/skills` 与 `.agents/skills`。先扫描的来源胜出同名冲突，
 * 返回稳定排序的轻量目录，供后续提示词目录和 Skills UI 共用。
 */
export function discoverProjectSkills(options: DiscoverProjectSkillsOptions): AgentSkillCatalog {
  const projectRoot = resolveProjectRoot(options.projectRoot)
  return discoverFromDirectories(projectRoot, projectSkillDirectories(projectRoot))
}

/**
 * 汇总项目、Axon 管理和用户全局四类来源。候选顺序固定为
 * 项目 `.axon` → 项目 `.agents` → `$HOME/.axon` → `$HOME/.agents`。
 */
export function discoverAgentSkills(options: DiscoverAgentSkillsOptions): AgentSkillCatalog {
  const projectRoot = resolveProjectRoot(options.projectRoot)
  const builtinRoot = resolve(options.builtinSkillsRoot ?? join(homedir(), '.axon', 'skills'))
  const userRoot = resolve(options.userSkillsRoot ?? join(homedir(), '.agents', 'skills'))
  return discoverFromDirectories(projectRoot, [
    ...projectSkillDirectories(projectRoot),
    { kind: 'builtin', rootPath: builtinRoot, displayRoot: '$HOME/.axon/skills' },
    { kind: 'user', rootPath: userRoot, displayRoot: '$HOME/.agents/skills' },
  ])
}

/** 设置页只检查两个全局来源，不需要虚构项目目录或读取任意工作区。 */
export function discoverGlobalAgentSkills(options: DiscoverGlobalAgentSkillsOptions = {}): AgentSkillCatalog {
  const builtinRoot = resolve(options.builtinSkillsRoot ?? join(homedir(), '.axon', 'skills'))
  const userRoot = resolve(options.userSkillsRoot ?? join(homedir(), '.agents', 'skills'))
  return discoverFromDirectories('', [
    { kind: 'builtin', rootPath: builtinRoot, displayRoot: '$HOME/.axon/skills' },
    { kind: 'user', rootPath: userRoot, displayRoot: '$HOME/.agents/skills' },
  ])
}

function escapePromptXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/** 把可由模型激活的轻量目录追加到 system prompt；不在这里读取 Skill 正文。 */
export function buildAgentSkillSystemPrompt(
  basePrompt: string,
  catalog: AgentSkillCatalog,
): string {
  const available = catalog.skills.filter((skill) => skill.disableModelInvocation !== true)
  if (available.length === 0) return basePrompt.trim()
  const entries = available.map((skill) => [
    `<skill name="${escapePromptXml(skill.name)}" source="${skill.directoryKind}" path="${escapePromptXml(skill.relativeInstructionPath)}">`,
    `<description>${escapePromptXml(skill.description)}</description>`,
    '</skill>',
  ].join('\n')).join('\n')
  const section = [
    '## 可用 Skills',
    '以下仅是 Skill 轻量目录。仅当任务明确符合 description 时，先调用 SkillRead 并传入 name 读取完整 SKILL.md，再遵循正文；未读取正文不得声称已使用该 Skill。需要读取 Skill 引用文件时，再向 SkillRead 传入 relative_path。Skill 中声明的工具不会绕过现有权限。',
    '<available_skills>',
    entries,
    '</available_skills>',
  ].join('\n')
  return [basePrompt.trim(), section].filter(Boolean).join('\n\n')
}
