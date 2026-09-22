/** 统一读取已发现 Skill 的宿主工具；不把任意文件读取能力扩散到 runtime adapter。 */

import { realpathSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import type {
  AgentCustomToolDefinition,
  AgentSkillActivation,
  AgentSkillSource,
} from '@axon/shared'
import type { AgentSkillCatalog } from './project-skill-discovery'

export const AGENT_SKILL_READ_TOOL_NAME = 'SkillRead'
const SKILL_ENTRY_FILE = 'SKILL.md'
const MAX_SKILL_RESOURCE_BYTES = 256 * 1024

export interface AgentSkillReadScope {
  tool: AgentCustomToolDefinition
  getActivations: () => AgentSkillActivation[]
}

function failed(message: string): Awaited<ReturnType<AgentCustomToolDefinition['execute']>> {
  return { content: message, isError: true }
}

function isWithinRoot(root: string, candidate: string): boolean {
  const pathRelative = relative(root, candidate)
  return pathRelative === '' || (!pathRelative.startsWith('..') && !isAbsolute(pathRelative))
}

function requestedPath(input: Record<string, unknown>): string | undefined {
  if (input.relative_path === undefined) return SKILL_ENTRY_FILE
  if (typeof input.relative_path !== 'string') return undefined
  const normalized = input.relative_path.trim().replaceAll('\\', '/')
  if (!normalized || normalized.includes('\0') || isAbsolute(normalized)) return undefined
  const segments = normalized.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return undefined
  return normalized
}

/**
 * 为单轮运行创建 SkillRead 与激活记录。目录发现只提供候选，本函数在真正读取时
 * 再校验真实路径和文件大小，防止发现后文件被替换或符号链接逃逸。
 */
export function createAgentSkillReadScope(catalog: AgentSkillCatalog): AgentSkillReadScope {
  const skills = new Map(catalog.skills.map((skill) => [skill.name, skill]))
  const activations = new Map<string, AgentSkillActivation>()

  const tool: AgentCustomToolDefinition = {
    name: AGENT_SKILL_READ_TOOL_NAME,
    description: '按名称读取一个可用 Skill 的 SKILL.md 或其目录内引用文件。任务匹配 Skill 描述时先读取 SKILL.md。',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: '可用 Skill 目录中列出的名称',
        },
        relative_path: {
          type: 'string',
          description: 'Skill 目录内的相对文件路径，默认 SKILL.md',
          default: SKILL_ENTRY_FILE,
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
    isDeferred: false,
    async execute(input, options) {
      if (options.signal?.aborted) return failed('SkillRead 已取消')
      const name = typeof input.name === 'string' ? input.name.trim() : ''
      const skill = skills.get(name)
      if (!skill) return failed('未找到指定 Skill')
      const relativePath = requestedPath(input)
      if (!relativePath) return failed('relative_path 必须是 Skill 目录内的安全相对路径')

      try {
        const skillRoot = realpathSync.native(skill.directoryPath)
        const target = realpathSync.native(resolve(skillRoot, relativePath))
        if (!isWithinRoot(skillRoot, target)) return failed('Skill 文件超出允许目录')
        const metadata = statSync(target)
        if (!metadata.isFile()) return failed('Skill 资源不是普通文件')
        if (metadata.size > MAX_SKILL_RESOURCE_BYTES) return failed('Skill 资源超过 256 KB')
        const content = readFileSync(target, 'utf8')
        if (content.includes('\0')) return failed('Skill 资源不是可读取的文本文件')
        if (options.signal?.aborted) return failed('SkillRead 已取消')

        if (relativePath === SKILL_ENTRY_FILE && !activations.has(skill.name)) {
          activations.set(skill.name, activationFrom(skill))
        }
        return {
          content: `<skill-resource name="${skill.name}" path="${relativePath}">\n${content}\n</skill-resource>`,
        }
      } catch {
        return failed('无法读取指定 Skill 资源')
      }
    },
  }

  return {
    tool,
    getActivations: () => [...activations.values()],
  }
}

function activationFrom(skill: AgentSkillSource): AgentSkillActivation {
  return {
    name: skill.name,
    directoryKind: skill.directoryKind,
    relativeInstructionPath: skill.relativeInstructionPath,
    sources: ['skill_read'],
  }
}
