/** 统一读取已发现 Skill 的宿主工具；不把任意文件读取能力扩散到 runtime adapter。 */

import { isAbsolute } from 'node:path'
import type {
  AgentCustomToolDefinition,
  AgentSkillActivation,
} from '@axon/shared'
import type { AgentSkillCatalog } from './project-skill-discovery'
import { escapeSkillMarkup, readAgentSkillResource, skillActivationFrom } from './agent-skill-resource'

export const AGENT_SKILL_READ_TOOL_NAME = 'SkillRead'
const SKILL_ENTRY_FILE = 'SKILL.md'

export interface AgentSkillReadScope {
  tool: AgentCustomToolDefinition
  getActivations: () => AgentSkillActivation[]
}

function failed(message: string): Awaited<ReturnType<AgentCustomToolDefinition['execute']>> {
  return { content: message, isError: true }
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
export function createAgentSkillReadScope(catalog: AgentSkillCatalog, explicit: readonly AgentSkillActivation[] = []): AgentSkillReadScope {
  // 自动匹配开关只控制目录展示；历史中已明确选择的 Skill 仍可按名称读取引用资料。
  const skills = new Map(catalog.skills.map((skill) => [skill.name, skill]))
  const activations = new Map<string, AgentSkillActivation>(explicit.map((skill) => [skill.name, { ...skill, sources: [...skill.sources] }]))

  const tool: AgentCustomToolDefinition = {
    name: AGENT_SKILL_READ_TOOL_NAME,
    permissionMode: 'managed',
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
        const { content } = readAgentSkillResource(skill, relativePath)
        if (options.signal?.aborted) return failed('SkillRead 已取消')

        if (relativePath === SKILL_ENTRY_FILE) {
          const previous = activations.get(skill.name)
          activations.set(skill.name, { ...skillActivationFrom(skill, 'skill_read'), sources: [...new Set([...(previous?.sources ?? []), 'skill_read' as const])] })
        }
        return {
          content: `<skill-resource name="${escapeSkillMarkup(skill.name)}" path="${escapeSkillMarkup(relativePath)}">\n${content}\n</skill-resource>`,
        }
      } catch (error) {
        return failed(error instanceof Error ? `无法读取指定 Skill 资源：${error.message.startsWith('Skill') ? error.message : '文件不存在或超出允许目录'}` : '无法读取指定 Skill 资源')
      }
    },
  }

  return {
    tool,
    getActivations: () => [...activations.values()],
  }
}
