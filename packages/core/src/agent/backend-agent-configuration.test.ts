import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AgentProviderAdapter, AgentQueryInput, AgentStreamPayload, BackendAgentConfiguration, BackendAgentFeatures, RuntimeChannelDefinition } from '@axon/shared'
import { ChannelManager, createBackend, createBackendPaths, createCredentialCodec } from '../index'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
class Adapter implements AgentProviderAdapter {
  inputs: AgentQueryInput[] = []
  async *query(input: AgentQueryInput): AsyncIterable<AgentStreamPayload> {
    this.inputs.push(input)
    yield { kind: 'sdk_message', message: { type: 'assistant', message: { content: [{ type: 'text', text: '已完成' }] } } }
    yield { kind: 'sdk_message', message: { type: 'result', subtype: 'success' } }
  }
  abort(): void {}
  dispose(): void {}
  async drain(): Promise<void> {}
}
const definition: RuntimeChannelDefinition = { id: 'configured', name: '夹具', provider: 'openai', baseUrl: 'https://example.test/v1',
  models: [{ id: 'fixture-model', name: '夹具模型', enabled: true }], enabled: true }

/** 真实业务装配与文件上下文，只替换模型；关闭能力不能被已有项目/全局设置重新打开。 */
function open(configuration?: BackendAgentConfiguration) {
  const directory = mkdtempSync(join(tmpdir(), 'axon-agent-config-'))
  const paths = createBackendPaths({ dataDir: join(directory, 'data'), homeDir: directory })
  const adapter = new Adapter()
  let titleRequests = 0
  const backend = createBackend({ paths, applicationVersion: '0.1.4', credentialCodec: createCredentialCodec(), resolveAdapter: () => adapter,
    runtimeChannels: [definition], resolveRuntimeCredential: async () => 'fixture-secret', agentConfiguration: configuration,
    providerStream: async function* () { titleRequests++; yield { type: 'text_delta', delta: '生成的标题' } },
  })
  cleanups.push(async () => { backend.dispose(); await backend.drain(); rmSync(directory, { recursive: true, force: true }) })
  backend.settings.update({ agentSystemPrompt: 'persisted-prompt' })
  const workspace = join(directory, 'workspace'); mkdirSync(workspace)
  writeFileSync(join(workspace, 'AGENTS.md'), 'project-instruction-marker')
  for (const root of [join(workspace, '.agents', 'skills'), paths.managedSkillsDir, paths.userSkillsDir]) {
    const skill = join(root, 'fixture-skill'); mkdirSync(skill, { recursive: true })
    writeFileSync(join(skill, 'SKILL.md'), '---\nname: fixture-skill\ndescription: skill-catalog-marker\n---\n正文')
  }
  const project = backend.projects.create({ name: '夹具项目', workspace: { kind: 'local', path: workspace } })
  backend.projects.update(project.id, { memoryEnabled: true })
  backend.memoryService.write(project.id, 'MEMORY.md', 'memory-index-marker')
  let mcpRequests = 0
  backend.mcpTools.getTools = async () => {
    mcpRequests++
    return [{ name: 'fixture_mcp', description: 'MCP 夹具', inputSchema: { type: 'object' }, execute: async () => ({ content: '结果' }) }]
  }
  return { backend, adapter, paths, project, get mcpRequests() { return mcpRequests }, get titleRequests() { return titleRequests } }
}

