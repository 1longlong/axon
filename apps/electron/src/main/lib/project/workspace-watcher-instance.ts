/** 生产进程共享监听器；所有窗口按 ownerId 隔离订阅。 */

import { WorkspaceWatcher } from './workspace-watcher'

let instance: WorkspaceWatcher | undefined

export function getWorkspaceWatcher(): WorkspaceWatcher {
  instance ??= new WorkspaceWatcher()
  return instance
}
