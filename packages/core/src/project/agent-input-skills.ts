/** 用户主动选择 Skill：来源签发、派发复核及正文直接加载，不伪造工具调用。 */
import { createHmac, randomBytes } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import type { AgentPreparedAttachmentInput, AgentSessionMeta, AgentSkillAttachment, AgentSkillChoice, AgentSkillSource } from '@axon/shared'
import type { AgentSkillCatalog } from './project-skill-discovery'
import { escapeSkillMarkup, readAgentSkillResource, skillActivationFrom } from './agent-skill-resource'

const MAX_EXPLICIT_SKILL_CHARS = 80_000

export class AgentInputSkills {
  private readonly key = randomBytes(32)
  constructor(private readonly discover: (session: AgentSessionMeta) => AgentSkillCatalog) {}

  /** 只列出合并后允许用户调用的确切来源；禁自动匹配不等同禁用户选择。 */
  list(session: AgentSessionMeta): AgentSkillChoice[] {
    const catalog = this.discover(session)
    return catalog.skills.filter((skill) => skill.userInvocable !== false).map((skill) => ({
      sourceId: this.sourceId(session, skill, catalog.projectRoot), name: skill.name, description: skill.description,
      directoryKind: skill.directoryKind, relativeInstructionPath: skill.relativeInstructionPath,
      ...(skill.argumentHint ? { argumentHint: skill.argumentHint } : {}),
    }))
  }

  /** 加入草稿时只确认来源，不提前加载正文到模型；发送及排队派发仍重新复核。 */
  resolve(session: AgentSessionMeta, sourceId: string): AgentSkillSource {
    const catalog = this.discover(session)
    const skill = catalog.skills.find((skill) => skill.userInvocable !== false && this.sourceId(session, skill, catalog.projectRoot) === sourceId)
    if (!skill) throw new Error('所选 Skill 已变化、失效或被覆盖，请重新选择')
    return skill
  }

  /** 一次准备全部所选正文；任何失败或总预算超限都拒绝本轮，不静默截断指引。 */
  prepare(session: AgentSessionMeta, attachments: readonly AgentSkillAttachment[]): Pick<AgentPreparedAttachmentInput, 'context' | 'skillActivations' | 'explicitSkillSources'> {
    const catalog = this.discover(session)
    const available = new Map(catalog.skills.filter((skill) => skill.userInvocable !== false).map((skill) => [this.sourceId(session, skill, catalog.projectRoot), skill]))
    const selected = new Map<string, AgentSkillSource>(), blocks: string[] = []
    let length = 0
    for (const attachment of attachments) {
      const skill = available.get(attachment.sourceId)
      if (!skill || skill.name !== attachment.name) throw new Error('所选 Skill 已变化、失效或被覆盖，请重新选择')
      const canonical = realpathSync.native(skill.instructionPath)
      if (selected.has(canonical)) continue
      const { content } = readAgentSkillResource(skill)
      const block = `<skill>\n<name>${escapeSkillMarkup(skill.name)}</name>\n<path>${escapeSkillMarkup(canonical)}</path>\n${content}\n</skill>`
      length += block.length
      if (length > MAX_EXPLICIT_SKILL_CHARS) throw new Error('所选 Skill 正文合计超过 80,000 字符，请减少选择')
      selected.set(canonical, skill)
      blocks.push(block)
    }
    return { context: blocks.length ? ['[用户明确选择的 Skills；正文已加载，无须再次读取入口文件]', ...blocks].join('\n\n') : '',
      skillActivations: [...selected.values()].map((skill) => skillActivationFrom(skill, 'explicit')),
      explicitSkillSources: [...selected.values()],
    }
  }

  /** 来源 ID 绑定会话、工作目录、正文版本和目录/文件身份，不仅凭同名匹配。 */
  private sourceId(session: AgentSessionMeta, skill: AgentSkillSource, projectRoot: string): string {
    const directory = lstatSync(skill.directoryPath), file = lstatSync(skill.instructionPath)
    return createHmac('sha256', this.key).update(JSON.stringify([
      session.id, session.projectId, projectRoot, skill.name, skill.directoryKind, skill.directoryPath,
      skill.instructionPath, skill.contentHash, directory.dev, directory.ino, file.dev, file.ino,
    ])).digest('hex')
  }
}
