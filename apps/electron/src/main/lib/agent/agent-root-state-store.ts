/** 根 Agent 会话的聚合状态存储；消息正文由各 Agent 的 JSONL 单独保存。 */

import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonFileSafe, writeJsonFileAtomic } from '../core/safe-file'

const STATE_VERSION = 1
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export interface AgentRootState {
  version: number
  /** main 保存根 Agent 完整元数据，其余 key 为子 Agent ID。 */
  agents: Record<string, unknown>
  /** 任务使用会话内格式，不重复保存 rootSessionId。 */
  tasks: unknown[]
}

function emptyState(): AgentRootState {
  return { version: STATE_VERSION, agents: {}, tasks: [] }
}

function normalizeId(value: string): string {
  if (!ID_PATTERN.test(value)) throw new Error('根会话 ID 格式无效')
  return value
}

/**
 * 读取和原子更新单个根会话的 state.json。
 * 调用方负责各自领域记录的细粒度校验，本层只守住文件结构与路径边界。
 */
export class AgentRootStateStore {
  constructor(private readonly sessionsDir: string) {
    mkdirSync(sessionsDir, { recursive: true })
    if (process.platform !== 'win32') chmodSync(sessionsDir, 0o700)
  }

  read(rootSessionId: string): AgentRootState {
    const path = this.statePath(rootSessionId)
    if (!existsSync(path)) return emptyState()
    const value = readJsonFileSafe<unknown>(path)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyState()
    const source = value as Record<string, unknown>
    if (
      source.version !== STATE_VERSION
      || !source.agents
      || typeof source.agents !== 'object'
      || Array.isArray(source.agents)
      || !Array.isArray(source.tasks)
    ) {
      console.warn(`[Agent 会话] 已忽略无效状态文件: ${rootSessionId}`)
      return emptyState()
    }
    return {
      version: STATE_VERSION,
      agents: { ...(source.agents as Record<string, unknown>) },
      tasks: [...source.tasks],
    }
  }

  update(rootSessionId: string, updater: (state: AgentRootState) => AgentRootState): AgentRootState {
    const id = normalizeId(rootSessionId)
    const directory = this.rootDir(id)
    mkdirSync(directory, { recursive: true })
    if (process.platform !== 'win32') chmodSync(directory, 0o700)
    const next = updater(this.read(id))
    const normalized: AgentRootState = {
      version: STATE_VERSION,
      agents: { ...next.agents },
      tasks: [...next.tasks],
    }
    const path = this.statePath(id)
    writeJsonFileAtomic(path, normalized)
    if (process.platform !== 'win32') chmodSync(path, 0o600)
    return normalized
  }

  /** 删除根会话时整目录回收，子 Agent 消息和任务状态天然级联删除。 */
  deleteRoot(rootSessionId: string): void {
    const directory = this.rootDir(rootSessionId)
    if (existsSync(directory)) rmSync(directory, { recursive: true, force: true })
  }

  /** 只枚举合法根目录；用于启动收敛和跨根任务管理，不读取消息正文。 */
  listRootIds(): string[] {
    return readdirSync(this.sessionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && ID_PATTERN.test(entry.name))
      .map((entry) => entry.name)
  }

  rootDir(rootSessionId: string): string {
    return join(this.sessionsDir, normalizeId(rootSessionId))
  }

  agentMessagesPath(rootSessionId: string, agentId: string): string {
    const normalizedAgentId = agentId === 'main' ? 'main' : normalizeId(agentId)
    return join(this.rootDir(rootSessionId), 'agents', normalizedAgentId, 'messages.jsonl')
  }

  private statePath(rootSessionId: string): string {
    return join(this.rootDir(rootSessionId), 'state.json')
  }
}
