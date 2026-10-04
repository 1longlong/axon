import type { ReactElement, SVGProps } from 'react'

interface WorkbenchIconProps extends SVGProps<SVGSVGElement> {
  size?: number
}

// 工作台共用静态 SVG；只负责呈现，状态与交互由调用组件管理。
export function AgentModeIcon({ size = 14, ...props }: WorkbenchIconProps): ReactElement {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true" {...props}>
    <path d="M12 8V4m0 0L9 6m3-2l3 2M5 14v-2a7 7 0 0114 0v2m-15 4a2 2 0 002 2h10a2 2 0 002-2v-4a2 2 0 00-2-2H6a2 2 0 00-2 2v4z" />
    <circle cx={9} cy={15} r={1} /><circle cx={15} cy={15} r={1} />
  </svg>
}

export function AgentSessionIcon({ size = 14, ...props }: WorkbenchIconProps): ReactElement {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true" {...props}>
    <rect x={3} y={11} width={18} height={10} rx={2} />
    <circle cx={12} cy={5} r={2} /><path d="M12 7v4" />
    <line x1={8} x2={8} y1={16} y2={16} strokeLinecap="round" /><line x1={16} x2={16} y1={16} y2={16} strokeLinecap="round" />
  </svg>
}

export function ChatIcon({ size = 14, ...props }: WorkbenchIconProps): ReactElement {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true" {...props}>
    <path d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
  </svg>
}

export function ProjectFolderIcon({ size = 14, ...props }: WorkbenchIconProps): ReactElement {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
    <path d="M10 4H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V8a2 2 0 00-2-2h-8l-2-2z" />
  </svg>
}

export function ThinkingIcon({ size = 14, ...props }: WorkbenchIconProps): ReactElement {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true" {...props}>
    <path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
  </svg>
}

export function FilesPanelIcon({ size = 14, ...props }: WorkbenchIconProps): ReactElement {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true" {...props}>
    <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
  </svg>
}
