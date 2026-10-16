import { afterEach, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonRpcPeer, registerExecHostBridge, registerPrivateHostBridge } from '@axon/app-server'
import { createCredentialCodec } from '@axon/core'
import { BACKEND_DIRECTORY_LOCK_FILE } from '@axon/host-node'
import { APP_SERVER_DIRECTORY_LOCK_ERROR, APP_SERVER_METHODS as methods, APP_SERVER_RPC_OPTIONS } from '@axon/shared'
import type { AppServerClient, AppServerExecBootstrap, Channel } from '@axon/shared'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

/** 真正启动独立服务，只测装配/写盘/EOF；不启动模型或 Shell 预热。 */
function open(options: { exec: boolean; bridge: boolean; dataDir?: string }) {
  const directory = mkdtempSync(join(tmpdir(), 'axon-exec-bootstrap-')), data = options.dataDir ?? join(directory, 'data')
  const child = spawn(process.execPath, [join(import.meta.dir, 'main.ts'), '--data-dir', data, '--home-dir', directory,
    '--application-version', '0.1.4', ...(options.exec ? ['--entry', 'exec'] : [])],
  { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, AXON_API_KEY: '', AXON_ZIMA_PYTHON: '' } })
  const exited = new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject) })
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  const peer = new JsonRpcPeer(child.stdout, child.stdin, { ...APP_SERVER_RPC_OPTIONS, requestTimeoutMs: 5_000 })
  const capabilities = registerPrivateHostBridge(peer, { credentialCodec: createCredentialCodec(), getClientSignal: () => undefined })
  let credentials = 0
  const bootstrap: AppServerExecBootstrap = { channels: [{ id: 'stable', name: '夹具', provider: 'openai',
    baseUrl: 'https://example.test/v1', models: [{ id: 'fixture', name: '模型', enabled: true }], enabled: true }],
  agent: { systemPrompt: 'transient-only', generateTitle: false, features: { skills: false, mcp: false, memory: false, tasks: false } } }
  if (options.bridge) registerExecHostBridge(peer, { bootstrap, resolveCredential: () => { credentials++; return 'fixture-secret' } })
  cleanups.push(async () => {
    peer.close()
    if (child.exitCode === null && child.signalCode === null) child.kill()
    child.stdin.destroy(); child.stdout.destroy()
    await exited
    rmSync(directory, { recursive: true, force: true })
  })
  return { peer, data, get stderr() { return stderr }, get credentials() { return credentials },
    initialize: () => peer.request(methods.INITIALIZE, { protocolVersion: 1,
      client: { name: 'axon-exec-fixture', version: '0.1.4' }, hostCapabilities: capabilities }),
    async eof() { child.stdin.end(); return await exited },
    async terminate() { child.kill('SIGKILL'); return await exited },
  }
}

describe('独立后端非交互可信装配', () => {
  test('exec 从私有桥装配，无密钥渠道落盘，不永久覆盖系统提示词，EOF 真正退出', async () => {
    const fixture = open({ exec: true, bridge: true })
    expect(await fixture.initialize()).toMatchObject({ dataDirectory: fixture.data, protocolVersion: 1 })
    const client = await fixture.peer.request(methods.REGISTER_CLIENT, { kind: 'external' }) as unknown as AppServerClient
    const channels = await fixture.peer.request(methods.CHANNEL_LIST, { clientId: client.clientId }) as unknown as Channel[]
    expect(channels.map((channel) => channel.id)).toEqual(['stable'])
    expect(channels[0]!.hasApiKey).toBe(false)
    expect(readFileSync(join(fixture.data, 'channels.json'), 'utf8')).not.toContain('secret')
    expect(await fixture.peer.request(methods.GET_SETTINGS, { clientId: client.clientId })).not.toHaveProperty('agentSystemPrompt')
    expect(fixture.credentials).toBe(0)
    expect(await fixture.eof()).toBe(0)
    expect(fixture.stderr).not.toContain('fixture-secret')
  })

  test('exec 缺桥则初始化失败且尚未创建业务目录', async () => {
    const fixture = open({ exec: true, bridge: false })
    await expect(fixture.initialize()).rejects.toMatchObject({ code: -32003 })
    expect(existsSync(fixture.data)).toBe(false)
    expect(await fixture.eof()).toBe(0)
  })

  test('普通入口即使有 exec 私有桥也不读取其配置', async () => {
    const fixture = open({ exec: false, bridge: true })
    await fixture.initialize()
    const client = await fixture.peer.request(methods.REGISTER_CLIENT, { kind: 'external' }) as unknown as AppServerClient
    expect(await fixture.peer.request(methods.CHANNEL_LIST, { clientId: client.clientId })).toEqual([])
    expect(fixture.credentials).toBe(0)
    expect(await fixture.eof()).toBe(0)
  })

  test.skipIf(process.platform !== 'darwin')('真实 child 共写被拒绝，失败前不修改配置，正常 EOF 后同一锁文件可重用', async () => {
    const first = open({ exec: true, bridge: true })
    await first.initialize()
    const file = join(first.data, 'channels.json'), content = readFileSync(file, 'utf8')
    const inode = statSync(join(first.data, BACKEND_DIRECTORY_LOCK_FILE)).ino
    // 普通与 exec 入口都必须遵守同一锁，不能通过省略 --entry 绕过。
    for (const exec of [true, false]) {
      const competitor = open({ exec, bridge: exec, dataDir: first.data })
      await expect(competitor.initialize()).rejects.toMatchObject({ code: APP_SERVER_DIRECTORY_LOCK_ERROR, data: { code: 'busy' } })
      expect(readFileSync(file, 'utf8')).toBe(content)
      expect(await competitor.eof()).toBe(0)
    }
    expect(await first.eof()).toBe(0)
    const next = open({ exec: true, bridge: true, dataDir: first.data })
    await next.initialize()
    expect(statSync(join(first.data, BACKEND_DIRECTORY_LOCK_FILE)).ino).toBe(inode)
    expect(await next.eof()).toBe(0)
  })

  test.skipIf(process.platform !== 'darwin')('直接 SIGKILL 后内核释放独占，不删除锁文件或按 PID 猜测陈旧状态', async () => {
    const first = open({ exec: true, bridge: true })
    await first.initialize()
    const file = join(first.data, BACKEND_DIRECTORY_LOCK_FILE), inode = statSync(file).ino
    expect(await first.terminate()).toBeNull()
    expect(existsSync(file)).toBe(true)
    const next = open({ exec: true, bridge: true, dataDir: first.data })
    await next.initialize()
    expect(statSync(file).ino).toBe(inode)
    expect(await next.eof()).toBe(0)
  })
})
