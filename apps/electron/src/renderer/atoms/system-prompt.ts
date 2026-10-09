import { atom } from 'jotai'
import type { SystemPromptTemplate } from '@axon/shared'

export const agentSystemPromptAtom = atom<string>('')
export const agentSystemPromptTemplatesAtom = atom<SystemPromptTemplate[]>([])

/** 持久化 Agent 系统提示词，空白内容统一清空。 */
export async function updateAgentSystemPrompt(prompt: string): Promise<void> {
  await window.axon.settings.update({ agentSystemPrompt: prompt.trim() })
}

/** 持久化 Agent 用户模板；内置模板不写入 settings.json。 */
export async function updateAgentSystemPromptTemplates(templates: SystemPromptTemplate[]): Promise<void> {
  await window.axon.settings.update({ agentSystemPromptTemplates: templates })
}
