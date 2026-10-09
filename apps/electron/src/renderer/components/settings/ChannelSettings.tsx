/** 渠道列表：添加、编辑、删除与启停。 */
import * as React from 'react'
import { useSetAtom } from 'jotai'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { PROVIDER_LABELS } from '@axon/shared'
import type { Channel } from '@axon/shared'
import { settingsEditingAtom } from '@/atoms/settings-tab'
import { ChannelForm } from './ChannelForm'

export function ChannelSettings(): React.ReactElement {
  const [channels, setChannels] = React.useState<Channel[]>([])
  const [viewMode, setViewMode] = React.useState<'list' | 'create' | 'edit'>('list')
  const [editingChannel, setEditingChannel] = React.useState<Channel | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const inFlight = React.useRef(false)
  const loadVersion = React.useRef(0)
  const setEditing = useSetAtom(settingsEditingAtom)

  /** 读取安全渠道快照；保存通知或新读取已发生时，丢弃旧响应。 */
  const loadChannels = React.useCallback(async (): Promise<void> => {
    const version = ++loadVersion.current
    setLoading(true)
    setError(null)
    try {
      const snapshot = await window.axon.channels.list()
      if (version === loadVersion.current) setChannels(snapshot)
    } catch { if (version === loadVersion.current) setError('加载渠道失败，请重试。') }
    finally { if (version === loadVersion.current) setLoading(false) }
  }, [])

  React.useEffect(() => {
    // 先订阅已保存快照再读取；迟到列表/CRUD 响应不能覆盖跨入口的新状态。
    const unsubscribe = window.axon.channels.onChanged((snapshot) => {
      loadVersion.current += 1
      setChannels(snapshot); setLoading(false); setError(null)
    })
    void loadChannels()
    return () => { loadVersion.current += 1; unsubscribe() }
  }, [loadChannels])
  React.useEffect(() => () => setEditing({ dirty: false, busy: false }), [setEditing])

  /** 提交单项修改；服务端通知优先，未收到通知时沿用操作响应更新列表。 */
  const mutate = async (channel: Channel, action: 'delete' | 'toggle'): Promise<void> => {
    if (inFlight.current) return
    if (action === 'delete' && !window.confirm(`确定删除渠道「${channel.name}」？删除后将无法在列表中使用，请谨慎操作。`)) return
    inFlight.current = true
    const version = ++loadVersion.current
    setBusy(true)
    setEditing({ dirty: false, busy: true })
    setError(null)
    try {
      if (action === 'delete') {
        await window.axon.channels.delete(channel.id)
        if (version === loadVersion.current) setChannels((current) => current.filter((item) => item.id !== channel.id))
      } else {
        const saved = await window.axon.channels.update(channel.id, { enabled: !channel.enabled })
        if (version === loadVersion.current) setChannels((current) => current.map((item) => item.id === saved.id ? saved : item))
      }
    } catch { setError(action === 'delete' ? '删除失败，请重试。' : '更新启用状态失败，请重试。') }
    finally {
      inFlight.current = false
      setBusy(false)
      setEditing({ dirty: false, busy: false })
    }
  }

  if (viewMode !== 'list') return (
    <ChannelForm channel={editingChannel} onCancel={() => setViewMode('list')} onSaved={() => {
      void loadChannels()
      setViewMode('list')
      setEditingChannel(null)
    }} />
  )

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div><h1 className="text-sm font-semibold">模型渠道</h1><p className="mt-1 text-xs leading-5 text-muted-foreground">管理 AI 供应商连接与 API Key。</p></div>
        <button type="button" disabled={loading || busy} onClick={() => { setEditingChannel(null); setViewMode('create') }} className="flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 text-xs text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-40"><Plus size={16} />添加配置</button>
      </div>
      {error && <div role="alert" className="text-xs text-destructive">{error}<button type="button" disabled={loading || busy} className="ml-3 underline" onClick={() => void loadChannels()}>重新加载</button></div>}
      {loading ? <p className="py-8 text-center text-xs text-muted-foreground">加载中…</p> : (
        <div className="divide-y divide-border-subtle overflow-hidden rounded-md border bg-[hsl(var(--input-surface))]">
          {channels.length === 0 ? <p className="py-12 text-center text-xs text-muted-foreground">{error ? '暂时无法读取渠道。' : '还没有配置任何模型，点击上方“添加配置”开始。'}</p> : channels.map((channel) => (
            <div key={channel.id} className="group flex items-center justify-between gap-3 px-3 py-3">
              <div className="min-w-0"><p className="truncate text-[13px] font-medium">{channel.name}</p><p className="mt-1 text-[11px] leading-5 text-muted-foreground">{PROVIDER_LABELS[channel.provider]} · {channel.models.filter((model) => model.enabled).length} 个模型已启用 · {channel.hasApiKey ? '已配置密钥' : '未配置密钥'}</p></div>
              <div className="flex shrink-0 items-center gap-2">
                <button type="button" disabled={busy} aria-label={`编辑 ${channel.name}`} title="编辑" className="rounded-md p-1.5 text-muted-foreground hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-40" onClick={() => { setEditingChannel(channel); setViewMode('edit') }}><Pencil size={14} /></button>
                <button type="button" disabled={busy} aria-label={`删除 ${channel.name}`} title="删除" className="rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-40" onClick={() => void mutate(channel, 'delete')}><Trash2 size={14} /></button>
                <label className="flex items-center gap-1 text-xs"><input type="checkbox" className="accent-primary focus-visible:ring-1 focus-visible:ring-ring" role="switch" aria-label={`启用 ${channel.name}`} disabled={busy} checked={channel.enabled} onChange={() => void mutate(channel, 'toggle')} />启用</label>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
