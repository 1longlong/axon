/** 原生对话框只负责用户选择；身份/路径/凭据边界由调用桥和独立后端复核。 */
import { BrowserWindow, dialog } from 'electron'
import type { WebContents } from 'electron'
import { basename } from 'node:path'
import type { AgentWorkspaceDirectorySelection } from '@axon/shared'

/** 对话框绑定原窗口；选择完成后由固定 IPC 再核对页面代次，不能替用户创建项目。 */
export async function pickAgentProjectRoot(sender: WebContents): Promise<AgentWorkspaceDirectorySelection> {
  const window = BrowserWindow.fromWebContents(sender)
  if (!window || window.isDestroyed()) throw new Error('Agent 窗口不可用')
  const result = await dialog.showOpenDialog(window, { title: '选择 Agent 本地项目目录', properties: ['openDirectory', 'createDirectory'] })
  if (result.canceled || !result.filePaths[0]) return { canceled: true }
  const path = result.filePaths[0]
  return { canceled: false, path, suggestedName: basename(path) || '本地项目' }
}

/** 非官方目标确认绑定原窗口与取消信号；结果仍交给私有桥复核，不在此处发送网络请求。 */
export async function showChannelTargetConfirmation(sender: WebContents, url: string, signal: AbortSignal): Promise<boolean> {
  const window = BrowserWindow.fromWebContents(sender)
  if (!window || window.isDestroyed() || signal.aborted) return false
  const result = await dialog.showMessageBox(window, {
    type: 'warning', title: '确认渠道请求目标', message: '是否向此非官方目录地址发送请求？',
    detail: `目标：${url}\n\n请求会携带当前填写或已保存的 API Key。第三方服务可能记录凭据；HTTP 不加密传输。请核对目标与密钥是否匹配。只允许本次请求及同一端点的分页，不跟随重定向。`,
    buttons: ['取消', '确认发送'], defaultId: 0, cancelId: 0, signal,
  })
  return result.response === 1 && !signal.aborted && !window.isDestroyed() && window.webContents === sender
}
