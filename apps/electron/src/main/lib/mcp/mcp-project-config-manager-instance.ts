/** MCP 项目配置管理器的主进程单例装配。 */

import { getAgentProjectManager } from '../project/agent-project-manager-instance'
import { createElectronCredentialCodec } from '../channel/electron-channel-credential-codec'
import { McpProjectConfigManager } from './mcp-project-config-manager'

let instance: McpProjectConfigManager | undefined

export function getMcpProjectConfigManager(): McpProjectConfigManager {
  if (!instance) {
    const credentialCodec = createElectronCredentialCodec()
    if (!credentialCodec.isSecure) {
      console.warn('[MCP 配置] 系统安全存储不可用，将使用受限权限文件保存配置')
    }
    instance = new McpProjectConfigManager({
      credentialCodec,
      resolveProjectDataDir: (projectId) => getAgentProjectManager().resolveProjectDataDir(projectId),
    })
  }
  return instance
}
