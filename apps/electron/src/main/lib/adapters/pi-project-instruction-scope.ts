/** Pi runtime 的 read 路径观察器：读取继续执行，新增目录指令在下一次模型请求前注入。 */

import { isAbsolute, relative, resolve } from 'node:path'
import type { AgentProjectInstructionSource } from '@axon/shared'
import {
  buildProjectInstructionSystemPrompt,
  canonicalizeProjectPath,
  resolveProjectInstructions,
} from '../project/project-instruction-resolver'

const MAX_ACTIVE_BYTES = 128 * 1024

interface ProjectInstructionScopeOptions {
  projectRoot: string
  initialSources: AgentProjectInstructionSource[]
}

function sourceKey(source: AgentProjectInstructionSource): string {
  return `${source.path}\0${source.contentHash}`
}

function isWithinRoot(root: string, candidate: string): boolean {
  const normalizedRoot = process.platform === 'win32' ? root.toLowerCase() : root
  const normalizedCandidate = process.platform === 'win32' ? candidate.toLowerCase() : candidate
  const pathRelative = relative(normalizedRoot, normalizedCandidate)
  return pathRelative === '' || (!pathRelative.startsWith('..') && !isAbsolute(pathRelative))
}

export class PiProjectInstructionScope {
  private readonly projectRoot: string
  private readonly delivered = new Set<string>()
  private readonly pending = new Map<string, AgentProjectInstructionSource>()
  private activeBytes = 0

  constructor(options: ProjectInstructionScopeOptions) {
    this.projectRoot = canonicalizeProjectPath(options.projectRoot)
    for (const source of options.initialSources) {
      this.delivered.add(sourceKey(source))
      this.activeBytes += Buffer.byteLength(source.content, 'utf8')
    }
  }

  /**
   * 只观察 read 的最终路径参数。新增指令先进入 pending，但不阻断或替代本次读取；
   * runtime 随后的上下文准备阶段会把 pending 内容交给模型。
   */
  observeRead(toolName: string, input: Record<string, unknown>): void {
    if (toolName.toLowerCase() !== 'read') return
    const rawPath = input.path
    if (typeof rawPath !== 'string' || !rawPath.trim()) return
    const targetPath = canonicalizeProjectPath(resolve(this.projectRoot, rawPath))
    if (!isWithinRoot(this.projectRoot, targetPath)) return

    try {
      const manifest = resolveProjectInstructions({ projectRoot: this.projectRoot, targetPath })
      for (const diagnostic of manifest.diagnostics) {
        console.warn(`[项目指令] ${diagnostic.path}: ${diagnostic.message}`)
      }
      for (const source of manifest.sources) {
        const key = sourceKey(source)
        if (this.delivered.has(key) || this.pending.has(key)) continue
        const bytes = Buffer.byteLength(source.content, 'utf8')
        if (this.activeBytes + bytes > MAX_ACTIVE_BYTES) {
          console.warn(`[项目指令] 已达到 ${MAX_ACTIVE_BYTES / 1024} KB 的本轮激活上限，跳过: ${source.path}`)
          continue
        }
        this.pending.set(key, source)
        this.activeBytes += bytes
      }
    } catch (error) {
      console.warn('[项目指令] read 目标作用域解析失败，已跳过动态激活:', error)
    }
  }

  /** 下一次模型请求前一次性消费新增来源，并把它们标记为本轮已下发。 */
  appendPending(systemPrompt: string): string {
    if (this.pending.size === 0) return systemPrompt
    const sources = [...this.pending.values()]
    this.pending.clear()
    for (const source of sources) this.delivered.add(sourceKey(source))
    return buildProjectInstructionSystemPrompt(systemPrompt, {
      projectRoot: this.projectRoot,
      sources,
      diagnostics: [],
      totalBytes: sources.reduce((total, source) => total + Buffer.byteLength(source.content, 'utf8'), 0),
    })
  }
}
