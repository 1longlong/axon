/** MCP 项目配置持久化：负责加密、原子写、恢复和项目私有路径隔离。 */

import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { MCP_PROJECT_CONFIG_VERSION } from '@axon/shared'
import type { McpConfigDiagnostic, McpProjectConfig } from '@axon/shared'
import type { CredentialCodec } from '../channel/channel-credential-codec'
import { parseMcpProjectConfig } from './mcp-validator'
import { writeJsonFileAtomic } from '../core/safe-file'

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
  /** 由项目管理器解析应用私有目录，不能直接使用 renderer 传入的路径。 */
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
  constructor(private readonly options: McpProjectConfigManagerOptions) {}

  get(projectId: string): McpProjectConfig {
    const path = this.configPath(projectId)
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
        try { plainText = this.options.credentialCodec.decrypt(envelope.encryptedConfig) }
        catch { credentialFailure = true; continue }
        const parsed = parseMcpProjectConfig(JSON.parse(plainText) as unknown)
        if (!parsed.ok) continue
        // 临时文件或备份恢复成功后立即重建主文件，后续读取不再依赖残留快照。
        if (candidate !== path) this.write(path, parsed.config, true)
        return structuredClone(parsed.config)
      } catch {
        // 当前候选不可用时继续尝试 .tmp 和 .bak。
      }
    }

    if (credentialFailure) {
      throw new McpProjectConfigManagerError('credential_error', 'MCP 配置无法使用当前系统安全存储解密')
    }
    throw new McpProjectConfigManagerError('storage_error', 'MCP 配置损坏且无法恢复')
  }

  /** 保存前复用唯一结构校验器；任何诊断都禁止覆盖上一份有效配置。 */
  save(projectId: string, value: unknown): McpProjectConfig {
    const parsed = parseMcpProjectConfig(value)
    if (!parsed.ok) {
      throw new McpProjectConfigManagerError(
        'invalid_input',
        parsed.diagnostics[0]?.message ?? 'MCP 配置无效',
        parsed.diagnostics,
      )
    }
    const path = this.configPath(projectId)
    this.write(path, parsed.config)
    return structuredClone(parsed.config)
  }

  /** 删除动作只落在项目私有目录；用户绑定的本地工作区不在可达路径内。 */
  delete(projectId: string): boolean {
    const path = this.configPath(projectId)
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

  /** 明文只存在于主进程内存；磁盘保存版本化密文 envelope，并限制文件权限。 */
  private write(path: string, config: McpProjectConfig, skipBackup = false): void {
    try {
      mkdirSync(dirname(path), { recursive: true })
      for (const candidate of [path, `${path}.tmp`, `${path}.bak`]) {
        if (existsSync(candidate) && !lstatSync(candidate).isFile()) {
          throw new McpProjectConfigManagerError('storage_error', 'MCP 配置快照路径不是普通文件')
        }
      }
      let encryptedConfig: string
      try { encryptedConfig = this.options.credentialCodec.encrypt(JSON.stringify(config)) }
      catch { throw new McpProjectConfigManagerError('credential_error', '加密 MCP 项目配置失败') }
      const envelope: StoredMcpProjectConfig = { storageVersion: MCP_STORAGE_VERSION, encryptedConfig }
      writeJsonFileAtomic(path, envelope, skipBackup)
      if (process.platform !== 'win32') chmodSync(path, 0o600)
    } catch (error) {
      if (error instanceof McpProjectConfigManagerError) throw error
      throw new McpProjectConfigManagerError('storage_error', '写入 MCP 项目配置失败')
    }
  }
}
