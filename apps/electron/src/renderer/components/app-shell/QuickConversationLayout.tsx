import * as React from 'react'

export interface QuickConversationLayoutOptions {
  expanded: boolean
  onToggle: () => void
  title?: string
  resetEpoch: number
}

/** 快捷窗口只在展开时挂载历史区；输入与权限交互始终留在底部。 */
export function QuickConversationLayout({ options, context, composer }: {
  options: QuickConversationLayoutOptions
  context: React.ReactNode
  composer: React.ReactNode
}): React.ReactElement {
  const [contextMounted, setContextMounted] = React.useState(options.expanded)
  React.useEffect(() => {
    if (options.expanded) setContextMounted(true)
  }, [options.expanded])

  return <div className={`relative h-full min-h-0 px-2 pb-2 ${options.expanded ? 'pt-3' : 'pt-5'}`}>
    {!options.expanded && <span className="absolute left-6 top-0 z-20 max-w-48 truncate rounded-full border border-[#E8ECF2] bg-white px-2.5 py-0.5 text-[11px] font-medium text-[#59616E] shadow-sm" title={options.title}>{options.title}</span>}
    <div className={`flex h-full min-h-0 flex-col border border-[#E9ECF0] bg-[#FFFFFF] text-[#333333] ${options.expanded ? 'rounded-[28px] shadow-[0_12px_30px_rgba(30,45,70,0.12),0_2px_8px_rgba(30,45,70,0.06)]' : 'rounded-full shadow-[0_7px_22px_rgba(30,45,70,0.09),0_1px_4px_rgba(30,45,70,0.04)]'}`}>
    {contextMounted && <div className={`${options.expanded ? 'flex' : 'hidden'} min-h-0 flex-1 flex-col overflow-hidden rounded-t-[28px]`}>
      <div className="shrink-0 border-b border-[#F0F1F3] px-5 py-3 text-xs font-medium text-[#59616E]" title={options.title}>{options.title}</div>
      {context}
    </div>}
    <div className="relative shrink-0" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
      <button
        type="button"
        aria-label={options.expanded ? '收起会话上下文' : '展开会话上下文'}
        aria-expanded={options.expanded}
        onClick={options.onToggle}
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        className="absolute -top-2 left-1/2 z-10 flex h-5 w-10 -translate-x-1/2 items-center justify-center rounded-full border border-[#ECEEF2] bg-white text-[#777777] shadow-sm transition-colors hover:bg-[#F3F5F7] hover:text-[#333333]"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d={options.expanded ? 'm2.5 4.5 3.5 3 3.5-3' : 'm2.5 7.5 3.5-3 3.5 3'} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      <div className={options.expanded ? 'mx-4 mb-4 mt-3 overflow-hidden rounded-full border border-[#D4DDE8] bg-white shadow-[0_2px_10px_rgba(30,45,70,0.06)]' : 'max-h-full overflow-y-auto'} style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>{composer}</div>
    </div>
  </div></div>
}
