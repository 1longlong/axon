import * as React from 'react'
import { useAtom } from 'jotai'
import { Check, Pencil, X, Type } from 'lucide-react'
import { markdownFontSizeAtom, updateMarkdownFontSize } from '@/atoms/markdown-font-size'
import type { MarkdownFontSize } from '@axon/shared'
import { MAX_CONVERSATION_TITLE_LENGTH } from '@axon/shared'
import type { ConversationMeta } from '@axon/shared'
import { ChatIcon } from '@/components/icons/WorkbenchIcons'
import { useChatController } from './ChatStateProvider'

/** Chat 顶栏负责修改会话元数据；消息生成链路不经过这里。 */
export function ChatHeader({ conversation }: { conversation: ConversationMeta }): React.ReactElement {
  const controller = useChatController()
  const [editingTitle, setEditingTitle] = React.useState(false)
  const [title, setTitle] = React.useState(conversation.title)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [fontSize, setFontSize] = useAtom(markdownFontSizeAtom)

  React.useEffect(() => setTitle(conversation.title), [conversation.title])

  const saveTitle = React.useCallback(async () => {
    const normalized = title.trim()
    if (!normalized || normalized === conversation.title) {
      setTitle(conversation.title)
      setEditingTitle(false)
      return
    }
    setBusy(true)
    setError(null)
    try {
      await controller.updateConversation(conversation.id, { title: normalized })
      setEditingTitle(false)
    } catch {
      setError('更新标题失败')
    } finally {
      setBusy(false)
    }
  }, [controller, conversation.id, conversation.title, title])

  const cycleFontSize = (): void => {
    const next: Record<MarkdownFontSize, MarkdownFontSize> = { small: 'medium', medium: 'large', large: 'small' }
    const value = next[fontSize]
    setFontSize(value)
    void updateMarkdownFontSize(value).catch(() => setError('保存阅读字号失败'))
  }

  return (
    <header className="titlebar-drag-region flex min-h-11 shrink-0 items-center gap-2 border-b border-border-subtle bg-[hsl(var(--content-area))] px-5 py-2">
      <ChatIcon size={14} className="shrink-0 text-muted-foreground" />
      <div className="titlebar-no-drag min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          {editingTitle ? (
            <div className="flex min-w-0 flex-1 items-center gap-1">
              <input
                autoFocus
                aria-label="Chat 会话标题"
                value={title}
                maxLength={MAX_CONVERSATION_TITLE_LENGTH}
                disabled={busy}
                onChange={(event) => setTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void saveTitle()
                  if (event.key === 'Escape') {
                    setTitle(conversation.title)
                    setEditingTitle(false)
                  }
                }}
                className="h-7 min-w-0 flex-1 rounded border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
              />
              <button type="button" aria-label="保存标题" disabled={busy} onClick={() => void saveTitle()} className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-40">
                <Check size={12} />
              </button>
              <button type="button" aria-label="取消编辑" disabled={busy} onClick={() => { setTitle(conversation.title); setEditingTitle(false) }} className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-40">
                <X size={12} />
              </button>
            </div>
          ) : (
            <div className="group/title flex min-w-0 max-w-[60%] items-center gap-1">
              <h1 className="truncate text-xs font-semibold" title={conversation.title}>{conversation.title}</h1>
              <button type="button" aria-label="编辑标题" onClick={() => setEditingTitle(true)} className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground group-hover/title:opacity-100 group-focus-within/title:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
                <Pencil size={12} />
              </button>
            </div>
          )}
          <span aria-hidden="true" className="shrink-0 text-xs text-muted-foreground/50">/</span>
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" title={conversation.modelId ?? '未选择模型'}>{conversation.modelId ?? '未选择模型'}</span>
        </div>
        {error && <p role="alert" className="mt-1 break-words text-[11px] text-destructive">{error}</p>}
      </div>

      <button type="button" aria-label="切换 Markdown 字号" title={`消息字号：${fontSize}`} onClick={cycleFontSize} className="titlebar-no-drag flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
        <Type size={14} />
      </button>
    </header>
  )
}
