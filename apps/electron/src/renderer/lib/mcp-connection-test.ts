/** 弹窗测试生命周期；取消/关闭先撤销 UI 代次，再请求主进程取消连接等待。 */
import type { McpConnectionTestInput, McpConnectionTestResult } from '@axon/shared'

export interface McpConnectionTestApi {
  testConnection(input: McpConnectionTestInput): Promise<McpConnectionTestResult>
  cancelConnectionTest(requestId: string): Promise<boolean>
}
export interface McpConnectionTestCallbacks {
  started(): void
  result(value: McpConnectionTestResult): void
  finished(): void
}

export class McpConnectionTestRunner {
  private current: string | null = null
  private disposed = false
  constructor(private readonly api: McpConnectionTestApi, private readonly callbacks: McpConnectionTestCallbacks) {}

  /** 一次只发起一个草稿测试；传输失败显示固定提示，不回显未知原生异常。 */
  async run(input: Omit<McpConnectionTestInput, 'requestId'>): Promise<void> {
    if (this.disposed || this.current) return
    const requestId = crypto.randomUUID()
    this.current = requestId
    this.callbacks.started()
    try {
      const result = await this.api.testConnection({ ...input, requestId })
      if (this.current === requestId) this.callbacks.result(result)
    } catch {
      if (this.current === requestId) this.callbacks.result({ ok: false, message: '连接测试失败，请检查服务配置和后端状态' })
    } finally {
      if (this.current === requestId) {
        this.current = null
        this.callbacks.finished()
      }
    }
  }

  /** 先禁止旧请求更新 UI；取消响应不是实际服务器已退出的证明。 */
  cancel(): void {
    const requestId = this.current
    if (!requestId) return
    this.current = null
    void this.api.cancelConnectionTest(requestId).catch(() => {})
    if (!this.disposed) this.callbacks.finished()
  }

  dispose(): void { this.disposed = true; this.cancel() }
}
