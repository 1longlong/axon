/** 非官方模型目录确认绑定原生页面；不会为反向请求临时登记或改投当前窗口。 */
import type { WebContents } from 'electron'
import type { AppServerWindowClients } from './app-server-window-clients'

export interface AppServerChannelTargetOptions {
  clients: Pick<AppServerWindowClients, 'find' | 'matches' | 'getClientSignal'>
  /** 原生对话负责遵循 signal 关闭；URL 校验由私有桥和 core 执行。 */
  show: (sender: WebContents, url: string, signal: AbortSignal) => Promise<boolean>
}

/** 父端只确认已登记的原页面；等待中取消即时拒绝，迟到批准不能开始网络请求。 */
export function createAppServerChannelTargetConfirmation(options: AppServerChannelTargetOptions) {
  return async (clientId: string, url: string, signal: AbortSignal): Promise<boolean> => {
    const sender = options.clients.find(clientId), page = options.clients.getClientSignal(clientId)
    if (!sender || !page || page.aborted || signal.aborted) return false
    const combined = AbortSignal.any([page, signal])
    let cancel: (() => void) | undefined
    try {
      const canceled = new Promise<boolean>((resolve) => {
        cancel = () => resolve(false)
        combined.addEventListener('abort', cancel, { once: true })
      })
      const allowed = await Promise.race([options.show(sender, url, combined), canceled])
      return allowed === true && !combined.aborted && options.clients.matches(sender, clientId)
        && options.clients.getClientSignal(clientId) === page
    } catch { return false }
    finally { if (cancel) combined.removeEventListener('abort', cancel) }
  }
}
