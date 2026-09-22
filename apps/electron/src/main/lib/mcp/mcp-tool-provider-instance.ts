/** MCP 工具提供器的主进程单例装配与退出清理入口。 */

import { getMcpProjectConfigManager } from './mcp-project-config-manager-instance'
import { McpToolProvider } from './mcp-tool-provider'

let instance: McpToolProvider | undefined

export function getMcpToolProvider(): McpToolProvider {
  instance ??= new McpToolProvider({
    getProjectConfig: (projectId) => getMcpProjectConfigManager().get(projectId),
  })
  return instance
}

/** 只清理已创建的实例，退出路径不反向初始化 MCP 或安全存储。 */
export function disposeMcpToolProvider(): void {
  instance?.dispose()
  instance = undefined
}