describe('可信 Agent 装配开关', () => {
  test('输出要求只进根上下文，不改用户 prompt/永久设置/子 Agent；调用方改引用不影响本次装配', async () => {
    const configuration: BackendAgentConfiguration = { systemPrompt: 'transient', finalOutputInstruction: 'root-final-format-marker',
      generateTitle: false, features: { skills: false, mcp: false, memory: false, tasks: false } }
    const fixture = open(configuration)
    configuration.finalOutputInstruction = 'changed-format-marker'
    const root = await fixture.backend.agentRuns.createSession({ projectId: fixture.project.id, channelId: definition.id,
      modelId: 'fixture-model', approvalPolicy: 'never', userInputPolicy: 'reject' })
    const owner = fixture.backend.clients.register()
    await fixture.backend.agentRuns.send(owner, { sessionId: root.id, text: '  用户原文\n' }, () => {})
    expect(fixture.adapter.inputs[0]?.systemPrompt).toContain('root-final-format-marker')
    expect(fixture.adapter.inputs[0]?.systemPrompt).toContain('每次调用 bash 都必须显式设置 workdir')
    expect(fixture.adapter.inputs[0]?.systemPrompt).not.toContain('changed-format-marker')
    expect(fixture.adapter.inputs[0]?.prompt).toBe('  用户原文\n')
    const child = fixture.backend.sessions.create({ projectId: fixture.project.id, channelId: definition.id, modelId: 'fixture-model',
      parentSessionId: root.id, rootSessionId: root.id, parentToolUseId: 'tool-format-test', subagentType: 'coder' })
    await fixture.backend.agentRuns.send(owner, { sessionId: child.id, text: '子任务' }, () => {})
    expect(fixture.adapter.inputs).toHaveLength(2)
    expect(fixture.adapter.inputs[1]?.systemPrompt).not.toContain('root-final-format-marker')
    expect(fixture.adapter.inputs[1]?.systemPrompt).toContain('除非确有必要，否则不要使用 cd')
    expect(fixture.backend.settings.get().agentSystemPrompt).toBe('persisted-prompt')
    expect(JSON.stringify(fixture.backend.sessions.getMessages(root.id))).not.toContain('root-final-format-marker')
  })

  test('全部关闭不发现 Skills、不读记忆、不连接 MCP、不注册协作或额外生成标题', async () => {
    const configuration: BackendAgentConfiguration = { systemPrompt: 'transient-prompt', generateTitle: false,
      features: { skills: false, mcp: false, memory: false, tasks: false } }
    const fixture = open(configuration)
    // 调用方之后改引用，不能重新打开本次装配已关闭的能力。
    configuration.features.skills = true
    configuration.systemPrompt = 'changed-prompt'
    const session = await fixture.backend.agentRuns.createSession({ projectId: fixture.project.id,
      channelId: definition.id, modelId: 'fixture-model', approvalPolicy: 'never', userInputPolicy: 'reject' })
    const owner = fixture.backend.clients.register()
    const readMemory = fixture.backend.memoryService.read.bind(fixture.backend.memoryService)
    let memoryReads = 0
    fixture.backend.memoryService.read = (...args) => { memoryReads++; return readMemory(...args) }
    expect(await fixture.backend.agentRuns.send(owner, { sessionId: session.id, text: '任务' }, () => {})).toMatchObject({ success: true })
    const input = fixture.adapter.inputs[0]!
    expect(input.connection?.apiKey).toBe('fixture-secret')
    expect(input.systemPrompt).toContain('transient-prompt')
    expect(input.systemPrompt).toContain('project-instruction-marker')
    for (const marker of ['persisted-prompt', 'changed-prompt', 'skill-catalog-marker', 'memory-index-marker']) {
      expect(input.systemPrompt).not.toContain(marker)
    }
    expect(input.customTools?.map((tool) => tool.name)).toEqual(['AskUserQuestion'])
    expect(fixture.mcpRequests).toBe(0)
    expect(memoryReads).toBe(0)
    expect(fixture.backend.sessions.get(session.id)?.memoryFileStates).toBeUndefined()
    expect(fixture.backend.settings.get().agentSystemPrompt).toBe('persisted-prompt')
    expect(readFileSync(fixture.paths.channelsPath, 'utf8')).not.toContain('fixture-secret')
    expect(JSON.stringify(fixture.backend.sessions.getMessages(session.id))).not.toContain('fixture-secret')
    fixture.backend.dispose(); await fixture.backend.drain()
    expect(fixture.titleRequests).toBe(0)
  })

  test('开关各自独立，默认桌面上下文与工具仍装配', async () => {
    for (const disabled of [undefined, 'skills', 'mcp', 'memory', 'tasks'] as const) {
      const features: BackendAgentFeatures = { skills: true, mcp: true, memory: true, tasks: true }
      if (disabled) features[disabled] = false
      const fixture = open(disabled ? { systemPrompt: '', generateTitle: false, features } : undefined)
      const session = await fixture.backend.agentRuns.createSession({ title: '命名会话', projectId: fixture.project.id,
        channelId: definition.id, modelId: 'fixture-model', approvalPolicy: 'never', userInputPolicy: 'reject' })
      expect(await fixture.backend.agentRuns.send(fixture.backend.clients.register(), { sessionId: session.id, text: '任务' }, () => {}))
        .toMatchObject({ success: true })
      const input = fixture.adapter.inputs[0]!
      const names = input.customTools?.map((tool) => tool.name) ?? []
      expect(names.includes('SkillRead')).toBe(features.skills)
      expect(names.includes('fixture_mcp')).toBe(features.mcp)
      expect(names.includes('MemoryRead')).toBe(features.memory)
      expect(names.includes('Agent')).toBe(features.tasks)
      expect(input.systemPrompt?.includes('skill-catalog-marker')).toBe(features.skills)
      expect(input.systemPrompt?.includes('memory-index-marker')).toBe(features.memory)
      expect(input.systemPrompt?.includes('persisted-prompt')).toBe(disabled === undefined)
      expect(fixture.mcpRequests).toBe(features.mcp ? 1 : 0)
    }
  })
})

test('运行渠道稳定引用，无密钥持久化，运行凭据失败不读取持久凭据', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'axon-runtime-channel-')), path = join(directory, 'channels.json')
  cleanups.push(async () => rmSync(directory, { recursive: true, force: true }))
  let decrypts = 0, now = 1
  const manager = new ChannelManager({ configPath: path, credentialCodec: { ...createCredentialCodec(), decrypt: async () => { decrypts++; return 'fallback-secret' } },
    now: () => now, resolveRuntimeCredential: async (channel) => {
      if (channel.baseUrl !== definition.baseUrl) throw new Error('fixture-secret host error')
      return 'fixture-secret'
    } })
  manager.configureRuntimeChannels([definition])
  expect((await manager.resolve(definition.id)).apiKey).toBe('fixture-secret')
  expect(manager.get(definition.id)?.hasApiKey).toBe(false)
  expect(readFileSync(path, 'utf8')).not.toContain('secret')
  now++
  manager.configureRuntimeChannels([{ ...definition, name: '新名称' }])
  expect(manager.list()).toHaveLength(1)
  expect(manager.get(definition.id)).toMatchObject({ createdAt: 1, updatedAt: 2, name: '新名称' })
  await manager.update(definition.id, { baseUrl: 'https://elsewhere.test' })
  await expect(manager.resolve(definition.id)).rejects.toMatchObject({ code: 'credential_error', message: '读取渠道凭据失败' })
  expect(decrypts).toBe(0)
  expect(() => manager.configureRuntimeChannels([definition, definition])).toThrow('运行渠道配置无效')
  expect(existsSync(path)).toBe(true)
})
