import * as React from 'react'
import { Check, ShieldCheck } from 'lucide-react'
import { cn } from '@/lib/utils'

export type AgentPermissionProfile = 'askApproval' | 'approveForMe' | 'fullAccess'

interface AgentPermissionMenuProps {
  profile: AgentPermissionProfile
  disabled: boolean
  supportsSandbox: boolean
}

const PROFILES = [
  { id: 'askApproval', label: '请求批准', available: true },
  { id: 'approveForMe', label: '帮我批准', available: false },
  { id: 'fullAccess', label: '完全访问权限', available: false },
] as const

/** 图标展开现有权限预设；仅允许已实现的人工审批，未实现策略保持禁用。 */
export function AgentPermissionMenu({ profile, disabled, supportsSandbox }: AgentPermissionMenuProps): React.ReactElement {
  const [open, setOpen] = React.useState(false)
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const menuRef = React.useRef<HTMLDivElement>(null)
  const containerRef = React.useRef<HTMLDivElement>(null)
  const menuId = React.useId()
  const selectedLabel = PROFILES.find((item) => item.id === profile)?.label ?? '请求批准'

  React.useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  React.useEffect(() => {
    if (!open) return
    menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    const closeOutside = (event: PointerEvent): void => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [open])

  const close = (): void => {
    setOpen(false)
    triggerRef.current?.focus()
  }

  return <div ref={containerRef} className="relative shrink-0">
    <button ref={triggerRef} type="button" disabled={disabled}
      aria-label={`批准策略：${selectedLabel}`} title={`批准策略：${selectedLabel}`}
      aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
      onClick={() => setOpen((previous) => !previous)}
      className={cn('flex size-7 items-center justify-center rounded text-muted-foreground hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50', open && 'bg-muted text-foreground')}>
      <ShieldCheck size={16} aria-hidden="true" />
    </button>
    {open && <div ref={menuRef} id={menuId} role="menu" aria-label="Agent 批准策略"
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
        // 当前只有人工审批可选，方向键和首尾键均回到唯一可用项。
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault()
          menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
        }
      }}
      onBlur={(event) => { if (!containerRef.current?.contains(event.relatedTarget as Node | null)) setOpen(false) }}
      className="absolute bottom-full right-0 z-50 mb-2 w-60 max-w-[calc(100vw-2rem)] rounded-md border bg-popover p-1 text-popover-foreground shadow-sm">
      {PROFILES.map((item) => <button key={item.id} type="button" role="menuitemradio"
        aria-checked={profile === item.id} disabled={!item.available} onClick={close}
        className={cn('flex w-full items-center gap-2 rounded px-2 py-2 text-left text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50', profile === item.id && 'bg-indigo-500/10 text-indigo-600 hover:bg-indigo-500/15 dark:text-indigo-300')}>
        <span className="min-w-0 flex-1">{item.label}{!item.available && <span className="ml-1 text-[11px] text-muted-foreground">{item.id === 'approveForMe' ? '（待实现）' : '（暂不支持）'}</span>}</span>
        {profile === item.id && <Check size={14} aria-hidden="true" className="shrink-0" />}
      </button>)}
      <p className="mt-1 border-t border-border-subtle px-2 pb-1 pt-2 text-[11px] leading-4 text-muted-foreground">
        {supportsSandbox ? '工具在沙箱中执行，需要额外权限时请求批准。' : '当前 Runtime 不支持操作系统沙箱，仅提供人工工具审批。'}
      </p>
    </div>}
  </div>
}
