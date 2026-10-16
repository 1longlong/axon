/** macOS 独立 CLI 目录：父入口/Worker 自包含，后端自带解释器和资源；不读取密钥或业务数据。 */
import { lstatSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { version } from '../package.json'
import { collectExternalDependencies, copyRuntimeDependencies } from './runtime-dependencies'

const MARKER = 'axon-cli-build.json'

function ownedBuild(path: string): boolean {
  try { lstatSync(path) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; else throw error }
  try {
    if (!lstatSync(path).isDirectory() || !lstatSync(join(path, MARKER)).isFile()) throw new Error()
    const value = JSON.parse(readFileSync(join(path, MARKER), 'utf8')) as { format?: unknown; package?: unknown }
    if (value.format !== 1 || value.package !== 'axon-exec') throw new Error()
    return true
  } catch (error) {
    throw new Error('构建目标不是 Axon CLI 产物目录，拒绝覆盖')
  }
}

/** 先构建自有暂存目录；全部资源成功才发布，失败不删除已有安装或半成品以外的内容。 */
export async function buildExec(output = join(import.meta.dir, '../dist')): Promise<void> {
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) throw new Error('CLI 构建首版仅支持本机 macOS arm64/x64')
  const target = resolve(output), toSource = relative(target, resolve(import.meta.dir, '../../..'))
  if (target === parse(target).root || target === homedir() || toSource === ''
    || !isAbsolute(toSource) && toSource !== '..' && !toSource.startsWith(`..${sep}`)) {
    throw new Error('构建目标不能是用户目录、源码根或其祖先，拒绝覆盖')
  }
  const previous = ownedBuild(target)
  await mkdir(dirname(target), { recursive: true })
  const staging = await mkdtemp(join(dirname(target), '.axon-cli-build-'))
  let backup: string | undefined, published = false
  try {
    const backend = join(staging, 'backend'), source = join(import.meta.dir, '../../app-server'),
      externals = collectExternalDependencies(source)
    await mkdir(backend)
    const compile = { autoloadDotenv: false, autoloadBunfig: false, autoloadTsconfig: false, autoloadPackageJson: false }
    const results = await Promise.allSettled([
      Bun.build({ entrypoints: [join(import.meta.dir, '../src/main.ts'), join(import.meta.dir, '../src/schema-worker.ts')],
        target: 'bun', compile: { ...compile, outfile: join(staging, 'axon') }, define: { AXON_EXEC_COMPILED: 'true' } }),
      Bun.build({ entrypoints: [join(source, 'src/standalone-main.ts')], target: 'bun',
        // 外置 SDK/资源包须读取 package.json 才能解析 exports；仍禁止 dotenv/bunfig/tsconfig 自动加载。
        compile: { ...compile, autoloadPackageJson: true, outfile: join(backend, 'axon-app-server') } }),
      Bun.build({ entrypoints: [join(source, 'src/main.ts')], target: 'bun', format: 'esm',
        external: externals.flatMap(({ name }) => [name, `${name}/*`]),
        outdir: backend, naming: 'app-server.mjs' }),
    ])
    // 任一编译失败也等其余实际构建完成，避免清理暂存目录后迟到写入再次创建半成品。
    if (results.some((result) => result.status === 'rejected' || !result.value.success)) {
      throw new AggregateError(results.flatMap((result) => result.status === 'rejected' ? [result.reason as unknown] : result.value.logs), 'CLI 构建失败')
    }
    const dependencies = await copyRuntimeDependencies(externals, join(backend, 'node_modules'))
    await writeFile(join(staging, MARKER), JSON.stringify({ format: 1, package: 'axon-exec', version,
      platform: process.platform, arch: process.arch, bunVersion: Bun.version, worker: 'embedded', dependencies }, null, 2) + '\n')
    // 不允许覆盖陌生路径；已有自有构建先移到本次随机目录，发布失败可恢复。
    if (ownedBuild(target) !== previous) throw new Error('构建目标在运行期间发生变化')
    if (previous) { backup = join(staging, 'previous'); await rename(target, backup) }
    try { await rename(staging, target); published = true }
    catch (error) { if (backup) { await rename(backup, target); backup = undefined }; throw error }
    if (backup) await rm(join(target, 'previous'), { recursive: true })
  } finally {
    // 回滚本身失败时旧构建仍在 previous，保留整个暂存目录而不是把它当半成品删除。
    if (!published && !backup) await rm(staging, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--outdir' || !args[1]?.trim() || args[1].includes('\0'))) {
    throw new Error('用法：bun run exec:build [--outdir <产物目录>]')
  }
  const output = resolve(args[1] ?? join(import.meta.dir, '../dist'))
  await buildExec(output)
  console.log(`Axon CLI 已构建：${join(output, 'axon')}（需保留完整产物目录）`)
}
