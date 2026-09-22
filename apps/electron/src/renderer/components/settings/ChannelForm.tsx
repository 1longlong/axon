/** 渠道基本信息表单：显式保存，密钥不回显。 */
import * as React from 'react'
import { useSetAtom } from 'jotai'
import { ArrowLeft, Download, Loader2 } from 'lucide-react'
import { MAX_CHANNEL_NAME_LENGTH, CHANNEL_NETWORK_ERRORS, PROVIDER_DEFAULT_URLS, PROVIDER_LABELS, PROVIDER_TYPES, isProviderType, resolveChannelModelsUrl } from '@axon/shared'
import type { Channel, ChannelNetworkResult } from '@axon/shared'
import { settingsEditingAtom } from '@/atoms/settings-tab'
import { buildChannelCreateInput, buildChannelUpdateInput, canLeaveSettings, createChannelDraft, hasPendingChannelModel, mergeFetchedChannelModels } from '@/lib/channel-form'
import { ChannelModelsEditor } from './ChannelModelsEditor'

interface ChannelFormProps {
  channel: Channel | null
  onSaved: (channel: Channel) => void
  onCancel: () => void
}

const INPUT_CLASS = 'mt-2 h-10 w-full rounded-lg border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring/30'

export function ChannelForm({ channel, onSaved, onCancel }: ChannelFormProps): React.ReactElement {
  const [initial] = React.useState(() => createChannelDraft(channel))
  const [draft, setDraft] = React.useState(initial)
  const [saving, setSaving] = React.useState(false)
  const [requesting, setRequesting] = React.useState(false)
  const [networkResult, setNetworkResult] = React.useState<ChannelNetworkResult | null>(null)
  const requestIdRef = React.useRef<string | null>(null)
  const cancelledRef = React.useRef<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const inFlight = React.useRef(false)
  const setEditing = useSetAtom(settingsEditingAtom)
  const dirty = JSON.stringify(initial) !== JSON.stringify(draft)
  const busy = saving || requesting
  let endpoint = ''
  try { endpoint = resolveChannelModelsUrl(draft.provider, draft.baseUrl) } catch { /* 无效地址由输入提示处理。 */ }

  React.useEffect(() => {
    setEditing({ dirty, busy })
  }, [dirty, busy, setEditing])
  React.useEffect(() => () => {
    const id = requestIdRef.current
    requestIdRef.current = null
    if (id) void window.axon.channels.cancel(id).catch(() => {})
    setEditing({ dirty: false, busy: false })
  }, [setEditing])
  React.useEffect(() => setNetworkResult(null), [draft.provider, draft.baseUrl, draft.apiKey])

  const handleNetwork = async (operation: 'test' | 'models'): Promise<void> => {
    if (inFlight.current || !endpoint) return
    inFlight.current = true
    const requestId = crypto.randomUUID()
    requestIdRef.current = requestId
    cancelledRef.current = null
    setRequesting(true)
    setNetworkResult(null)
    setError(null)
    try {
      const result = await window.axon.channels.request({
        requestId, operation, provider: draft.provider, baseUrl: draft.baseUrl,
        ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
        ...(channel ? { channelId: channel.id } : {}),
      })
      if (requestIdRef.current !== requestId) return
      if (cancelledRef.current === requestId) {
        setNetworkResult({ success: false, code: 'cancelled', message: CHANNEL_NETWORK_ERRORS.cancelled })
        return
      }
      if (result.success && operation === 'models') {
        try {
          const models = mergeFetchedChannelModels(draft.models, result.models)
          setDraft((current) => ({ ...current, models }))
        } catch {
          setError('合并后超过 500 个模型，原有模型未改变；请先移除不需要的模型。')
          return
        }
      }
      setNetworkResult(result)
    } catch {
      if (requestIdRef.current === requestId) setError('渠道请求失败，请重试。')
    } finally {
      if (requestIdRef.current === requestId) {
        requestIdRef.current = null
        inFlight.current = false
        setRequesting(false)
      }
    }
  }

  const cancelNetwork = (): void => {
    const id = requestIdRef.current
    if (!id) return
    cancelledRef.current = id
    void window.axon.channels.cancel(id).catch(() => setError('取消请求失败，请等待请求超时。'))
  }

  const handleCancel = (): void => {
    if (canLeaveSettings({ dirty, busy: inFlight.current }, () => window.confirm('放弃未保存的渠道更改？'))) onCancel()
  }

  const handleSave = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (inFlight.current || hasPendingChannelModel(draft.pendingModel)) return
    inFlight.current = true
    setSaving(true)
    setError(null)
    try {
      const saved = channel
        ? await window.axon.channels.update(channel.id, buildChannelUpdateInput(draft, initial))
        : await window.axon.channels.create(buildChannelCreateInput(draft))
      setDraft((current) => ({ ...current, apiKey: '' }))
      setEditing({ dirty: false, busy: false })
      onSaved(saved)
    } catch {
      // 不展示 IPC 原始错误，避免底层异常携带凭据。
      setError('保存失败，请检查渠道名称、HTTP(S) 地址及模型配置后重试；若仍失败，请检查本地配置目录权限。')
    } finally {
      inFlight.current = false
      setSaving(false)
    }
  }

  return (
    <form className="space-y-6" onSubmit={(event) => void handleSave(event)}>
      <div className="flex items-center gap-3">
        <button type="button" aria-label="返回渠道列表" disabled={busy} onClick={handleCancel} className="h-8 w-8 rounded-md hover:bg-muted disabled:opacity-40"><ArrowLeft size={18} /></button>
        <h3 className="flex-1 text-lg font-medium">{channel ? '编辑模型配置' : '添加模型配置'}</h3>
        <button type="submit" disabled={busy || hasPendingChannelModel(draft.pendingModel) || !draft.name.trim() || (!!channel && !dirty)} className="flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-sm text-primary-foreground disabled:opacity-40">
          {saving && <Loader2 size={14} className="animate-spin" />}{saving ? '保存中…' : channel ? '保存' : '创建'}
        </button>
      </div>
      <fieldset disabled={busy} className="space-y-4 rounded-xl border bg-card p-5">
        <legend className="px-1 text-sm font-medium">基本信息</legend>
        <label className="block text-sm font-medium">供应商类型
          <select className={INPUT_CLASS} value={draft.provider} onChange={(event) => {
            const provider = event.target.value
            if (isProviderType(provider)) setDraft((current) => ({ ...current, provider, baseUrl: PROVIDER_DEFAULT_URLS[provider] }))
          }}>
            {PROVIDER_TYPES.map((provider) => <option key={provider} value={provider}>{PROVIDER_LABELS[provider]}</option>)}
          </select>
        </label>
        <label className="block text-sm font-medium">供应商名称
          <input className={INPUT_CLASS} required maxLength={MAX_CHANNEL_NAME_LENGTH} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="例如：我的模型渠道" />
        </label>
        <label className="block text-sm font-medium">Base URL
          <input className={INPUT_CLASS} type="url" required value={draft.baseUrl} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} placeholder="https://…" />
        </label>
        <label className="block text-sm font-medium">API Key
          <input className={INPUT_CLASS} type="password" autoComplete="new-password" spellCheck={false} value={draft.apiKey} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} placeholder={channel?.hasApiKey ? '已配置；留空保留原密钥' : '输入 API Key（无鉴权服务可留空）'} />
        </label>
        <p className="text-xs text-muted-foreground">密钥在保存、测试或获取模型时交给主进程，不从存储中回显。测试时留空会使用已保存密钥；更改供应商或地址不会清除原密钥，请核对目标是否匹配。</p>
      </fieldset>
      <div className="space-y-3">
        <p className="break-all text-xs text-muted-foreground">目录地址：{endpoint || '请填写不含鉴权查询参数的有效 HTTP(S) 地址'}</p>
        <div className="flex items-center gap-2">
          <button type="button" disabled={busy || !endpoint} onClick={() => void handleNetwork('test')} className="h-8 rounded-md border px-3 text-xs disabled:opacity-40">测试目录连接</button>
          <button type="button" disabled={busy || !endpoint || hasPendingChannelModel(draft.pendingModel)} onClick={() => void handleNetwork('models')} className="flex h-8 items-center gap-2 rounded-md border px-3 text-xs disabled:opacity-40"><Download size={12} />从供应商获取</button>
          {requesting && <><Loader2 size={14} className="animate-spin" /><button type="button" onClick={cancelNetwork} className="text-xs underline">取消请求</button></>}
        </div>
        {networkResult && <p role="status" className={`text-xs ${networkResult.success ? 'text-muted-foreground' : 'text-destructive'}`}>{networkResult.message}{networkResult.success && `（${networkResult.elapsedMs} ms）`}</p>}
      </div>
      <ChannelModelsEditor models={draft.models} pending={draft.pendingModel} disabled={busy}
        onChange={(models, pendingModel) => setDraft((current) => ({ ...current, models, pendingModel }))} />
      <p className="text-xs text-muted-foreground">目录测试只检查目录接口，不发送对话、不验证生成能力。获取后保留已有配置，新模型默认未启用；请启用所需模型并保存。第三方或 HTTP 目标每次请求前需要确认。</p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </form>
  )
}
