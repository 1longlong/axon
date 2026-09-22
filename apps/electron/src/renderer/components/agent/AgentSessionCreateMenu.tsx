import * as React from 'react'
import { createPortal } from 'react-dom'
import { Plus } from 'lucide-react'
import type { AgentRuntimeId } from '@axon/shared'

const MENU_WIDTH = 224

/** 创建菜单挂到页面顶层，避免被左侧栏的滚动容器裁切。 */
export function AgentSessionCreateMenu({ projectName, disabled, onCreate }: {
  projectName: string
  disabled: boolean
  onCreate(runtimeId: AgentRuntimeId): void
}): React.ReactElement {
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const menuRef = React.useRef<HTMLDivElement>(null)
  const [open, setOpen] = React.useState(false)
  const [position, setPosition] = React.useState<{ left: number; top: number } | null>(null)

  React.useLayoutEffect(() => {
    if (!open || !triggerRef.current || !menuRef.current) return
    const anchor = triggerRef.current.getBoundingClientRect()
    const height = menuRef.current.offsetHeight
    const left = Math.max(8, Math.min(anchor.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8))
    const top = anchor.bottom + height + 8 <= window.innerHeight
      ? anchor.bottom + 4
      : Math.max(8, anchor.top - height - 4)
    setPosition({ left, top })
  }, [open])

  React.useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent): void => {
      const target = event.target as Node
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    const closeOnMove = (): void => setOpen(false)
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeOnEscape)
    window.addEventListener('resize', closeOnMove)
    window.addEventListener('scroll', closeOnMove, true)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape)
      window.removeEventListener('resize', closeOnMove)
      window.removeEventListener('scroll', closeOnMove, true)
    }
  }, [open])

  const create = (runtimeId: AgentRuntimeId): void => {
    if (disabled) return
    setOpen(false)
    onCreate(runtimeId)
  }

  return <>
    <button ref={triggerRef} type="button" disabled={disabled} aria-expanded={open}
      aria-label={`在 ${projectName} 中新建会话`} title="新建会话"
      onClick={() => { setPosition(null); setOpen((current) => !current) }}
      className="flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground disabled:opacity-40">
      <Plus size={14} />
    </button>
    {open && createPortal(<div ref={menuRef} role="menu" aria-label={`选择 ${projectName} 会话 Runtime`}
      style={{ position: 'fixed', left: position?.left ?? 0, top: position?.top ?? 0, width: MENU_WIDTH, visibility: position ? 'visible' : 'hidden' }}
      className="z-[100] rounded-md border bg-popover p-1 text-popover-foreground shadow-lg">
      <button type="button" role="menuitem" onClick={() => create('pi')} className="w-full rounded px-2 py-1.5 text-left text-xs hover:bg-muted">Pi · 默认</button>
      <button type="button" role="menuitem" onClick={() => create('zima')} className="w-full rounded px-2 py-1.5 text-left text-xs hover:bg-muted">Zima</button>
    </div>, document.body)}
  </>
}
