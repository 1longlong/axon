import type { AgentSkillActivation, SDKMessage } from '@axon/shared'

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const ACTIVATION_SOURCES = ['skill_read', 'explicit'] as const

function expectedInstructionPath(directoryKind: AgentSkillActivation['directoryKind'], name: string): string {
  if (directoryKind === 'axon') return `.axon/skills/${name}/SKILL.md`
  if (directoryKind === 'agents') return `.agents/skills/${name}/SKILL.md`
  if (directoryKind === 'builtin') return `$HOME/.axon/skills/${name}/SKILL.md`
  return `$HOME/.agents/skills/${name}/SKILL.md`
}

function normalizeActivation(value: unknown): AgentSkillActivation | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const name = typeof record.name === 'string' ? record.name.trim() : ''
  const directoryKind = record.directoryKind
  if (
    !SKILL_NAME_PATTERN.test(name)
    || !['axon', 'agents', 'builtin', 'user'].includes(String(directoryKind))
  ) {
    return undefined
  }
  const expectedPath = expectedInstructionPath(directoryKind as AgentSkillActivation['directoryKind'], name)
  const rawSources = record.sources
  if (record.relativeInstructionPath !== expectedPath || !Array.isArray(rawSources)) {
    return undefined
  }
  const sources = ACTIVATION_SOURCES.filter((source) => rawSources.includes(source))
  if (sources.length === 0) return undefined
  return {
    name,
    directoryKind: directoryKind as AgentSkillActivation['directoryKind'],
    relativeInstructionPath: expectedPath,
    sources,
  }
}

/** 从单轮 result 读取可信 Skill 激活，隔离损坏或手工篡改的 JSONL 字段。 */
export function getResultSkillActivations(message: SDKMessage): AgentSkillActivation[] {
  if (message.type !== 'result') return []
  const values = (message as { skill_activations?: unknown }).skill_activations
  if (!Array.isArray(values)) return []
  const activations = new Map<string, AgentSkillActivation>()
  for (const value of values) {
    const activation = normalizeActivation(value)
    if (activation && !activations.has(activation.name)) activations.set(activation.name, activation)
  }
  return [...activations.values()]
}
