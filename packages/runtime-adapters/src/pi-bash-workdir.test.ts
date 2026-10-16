import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPiBashToolWithWorkdir } from './pi-agent-adapter'

test('Pi Bash 扩展 schema，目录绑定单次调用且原样保留命令与 SDK 参数', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'axon-pi-workdir-'))
  mkdirSync(join(directory, 'child'))
  const calls: Array<{ cwd: string; args: Record<string, unknown>; signal?: AbortSignal }> = []
  const factory = (cwd: string) => ({
    name: 'bash', label: 'Bash', description: '执行命令',
    parameters: { type: 'object', properties: { command: { type: 'string' }, timeout: { type: 'number' } }, required: ['command'] },
    execute: async (_id: string, args: Record<string, unknown>, signal?: AbortSignal) => {
      calls.push({ cwd, args, signal })
      return { content: [{ type: 'text', text: 'ok' }] }
    },
  })
  const tool = createPiBashToolWithWorkdir(factory as unknown as Parameters<typeof createPiBashToolWithWorkdir>[0], directory, undefined)
  const signal = new AbortController().signal
  try {
    expect(tool.parameters).toMatchObject({ properties: { workdir: { type: 'string' }, timeout: { type: 'number' } }, required: ['command'] })
    expect(tool.description).toContain('每次调用都必须显式设置 workdir')
    expect(tool.description).toContain('除非确有必要，否则不要使用 cd')
    expect(tool.description).not.toContain('在多个目录间切换')
    expect(tool.parameters).toMatchObject({ properties: { workdir: { description: expect.stringContaining('每次调用都显式填写') } } })
    const args = { command: 'cd .. && pwd', workdir: 'child', timeout: 7 }
    await tool.execute('one', args, signal, undefined, undefined!)
    await tool.execute('two', { command: 'pwd' }, signal, undefined, undefined!)
    await tool.execute('three', { command: 'pwd', workdir: '.' }, signal, undefined, undefined!)
    await tool.execute('outside', { command: 'pwd', workdir: '..' }, signal, undefined, undefined!)
    expect(calls).toEqual([
      { cwd: realpathSync(join(directory, 'child')), args: { command: 'cd .. && pwd', timeout: 7 }, signal },
      { cwd: realpathSync(directory), args: { command: 'pwd' }, signal },
      { cwd: realpathSync(directory), args: { command: 'pwd' }, signal },
      { cwd: realpathSync(join(directory, '..')), args: { command: 'pwd' }, signal },
    ])
    expect(args.workdir).toBe('child')
    await expect(tool.execute('bad', { command: 'pwd', workdir: 'missing' }, signal, undefined, undefined!)).rejects.toThrow('不存在')
    expect(calls).toHaveLength(4)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
