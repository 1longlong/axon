/** 渠道管理器的生产环境单例装配。 */

import { getChannelsPath } from '../core/config-paths'
import { ChannelManager } from './channel-manager'
import { createElectronChannelCredentialCodec } from './electron-channel-credential-codec'

let channelManager: ChannelManager | null = null

export function getChannelManager(): ChannelManager {
  if (!channelManager) {
    channelManager = new ChannelManager({
      configPath: getChannelsPath(),
      credentialCodec: createElectronChannelCredentialCodec(),
    })
  }
  return channelManager
}
