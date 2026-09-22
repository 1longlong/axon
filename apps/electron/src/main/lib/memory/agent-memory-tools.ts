/** Agent 项目记忆工具与动态提示词：只通过受限服务访问 memory/。 */

import { AGENT_MEMORY_INDEX_FILE } from '@axon/shared'
import type {
  AgentCustomToolDefinition,
  AgentMemoryFile,
  AgentMemoryFileStates,
  AgentMemorySummary,
} from '@axon/shared'
import type { AgentMemoryService } from './agent-memory-service'
import { AgentMemoryServiceError } from './agent-memory-service'

const MEMORY_LIST_TOOL = 'MemoryList'
const MEMORY_READ_TOOL = 'MemoryRead'
const MEMORY_WRITE_TOOL = 'MemoryWrite'

export const AGENT_MEMORY_SAFE_TOOL_NAMES = [MEMORY_LIST_TOOL, MEMORY_READ_TOOL] as const
export const AGENT_MEMORY_EDIT_TOOL_NAMES = [MEMORY_WRITE_TOOL] as const

interface AgentMemoryToolOptions {
  projectId: string
  memory: Pick<AgentMemoryService, 'list' | 'read' | 'write'>
  /** 成功读取后推进当前会话基线；未重读的外部修改会在后续轮次持续提醒。 */
  onRead?: (file: AgentMemoryFile) => void
  /** 只同步当前会话已知的自身写入；失败不影响已经落盘的记忆。 */
  onWrite?: (file: AgentMemoryFile) => void
}

export interface AgentMemoryContext {
  prompt: string
  fileStates: AgentMemoryFileStates
  shouldPersistStates: boolean
}

interface AgentMemoryFileChange {
  kind: 'modified' | 'deleted'
  path: string
}

function parsePath(input: Record<string, unknown>): string | null {
  return typeof input.path === 'string' && input.path.trim() ? input.path.trim() : null
}

function failure(message: string): { content: string; isError: true } {
  return { content: message, isError: true }
}

function memoryFailure(error: unknown): { content: string; isError: true } {
  return failure(error instanceof AgentMemoryServiceError ? error.message : '项目记忆操作失败')
}

/**
 * 生成一轮 Agent 可见的记忆工具；服务会在真正执行时再次校验项目开关和路径，
 * 防止运行期间切换项目设置后沿用过期授权。
 */
export function createAgentMemoryTools(options: AgentMemoryToolOptions): AgentCustomToolDefinition[] {
  return [
    {
      name: MEMORY_LIST_TOOL,
      description: '列出当前项目 memory/ 中可用的 Markdown 记忆文件及其元信息。需要根据 MEMORY.md 查找相关主题文件，或确认记忆文件是否存在时调用。',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      execute: async () => {
        try {
          const summary = options.memory.list(options.projectId)
          return {
            content: {
              indexExists: summary.indexExists,
              totalBytes: summary.totalBytes,
              files: summary.files.map((file) => ({
                path: file.relativePath,
                size: file.size,
                updatedAt: file.updatedAt,
              })),
            },
          }
        } catch (error) { return memoryFailure(error) }
      },
    },
    {
      name: MEMORY_READ_TOOL,
      description: '读取当前项目 memory/ 下一个 Markdown 记忆文件的最新全文。MEMORY.md 只负责索引；任务涉及某个主题时，先读取对应文件再使用其中内容。',
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['path'],
        properties: { path: { type: 'string', description: '相对于 memory/ 的 Markdown 路径，例如 preferences.md。' } },
      },
      execute: async (input) => {
        const path = parsePath(input)
        if (!path) return failure('记忆路径无效')
        try {
          const file = options.memory.read(options.projectId, path)
          try { options.onRead?.(file) }
          catch (error) { console.warn('[项目记忆] 读取成功，但会话元信息同步失败:', error) }
          return { content: { path: file.relativePath, content: file.content, size: file.size, updatedAt: file.updatedAt } }
        } catch (error) { return memoryFailure(error) }
      },
    },
    {
      name: MEMORY_WRITE_TOOL,
      description: '创建或完整替换当前项目 memory/ 下一个 Markdown 记忆文件。仅在用户明确要求跨轮次记住，或明确建立了会持续影响后续工作的稳定规则、偏好或决策时调用；更新已有文件前先读取，并做最小合并。新增主题文件时同步维护 MEMORY.md 的简短索引。',
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['path', 'content'],
        properties: {
          path: { type: 'string', description: '相对于 memory/ 的 Markdown 路径。' },
          content: { type: 'string', description: '写入后的完整 Markdown 内容；已有文件会被完整替换。' },
        },
      },
      execute: async (input) => {
        const path = parsePath(input)
        if (!path || typeof input.content !== 'string') return failure('记忆路径或内容无效')
        try {
          const file = options.memory.write(options.projectId, path, input.content)
          try { options.onWrite?.(file) }
          catch (error) { console.warn('[项目记忆] 写入成功，但会话元信息同步失败:', error) }
          return { content: { path: file.relativePath, size: file.size, updatedAt: file.updatedAt } }
        } catch (error) { return memoryFailure(error) }
      },
    },
  ]
}

function escapePromptXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/**
 * 构造每轮最新的项目记忆说明；正文只包含索引，主题文件继续由 MemoryRead 按需加载。
 */
export function buildAgentMemoryPromptSection(
  index: AgentMemoryFile | null,
  changes: readonly AgentMemoryFileChange[] = [],
): string {
  const indexBody = index
    ? `<memory_index path="memory/${AGENT_MEMORY_INDEX_FILE}">\n${escapePromptXml(index.content)}\n</memory_index>`
    : `<memory_index path="memory/${AGENT_MEMORY_INDEX_FILE}" status="missing" />`
  const changeBody = changes.length > 0
    ? `\n\n<memory_changes>\n${changes.map((change) => (
        `<file kind="${change.kind}" path="memory/${escapePromptXml(change.path)}" />`
      )).join('\n')}\n</memory_changes>\n以上记忆文件自本会话上一轮后发生变化；旧上下文中的对应内容可能失效，使用前重新调用 MemoryRead。`
    : ''
  return `## 项目长期记忆
<system-reminder>
项目记忆已启用。${AGENT_MEMORY_INDEX_FILE} 是主题索引，当前内容如下；其他记忆文件不会自动进入上下文，需要时使用 MemoryRead 读取最新内容。

${indexBody}${changeBody}

当用户明确要求跨轮次记住某项信息，或明确建立了会持续影响后续工作的稳定规则、偏好或决策时，使用 MemoryWrite 做最小、具体、结构化的记录。更新已有主题前先读取并合并；创建新主题时同步更新 ${AGENT_MEMORY_INDEX_FILE}。写入成功后在回复中简要告知用户。不要仅给出建议而不执行已经明确要求的记忆写入。
</system-reminder>`
}

function createFileStates(summary: AgentMemorySummary): AgentMemoryFileStates {
  return Object.fromEntries(summary.files.map((file) => [
    file.relativePath,
    { updatedAt: file.updatedAt, size: file.size },
  ]))
}

function findStaleFiles(
  previous: AgentMemoryFileStates,
  current: AgentMemoryFileStates,
): AgentMemoryFileChange[] {
  const changes: AgentMemoryFileChange[] = []
  for (const [path, before] of Object.entries(previous)) {
    const state = current[path]
    if (!state) changes.push({ kind: 'deleted', path })
    else if (before.updatedAt !== state.updatedAt || before.size !== state.size) {
      changes.push({ kind: 'modified', path })
    }
  }
  return changes.sort((left, right) => left.path.localeCompare(right.path, 'zh-CN'))
}

function sameFileStates(left: AgentMemoryFileStates | undefined, right: AgentMemoryFileStates): boolean {
  if (!left) return false
  const paths = Object.keys(left)
  return paths.length === Object.keys(right).length && paths.every((path) => (
    left[path]?.updatedAt === right[path]?.updatedAt && left[path]?.size === right[path]?.size
  ))
}

/**
 * 每轮仅扫描 memory/ 元信息并读取索引正文；首次建立基线不产生“全部新增”提醒。
 */
export function resolveAgentMemoryContext(
  projectId: string,
  memory: Pick<AgentMemoryService, 'list' | 'read'>,
  previous: AgentMemoryFileStates | undefined,
): AgentMemoryContext {
  const summary = memory.list(projectId)
  const current = createFileStates(summary)
  const changes = previous ? findStaleFiles(previous, current) : []
  const index = summary.indexExists ? memory.read(projectId, AGENT_MEMORY_INDEX_FILE) : null
  // MEMORY.md 已进入本轮 prompt，可推进；删除文件已明确提醒，可移除。其余修改保持旧基线直到 MemoryRead。
  const fileStates: AgentMemoryFileStates = { ...(previous ?? {}) }
  for (const change of changes) {
    if (change.kind === 'deleted') delete fileStates[change.path]
  }
  const currentIndex = current[AGENT_MEMORY_INDEX_FILE]
  if (currentIndex) fileStates[AGENT_MEMORY_INDEX_FILE] = currentIndex
  else delete fileStates[AGENT_MEMORY_INDEX_FILE]
  return {
    prompt: buildAgentMemoryPromptSection(index, changes),
    fileStates,
    shouldPersistStates: !sameFileStates(previous, fileStates),
  }
}
