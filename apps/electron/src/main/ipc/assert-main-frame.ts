import type { IpcMainInvokeEvent } from 'electron'

/** 拒绝 iframe 发起的高权限 IPC；所有领域 registrar 在进入业务逻辑前复用此边界。 */
export function assertMainFrame(event: IpcMainInvokeEvent, feature: string): void {
  if (event.senderFrame !== event.sender.mainFrame) {
    throw new Error(`不允许从子框架请求${feature}`)
  }
}
