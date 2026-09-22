import * as React from 'react'
import { HelpCircle } from 'lucide-react'
import { useAtomValue } from 'jotai'
import { agentStateAtom } from '@/atoms/agent-state'
import { useAgentController } from './AgentStateProvider'

interface AnswerDraft {
  selected: string[]
  custom: string
}

/** 展示当前会话第一条追问；回答作为工具结果返回，不创建新的用户消息轮次。 */
export function AskUserBanner({ sessionId }: { sessionId: string }): React.ReactElement | null {
  const controller = useAgentController()
  const request = useAtomValue(agentStateAtom).pendingAskUsersBySession[sessionId]?.[0]
  const [drafts, setDrafts] = React.useState<Record<string, AnswerDraft>>({})

  React.useEffect(() => { setDrafts({}) }, [request?.requestId])
  if (!request) return null

  const draftFor = (question: string): AnswerDraft => drafts[question] ?? { selected: [], custom: '' }
  const updateDraft = (question: string, draft: AnswerDraft): void => {
    setDrafts((current) => ({ ...current, [question]: draft }))
  }
  const toggleOption = (question: typeof request.questions[number], label: string): void => {
    const current = draftFor(question.question)
    const selected = question.multiSelect
      ? current.selected.includes(label)
        ? current.selected.filter((item) => item !== label)
        : [...current.selected, label]
      : [label]
    updateDraft(question.question, { selected, custom: question.multiSelect ? current.custom : '' })
  }
  const answers = Object.fromEntries(request.questions.map((question) => {
    const draft = draftFor(question.question)
    return [question.question, [...draft.selected, draft.custom.trim()].filter(Boolean).join('、')]
  }))
  const canSubmit = Object.values(answers).every((answer) => answer.length > 0)

  return <div className="mx-4 mt-3 shrink-0 rounded-lg border border-blue-500/40 bg-blue-500/5 p-3 text-sm">
    <div className="flex items-start gap-2">
      <HelpCircle size={17} className="mt-0.5 shrink-0 text-blue-600" />
      <div className="min-w-0 flex-1 space-y-4">
        <p className="font-medium">Agent 需要你的回答</p>
        {request.questions.map((question) => {
          const draft = draftFor(question.question)
          return <fieldset key={question.question} className="space-y-2">
            <legend className="text-xs font-medium">{question.header ? `${question.header} · ` : ''}{question.question}</legend>
            {question.options.length > 0 && <div className="flex flex-wrap gap-2">
              {question.options.map((option) => {
                const selected = draft.selected.includes(option.label)
                return <button key={option.label} type="button" title={option.description} onClick={() => toggleOption(question, option.label)} className={`rounded-md border px-2.5 py-1.5 text-left text-xs ${selected ? 'border-primary bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-muted'}`}>
                  <span className="block">{option.label}</span>
                  {option.description && <span className="mt-0.5 block text-[10px] opacity-75">{option.description}</span>}
                </button>
              })}
            </div>}
            <textarea
              value={draft.custom}
              onChange={(event) => updateDraft(question.question, {
                selected: question.multiSelect ? draft.selected : [],
                custom: event.target.value,
              })}
              maxLength={10_000}
              rows={2}
              className="w-full resize-y rounded-md border bg-background px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-ring"
              placeholder={question.options.length > 0 ? '其他答案（可选）' : '请输入回答'}
            />
          </fieldset>
        })}
        <div className="flex gap-2">
          <button type="button" disabled={!canSubmit} onClick={() => void controller.respondAskUser({ requestId: request.requestId, behavior: 'answer', answers })} className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-40">提交回答</button>
          <button type="button" onClick={() => void controller.respondAskUser({ requestId: request.requestId, behavior: 'cancel' })} className="rounded-md border px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted">取消</button>
        </div>
      </div>
    </div>
  </div>
}
