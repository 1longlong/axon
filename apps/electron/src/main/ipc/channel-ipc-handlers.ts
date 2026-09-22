/** 渠道 CRUD 与模型目录请求的 Electron 通道绑定。 */

import { BrowserWindow, dialog, ipcMain } from 'electron'
import type { WebContents } from 'electron'
import { CHANNEL_IPC_CHANNELS } from '@axon/shared'
import { createChannelIpcHandlers } from '../lib/channel/channel-ipc-handlers'
import { ChannelNetworkService } from '../lib/channel/channel-network-service'
import type { ChannelManager } from '../lib/channel/channel-manager'
import { assertMainFrame } from './assert-main-frame'

/** 注册渠道完整 IPC 生命周期；renderer 销毁或重载时取消其尚未完成的网络请求。 */
export function registerChannelIpcHandlers(
  manager: ChannelManager,
  networkService?: ChannelNetworkService,
): void {
  const channels = createChannelIpcHandlers(manager)
  ipcMain.handle(CHANNEL_IPC_CHANNELS.LIST, () => channels.list())
  ipcMain.handle(CHANNEL_IPC_CHANNELS.CREATE, (_event, input: unknown) => channels.create(input))
  ipcMain.handle(CHANNEL_IPC_CHANNELS.UPDATE, (_event, id: unknown, input: unknown) => channels.update(id, input))
  ipcMain.handle(CHANNEL_IPC_CHANNELS.DELETE, (_event, id: unknown) => channels.delete(id))

  const network = networkService ?? new ChannelNetworkService({
    manager,
    confirmTarget: async (owner, url, signal) => {
      const win = BrowserWindow.getAllWindows().find((item) => item.webContents.id === owner)
      if (!win || win.isDestroyed() || signal.aborted) return false
      const result = await dialog.showMessageBox(win, {
        type: 'warning',
        title: '确认渠道请求目标',
        message: '是否向此非官方目录地址发送请求？',
        detail: `目标：${url}\n\n请求会携带当前填写或已保存的 API Key。第三方服务可能记录凭据；HTTP 不加密传输。请核对目标与密钥是否匹配。只允许本次请求及同一端点的分页，不跟随重定向。`,
        buttons: ['取消', '确认发送'],
        defaultId: 0,
        cancelId: 0,
        signal,
      })
      return result.response === 1 && !signal.aborted
    },
  })
  const watched = new WeakSet<WebContents>()
  ipcMain.handle(CHANNEL_IPC_CHANNELS.REQUEST, (event, input: unknown) => {
    assertMainFrame(event, '请求渠道')
    const sender = event.sender
    const owner = sender.id
    if (!watched.has(sender)) {
      watched.add(sender)
      sender.on('destroyed', () => network.cancel(owner))
      sender.on('render-process-gone', () => network.cancel(owner))
      sender.on('did-start-loading', () => network.cancel(owner))
    }
    return network.request(owner, input)
  })
  ipcMain.handle(CHANNEL_IPC_CHANNELS.CANCEL, (event, id: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame || typeof id !== 'string') return false
    return network.cancel(event.sender.id, id)
  })
}
