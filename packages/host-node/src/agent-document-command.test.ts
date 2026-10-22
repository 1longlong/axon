import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { AgentDocumentCommandEnvironment } from './agent-document-command'

let root: string
const environments: AgentDocumentCommandEnvironment[] = []
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'axon-doc-command-test-'))) })
afterEach(async () => {
  for (const environment of environments.splice(0)) {
    environment.dispose()
    try { await environment.drain() } catch { /* 陌生文件用例只保留本测试自建目录。 */ }
    const generated = dirname(environment.commandDirectory)
    if (dirname(generated) !== realpathSync(tmpdir()) || !basename(generated).startsWith('axon-doc-')) throw new Error('测试命令目录身份异常，拒绝清理')
    rmSync(generated, { recursive: true, force: true })
  }
  rmSync(root, { recursive: true, force: true })
})
function environment(waitUntilUnused: () => Promise<void> = async () => {}): AgentDocumentCommandEnvironment {
  const entry = join(root, 'helper.mjs')
  writeFileSync(entry, 'process.stdout.write(JSON.stringify({argv:process.argv.slice(2), evil:process.env.AXON_DOC_EVIL??null, nodeOptions:process.env.NODE_OPTIONS??null, bunOptions:process.env.BUN_OPTIONS??null}))')
  const value = new AgentDocumentCommandEnvironment({ executable: process.execPath, entry, runtime: 'bun', waitUntilUnused })
  environments.push(value); return value
}
describe('文档受管命令环境', () => {
  test('固定执行器不读任务 dotenv/preload 或继承运行选项，参数原样传给 helper', async () => {
    const value = environment(), marker = join(root, 'executed.txt')
    writeFileSync(join(root, '.env'), 'AXON_DOC_EVIL=from-dotenv')
    writeFileSync(join(root, 'evil.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed')`)
    writeFileSync(join(root, 'bunfig.toml'), `preload = [${JSON.stringify(join(root, 'evil.cjs'))}]`)
    const child = Bun.spawn([join(value.commandDirectory, 'axon-doc'), 'extract', '--input', 'a file.pdf'], {
      cwd: root, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, AXON_DOC_EVIL: undefined,
        NODE_OPTIONS: `--require ${join(root, 'evil.cjs')}`, BUN_OPTIONS: `--preload ${join(root, 'evil.cjs')}` },
    })
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(code).toBe(0)
    // Bun 1.3.9 对显式 tsconfig 偶发输出原生目录诊断；协议允许 stderr，未知诊断仍失败。
    const diagnosticPrefix = `Internal error: directory mismatch for directory "${join(dirname(value.commandDirectory), 'tsconfig.json')}", fd `
    expect(err === '' || err.startsWith(diagnosticPrefix) && /^\d+\. You don't need to do anything, but this indicates a bug\.\s*$/.test(err.slice(diagnosticPrefix.length))).toBe(true)
    expect(JSON.parse(out)).toEqual({ argv: ['extract', '--input', 'a file.pdf'], evil: null, nodeOptions: null, bunOptions: null })
    expect(existsSync(marker)).toBe(false)
    expect(readFileSync(join(value.commandDirectory, 'axon-doc'), 'utf8')).toContain(process.execPath)
  })
  test('dispose 不提前删除命令，drain 等真正使用者结束后清理', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve }), value = environment(() => gate)
    value.dispose(); let finished = false
    const draining = value.drain().then(() => { finished = true })
    await Promise.resolve(); expect(finished).toBe(false); expect(existsSync(value.commandDirectory)).toBe(true)
    release(); await draining
    expect(existsSync(value.commandDirectory)).toBe(false)
  })
  test('目录混入陌生文件时保留并报错，不递归扫删', async () => {
    const value = environment(), note = join(dirname(value.commandDirectory), 'user.txt')
    writeFileSync(note, 'keep'); value.dispose()
    await expect(value.drain()).rejects.toThrow('陌生内容')
    expect(readFileSync(note, 'utf8')).toBe('keep')
  })
})
