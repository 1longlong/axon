/** 只验证关键持久化闭环；完整回归留到迭代收尾。 */
import { expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoopService } from './loop-service'

test('finish 等实际执行完成再结算，重启恢复结果并保留未提交坏尾', async () => {
  const root = mkdtempSync(join(tmpdir(), 'axon-loop-journal-check-'))
  let release!: () => void
  const gate = new Promise<void>((done) => { release = done })
  let token = ''
  const options = { directory: join(root, 'data'), validateDefinition: () => {} }
  let service: LoopService | undefined, restored: LoopService | undefined
  try {
    service = new LoopService({ ...options, execute: async (request) => {
      token = request.control.token
      service!.cli(token, ['finish', '--message', '测试通过', '--reason', '验证完成'])
      await gate
      return { phase: 'done', finalText: '已完成', costUsd: 0.01 }
    } })
    service.start({ commandDirectory: '/controlled/bin', socketPath: '/controlled/socket' })
    const loop = service.create({ name: '验收', workspacePath: root, channelId: 'channel', modelId: 'model',
      task: '检查测试', goal: '测试通过', cron: '0 0 1 1 *', timezone: 'Asia/Shanghai' })
    const runId = service.run(loop.id).runId!
    expect(service.get(loop.id).job.completedAt).toBeNull()
    expect(service.get(loop.id).job.running).toBe(true)
    release()
    for (let i = 0; i < 100 && service.get(loop.id).job.running; i++) await Bun.sleep(5)
    const detail = service.get(loop.id)
    expect(detail.job.enabled).toBe(false)
    expect(detail.job.completionReason).toBe('验证完成')
    expect(detail.runs[0]).toMatchObject({ id: runId, phase: 'done', message: '测试通过' })
    expect(service.getRun(loop.id, runId).finalText).toBe('已完成')
    expect(() => service!.cli(token, ['report', '--message', '迟到'])).toThrow('凭据已失效')
    service.dispose(); await service.drain()
    appendFileSync(join(root, 'data', loop.id, 'journal.jsonl'), '{"version":')
    restored = new LoopService(options)
    expect(restored.get(loop.id).job.completionReason).toBe('验证完成')
    expect(restored.getRun(loop.id, runId).message).toBe('测试通过')
    expect(readdirSync(join(root, 'data', loop.id)).some((file) => file.startsWith('journal-tail-'))).toBe(true)
  } finally {
    release(); service?.dispose(); restored?.dispose()
    await Promise.all([service?.drain(), restored?.drain()])
    rmSync(root, { recursive: true })
  }
})
