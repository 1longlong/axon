import * as React from 'react'
import { useAtomValue } from 'jotai'
import { chatStateAtom } from '@/atoms/chat-state'
import { getDefaultChatModel } from '@/lib/chat-model-options'
import type { AgentRuntimeId } from '@axon/shared'
import { useAgentController } from './AgentStateProvider'

/** 创建真实 Agent 会话；主进程持久化成功后才进入当前视图，避免占位 ID 进入历史。 */
export function useCreateAgentSession(): {
  createAgentSession: (projectId: string, runtimeId?: AgentRuntimeId) => Promise<{ id: string; title: string } | null>
  creating: boolean
  createError: string | null
} {
  const controller = useAgentController()
  const channels = useAtomValue(chatStateAtom).channels
  const [creating, setCreating] = React.useState(false)
  const [createError, setCreateError] = React.useState<string | null>(null)
  const createAgentSession = React.useCallback(async (projectId: string, runtimeId: AgentRuntimeId = 'pi') => {
    if (creating) return null
    setCreating(true)
    setCreateError(null)
    try {
      const eligibleChannels = runtimeId === 'zima'
        ? channels.filter((channel) => channel.hasApiKey && ['openai', 'custom', 'anthropic', 'anthropic-compatible', 'google'].includes(channel.provider))
        : channels
      const selection = getDefaultChatModel(eligibleChannels)
      if (runtimeId === 'zima' && (!selection.channelId || !selection.modelId)) {
        setCreateError('Zima 需要已启用且配置 API Key 的兼容渠道和模型')
        return null
      }
      // 沿用 Chat 的渠道选择规则；会话归属由左侧项目节点显式传入。
      const session = await controller.createSession({
        ...selection,
        projectId,
        runtimeId,
      })
      return { id: session.id, title: session.title }
    } catch (error) {
      setCreateError(runtimeId === 'zima'
        ? `新建 Zima 会话失败：${error instanceof Error ? error.message : '请检查 Python 和渠道配置'}`
        : '新建 Agent 会话失败')
      return null
    } finally {
      setCreating(false)
    }
  }, [channels, controller, creating])
  return { createAgentSession, creating, createError }
}
