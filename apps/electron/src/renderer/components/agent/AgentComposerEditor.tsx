import * as React from 'react'
import { EditorContent, Node, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import { Popover } from '@base-ui/react/popover'
import { MAX_AGENT_ATTACHMENTS } from '@axon/shared'
import { agentComposerTextNodes, readAgentComposerDocument } from '@/lib/agent-composer-document'
import type { AgentComposerSkill, AgentComposerValue } from '@/lib/agent-composer-document'
import { matchAgentSlashCandidates, readAgentSlashInput, resolveAgentSlashCommand } from '@/lib/agent-slash-command'
import type { AgentLocalCommand, AgentSlashCandidate, AgentSlashInput } from '@/lib/agent-slash-command'
import type { AgentSkillChoice } from '@axon/shared'

export interface AgentComposerEditorHandle {
  insertSkill(skill: AgentComposerSkill): void
  appendText(text: string): void
  focus(): void
  isFocused(): boolean
  handleLocalCommand(): boolean
}

const SkillNode = Node.create({
  name: 'agentSkill', group: 'inline', inline: true, atom: true, selectable: true, draggable: false,
  addAttributes: () => ({ sourceId: { default: null }, name: { default: '' } }),
  // 只允许当前选择器通过命令创建节点；HTML 粘贴、拖入不能伪造来源。
  parseHTML: () => [],
  renderHTML: ({ node }) => ['span', {}, `$${String(node.attrs.name)}`],
  renderText: ({ node }) => `$${String(node.attrs.name)}`,
  addNodeView() {
    return ({ node, editor, getPos }) => {
      const dom = document.createElement('span')
      dom.contentEditable = 'false'
      dom.dataset.agentInlineSkill = ''
      dom.className = 'mx-0.5 inline-flex items-center gap-1 rounded-full border border-border bg-muted/70 px-2 align-baseline text-xs leading-5 text-foreground'
      const label = document.createElement('span')
      label.textContent = `$${String(node.attrs.name)}`
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.setAttribute('aria-label', `移除 Skill ${String(node.attrs.name)}`)
      remove.className = 'rounded-full px-0.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40'
      remove.textContent = '×'
      remove.addEventListener('mousedown', (event) => event.preventDefault())
      remove.addEventListener('click', () => {
        if (!editor.isEditable) return
        const position = getPos()
        if (typeof position === 'number') editor.chain().focus().deleteRange({ from: position, to: position + node.nodeSize }).run()
      })
      dom.append(label, remove)
      return { dom, stopEvent: (event) => event.target instanceof Element && Boolean(event.target.closest('button')) }
    }
  },
})

/** 主窗/浮窗共用纯文字与原子 Skill 编辑；本层不读 Skill 正文，也不改变附件授权。 */
export const AgentComposerEditor = React.forwardRef<AgentComposerEditorHandle, {
  disabled: boolean
  compact?: boolean
  autoFocus?: boolean
  commandMenuAnchor: React.RefObject<HTMLDivElement>
  sessionId: string
  onChange(value: AgentComposerValue): void
  onSubmit(): void
  onEscape?: () => void
  onCommand?: (command: AgentLocalCommand) => void
  onCommandMenuOpen?: () => void
}>(function AgentComposerEditor({ disabled, compact, autoFocus, commandMenuAnchor, sessionId, onChange, onSubmit, onEscape, onCommand, onCommandMenuOpen }, ref) {
  const callbacks = React.useRef({ onChange, onSubmit, onEscape, onCommand, onCommandMenuOpen })
  callbacks.current = { onChange, onSubmit, onEscape, onCommand, onCommandMenuOpen }
  const listId = React.useId()
  const dismissed = React.useRef(false)
  const menuOpenRef = React.useRef(false)
  const dispatchRef = React.useRef<(candidate?: AgentSlashCandidate) => boolean>(() => false)
  const [slashInput, setSlashInput] = React.useState<AgentSlashInput>()
  const [skills, setSkills] = React.useState<AgentSkillChoice[]>([])
  const [loading, setLoading] = React.useState(false)
  const [loadError, setLoadError] = React.useState<string>()
  const [activeIndex, setActiveIndex] = React.useState(0)
  const menu = slashInput ? matchAgentSlashCandidates(slashInput, skills) : []
  const selectionRef = React.useRef({ menu, activeIndex })
  selectionRef.current = { menu, activeIndex }
  const [commandError, setCommandError] = React.useState<string>()

  const dismissMenu = (): void => {
    dismissed.current = true
    menuOpenRef.current = false
    setSlashInput(undefined)
  }
  /** 菜单只提供本地补全；输入更新/移动光标不会执行命令或发送消息。 */
  const synchronizeMenu = (current: NonNullable<ReturnType<typeof useEditor>>, changed: boolean): void => {
    if (changed) { dismissed.current = false; setCommandError(undefined) }
    const input = readAgentSlashInput(current.getJSON())
    const selection = current.state.selection
    const eligible = current.isFocused && current.isEditable && callbacks.current.onCommand && !dismissed.current
      && input && !input.arguments && selection.empty && selection.from <= input.lineEnd
    if (eligible && !menuOpenRef.current) callbacks.current.onCommandMenuOpen?.()
    menuOpenRef.current = Boolean(eligible)
    setSlashInput(eligible ? input : undefined)
    if (changed) setActiveIndex(0)
  }
  // 一次打开只读取一份发现摘要；输入字符本地过滤，关闭/换会话丢弃迟到响应。
  React.useEffect(() => {
    if (!slashInput || !onCommand || disabled) return
    let active = true
    setLoading(true); setLoadError(undefined); setSkills([])
    void window.axon.agent.attachmentCommand({ action: 'listSkills', sessionId }).then((result) => {
      if (!result || typeof result !== 'object' || !('skills' in result) || !Array.isArray(result.skills)) throw new Error('Skills 响应无效')
      if (active) setSkills(result.skills)
    }).catch(() => { if (active) setLoadError('读取 Skills 失败，关闭后重新输入 / 重试') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [Boolean(slashInput), sessionId, Boolean(onCommand), disabled])
  const editor = useEditor({
    immediatelyRender: false,
    editable: !disabled,
    autofocus: autoFocus || compact ? 'end' : false,
    enableInputRules: false,
    enablePasteRules: false,
    extensions: [StarterKit.configure({
      blockquote: false, bold: false, bulletList: false, code: false, codeBlock: false, heading: false,
      horizontalRule: false, italic: false, link: false, listItem: false, listKeymap: false, orderedList: false,
      strike: false, underline: false, trailingNode: false,
    }), SkillNode, Placeholder.configure({ placeholder: compact ? '请输入' : '输入消息…' })],
    editorProps: {
      attributes: { class: compact
        ? 'agent-composer-editor chat-rich-input min-h-6 max-h-24 overflow-y-auto text-base leading-6 outline-none'
        : 'agent-composer-editor chat-rich-input min-h-12 max-h-56 overflow-y-auto px-1 py-1 text-[13px] leading-6 outline-none',
      'aria-label': compact ? '快捷输入消息' : '消息输入', role: 'textbox', 'aria-multiline': 'true',
      ...(compact ? { 'data-quick-composer': '' } : {}) },
      handleKeyDown: (_view, event) => {
        // 先消费 IME/菜单按键，再处理发送或浮窗关闭，避免同一次 Enter/Esc 穿透。
        if (event.isComposing || event.keyCode === 229) return false
        if (menuOpenRef.current && event.key === 'Escape') {
          event.preventDefault(); event.stopPropagation(); dismissMenu(); return true
        }
        if (menuOpenRef.current && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
          event.preventDefault()
          const count = selectionRef.current.menu.length
          if (count) setActiveIndex((index) => (index + (event.key === 'ArrowDown' ? 1 : -1) + count) % count)
          return true
        }
        if (menuOpenRef.current && !event.shiftKey && (event.key === 'Tab' || event.key === 'Enter')) {
          event.preventDefault(); dispatchRef.current(); return true
        }
        if (event.key === 'Escape' && callbacks.current.onEscape) {
          event.preventDefault(); callbacks.current.onEscape(); return true
        }
        if (event.key !== 'Enter' || event.shiftKey) return false
        event.preventDefault()
        if (!dispatchRef.current()) callbacks.current.onSubmit()
        return true
      },
      handlePaste: (view, event) => {
        const text = event.clipboardData?.getData('text/plain')
        if (text === undefined) return false
        event.preventDefault()
        const nodes = agentComposerTextNodes(text).map((node) => view.state.schema.nodeFromJSON(node))
        // 替换当前选择，保持每个换行与空格，不解释 Markdown 或 HTML。
        const transaction = view.state.tr.deleteSelection()
        let position = transaction.selection.from
        for (const node of nodes) { transaction.insert(position, node); position += node.nodeSize }
        view.dispatch(transaction)
        return true
      },
      handleDrop: (_view, event) => { event.preventDefault(); return true },
    },
    onUpdate: ({ editor: current }) => {
      callbacks.current.onChange(readAgentComposerDocument(current.getJSON()))
      synchronizeMenu(current, true)
    },
    onSelectionUpdate: ({ editor: current }) => synchronizeMenu(current, false),
    onFocus: ({ editor: current }) => synchronizeMenu(current, false),
  })
  React.useEffect(() => {
    editor?.setEditable(!disabled)
    if (disabled || !onCommand) dismissMenu()
  }, [disabled, editor, Boolean(onCommand)])

  /** 提交入口共用分发：Skill 原位替换，命令打开选择器；均保留下方文字与其他附件。 */
  const handleLocalCommand = (candidate?: AgentSlashCandidate): boolean => {
    if (!editor || editor.isDestroyed || !editor.isEditable || !callbacks.current.onCommand) return false
    const input = readAgentSlashInput(editor.getJSON())
    if (!input) return false
    const selected = candidate ?? (menuOpenRef.current ? selectionRef.current.menu[selectionRef.current.activeIndex] : undefined)
    if (selected?.kind === 'skill') {
      const current = readAgentComposerDocument(editor.getJSON())
      if (current.skills.some((skill) => skill.sourceId === selected.skill.sourceId)) {
        setCommandError('此 Skill 已在输入框中'); return true
      }
      if (current.skills.length >= MAX_AGENT_ATTACHMENTS) { setCommandError('选择的 Skill 过多'); return true }
      // 替换当前命令片段而非追加到末尾；来源复核和正文读取仍由发送时的后端完成。
      editor.chain().focus().deleteRange({ from: 1, to: input.lineEnd })
        .insertContent({ type: 'agentSkill', attrs: { sourceId: selected.skill.sourceId, name: selected.skill.name } }).run()
      dismissMenu()
      return true
    }
    const resolved = resolveAgentSlashCommand(input, menuOpenRef.current)
    if (resolved.kind === 'error') { dismissMenu(); setCommandError(resolved.message); return true }
    dismissMenu()
    editor.commands.deleteRange({ from: input.from, to: input.to })
    // 删除也会触发 onUpdate；在打开选择器前再次封住候选，避免重复分发。
    dismissMenu()
    callbacks.current.onCommand(resolved.command)
    return true
  }
  dispatchRef.current = handleLocalCommand
  React.useImperativeHandle(ref, () => ({
    insertSkill(skill) {
      if (!editor || editor.isDestroyed || !editor.isEditable) throw new Error('输入区暂不可用')
      const current = readAgentComposerDocument(editor.getJSON())
      if (current.skills.some((item) => item.sourceId === skill.sourceId)) return
      if (current.skills.length >= MAX_AGENT_ATTACHMENTS) throw new Error('选择的 Skill 过多')
      editor.commands.insertContent({ type: 'agentSkill', attrs: skill })
    },
    appendText(text) {
      if (!editor || editor.isDestroyed) return
      const current = readAgentComposerDocument(editor.getJSON())
      editor.commands.insertContentAt(editor.state.doc.content.size - 1,
        agentComposerTextNodes(`${current.text || current.skills.length ? '\n' : ''}${text}`))
    },
    focus() { if (editor && !editor.isDestroyed) editor.commands.focus() },
    isFocused() { return editor?.isFocused === true },
    handleLocalCommand() { return dispatchRef.current() },
  }), [editor])
  const menuOpen = Boolean(slashInput) && !disabled && Boolean(onCommand)
  React.useEffect(() => {
    if (menuOpen) document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView({ block: 'nearest' })
  }, [menuOpen, activeIndex, listId])
  React.useEffect(() => {
    if (!editor || editor.isDestroyed) return
    editor.view.dom.setAttribute('role', onCommand ? 'combobox' : 'textbox')
    editor.view.dom.setAttribute('aria-autocomplete', onCommand ? 'list' : 'none')
    if (onCommand) editor.view.dom.setAttribute('aria-expanded', String(menuOpen))
    else editor.view.dom.removeAttribute('aria-expanded')
    if (menuOpen) {
      editor.view.dom.setAttribute('aria-controls', listId)
      if (menu.length) editor.view.dom.setAttribute('aria-activedescendant', `${listId}-${activeIndex}`)
      else editor.view.dom.removeAttribute('aria-activedescendant')
    } else {
      editor.view.dom.removeAttribute('aria-controls')
      editor.view.dom.removeAttribute('aria-activedescendant')
    }
  }, [editor, menuOpen, listId, activeIndex, menu.length, Boolean(onCommand)])
  return <div className="min-w-0 flex-1">
    <EditorContent editor={editor} className={disabled ? 'opacity-60' : undefined} />
    {commandError && <p role="alert" className="mt-1 text-xs text-destructive">{commandError}</p>}
    <Popover.Root open={menuOpen} onOpenChange={(open) => { if (!open) dismissMenu() }}>
      {/* 以整个输入容器为基准，附件或工具栏变高时仍保持候选在输入框之外。 */}
      <Popover.Portal><Popover.Positioner anchor={commandMenuAnchor} side="top" align="start" sideOffset={8}
        collisionAvoidance={{ side: 'none', align: 'shift', fallbackAxisSide: 'none' }} className="z-[110]">
        <Popover.Popup initialFocus={false} finalFocus={false} role="listbox" id={listId} aria-label="本地命令"
          className="max-h-[min(18rem,var(--available-height))] w-[var(--anchor-width)] max-w-[calc(100vw-24px)] overflow-y-auto rounded-xl border border-border bg-background p-1.5 shadow-md outline-none">
          {menu.map((candidate, index) => <button key={candidate.kind === 'command' ? 'command-' + candidate.command.name : candidate.skill.sourceId}
            type="button" role="option" id={`${listId}-${index}`} aria-selected={index === activeIndex} tabIndex={-1}
            onMouseEnter={() => setActiveIndex(index)} onMouseDown={(event) => event.preventDefault()} onClick={() => dispatchRef.current(candidate)}
            className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[13px] hover:bg-muted ${index === activeIndex ? 'bg-muted/60' : ''}`}>
            <span className="min-w-0 flex-1"><span className="flex items-center gap-2"><span className="truncate font-mono">/{candidate.kind === 'command' ? candidate.command.name : candidate.skill.name}</span>
              <span className="text-[10px] text-muted-foreground">{candidate.kind === 'command' ? '命令' : 'Skill'}</span></span>
              <span className="block truncate text-xs text-muted-foreground">{candidate.kind === 'command' ? candidate.command.description : candidate.skill.description}</span></span>
            <span aria-hidden="true" className="text-xs text-muted-foreground">↵</span>
          </button>)}
          {loading && <p role="status" className="px-3 py-2 text-xs text-muted-foreground">正在读取 Skills…</p>}
          {loadError && <p role="alert" className="px-3 py-2 text-xs text-destructive">{loadError}</p>}
          {!loading && !loadError && !menu.length && <p className="px-3 py-2 text-xs text-muted-foreground">没有匹配的命令或 Skill</p>}
        </Popover.Popup>
      </Popover.Positioner></Popover.Portal>
    </Popover.Root>
  </div>
})
