import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseExecArguments } from './arguments'
import { prepareExec } from './preflight'
import { ExecFileOutputError, ExecOutputFile } from './output-file'

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
async function fixture(path = 'answer.txt') {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'axon-exec-file-'))), cwd = join(directory, 'project'), homeDir = join(directory, 'home')
  mkdirSync(cwd); mkdirSync(homeDir); mkdirSync(join(homeDir, '.axon-exec'))
  writeFileSync(join(homeDir, '.axon-exec/config.json'), JSON.stringify({ defaults: { channel: 'local' }, channels: [{
    id: 'local', provider: 'custom', baseUrl: 'http://127.0.0.1:8123/v1', defaultModel: 'fixture', models: [{ id: 'fixture' }],
  }] }))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  const prepared = await prepareExec(parseExecArguments(['exec', '--skip-git-repo-check', '-o', path, '任务']),
    { originalCwd: cwd, homeDir, platform: 'darwin', isTTY: true })
  return { prepared, cwd, homeDir, directory }
}

describe('exec 原子最终正文文件', () => {
  test('预检不写文件；新建/替换保留全部 Unicode 和空白，私有文件无遗留临时项', async () => {
    const f = await fixture(), file = ExecOutputFile.prepare(f.prepared)!
    expect(existsSync(join(f.cwd, 'answer.txt'))).toBe(false)
    await file.write('  回复中文\n\n', new AbortController().signal)
    expect(readFileSync(join(f.cwd, 'answer.txt'), 'utf8')).toBe('  回复中文\n\n')
    expect(statSync(join(f.cwd, 'answer.txt')).mode & 0o777).toBe(0o600)
    await file.write('', new AbortController().signal)
    expect(readFileSync(join(f.cwd, 'answer.txt'), 'utf8')).toBe('')
    expect(readdirSync(f.cwd)).toEqual(['answer.txt'])
  })

  test('拒绝非普通目标/链接/缺父目录；不能覆盖业务数据、配置和绝对 Schema 路径', async () => {
    const f = await fixture(), schema = join(f.cwd, 'schema.json')
    writeFileSync(schema, '{}'); symlinkSync(schema, join(f.cwd, 'link'))
    mkdirSync(join(f.homeDir, '.axon')); mkdirSync(join(f.homeDir, '.axon-dev')); mkdirSync(f.prepared.dataDir, { recursive: true })
    const paths = [f.cwd, '/dev/null', join(f.cwd, 'link'), join(f.cwd, 'missing/out'),
      join(f.prepared.dataDir, 'messages.jsonl'), f.prepared.configuration.configPath!,
      join(f.homeDir, '.axon/out'), join(f.homeDir, '.axon-dev/out'), schema]
    f.prepared.args.flags.outputSchema = schema
    for (const path of paths) {
      f.prepared.outputLastMessage = path
      expect(() => ExecOutputFile.prepare(f.prepared)).toThrow('输出目标')
    }
    expect(readFileSync(schema, 'utf8')).toBe('{}')
    expect(readdirSync(f.cwd).sort()).toEqual(['link', 'schema.json'])
  })

  test('取消、后端运行期间目标变链接或父目录被替换不破坏原文件、不写入替代目录', async () => {
    const f = await fixture(), path = join(f.cwd, 'answer.txt')
    writeFileSync(path, 'original')
    const file = ExecOutputFile.prepare(f.prepared)!, canceled = new AbortController()
    canceled.abort(new Error('取消'))
    await expect(file.write('new', canceled.signal)).rejects.toThrow('取消')
    expect(readFileSync(path, 'utf8')).toBe('original')
    renameSync(f.cwd, join(f.directory, 'original-project')); mkdirSync(f.cwd)
    writeFileSync(path, 'replacement')
    await expect(file.write('new', new AbortController().signal)).rejects.toBeInstanceOf(ExecFileOutputError)
    expect(readFileSync(path, 'utf8')).toBe('replacement')
    expect(readFileSync(join(f.directory, 'original-project/answer.txt'), 'utf8')).toBe('original')
    expect(readdirSync(f.cwd)).toEqual(['answer.txt'])
    const next = ExecOutputFile.prepare(f.prepared)!
    rmSync(path); symlinkSync(join(f.directory, 'original-project/answer.txt'), path)
    await expect(next.write('new', new AbortController().signal)).rejects.toBeInstanceOf(ExecFileOutputError)
    expect(readFileSync(path, 'utf8')).toBe('original')
  })
})
