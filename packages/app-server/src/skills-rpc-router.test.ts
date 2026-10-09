import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createBackend, createBackendPaths, createCredentialCodec } from '@axon/core'
import type { AxonBackend, BackendOptions } from '@axon/core'
import { APP_SERVER_METHODS as methods, APP_SERVER_NOTIFICATIONS as notices, APP_SERVER_RPC_OPTIONS } from '@axon/shared'
import type { AgentSkillSettingsSnapshot, AppServerClient, InstallableSkillCatalog, InstallableSkillPackage, RpcJsonObject, RpcJsonValue } from '@axon/shared'
import { AppServerConnection, JsonRpcPeer } from './index'

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })

function skill(version = '1.0.0', body = '# 审查正文'): InstallableSkillPackage {
  const files = [['SKILL.md', `---\nname: review-code\ndescription: 审查关键代码\n---\n\n${body}`],
    ['references/rules.md', '# 私有规则'], ['scripts/check.sh', '#!/bin/sh\nexit 0\n']].map(([path, text]) => {
    const bytes = Buffer.from(text!)
    return { path: path!, contentBase64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex'),
      ...(path === 'scripts/check.sh' ? { executable: true } : {}) }
  })
  const canonical = [...files].sort((a, b) => a.path.localeCompare(b.path)).map((file) => `${file.path}\0${file.sha256}\n`).join('')
  return { catalogId: 'fixture/review-code', name: 'review-code', version, description: '审查关键代码',
    contentHash: createHash('sha256').update(canonical).digest('hex'), files }
}

/** 使用实际工厂、受管目录和安装仓储；catalog 是隔离来源，不修改正式 HOME。 */
async function open(getCatalog?: NonNullable<BackendOptions['skillCatalog']>['getCatalog']) {
  const directory = mkdtempSync(join(tmpdir(), 'axon-skills-rpc-'))
  let catalog: InstallableSkillCatalog = { packages: [] }
  const upstream = new PassThrough(), downstream = new PassThrough()
  const parent = new JsonRpcPeer(downstream, upstream, { ...APP_SERVER_RPC_OPTIONS, requestTimeoutMs: 2_000 })
  const child = new JsonRpcPeer(upstream, downstream, { ...APP_SERVER_RPC_OPTIONS, requestTimeoutMs: 2_000 })
  let backend: AxonBackend
  const connection = new AppServerConnection({ peer: child, bootstrap: () => {
    backend = createBackend({ paths: createBackendPaths({ dataDir: join(directory, 'data'), homeDir: directory }),
      applicationVersion: '0.1.3', credentialCodec: createCredentialCodec(), skillCatalog: { getCatalog: getCatalog ?? (() => catalog) },
      resolveAdapter: () => ({ async *query() { throw new Error('Skills 设置不得执行 Agent') }, abort() {}, dispose() {}, async drain() {} }) })
    return { backend, applicationVersion: '0.1.3', capabilities: { runtimes: [], credentialStorage: 'unavailable', channelTargetConfirmation: false } }
  } })
  cleanups.push(() => { connection.close(); parent.close(); upstream.destroy(); downstream.destroy(); rmSync(directory, { recursive: true, force: true }) })
  await parent.request(methods.INITIALIZE, { protocolVersion: 1, client: { name: 'axon-skills-fixture', version: '0.1.3' },
    hostCapabilities: { credentialStorage: 'unavailable', channelTargetConfirmation: false } })
  const main = await parent.request(methods.REGISTER_CLIENT, { kind: 'main' }) as unknown as AppServerClient
  const quick = await parent.request(methods.REGISTER_CLIENT, { kind: 'quick' }) as unknown as AppServerClient
  const events: RpcJsonObject[] = [], persisted: boolean[] = []
  parent.handleNotification(notices.SETTINGS_UPDATED, (params) => {
    const packet = params as RpcJsonObject
    events.push(packet); persisted.push(JSON.stringify(packet.settings) === JSON.stringify(backend!.settings.get()))
  })
  const request = (method: string, input?: RpcJsonValue, client = main, signal?: AbortSignal) => parent.request(method,
    { clientId: client.clientId, ...(input === undefined ? {} : { input }) }, { timeoutMs: 0, signal })
  const apply = async (ids: RpcJsonValue = ['fixture/review-code'], client = main, signal?: AbortSignal) =>
    await request(methods.SKILLS_APPLY_SETTINGS, ids, client, signal) as unknown as AgentSkillSettingsSnapshot
  return { directory, parent, connection, backend: backend!, main, quick, request, apply, events, persisted,
    setCatalog(value: InstallableSkillCatalog) { catalog = value }, disconnect() { upstream.destroy(); downstream.destroy() } }
}

