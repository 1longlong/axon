/** Axon Loop 展示组件与纯计算；第三方许可见 THIRD_PARTY_NOTICES.md。 */
import { useState, type ReactNode } from 'react'

/** Axon Loop 界面：按输入数据渲染并管理本地交互，不访问后端实现。 */
export function LoopTabs({ labels, panels }: { labels: string[]; panels: ReactNode[] }) {
  const tabs = labels.slice(0, panels.length)
  const [active, setActive] = useState(0)
  if (!tabs.length) return null
  const current = Math.min(active, tabs.length - 1)
  return (
    <div className="min-w-0">
      <div className="mb-3 inline-flex overflow-hidden rounded-control border border-hairline">
        {tabs.map((label, i) => (
          <button
            key={`${i}:${label}`}
            type="button"
            onClick={() => setActive(i)}
            className={`cursor-pointer border-none px-3 py-1 text-caption font-medium transition-colors ${
              current === i ? 'bg-raised text-display' : 'bg-transparent text-secondary hover:text-display'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="min-w-0">{panels[current]}</div>
    </div>
  )
}
