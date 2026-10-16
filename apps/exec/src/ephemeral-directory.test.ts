import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseExecArguments } from './arguments'
import { ExecEphemeralDirectory } from './ephemeral-directory'
import { prepareExec } from './preflight'

const directories: string[] = []
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'axon-ephemeral-test-')))
  directories.push(root)
  const cwd = join(root, 'workspace'), homeDir = join(root, 'home'), dataDir = join(root, 'data')
  mkdirSync(cwd); mkdirSync(homeDir)
  const config = join(root, 'config.json')
  writeFileSync(config, JSON.stringify({ defaults: { channel: 'local' }, channels: [{ id: 'local', provider: 'custom',
    baseUrl: 'http://localhost:8123/v1', defaultModel: 'fixture', models: [{ id: 'fixture' }] }] }))
  const args = parseExecArguments(['exec', '--ephemeral', '--data-dir', dataDir, '--config-file', config, '--skip-git-repo-check', '任务'])
  const prepared = await prepareExec(args, { originalCwd: cwd, homeDir, platform: 'darwin', isTTY: true })
  return { prepared, dataDir, root, cwd, config }
}

describe('exec 临时业务目录', () => {
  test('原子私有根彼此独立；只删除自有目录，既有配置、历史、输出与工作区保持', async () => {
    const f = await fixture(); mkdirSync(f.dataDir)
    const kept = join(f.dataDir, 'existing.json'); writeFileSync(kept, 'original')
    const first = ExecEphemeralDirectory.create(f.prepared), second = ExecEphemeralDirectory.create(f.prepared)
    expect(first.dataDir).not.toBe(second.dataDir)
    expect(lstatSync(first.dataDir).mode & 0o777).toBe(0o700)
    mkdirSync(join(first.dataDir, 'agent-sessions')); writeFileSync(join(first.dataDir, 'agent-sessions/history'), 'temporary')
    writeFileSync(join(f.cwd, 'answer.txt'), 'user output')
    const task = first.dispose(); expect(first.dispose()).toBe(task); await task
    expect(existsSync(first.dataDir)).toBe(false); expect(existsSync(second.dataDir)).toBe(true)
    expect(readFileSync(kept, 'utf8')).toBe('original'); expect(readFileSync(join(f.cwd, 'answer.txt'), 'utf8')).toBe('user output')
    expect(existsSync(f.config)).toBe(true)
    await second.dispose(); expect(readdirSync(f.dataDir)).toEqual(['existing.json'])
  })

  test('内部链接不跟随删除；替换根或父目录拒绝清理，不删除替代目录', async () => {
    const f = await fixture(), safe = ExecEphemeralDirectory.create(f.prepared)
    writeFileSync(join(f.cwd, 'important.txt'), 'keep')
    symlinkSync(f.cwd, join(safe.dataDir, 'external'))
    await safe.dispose(); expect(readFileSync(join(f.cwd, 'important.txt'), 'utf8')).toBe('keep')
    const replaced = ExecEphemeralDirectory.create(f.prepared)
    renameSync(replaced.dataDir, `${replaced.dataDir}-original`); symlinkSync(f.cwd, replaced.dataDir)
    await expect(replaced.dispose()).rejects.toThrow('未能安全清理')
    expect(lstatSync(replaced.dataDir).isSymbolicLink()).toBe(true)
    const parent = ExecEphemeralDirectory.create(f.prepared)
    renameSync(f.dataDir, `${f.dataDir}-original`); mkdirSync(f.dataDir)
    await expect(parent.dispose()).rejects.toThrow('未能安全清理')
    expect(existsSync(`${f.dataDir}-original`)).toBe(true); expect(existsSync(f.dataDir)).toBe(true)
  })

  test('预检后的容器变为链接时不创建临时根，也不修改链接目标', async () => {
    const f = await fixture(); symlinkSync(f.cwd, f.dataDir)
    expect(() => ExecEphemeralDirectory.create(f.prepared)).toThrow('无法创建')
    expect(readdirSync(f.cwd)).toEqual([])
  })
})
