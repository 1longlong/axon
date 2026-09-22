/**
 * 配置路径工具
 *
 * 管理 Axon 应用的本地配置文件路径。
 * 所有用户配置存储在 ~/.axon/ 目录下（开发模式 ~/.axon-dev/）。
 * 随迭代逐步扩充子目录。
 */

import { join } from 'node:path'
import { mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'

/**
 * 获取配置目录名称
 *
 * 开发模式下返回 '.axon-dev'，正式版本返回 '.axon'。
 *
 * 检测优先级：
 * 1. AXON_DEV=1 环境变量（显式覆盖）
 * 2. Electron app.isPackaged（未打包 = 开发模式）
 * 3. 兜底 '.axon'
 */
let _configDirName: string | undefined

export function getConfigDirName(): string {
  if (_configDirName === undefined) {
    if (process.env.AXON_DEV === '1') {
      _configDirName = '.axon-dev'
    } else {
      try {
        // 延迟 require：本模块也被 bun test 直接加载，此时 electron 不可用
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { app } = require('electron')
        _configDirName = app.isPackaged ? '.axon' : '.axon-dev'
      } catch {
        _configDirName = '.axon'
      }
    }
    const mode = _configDirName === '.axon-dev' ? '开发模式' : '正式版本'
    console.log(`[配置] 配置目录: ~/${_configDirName}/（${mode}）`)
  }
  return _configDirName
}

/**
 * 获取配置目录路径
 *
 * 开发模式返回 ~/.axon-dev/，正式版本返回 ~/.axon/。
 * 如果目录不存在则自动创建。
 */
export function getConfigDir(): string {
  const configDir = join(homedir(), getConfigDirName())

  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true })
    console.log(`[配置] 已创建配置目录: ${configDir}`)
  }

  return configDir
}

/** 应用设置文件路径（~/.axon/settings.json） */
export function getSettingsPath(): string {
  return join(getConfigDir(), 'settings.json')
}

/** 用户资料文件路径（~/.axon/user-profile.json） */
export function getUserProfilePath(): string {
  return join(getConfigDir(), 'user-profile.json')
}

/** Axon 管理安装的 Skills 固定使用正式用户目录，不随开发配置目录切换。 */
export function getAgentManagedSkillsDir(): string {
  return join(homedir(), '.axon', 'skills')
}

/** Axon 管理 Skill 的实际安装清单；期望 catalog ID 仍保存在 settings.json。 */
export function getAgentSkillInstallationsPath(): string {
  return join(homedir(), '.axon', 'skill-installations.json')
}

/** 渠道配置文件路径（~/.axon/channels.json） */
export function getChannelsPath(): string {
  return join(getConfigDir(), 'channels.json')
}

/** Chat 会话轻量索引（~/.axon/conversations.json）。 */
export function getConversationsIndexPath(): string {
  return join(getConfigDir(), 'conversations.json')
}

/** Chat 消息目录（~/.axon/conversations/）。 */
export function getConversationsDir(): string {
  const directory = join(getConfigDir(), 'conversations')
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true })
    console.log(`[配置] 已创建对话目录: ${directory}`)
  }
  return directory
}

/** 附件存储根目录（~/.axon/attachments/），二进制按会话分目录存放。 */
export function getAttachmentsDir(): string {
  const directory = join(getConfigDir(), 'attachments')
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true })
    console.log(`[配置] 已创建附件目录: ${directory}`)
  }
  return directory
}

/** Agent 顶层会话轻量索引（~/.axon/agent-sessions.json），不包含子 Agent。 */
export function getAgentSessionsIndexPath(): string {
  return join(getConfigDir(), 'agent-sessions.json')
}

/** Agent 根会话聚合目录：state.json + agents/<id>/messages.jsonl。 */
export function getAgentSessionsDir(): string {
  const directory = join(getConfigDir(), 'agent-sessions')
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true })
  return directory
}

/** Agent 项目轻量索引（~/.axon/agent-projects.json）。 */
export function getAgentProjectsIndexPath(): string {
  return join(getConfigDir(), 'agent-projects.json')
}

/** Agent 项目的托管工作区根目录；与旧开发期工作区目录彻底分离。 */
export function getAgentProjectsDir(): string {
  const directory = join(getConfigDir(), 'agent-projects')
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true })
  return directory
}

/** Runtime 私有配置目录；其内部格式只由 adapter 解释。 */
export function getAgentRuntimeConfigDir(): string {
  const directory = join(getConfigDir(), 'runtime')
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true })
  return directory
}

/** Runtime session artifact 目录，是 Agent 续跑的唯一凭据来源。 */
export function getAgentRuntimeSessionsDir(): string {
  const directory = join(getAgentRuntimeConfigDir(), 'sessions')
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true })
  return directory
}
