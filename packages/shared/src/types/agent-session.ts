/** Agent runtime 能力与应用侧会话元数据。 */

export type AgentPermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'

/** 中立思考等级；具体 runtime 负责按当前模型能力映射或收窄。 */
export type AgentThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** 模型可用的思考等级；缺失表示尚无可信能力信息，不能据此展示选择器。 */
export interface AgentReasoningCapability {
  levels: AgentThinkingLevel[]
  defaultLevel: AgentThinkingLevel
}

export const DEFAULT_AGENT_SESSION_TITLE = '新任务'
export const MAX_AGENT_SESSION_TITLE_LENGTH = 120

/** 单个记忆文件在某 Agent 会话上次构造请求时的元信息，不包含文件正文。 */
export interface AgentMemoryFileState {
  updatedAt: number
  size: number
}

/** 已注入或由模型成功读取的记忆路径到元信息的映射；用于检测内容陈旧。 */
export type AgentMemoryFileStates = Record<string, AgentMemoryFileState>

/** 会话创建后固定的 Agent runtime 归属，与具体协议和进程实现无关。 */
export type AgentRuntimeId = 'pi' | 'zima'

/** 跨主进程和 UI 的静态能力声明；具体模型等级仍由渠道能力查询决定。 */
export interface AgentRuntimeCapabilities {
  thinkingLevel: boolean
  nestedProjectInstructions: 'automatic' | 'manual'
}

export const AGENT_RUNTIME_CAPABILITIES: Record<AgentRuntimeId, AgentRuntimeCapabilities> = {
  pi: { thinkingLevel: true, nestedProjectInstructions: 'automatic' },
  zima: { thinkingLevel: true, nestedProjectInstructions: 'manual' },
}

/**
 * Agent 会话元数据。根会话来自全局索引；子 Agent 来自根目录 state.json。
 * 自有 JSONL 是唯一展示源；runtime artifact 是唯一 resume 凭据。
 */
export interface AgentSessionMeta {
  id: string
  runtimeId: AgentRuntimeId
  title: string
  channelId?: string
  modelId?: string
  /** 所属项目；运行 cwd 由项目的唯一工作区解析。 */
  projectId?: string
  /** runtime 侧会话 ID，resume 时经 adapter 扩展输入传入。 */
  sdkSessionId?: string
  /** runtime session artifact 的精确路径；避免仅按 ID 子串定位 artifact。 */
  runtimeSessionFile?: string
  /** 会话级权限模式，持久化以便重启恢复。 */
  permissionMode?: AgentPermissionMode
  /** 会话级思考等级；缺失时按 medium 处理。 */
  thinkingLevel?: AgentThinkingLevel
  /** 缺失表示尚未建立首轮基线；空对象表示上一轮确认 memory/ 为空。 */
  memoryFileStates?: AgentMemoryFileStates
  /** 子 Agent 读取时由所属根目录推导；不会重复写入 state.json。 */
  parentSessionId?: string
  /** 子 Agent 读取时由所属根目录推导。 */
  rootSessionId?: string
  /** 从 state.json 对应 task 的 parentToolUseId 推导。 */
  parentToolUseId?: string
  /** 仅子会话存在；决定模型角色和可见工具边界。 */
  subagentType?: import('./agent-collaboration').AgentSubagentType
  createdAt: number
  updatedAt: number
}

export interface AgentSessionCreateInput {
  title?: string
  runtimeId?: AgentRuntimeId
  channelId?: string
  modelId?: string
  projectId?: string
  permissionMode?: AgentPermissionMode
  thinkingLevel?: AgentThinkingLevel
  /** 以下字段只供主进程协作编排层写入，renderer IPC 明确拒绝。 */
  parentSessionId?: string
  rootSessionId?: string
  parentToolUseId?: string
  subagentType?: import('./agent-collaboration').AgentSubagentType
}

export interface AgentSessionUpdateInput {
  title?: string
  /** null 表示清除对应字段。 */
  channelId?: string | null
  modelId?: string | null
  projectId?: string | null
  permissionMode?: AgentPermissionMode | null
  thinkingLevel?: AgentThinkingLevel | null
  sdkSessionId?: string
  runtimeSessionFile?: string
  /** null 清除基线；通常只由主进程记忆协调流程更新。 */
  memoryFileStates?: AgentMemoryFileStates | null
}
