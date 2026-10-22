/** 输入框只展示后端模型目录结论；确认严格绑定渠道/模型，切换后失效。 */
import * as React from 'react'
import type { AgentImageCapability, AgentSendInput } from '@axon/shared'

export function useAgentImageCapability(sessionId: string, channelId: string | undefined, modelId: string | undefined, hasImages: boolean) {
  const key = `${sessionId}\0${channelId ?? ''}\0${modelId ?? ''}`
  const [result, setResult] = React.useState<{ key: string; capability?: AgentImageCapability; failed?: boolean }>()
  const [confirmedKey, setConfirmedKey] = React.useState<string>()
  const [revision, retry] = React.useReducer((value: number) => value + 1, 0)
  React.useEffect(() => { setConfirmedKey(undefined) }, [key, hasImages])
  React.useEffect(() => {
    if (!hasImages || !channelId || !modelId) return
    let active = true
    setResult(undefined)
    void window.axon.agent.attachmentCommand({ action: 'getImageCapability', sessionId }).then((value) => {
      if (!value || typeof value !== 'object' || !('support' in value)) throw new Error('图片能力响应无效')
      if (active) setResult({ key, capability: value })
    }).catch(() => { if (active) setResult({ key, failed: true }) })
    return () => { active = false }
  }, [key, hasImages, revision])
  const current = result?.key === key ? result : undefined
  const capability = current?.capability
  const confirmed = confirmedKey === key
  const consent: AgentSendInput['imageModelConsent'] = hasImages && capability?.support === 'unknown' && confirmed && channelId && modelId
    ? { channelId, modelId } : undefined
  return {
    capability, confirmed, consent, failed: current?.failed === true,
    loading: hasImages && !current,
    canSend: !hasImages || Boolean(capability && capability.support !== 'unsupported' && (capability.support !== 'unknown' || confirmed)),
    setConfirmed: (value: boolean): void => setConfirmedKey(value ? key : undefined),
    retry,
  }
}
