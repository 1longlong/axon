/** Loop 页面是独立业务入口，不伪装成 Agent 会话或改变已有 Tab 数据。 */
import { atom } from 'jotai'
export type LoopPage = { kind: 'overview' } | { kind: 'create' } | { kind: 'detail'; id: string }
  | { kind: 'settings'; id: string } | { kind: 'run'; id: string; runId: string }
export const loopPageAtom = atom<LoopPage | null>(null)

/** 表单保存期间禁止导航；未保存修改由应用导航统一确认。 */
export const loopFormEditingAtom = atom({ dirty: false, busy: false })
