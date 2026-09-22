import * as React from 'react'
import { detectIsWindows } from '@/lib/platform'

/**
 * Windows 自定义标题栏控制按钮（最小化/最大化/关闭）。
 * macOS 使用 hiddenInset 原生红绿灯，不渲染本组件。
 */
export function WindowControls(): React.ReactElement | null {
  const isWindows = React.useMemo(() => detectIsWindows(), [])
  const [isMaximized, setIsMaximized] = React.useState(false)

  React.useEffect(() => {
    if (!isWindows) return
    void window.axon.window.isMaximized().then(setIsMaximized)
    const unsub = window.axon.window.onResize(() => {
      void window.axon.window.isMaximized().then((next: boolean) => {
        setIsMaximized((prev) => (prev === next ? prev : next))
      })
    })
    return unsub
  }, [isWindows])

  if (!isWindows) return null

  return (
    <div className="window-titlebar fixed inset-x-0 top-0 z-[100] flex h-8 select-none">
      {/* 拖拽区域（按钮区之外的部分） */}
      <div aria-hidden="true" className="titlebar-drag-region absolute inset-y-0 left-0 right-[138px]" />
      <div className="window-controls relative ml-auto flex">
        <button
          type="button"
          className="window-control-btn"
          aria-label="最小化"
          onClick={() => void window.axon.window.minimize()}
        >
          <svg width="12" height="12" viewBox="0 0 12 12">
            <rect x="1" y="5.5" width="10" height="1" fill="currentColor" />
          </svg>
        </button>

        <button
          type="button"
          className="window-control-btn"
          aria-label={isMaximized ? '还原' : '最大化'}
          onClick={() => void window.axon.window.maximize()}
        >
          {isMaximized ? (
            <svg width="12" height="12" viewBox="0 0 12 12">
              <rect x="3" y="0.5" width="8" height="8" rx="0.5" fill="none" stroke="currentColor" strokeWidth="1" />
              <rect x="1" y="3.5" width="8" height="8" rx="0.5" fill="currentColor" stroke="currentColor" strokeWidth="1" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 12 12">
              <rect x="1.5" y="1.5" width="9" height="9" rx="1" fill="none" stroke="currentColor" strokeWidth="1" />
            </svg>
          )}
        </button>

        <button
          type="button"
          className="window-control-btn window-control-close"
          aria-label="关闭"
          onClick={() => void window.axon.window.close()}
        >
          <svg width="12" height="12" viewBox="0 0 12 12">
            <path d="M1.5 1.5l9 9M10.5 1.5l-9 9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  )
}