describe('Skills 设置应用协议', () => {
  test('真实空目录和全局优先级摘要；返回不含正文/绝对路径，身份与固定字段不可绕过', async () => {
    const f = await open()
    expect(await f.request(methods.SKILLS_GET_SETTINGS)).toEqual({ available: [], desiredCatalogIds: [], installed: [], discovered: [], failures: [] })
    for (const [root, description] of [[f.backend.paths.managedSkillsDir, 'Axon 版本'], [f.backend.paths.userSkillsDir, '用户版本']]) {
      mkdirSync(join(root!, 'review-code'), { recursive: true })
      writeFileSync(join(root!, 'review-code', 'SKILL.md'), `---\nname: review-code\ndescription: ${description}\n---\n\n不得返回的正文`)
    }
    const snapshot = await f.request(methods.SKILLS_GET_SETTINGS, undefined, f.quick)
    expect(snapshot).toMatchObject({ discovered: [
      { name: 'review-code', directoryKind: 'builtin', effective: true }, { name: 'review-code', directoryKind: 'user', effective: false },
    ] })
    expect(JSON.stringify(snapshot)).not.toContain(f.directory)
    expect(JSON.stringify(snapshot)).not.toContain('不得返回的正文')
    expect(JSON.stringify(snapshot)).not.toContain('contentBase64')
    const foreign = f.backend.clients.register()
    await expect(f.parent.request(methods.SKILLS_GET_SETTINGS, { clientId: foreign })).rejects.toMatchObject({ code: -32004 })
    await expect(f.parent.request(methods.SKILLS_GET_SETTINGS, { clientId: f.main.clientId, input: f.directory })).rejects.toMatchObject({ code: -32602 })
    await expect(f.parent.request(methods.SKILLS_APPLY_SETTINGS, { clientId: f.main.clientId, input: [], owner: f.quick.clientId })).rejects.toMatchObject({ code: -32602 })
    expect(f.events).toEqual([])
  })

  test('实际原子安装/修复/更新/卸载；设置落盘后同时通知主窗口和快捷入口，未知目录保留', async () => {
    const f = await open(); f.setCatalog({ packages: [skill()] })
    await f.request(methods.UPDATE_SETTINGS, { themeMode: 'dark', agentSystemPrompt: '用户规则' })
    f.events.length = 0; f.persisted.length = 0
    const first = await f.apply([' fixture/review-code '])
    const instruction = join(f.backend.paths.managedSkillsDir, 'review-code', 'SKILL.md')
    expect(first).toMatchObject({ desiredCatalogIds: ['fixture/review-code'], installed: [{ version: '1.0.0' }], failures: [],
      discovered: [{ name: 'review-code', effective: true }] })
    expect(readFileSync(instruction, 'utf8')).toContain('# 审查正文')
    expect(statSync(join(dirname(instruction), 'scripts/check.sh')).mode & 0o111).not.toBe(0)
    expect(f.events.map((event) => event.clientId)).toEqual([f.main.clientId, f.quick.clientId])
    expect(f.persisted).toEqual([true, true])
    expect(f.backend.settings.get()).toMatchObject({ themeMode: 'dark', agentSystemPrompt: '用户规则', agentSkillCatalogIds: ['fixture/review-code'] })
    expect(JSON.parse(readFileSync(f.backend.paths.skillInstallationsPath, 'utf8')).installed).toEqual(first.installed)
    expect(JSON.stringify(first)).not.toContain('contentBase64')
    expect(JSON.stringify(first)).not.toContain('# 审查正文')
    expect((await f.apply()).installed).toEqual(first.installed)
    writeFileSync(instruction, '损坏内容')
    await f.apply(); expect(readFileSync(instruction, 'utf8')).toContain('# 审查正文')
    f.setCatalog({ packages: [skill('2.0.0', '# 更新正文')] })
    expect((await f.apply()).installed[0]?.version).toBe('2.0.0')
    expect(readFileSync(instruction, 'utf8')).toContain('# 更新正文')
    const manual = join(f.backend.paths.managedSkillsDir, 'manual')
    mkdirSync(manual); writeFileSync(join(manual, 'SKILL.md'), '手动文件保留')
    const removed = await f.apply([], f.quick)
    expect(removed.desiredCatalogIds).toEqual([]); expect(removed.installed).toEqual([])
    expect(existsSync(instruction)).toBe(false)
    expect(readFileSync(join(manual, 'SKILL.md'), 'utf8')).toBe('手动文件保留')
    expect(f.persisted.every(Boolean)).toBe(true)
  })

  test('坏选择/输入和 catalog 不写盘、不通知；普通设置不能绕过专用安装', async () => {
    const f = await open(); f.setCatalog({ packages: [skill()] })
    const bad: RpcJsonValue[] = [null, 'fixture/review-code', [1], ['unknown'], ['', 'fixture/review-code'],
      ['fixture/review-code', ' fixture/review-code '], Array.from({ length: 201 }, () => 'fixture/review-code'),
      { ids: ['fixture/review-code'], root: f.directory }, { files: [], catalogId: 'malicious' }]
    for (const input of bad) await expect(f.apply(input)).rejects.toMatchObject({ code: -32602 })
    await expect(f.request(methods.UPDATE_SETTINGS, { agentSkillCatalogIds: ['fixture/review-code'] })).rejects.toMatchObject({ code: -32602 })
    const broken = skill(); broken.files[0]!.sha256 = '0'.repeat(64)
    f.setCatalog({ packages: [broken] })
    await expect(f.apply()).rejects.toMatchObject({ code: -32603, message: 'RPC 请求处理失败' })
    expect(f.backend.settings.get().agentSkillCatalogIds).toEqual([])
    expect(existsSync(f.backend.paths.settingsPath)).toBe(false)
    expect(existsSync(f.backend.paths.skillInstallationsPath)).toBe(false)
    expect(f.events).toEqual([])
  })

  test('逐项失败保留真实期望状态；保存选择后发生未知错误仍通知设置，不暴露内部路径', async () => {
    const f = await open(); f.setCatalog({ packages: [skill()] })
    const occupied = join(f.backend.paths.managedSkillsDir, 'review-code')
    mkdirSync(occupied, { recursive: true }); writeFileSync(join(occupied, 'SKILL.md'), '未登记的用户文件')
    const result = await f.apply()
    expect(result).toMatchObject({ desiredCatalogIds: ['fixture/review-code'], installed: [],
      failures: [{ catalogId: 'fixture/review-code', message: '目标目录已存在但不属于 Axon 安装清单' }] })
    expect(readFileSync(join(occupied, 'SKILL.md'), 'utf8')).toBe('未登记的用户文件')
    expect(f.events).toHaveLength(2)
    expect(f.persisted).toEqual([true, true])
    const blocked = await open(); blocked.setCatalog({ packages: [skill()] })
    mkdirSync(dirname(blocked.backend.paths.managedSkillsDir), { recursive: true })
    writeFileSync(blocked.backend.paths.managedSkillsDir, '阻止安装的普通文件')
    await expect(blocked.apply()).rejects.toMatchObject({ code: -32603, message: 'RPC 请求处理失败' })
    expect(blocked.backend.settings.get().agentSkillCatalogIds).toEqual(['fixture/review-code'])
    expect(blocked.events).toHaveLength(2); expect(blocked.persisted).toEqual([true, true])
    expect(readFileSync(blocked.backend.paths.managedSkillsDir, 'utf8')).toBe('阻止安装的普通文件')
  })

  test('挂起目录读取期间取消/入口注销/物理断开；迟到 catalog 不安装或产生通知', async () => {
    for (const mode of ['cancel', 'detach', 'disconnect']) {
      let finish = (): void => {}, start = (): void => {}
      const catalog = new Promise<InstallableSkillCatalog>((resolve) => { finish = () => resolve({ packages: [skill()] }) })
      const started = new Promise<void>((resolve) => { start = resolve })
      const f = await open(() => { start(); return catalog })
      const abort = new AbortController()
      const pending = f.apply(undefined, f.main, abort.signal)
      const outcome = pending.catch((error: unknown) => error)
      await started
      if (mode === 'cancel') abort.abort()
      else if (mode === 'detach') await f.parent.request(methods.DETACH_CLIENT, { clientId: f.main.clientId })
      else f.disconnect()
      expect(await outcome).toBeInstanceOf(Error)
      finish(); await Promise.resolve(); await Promise.resolve()
      expect(f.backend.settings.get().agentSkillCatalogIds).toEqual([])
      expect(existsSync(f.backend.paths.skillInstallationsPath)).toBe(false)
      expect(existsSync(join(f.backend.paths.managedSkillsDir, 'review-code'))).toBe(false)
      expect(f.events).toEqual([])
      if (mode !== 'disconnect') expect(await f.request(methods.GET_SETTINGS, undefined, f.quick)).toMatchObject({ agentSkillCatalogIds: [] })
    }
  })

  test('同步安装已接纳后取消响应等待不回滚、不重投；存活入口仍收到真实已保存状态', async () => {
    let reads = 0
    const f = await open(() => { reads += 1; return { packages: [skill()] } })
    const abort = new AbortController(), update = f.backend.settings.update
    f.backend.settings.update = (input) => {
      const saved = update(input)
      if ('agentSkillCatalogIds' in input) abort.abort()
      return saved
    }
    const outcome = f.apply(undefined, f.main, abort.signal).catch((error: unknown) => error)
    expect(await outcome).toBeInstanceOf(Error)
    // 同步写盘已完成，但路由的 finally 通知仍在微任务中交付。
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(reads).toBe(1)
    expect(readFileSync(join(f.backend.paths.managedSkillsDir, 'review-code', 'SKILL.md'), 'utf8')).toContain('# 审查正文')
    expect(f.backend.settings.get().agentSkillCatalogIds).toEqual(['fixture/review-code'])
    expect(f.events.map((event) => event.clientId)).toEqual([f.main.clientId, f.quick.clientId])
    expect(f.persisted).toEqual([true, true])
  })
})
