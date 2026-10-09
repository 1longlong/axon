import { expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { APP_SERVER_METHODS as methods } from '@axon/shared'
import type { Channel } from '@axon/shared'
import { AppServerProcess } from '../src/main/lib/desktop/app-server-process'
import { createFixtureCredentialCodec } from '../../../packages/core/test-support/credential-codec'

/** 使用离线协议解释器验证诊断 child；不读取用户渠道、不请求外部模型。 */
test('Zima 诊断在独立 child 经私有桥读取密文，一次执行后拒绝重投', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'axon-zima-live-offline-'))
  const interpreter = join(directory, 'controlled-python')
  const fixture = join(import.meta.dir, '../../../packages/runtime-adapters/src/fixtures/fake-zima-runtime.mjs')
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
  writeFileSync(interpreter, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)}\n`)
  chmodSync(interpreter, 0o700)
  const server = new AppServerProcess({
    launch: { executable: process.execPath, entryArgs: [join(import.meta.dir, 'zima-live-backend.ts')],
      dataDir: join(directory, 'data'), homeDir: directory, applicationVersion: '0.1.3', zimaPython: interpreter },
    credentialCodec: createFixtureCredentialCodec(), stopTimeoutMs: 2_000,
  })
  try {
    await server.start()
    expect(server.pid).not.toBe(process.pid)
    const client = await server.registerClient('external')
    const secret = 'sk-zima-live-offline-fixture'
    const channel = await server.request(client.clientId, methods.CHANNEL_CREATE, {
      name: '离线诊断', provider: 'custom', apiKey: secret, baseUrl: 'http://127.0.0.1:1/v1',
      models: [{ id: 'fake-model', name: '离线模型', enabled: true }],
    }) as unknown as Channel
    const peer = server.readyPeer()
    await expect(peer.request('axon/test/zima/live', { channelId: channel.id, unexpected: true }))
      .rejects.toMatchObject({ code: -32602 })
    const report = await peer.request('axon/test/zima/live', { channelId: channel.id })
    expect(report).toEqual({ runtime: 'zima', provider: 'custom', model: 'fake-model', result: 'success', answer: '完成' })
    expect(JSON.stringify(report)).not.toContain(secret)
    expect(readFileSync(join(directory, 'data/channels.json'), 'utf8')).not.toContain(secret)
    expect(readFileSync(join(directory, 'data/runtime/zima/live-model-smoke/state.json'), 'utf8')).toBe('{}')
    await expect(peer.request('axon/test/zima/live', { channelId: channel.id }))
      .rejects.toMatchObject({ code: -32002 })
  } finally {
    try { await server.stop() } finally { rmSync(directory, { recursive: true, force: true }) }
  }
}, 15_000)
