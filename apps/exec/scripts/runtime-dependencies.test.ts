import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, parse, resolve } from 'node:path'
import { buildExec } from './build'
import { copyRuntimeDependencies } from './runtime-dependencies'

const directories: string[] = []
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })
function fixture(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'axon-dependency-test-')))
  directories.push(path)
  return path
}
function packageAt(directory: string, name: string, version: string, extra: Record<string, unknown> = {}): void {
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, version, main: 'index.js', ...extra }))
  writeFileSync(join(directory, 'index.js'), 'export default "fixture"')
  mkdirSync(join(directory, 'assets')); writeFileSync(join(directory, 'assets/data.txt'), version)
}

describe('独立 CLI 依赖及构建目标边界', () => {
  test('复制包内资源、保留不同版本和循环；仅可选缺失依赖可略过，相对链接不指向源码', async () => {
    const root = fixture(), source = join(root, 'source/node_modules'), output = join(root, 'bundle/node_modules'),
      a = join(source, 'axon-fixture-a'), b = join(source, 'axon-fixture-b')
    packageAt(a, 'axon-fixture-a', '1.0.0', { dependencies: { 'axon-fixture-value': '1', 'axon-fixture-b': '1' },
      optionalDependencies: { 'axon-fixture-missing': '1' } })
    packageAt(b, 'axon-fixture-b', '1.0.0', { dependencies: { 'axon-fixture-value': '2', 'axon-fixture-a': '1' } })
    packageAt(join(a, 'node_modules/axon-fixture-value'), 'axon-fixture-value', '1.0.0')
    packageAt(join(b, 'node_modules/axon-fixture-value'), 'axon-fixture-value', '2.0.0')
    const copied = await copyRuntimeDependencies([{ name: 'axon-fixture-a', directory: a }, { name: 'axon-fixture-b', directory: b }], output)
    expect(copied).toHaveLength(4)
    expect(copied.filter(({ name }) => name === 'axon-fixture-value').map(({ version }) => version).sort()).toEqual(['1.0.0', '2.0.0'])
    for (const [name, version] of [['axon-fixture-a', '1.0.0'], ['axon-fixture-b', '2.0.0']]) {
      const entry = join(output, name!), actual = realpathSync(entry), dependency = join(actual, 'node_modules/axon-fixture-value')
      expect(readlinkSync(entry).startsWith('/')).toBe(false)
      expect(realpathSync(dependency).startsWith(`${output}/`)).toBe(true)
      expect(readFileSync(join(dependency, 'assets/data.txt'), 'utf8')).toBe(version!)
      expect(existsSync(join(actual, 'node_modules/axon-fixture-missing'))).toBe(false)
    }
    const cycle = realpathSync(join(output, 'axon-fixture-a/node_modules/axon-fixture-b/node_modules/axon-fixture-a'))
    expect(cycle).toBe(realpathSync(join(output, 'axon-fixture-a')))
    rmSync(join(root, 'source'), { recursive: true })
    expect(readFileSync(join(output, 'axon-fixture-a/assets/data.txt'), 'utf8')).toBe('1.0.0')
  })

  test('必需依赖缺失不得生成看似完整的依赖包', async () => {
    const root = fixture(), source = join(root, 'source'), output = join(root, 'output')
    packageAt(source, 'axon-fixture-required', '1.0.0', { dependencies: { 'axon-fixture-never-installed': '1' } })
    await expect(copyRuntimeDependencies([{ name: 'axon-fixture-required', directory: source }], output)).rejects.toThrow()
  })

  test.skipIf(process.platform !== 'darwin')('陌生目录、文件、链接或损坏构建清单启动前拒绝，不删除用户内容', async () => {
    const root = fixture(), directory = join(root, 'existing'), linked = join(root, 'link'), file = join(root, 'file')
    mkdirSync(directory); writeFileSync(join(directory, 'keep'), 'original'); writeFileSync(file, 'user-file')
    symlinkSync(directory, linked)
    for (const path of [directory, linked, file]) await expect(buildExec(path)).rejects.toThrow('拒绝覆盖')
    for (const path of [parse(root).root, homedir(), resolve(import.meta.dir, '../../..')]) await expect(buildExec(path)).rejects.toThrow('拒绝覆盖')
    writeFileSync(join(directory, 'axon-cli-build.json'), '{invalid')
    await expect(buildExec(directory)).rejects.toThrow('拒绝覆盖')
    expect(readFileSync(join(directory, 'keep'), 'utf8')).toBe('original')
    expect(readFileSync(file, 'utf8')).toBe('user-file')
  })
})
