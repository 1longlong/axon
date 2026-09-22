/** 生产进程共享的 Agent 记忆监听器。 */

import { AgentMemoryWatcher } from './agent-memory-watcher'

let instance: AgentMemoryWatcher | undefined

export function getAgentMemoryWatcher(): AgentMemoryWatcher {
  instance ??= new AgentMemoryWatcher()
  return instance
}
