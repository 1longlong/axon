/** MCP 项目配置持久化：负责加密、原子写、恢复和项目私有路径隔离。 */

import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { MCP_PROJECT_CONFIG_VERSION } from '@axon/shared'
import type { McpConfigDiagnostic, McpProjectConfig } from '@axon/shared'
import type { CredentialCodec } from '../channel/credential-codec'
import { parseMcpProjectConfig } from './mcp-validator'
import { writeJsonFileAtomic } from '../storage/safe-file'

const MCP_STORAGE_VERSION = 1

interface StoredMcpProjectConfig {
  storageVersion: typeof MCP_STORAGE_VERSION
  encryptedConfig: string
}

export class McpProjectConfigManagerError extends Error {
  constructor(
    readonly code: 'invalid_input' | 'project_unavailable' | 'credential_error' | 'storage_error',
    message: string,
    readonly diagnostics?: McpConfigDiagnostic[],
  ) {
    super(message)
    this.name = 'McpProjectConfigManagerError'
  }
}

export interface McpProjectConfigManagerOptions {
  credentialCodec: CredentialCodec
  /** 由项目管理器解析应用私有目录，不能直接使用客户端传入的路径。 */
  resolveProjectDataDir: (projectId: string) => string
}

function emptyConfig(): McpProjectConfig {
  return { version: MCP_PROJECT_CONFIG_VERSION, servers: {} }
}

function isStoredEnvelope(value: unknown): value is StoredMcpProjectConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.storageVersion === MCP_STORAGE_VERSION
    && typeof record.encryptedConfig === 'string'
    && record.encryptedConfig.length > 0
    && Object.keys(record).every((key) => key === 'storageVersion' || key === 'encryptedConfig')
}

/** 管理单个项目的一份 MCP 配置；返回值始终是与内部状态分离的对象。 */
export class McpProjectConfigManager {
  /** 只用于淘汰异步返回的旧结果，不阻塞或排队配置操作。 */
  private readonly revisions = new Map<string, number>()

  constructor(private readonly options: McpProjectConfigManagerOptions) {}

  /** 等待宿主解密并验证候选；恢复前复核操作版本，不能覆盖期间保存或删除的新状态。 */
  async get(projectId: string): Promise<McpProjectConfig> {
    const path = this.configPath(projectId)
    const revision = this.revisions.get(projectId)
    const candidates = [path, `${path}.tmp`, `${path}.bak`]
    if (!candidates.some(existsSync)) return emptyConfig()

    let credentialFailure = false
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue
      try {
        if (!lstatSync(candidate).isFile()) continue
        const envelope: unknown = JSON.parse(readFileSync(candidate, 'utf-8'))
        if (!isStoredEnvelope(envelope)) continue
        let plainText: string
        try { plainText = await this.options.credentialCodec.decrypt(envelope.encryptedConfig) }
        catch {
          if (this.revisions.get(projectId) !== revision) return this.get(projectId)
          credentialFailure = true
          continue
        }
        const parsed = parseMcpProjectConfig(JSON.parse(plainText) as unknown)
        if (!parsed.ok) continue
        if (this.revisions.get(projectId) !== revision) return this.get(projectId)
        if (this.configPath(projectId) !== path) return this.get(projectId)
        // 候选密文已验证；直接发布原 envelope，避免恢复时再次异步加密造成覆盖竞态。
        if (candidate !== path) this.write(path, envelope, true)
        return structuredClone(parsed.config)
      } catch (error) {
        if (error instanceof McpProjectConfigManagerError) throw error
        // 当前候选不可用时继续尝试 .tmp 和 .bak。
      }
    }

    if (credentialFailure) {
      throw new McpProjectConfigManagerError('credential_error', 'MCP 配置无法使用当前系统安全存储解密')
    }
    throw new McpProjectConfigManagerError('storage_error', 'MCP 配置损坏且无法恢复')
  }

  /** 保存前复用唯一结构校验器；任何诊断都禁止覆盖上一份有效配置。 */
  async save(projectId: string, value: unknown): Promise<McpProjectConfig> {
    const parsed = parseMcpProjectConfig(value)
    if (!parsed.ok) {
      throw new McpProjectConfigManagerError(
        'invalid_input',
        parsed.diagnostics[0]?.message ?? 'MCP 配置无效',
        parsed.diagnostics,
      )
    }
    const path = this.configPath(projectId)
    const revision = (this.revisions.get(projectId) ?? 0) + 1
    this.revisions.set(projectId, revision)
    let encryptedConfig: string
    try { encryptedConfig = await this.options.credentialCodec.encrypt(JSON.stringify(parsed.config)) }
    catch { throw new McpProjectConfigManagerError('credential_error', '加密 MCP 项目配置失败') }
    // 加密返回后重新确认项目；更晚的保存/删除胜出，旧请求不得复活目录或覆盖新配置。
    if (this.configPath(projectId) !== path || this.revisions.get(projectId) !== revision) {
      throw new McpProjectConfigManagerError('storage_error', '本次 MCP 配置保存已被较新的操作替代')
    }
    this.write(path, { storageVersion: MCP_STORAGE_VERSION, encryptedConfig })
    return structuredClone(parsed.config)
  }

  /** 删除动作只落在项目私有目录；用户绑定的本地工作区不在可达路径内。 */
  delete(projectId: string): boolean {
    const path = this.configPath(projectId)
    this.revisions.set(projectId, (this.revisions.get(projectId) ?? 0) + 1)
    let removed = false
    try {
      for (const candidate of [path, `${path}.tmp`, `${path}.bak`]) {
        if (!existsSync(candidate)) continue
        rmSync(candidate, { force: true })
        removed = true
      }
    } catch {
      throw new McpProjectConfigManagerError('storage_error', '删除 MCP 项目配置失败')
    }
    return removed
  }

  private configPath(projectId: string): string {
    try { return join(this.options.resolveProjectDataDir(projectId), 'mcp.json') }
    catch {
      throw new McpProjectConfigManagerError('project_unavailable', 'MCP 配置所属项目不存在或不可用')
    }
  }

  /** 落盘段不再 await；只保存已加密 envelope，明文留在后端内存并限制文件权限。 */
  private write(path: string, envelope: StoredMcpProjectConfig, skipBackup = false): void {
    try {
      mkdirSync(dirname(path), { recursive: true })
      for (const candidate of [path, `${path}.tmp`, `${path}.bak`]) {
        if (existsSync(candidate) && !lstatSync(candidate).isFile()) {
          throw new McpProjectConfigManagerError('storage_error', 'MCP 配置快照路径不是普通文件')
        }
      }
      writeJsonFileAtomic(path, envelope, skipBackup)
      if (process.platform !== 'win32') chmodSync(path, 0o600)
    } catch (error) {
      if (error instanceof McpProjectConfigManagerError) throw error
      throw new McpProjectConfigManagerError('storage_error', '写入 MCP 项目配置失败')
    }
  }
}
