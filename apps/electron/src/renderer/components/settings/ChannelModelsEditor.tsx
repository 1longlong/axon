/** 模型列表编辑只修改草稿，由渠道表单统一保存。 */
import * as React from 'react'
import { Plus, X } from 'lucide-react'
import { MAX_CHANNEL_MODELS } from '@axon/shared'
import type { ChannelModel } from '@axon/shared'
import { addManualChannelModel, hasPendingChannelModel } from '@/lib/channel-form'
import type { PendingChannelModel } from '@/lib/channel-form'

interface ChannelModelsEditorProps {
  models: ChannelModel[]
  pending: PendingChannelModel
  disabled: boolean
  onChange: (models: ChannelModel[], pending: PendingChannelModel) => void
}

export function ChannelModelsEditor({ models, pending, disabled, onChange }: ChannelModelsEditorProps): React.ReactElement {
  const [error, setError] = React.useState<string | null>(null)
  const handleAdd = (): void => {
    if (disabled) return
    try {
      onChange(addManualChannelModel(models, pending), { id: '', name: '' })
      setError(null)
    } catch (error: unknown) {
      setError(error instanceof Error ? error.message : '添加模型失败')
    }
  }
  const handleEnter = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      if (!event.nativeEvent.isComposing) handleAdd()
    }
  }

  return (
    <fieldset disabled={disabled} className="space-y-3">
      <legend className="text-xs font-medium">可用模型</legend>
      <p className="text-xs text-muted-foreground">
        {models.filter((model) => model.enabled).length} 个已启用 / 共 {models.length} 个（最多 {MAX_CHANNEL_MODELS} 个）。模型 ID 用于实际请求，显示名称可自由修改；留空时使用 ID。
      </p>
      <div className="overflow-hidden rounded-md border bg-[hsl(var(--input-surface))]">
        <div className="max-h-[280px] divide-y divide-border-subtle overflow-y-auto">
          {models.length === 0 && <p className="px-3 py-5 text-center text-xs text-muted-foreground">暂无模型，请按供应商提供的模型 ID 手动添加。</p>}
          {models.map((model) => (
            <div key={model.id} className="group flex items-center gap-2 px-3 py-2">
              <label className="flex shrink-0 items-center gap-1 text-xs">
                <input type="checkbox" className="accent-primary focus-visible:ring-1 focus-visible:ring-ring" role="switch" aria-label={`启用模型 ${model.id}`} checked={model.enabled}
                  onChange={() => onChange(models.map((item) => item.id === model.id ? { ...item, enabled: !item.enabled } : item), pending)} />启用
              </label>
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-[11px] text-muted-foreground" title={model.id}>{model.id}</p>
                <input aria-label={`模型显示名称 ${model.id}`} value={model.name} placeholder={model.id}
                  onChange={(event) => onChange(models.map((item) => item.id === model.id ? { ...item, name: event.target.value } : item), pending)}
                  className="mt-1 h-8 w-full rounded-md border bg-[hsl(var(--input-surface))] px-2 text-[13px] outline-none focus:ring-1 focus:ring-ring" />
              </div>
              <button type="button" aria-label={`删除模型 ${model.id}`} title="删除模型"
                onClick={() => {
                  if (window.confirm(`从此渠道移除模型「${model.id}」？点击保存后生效。`)) onChange(models.filter((item) => item.id !== model.id), pending)
                }} className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2 border-t border-border-subtle px-3 py-2">
          <input aria-label="新模型 ID" value={pending.id} placeholder="模型 ID"
            onChange={(event) => { setError(null); onChange(models, { ...pending, id: event.target.value }) }}
            onKeyDown={handleEnter} className="h-8 min-w-0 flex-1 rounded-md border bg-[hsl(var(--input-surface))] px-2 font-mono text-xs outline-none focus:ring-1 focus:ring-ring" />
          <input aria-label="新模型显示名称" value={pending.name} placeholder="显示名称（可选）"
            onChange={(event) => { setError(null); onChange(models, { ...pending, name: event.target.value }) }}
            onKeyDown={handleEnter} className="h-8 min-w-0 flex-1 rounded-md border bg-[hsl(var(--input-surface))] px-2 text-[13px] outline-none focus:ring-1 focus:ring-ring" />
          <button type="button" aria-label="添加模型" title="添加模型" disabled={!pending.id.trim() || models.length >= MAX_CHANNEL_MODELS}
            onClick={handleAdd} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-40"><Plus size={18} /></button>
        </div>
      </div>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      {hasPendingChannelModel(pending) && <p role="status" className="text-xs text-muted-foreground">请先点击“添加模型”（或回车），或清空这两个输入框后再保存渠道。</p>}
      <p className="text-xs text-muted-foreground">模型变更点击顶部“保存 / 创建”后生效。这里只记录配置，不验证模型是否存在或当前账号是否有权限。</p>
    </fieldset>
  )
}
