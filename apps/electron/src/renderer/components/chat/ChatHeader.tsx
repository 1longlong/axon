import * as React from 'react'
import { useAtom } from 'jotai'
import { Check, Pencil, X, Type } from 'lucide-react'
import { markdownFontSizeAtom, updateMarkdownFontSize } from '@/atoms/markdown-font-size'
import type { MarkdownFontSize } from '@/types/settings'
import { MAX_CONVERSATION_TITLE_LENGTH } from '@axon/shared'
import type { ConversationMeta } from '@axon/shared'
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
    <header className="titlebar-drag-region flex h-14 shrink-0 items-center gap-3 border-b px-4">
      <div className="titlebar-no-drag flex min-w-0 flex-1 items-center gap-1">
        {editingTitle ? (
          <>
            <input
              autoFocus
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
              className="h-8 min-w-0 max-w-sm flex-1 rounded-md border bg-background px-2 text-sm outline-none focus:ring-1 focus:ring-ring"
            />
            <button type="button" aria-label="保存标题" disabled={busy} onClick={() => void saveTitle()} className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
              <Check size={14} />
            </button>
            <button type="button" aria-label="取消编辑" disabled={busy} onClick={() => { setTitle(conversation.title); setEditingTitle(false) }} className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
              <X size={14} />
            </button>
          </>
        ) : (
          <>
            <h1 className="truncate text-sm font-medium">{conversation.title}</h1>
            <button type="button" aria-label="编辑标题" onClick={() => setEditingTitle(true)} className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
              <Pencil size={13} />
            </button>
          </>
        )}
        {error && <span className="ml-2 text-xs text-destructive">{error}</span>}
      </div>

      <button type="button" aria-label="切换 Markdown 字号" title={`消息字号：${fontSize}`} onClick={cycleFontSize} className="titlebar-no-drag rounded-md border p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
        <Type size={14} />
      </button>
    </header>
  )
}
