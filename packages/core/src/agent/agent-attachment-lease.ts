/** 附件接管只在可信后端内部传递；页面只能提交草稿 ID。 */
import type { AgentPreparedAttachmentInput } from '@axon/shared'

export interface AgentAttachmentLease {
  draftId: string
  sessionId: string
  /** 派发前复核原件，返回中立上下文；未来图片准备仍在这一接管边界内。 */
  prepare: () => AgentPreparedAttachmentInput
  /** 先保护将入历史的文件，再追加 JSONL；崩溃后的未知窗口只保留、不猜测删除。 */
  reserveForHistory: () => void
  /** 用户消息已落 JSONL 后标记，后续失败/暂停/退出不再删除原件。 */
  commit: () => void
  /** 实际执行结束后释放运行引用；未落盘且入口仍有效时退还草稿。 */
  settle: () => void
  /** 取消排队时明确放弃未落盘输入；不删除已进入历史的附件。 */
  cancel: () => void
}
