/** 项目 MCP 配置、连接测试与内置预设的 Electron 通道绑定。 */

import { ipcMain } from 'electron'
import { MCP_IPC_CHANNELS } from '@axon/shared'
import type { McpProjectIpcController } from '../lib/mcp/mcp-project-ipc-handlers'
import { assertMainFrame } from './assert-main-frame'

/** 注册 MCP 项目配置入口；主 frame 之外不能读取可能含凭据的解密配置。 */
export function registerMcpProjectIpcHandlers(controller: McpProjectIpcController): void {
  ipcMain.handle(MCP_IPC_CHANNELS.GET_PROJECT_CONFIG, (event, projectId: unknown) => {
    assertMainFrame(event, 'MCP 项目配置')
    return controller.get(projectId)
  })
  ipcMain.handle(MCP_IPC_CHANNELS.SAVE_PROJECT_CONFIG, (event, projectId: unknown, config: unknown) => {
    assertMainFrame(event, 'MCP 项目配置')
    return controller.save(projectId, config)
  })
  ipcMain.handle(MCP_IPC_CHANNELS.TEST_SERVER_CONNECTION, (event, projectId: unknown, serverName: unknown, server: unknown) => {
    assertMainFrame(event, 'MCP 连接测试')
    return controller.testConnection(projectId, serverName, server)
  })
  ipcMain.handle(MCP_IPC_CHANNELS.LIST_BUILTIN_PRESETS, (event) => {
    assertMainFrame(event, 'MCP 内置目录')
    return controller.listBuiltinPresets()
  })
  ipcMain.handle(MCP_IPC_CHANNELS.MATERIALIZE_BUILTIN_PRESET, (event, projectId: unknown, presetId: unknown) => {
    assertMainFrame(event, 'MCP 内置预设')
    return controller.materializeBuiltinPreset(projectId, presetId)
  })
}
