import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkAgentEnvironment } from './agent-environment-service'

describe('Agent 环境检查', () => {
  test('返回工作目录和命令可用性，不泄露底层异常', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'axon-agent-env-'))
    const result = await checkAgentEnvironment({ cwd: directory })
    expect(result.cwd).toBe(directory)
    expect(result.directory).toEqual({ available: true, writable: true, message: '工作目录可用' })
    expect(result.git.message).toMatch(/可用|不可用/)
    expect(JSON.stringify(result)).not.toContain('ENOENT')
  })

  test('非法目录返回稳定失败项但仍完成命令检查', async () => {
    const result = await checkAgentEnvironment({ cwd: join(tmpdir(), 'axon-no-such-directory') })
    expect(result.directory).toMatchObject({ available: false, writable: false })
    expect(result.directory.message).toContain('不存在')
    expect(result.node.message).toMatch(/可用|不可用/)
  })
})
