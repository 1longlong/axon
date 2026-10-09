/** Agent 项目记忆编排：收束客户端输入，再交给受限文件服务。 */

import type { AgentMemoryFile, AgentMemorySummary, BackendClientId } from '@axon/shared'
import type { BackendClientRegistry } from '../backend-client-registry'
import type { AgentMemoryService } from './agent-memory-service'
import { AgentMemoryServiceError } from './agent-memory-service'
import type { AgentProjectManager } from '../project/agent-project-manager'
import type { AgentMemoryWatcher } from './agent-memory-watcher'

export interface AgentMemoryControllerOptions {
  clients: Pick<BackendClientRegistry, 'has' | 'subscribeDetached'>
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

export class AgentMemoryController {
  private readonly owners = new Set<BackendClientId>()
  private readonly unsubscribeClients: () => void
  private disposed = false

  /** 客户端注销时只释放其记忆变化订阅，与逐轮文件陈旧检测保持独立。 */
  constructor(private readonly options: AgentMemoryControllerOptions) {
    this.unsubscribeClients = options.clients.subscribeDetached((id) => this.clearWatches(id))
  }

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

  /** 校验项目开关后监听其工作区；入口收到事件后重新读取，不信任文件系统提示正文。 */
  watch(ownerId: BackendClientId, value: unknown, emit: (changedAt: number, relativePath?: string) => void): void {
    if (this.disposed || !this.options.clients.has(ownerId)) {
      throw new AgentMemoryServiceError('invalid_input', '订阅客户端未登记或已断开')
    }
    const projectId = parseText(value, '项目标识')
    const project = this.options.projects.get(projectId)
    if (!project) throw new AgentMemoryServiceError('project_unavailable', 'Agent 项目不存在')
    if (!project.memoryEnabled) throw new AgentMemoryServiceError('disabled', '该项目尚未启用记忆')
    this.options.watcher.watch(ownerId, projectId, this.options.projects.resolveProjectCwd(projectId), (changedAt, path) => {
      if (!this.disposed && this.options.clients.has(ownerId)) emit(changedAt, path)
    })
    this.owners.add(ownerId)
  }

  unwatch(ownerId: BackendClientId, value: unknown): void {
    this.options.watcher.unwatch(ownerId, parseText(value, '项目标识'))
  }

  clearWatches(ownerId: BackendClientId): void {
    this.owners.delete(ownerId)
    this.options.watcher.clearOwner(ownerId)
  }

  /** 退出时先拒绝新订阅和投递，再逐项清理，单句柄失败不跳过其他客户端。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribeClients()
    const errors: unknown[] = []
    for (const owner of [...this.owners]) {
      try { this.clearWatches(owner) } catch (error) { errors.push(error) }
    }
    if (errors.length) throw new AggregateError(errors, '记忆订阅清理失败')
  }
}
