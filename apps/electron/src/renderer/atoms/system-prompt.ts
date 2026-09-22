import { atom } from 'jotai'
import type { SystemPromptTemplate } from '@/types/settings'

export const agentSystemPromptAtom = atom<string>('')
export const agentSystemPromptTemplatesAtom = atom<SystemPromptTemplate[]>([])

/** 从应用设置恢复 Agent 系统提示词和用户模板；失败时保持空白默认值。 */
export async function initializeAgentSystemPrompt(
  setPrompt: (prompt: string) => void,
  setTemplates: (templates: SystemPromptTemplate[]) => void,
): Promise<void> {
  try {
    const settings = await window.axon.settings.get()
    setPrompt(settings.agentSystemPrompt ?? '')
    setTemplates(settings.agentSystemPromptTemplates)
  } catch {
    setPrompt('')
    setTemplates([])
  }
}

/** 持久化 Agent 系统提示词，空白内容统一清空。 */
export async function updateAgentSystemPrompt(prompt: string): Promise<void> {
  await window.axon.settings.update({ agentSystemPrompt: prompt.trim() })
}

/** 持久化 Agent 用户模板；内置模板不写入 settings.json。 */
export async function updateAgentSystemPromptTemplates(templates: SystemPromptTemplate[]): Promise<void> {
  await window.axon.settings.update({ agentSystemPromptTemplates: templates })
}
