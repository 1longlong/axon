import { createContext, useContext, useEffect, useMemo } from 'react'
import type { ReactNode } from 'react'
import { useStore } from 'jotai'
import { AgentRendererController } from '@/atoms/agent-state'
import { AgentTaskRendererController } from '@/atoms/agent-task-state'

const AgentControllerContext = createContext<AgentRendererController | null>(null)
const AgentTaskControllerContext = createContext<AgentTaskRendererController | null>(null)

/** 在应用根部建立唯一 Agent 事件订阅，UI 只通过 controller 访问主进程。 */
export function AgentStateProvider({ children }: { children: ReactNode }): React.ReactElement {
  const store = useStore()
  const controller = useMemo(() => new AgentRendererController({
    ...window.axon.agent,
    listProjects: window.axon.agentProjects.list,
    createProject: window.axon.agentProjects.create,
    updateProject: window.axon.agentProjects.update,
    deleteProject: window.axon.agentProjects.delete,
    pickLocalWorkspace: window.axon.agentProjects.pickLocalWorkspace,
    listProjectDirectory: window.axon.agentProjects.listDirectory,
    readProjectFile: window.axon.agentProjects.readFile,
    readProjectDiff: window.axon.agentProjects.readDiff,
    watchProjectDirectory: window.axon.agentProjects.watchDirectory,
    unwatchProjectDirectory: window.axon.agentProjects.unwatchDirectory,
    onProjectDirectoryChanged: window.axon.agentProjects.onDirectoryChanged,
    listProjectMemory: window.axon.agentMemory.list,
    readProjectMemory: window.axon.agentMemory.read,
    writeProjectMemory: window.axon.agentMemory.write,
    watchProjectMemory: window.axon.agentMemory.watch,
    unwatchProjectMemory: window.axon.agentMemory.unwatch,
    onProjectMemoryChanged: window.axon.agentMemory.onChanged,
  }, store), [store])
  const taskController = useMemo(
    () => new AgentTaskRendererController(window.axon.agentTasks, store),
    [store],
  )

  useEffect(() => {
    const stopAgent = controller.start()
    const stopTasks = taskController.start()
    return () => {
      stopTasks()
      stopAgent()
    }
  }, [controller, taskController])

  return <AgentControllerContext.Provider value={controller}><AgentTaskControllerContext.Provider value={taskController}>{children}</AgentTaskControllerContext.Provider></AgentControllerContext.Provider>
}

export function useAgentTaskController(): AgentTaskRendererController {
  const controller = useContext(AgentTaskControllerContext)
  if (!controller) throw new Error('useAgentTaskController 必须在 AgentStateProvider 内使用')
  return controller
}

export function useAgentController(): AgentRendererController {
  const controller = useContext(AgentControllerContext)
  if (!controller) throw new Error('useAgentController 必须在 AgentStateProvider 内使用')
  return controller
}
