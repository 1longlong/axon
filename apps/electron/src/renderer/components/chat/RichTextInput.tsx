import * as React from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import { Markdown } from 'tiptap-markdown'
import type { MarkdownStorage } from 'tiptap-markdown'
import { cn } from '@/lib/utils'

interface RichTextInputProps {
  value: string
  disabled: boolean
  onChange(value: string): void
  onSubmit(value: string): void
}

type EditorInstance = NonNullable<ReturnType<typeof useEditor>>

function getMarkdown(editor: EditorInstance): string {
  const storage: unknown = editor.storage
  return (storage as { markdown: MarkdownStorage }).markdown.getMarkdown()
}

/** Chat/Agent 共用的纯输入区：保留换行与 Markdown 文本兼容，不提供格式化工具栏。 */
export function RichTextInput({ value, disabled, onChange, onSubmit }: RichTextInputProps): React.ReactElement {
  const onChangeRef = React.useRef(onChange)
  const onSubmitRef = React.useRef(onSubmit)
  const editorRef = React.useRef<EditorInstance | null>(null)
  onChangeRef.current = onChange
  onSubmitRef.current = onSubmit

  const editor = useEditor({
    immediatelyRender: false,
    content: value,
    extensions: [
      StarterKit.configure({ heading: false, horizontalRule: false }),
      Placeholder.configure({ placeholder: '输入消息…' }),
      Markdown.configure({
        html: false,
        transformPastedText: true,
        transformCopiedText: true,
      }),
    ],
    editorProps: {
      attributes: {
        class: 'chat-rich-input min-h-20 max-h-56 overflow-y-auto px-2 py-1 text-sm leading-6 outline-none',
        'aria-label': '消息输入',
      },
      handleKeyDown: (_view, event) => {
        if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return false
        const current = editorRef.current
        if (!current || current.isDestroyed) return false
        event.preventDefault()
        onSubmitRef.current(getMarkdown(current))
        return true
      },
    },
    onUpdate: ({ editor: current }) => onChangeRef.current(getMarkdown(current)),
  })
  editorRef.current = editor

  React.useEffect(() => {
    editor?.setEditable(!disabled)
  }, [disabled, editor])

  React.useEffect(() => {
    if (!editor || editor.isDestroyed || getMarkdown(editor) === value) return
    // 外部清空或切换草稿时禁止触发 onUpdate，避免旧内容回写 atom。
    editor.commands.setContent(value, { emitUpdate: false })
  }, [editor, value])

  return (
    <div>
      <EditorContent editor={editor} className={cn(disabled && 'opacity-60')} />
    </div>
  )
}
