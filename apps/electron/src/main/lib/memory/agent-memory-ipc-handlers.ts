/** Agent 项目记忆 IPC：收束 renderer 输入，再交给受限文件服务。 */

import type { AgentMemoryFile, AgentMemorySummary } from '@axon/shared'
import type { AgentMemoryService } from './agent-memory-service'
import { AgentMemoryServiceError } from './agent-memory-service'
import type { AgentProjectManager } from '../project/agent-project-manager'
import type { AgentMemoryWatcher } from './agent-memory-watcher'

export interface AgentMemoryIpcControllerOptions {
  memory: Pick<AgentMemoryService, 'list' | 'read' | 'write'>
  projects: Pick<AgentProjectManager, 'get' | 'resolveProjectCwd'>
  watcher: Pick<AgentMemoryWatcher, 'watch' | 'unwatch' | 'clearOwner'>
}

function parseText(value: unknown, field: '项目标识' | '记忆路径'): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AgentMemoryServiceError('invalid_input', `${field}无效`)
  }
  return value.trim()
}

export class AgentMemoryIpcController {
  constructor(private readonly options: AgentMemoryIpcControllerOptions) {}

  list(projectId: unknown): AgentMemorySummary {
    return this.options.memory.list(parseText(projectId, '项目标识'))
  }

  read(projectId: unknown, relativePath: unknown): AgentMemoryFile {
    return this.options.memory.read(
      parseText(projectId, '项目标识'),
      parseText(relativePath, '记忆路径'),
    )
  }

  write(projectId: unknown, relativePath: unknown, content: unknown): AgentMemoryFile {
    if (typeof content !== 'string') throw new AgentMemoryServiceError('invalid_input', '记忆内容无效')
    return this.options.memory.write(
      parseText(projectId, '项目标识'),
      parseText(relativePath, '记忆路径'),
      content,
    )
  }

  /** 校验项目开关后监听其工作区；事件仍由 renderer 重新读取以避免信任文件系统提示。 */
  watch(ownerId: number, value: unknown, emit: (changedAt: number, relativePath?: string) => void): void {
    const projectId = parseText(value, '项目标识')
    const project = this.options.projects.get(projectId)
    if (!project) throw new AgentMemoryServiceError('project_unavailable', 'Agent 项目不存在')
    if (!project.memoryEnabled) throw new AgentMemoryServiceError('disabled', '该项目尚未启用记忆')
    this.options.watcher.watch(ownerId, projectId, this.options.projects.resolveProjectCwd(projectId), emit)
  }

  unwatch(ownerId: number, value: unknown): void {
    this.options.watcher.unwatch(ownerId, parseText(value, '项目标识'))
  }

  clearWatches(ownerId: number): void {
    this.options.watcher.clearOwner(ownerId)
  }
}
