/** Agent Skills 设置编排：安全摘要、期望选择与安装服务之间的唯一桥梁。 */

import type {
  AgentSkillDiscoverySummary,
  AgentSkillSettingsSnapshot,
  InstallableSkillCatalog,
} from '@axon/shared'
import type { AgentSkillCatalogProvider } from './agent-skill-catalog'
import type { AgentSkillInstallationService } from './agent-skill-installation-service'
import { AgentSkillInstallationError } from './agent-skill-installation-service'
import type { AgentSkillCatalog } from './project-skill-discovery'
import { waitWithSignal } from '../async/wait-with-signal'
import { AsyncWorkTracker } from '../async/async-work-tracker'

export interface AgentSkillSettingsControllerOptions {
  catalog: AgentSkillCatalogProvider
  installations: Pick<AgentSkillInstallationService, 'getState' | 'getDesiredCatalogIds' | 'reconcile'>
  discoverGlobalSkills: () => AgentSkillCatalog
}

function availableSummaries(catalog: InstallableSkillCatalog): AgentSkillSettingsSnapshot['available'] {
  return catalog.packages.map((item) => ({
    catalogId: item.catalogId,
    name: item.name,
    version: item.version,
    description: item.description,
    contentHash: item.contentHash,
  }))
}

function discoveredSummaries(catalog: AgentSkillCatalog): AgentSkillDiscoverySummary[] {
  return [
    ...catalog.skills.map((skill) => ({ ...skill, effective: true as const })),
    ...catalog.shadowedSkills.map((skill) => ({ ...skill, effective: false as const })),
  ].map((skill) => ({
    name: skill.name,
    description: skill.description,
    directoryKind: skill.directoryKind,
    relativeInstructionPath: skill.relativeInstructionPath,
    effective: skill.effective,
  })).sort((left, right) => left.name.localeCompare(right.name) || Number(right.effective) - Number(left.effective))
}

function parseDesiredIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 200) throw new AgentSkillInstallationError('invalid_selection', 'Skill 选择格式无效')
  if (!value.every((item) => typeof item === 'string')) throw new AgentSkillInstallationError('invalid_selection', 'Skill 选择格式无效')
  return value.map((item) => item.trim())
}

export class AgentSkillSettingsController {
  private readonly lifetime = new AbortController()
  private readonly work = new AsyncWorkTracker()
  constructor(private readonly options: AgentSkillSettingsControllerOptions) {}

  /** 可取消地读取目录，再返回安全摘要；不暴露正文、绝对路径或暂存状态。 */
  getSnapshot(signal?: AbortSignal): Promise<AgentSkillSettingsSnapshot> {
    return this.work.run(() => this.readSnapshot(this.signal(signal)))
  }

  /** 目录 Promise 登记到真实完成，退出只取消等待，迟到结果不扫描安装目录。 */
  private async readSnapshot(signal: AbortSignal): Promise<AgentSkillSettingsSnapshot> {
    this.ensureActive(signal)
    const catalog = await waitWithSignal(this.work.run(() => Promise.resolve(this.options.catalog.getCatalog())), signal)
    this.ensureActive(signal)
    const state = this.options.installations.getState()
    return {
      available: availableSummaries(catalog),
      desiredCatalogIds: this.options.installations.getDesiredCatalogIds(),
      installed: state.installed,
      discovered: discoveredSummaries(this.options.discoverGlobalSkills()),
      failures: [],
    }
  }

  /** 目录读取可取消；写盘前复核信号，同步核对开始后不把取消等待伪装成回滚。 */
  apply(rawIds: unknown, signal?: AbortSignal): Promise<AgentSkillSettingsSnapshot> {
    return this.work.run(() => this.applySelection(rawIds, this.signal(signal)))
  }

  /** 退出发生在目录等待时禁止安装；已进入同步 reconcile 的写盘段仍完整执行。 */
  private async applySelection(rawIds: unknown, signal: AbortSignal): Promise<AgentSkillSettingsSnapshot> {
    this.ensureActive(signal)
    const desiredIds = parseDesiredIds(rawIds)
    const catalog = await waitWithSignal(this.work.run(() => Promise.resolve(this.options.catalog.getCatalog())), signal)
    this.ensureActive(signal)
    const result = this.options.installations.reconcile(catalog, desiredIds)
    return {
      available: availableSummaries(catalog),
      desiredCatalogIds: result.desiredCatalogIds,
      installed: result.installed,
      discovered: discoveredSummaries(this.options.discoverGlobalSkills()),
      failures: result.failures,
    }
  }

  private signal(signal?: AbortSignal): AbortSignal {
    return signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal
  }
  private ensureActive(signal: AbortSignal): void {
    if (signal.aborted) throw new DOMException('Skills 设置操作已取消', 'AbortError')
  }
  /** 退出封住查询/安装入口并取消目录等待，不中断已接纳的同步原子写盘。 */
  dispose(): void { this.lifetime.abort(new DOMException('Skills 设置操作已取消', 'AbortError')) }
  /** 等待原目录 provider 和设置操作结束，避免取消后丢失仍存活的工作。 */
  drain(): Promise<void> { return this.work.drain() }
}
