import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AgentProjectManager,
  createBackendPaths,
  initializeBackendDirectories,
  McpProjectConfigManager,
  McpProjectController,
  McpToolProvider,
} from '../index'
import { createFixtureCredentialCodec } from '../../test-support/credential-codec'

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'axon-core-mcp-')) })
afterEach(() => rmSync(directory, { recursive: true, force: true }))

/** 等待真实子进程留下关闭证据；等待有上限，不把调用 dispose 当成完成。 */
async function waitForClose(marker: string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!existsSync(marker) && Date.now() < deadline) await Bun.sleep(10)
  expect(existsSync(marker)).toBe(true)
}

describe('core MCP 非 Electron 装配', () => {
  test('真实 stdio 握手、分页、调用和配置重建使用同一中立业务链', async () => {
    expect(process.versions.electron).toBeUndefined()
    const paths = createBackendPaths({ dataDir: join(directory, 'data'), homeDir: join(directory, 'home') })
    initializeBackendDirectories(paths)
    const projects = new AgentProjectManager({ indexPath: paths.agentProjectsIndexPath, projectsDir: paths.agentProjectsDir })
    const project = projects.create({ name: 'MCP Project' })
    const options = {
      credentialCodec: createFixtureCredentialCodec(),
      resolveProjectDataDir: (projectId: string) => projects.resolveProjectDataDir(projectId),
    }
    const configs = new McpProjectConfigManager(options)
    const provider = new McpToolProvider({ applicationVersion: 'axon-test-version', getProjectConfig: (id) => configs.get(id) })
    const controller = new McpProjectController({ projects, configs, tools: provider })
    const script = fileURLToPath(new URL('../../test-support/mcp-stdio-fixture.mjs', import.meta.url))
    const testMarker = join(directory, 'test-closed')
    const cachedMarker = join(directory, 'cached-closed')
    const server = { type: 'stdio', command: process.execPath, args: [script, testMarker], startupTimeoutMs: 2_000, requestTimeoutMs: 2_000 }
    let cachedStarted = false
    try {
      const tested = await controller.testConnection(project.id, 'local', server)
      expect(tested.ok).toBe(true)
      if (!tested.ok) throw new Error(tested.message)
      expect(tested.tools.map((tool) => tool.name)).toEqual(['echo', 'second'])
      expect(tested.tools[0]).toMatchObject({ description: 'client=axon-test-version', annotations: { readOnlyHint: true } })
      await waitForClose(testMarker)
      expect(existsSync(join(projects.resolveProjectDataDir(project.id), 'mcp.json'))).toBe(false)

      await controller.save(project.id, { version: 1, servers: { local: { ...server, args: [script, cachedMarker], env: { AXON_TEST_SECRET: 'fixture-only-secret' } } } })
      const stored = readFileSync(join(projects.resolveProjectDataDir(project.id), 'mcp.json'), 'utf8')
      expect(stored).not.toContain('fixture-only-secret')
      expect(await new McpProjectConfigManager(options).get(project.id)).toEqual(await configs.get(project.id))
      const tools = await provider.getTools(project.id)
      cachedStarted = true
      expect(tools.map((tool) => tool.name)).toEqual(['mcp__local__echo', 'mcp__local__second'])
      expect(tools.every((tool) => tool.isDeferred && tool.permissionMode !== 'managed')).toBe(true)
      const called = await tools[0]!.execute({ value: 'hello' }, { toolUseId: 'echo-call' })
      expect(called.isError).not.toBe(true)
      expect(called.content).toEqual([{ type: 'text', text: JSON.stringify({ clientVersion: 'axon-test-version', name: 'echo', arguments: { value: 'hello' } }) }])
    } finally {
      controller.dispose()
      provider.dispose()
      await Promise.all([controller.drain(), provider.drain()])
      if (cachedStarted) await waitForClose(cachedMarker)
    }
  }, 10_000)

  test('真实 stdio 服务器忽略 EOF/SIGTERM 时，drain 等待最终进程 close，不能把 SIGKILL 调用当作退出', async () => {
    const marker = join(directory, 'stubborn')
    const script = fileURLToPath(new URL('../../test-support/mcp-stubborn-stdio-fixture.mjs', import.meta.url))
    const server = { type: 'stdio' as const, command: process.execPath, args: [script, marker],
      enabled: true, required: true, startupTimeoutMs: 2_000, requestTimeoutMs: 2_000 }
    const provider = new McpToolProvider({ applicationVersion: 'test',
      getProjectConfig: async () => ({ version: 1, servers: { local: server } }) })
    let drain: Promise<void> | undefined
    try {
      await provider.getTools('project')
      const pid = Number(readFileSync(`${marker}.pid`, 'utf8'))
      expect(Number.isSafeInteger(pid) && pid > 0).toBe(true)
      provider.dispose()
      drain = provider.drain()
      expect(await Promise.race([drain.then(() => '结束'), Bun.sleep(20).then(() => '等待')])).toBe('等待')
      await drain
      expect(existsSync(`${marker}.eof`)).toBe(true)
      expect(existsSync(`${marker}.term`)).toBe(true)
      let alive = true
      try { process.kill(pid, 0) }
      catch (error) { expect(error).toMatchObject({ code: 'ESRCH' }); alive = false }
      expect(alive).toBe(false)
    } finally {
      provider.dispose()
      await (drain ?? provider.drain())
    }
  }, 10_000)

  test('真实 stdio 启动失败未产生 PID 时，不等待永远不会发生的进程 close', async () => {
    const provider = new McpToolProvider({ applicationVersion: 'test', getProjectConfig: async () => ({ version: 1, servers: {} }) })
    try {
      await expect(provider.testConnection({ type: 'stdio', command: join(directory, '不存在的程序'), enabled: true,
        required: true, startupTimeoutMs: 1_000, requestTimeoutMs: 1_000 })).rejects.toBeInstanceOf(Error)
    } finally {
      provider.dispose()
      await provider.drain()
    }
  })
})
