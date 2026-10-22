/** 构建独立 Node 后端入口；执行器由 Electron 自带，不依赖用户安装 Bun/Node。 */
import { build } from 'esbuild'
import type { BuildOptions } from 'esbuild'
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
// 仅构建期共用依赖复制器；生产桌面仍不加载 backend SDK 或执行器。
import { collectExternalDependencies, copyRuntimeDependencies } from '../../exec/scripts/runtime-dependencies'

const DEPENDENCY_MARKER = '.axon-desktop-runtime.json'

/** 外置依赖从后端清单取得，不依赖开发目录遗留链接；只替换有自有标识的完整构建。 */
async function buildRuntimeDependencies(directory: string): Promise<void> {
  const target = join(directory, 'node_modules')
  const owned = (): { dev: number; ino: number } | undefined => {
    let stat: ReturnType<typeof lstatSync>
    try { stat = lstatSync(target) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('后端依赖目标不是自有构建目录')
    const marker: unknown = JSON.parse(readFileSync(join(target, DEPENDENCY_MARKER), 'utf8'))
    if (!marker || typeof marker !== 'object' || !('package' in marker) || marker.package !== 'axon-desktop-runtime') throw new Error('后端依赖目录包含未知来源，拒绝覆盖')
    return { dev: stat.dev, ino: stat.ino }
  }
  const previous = owned(), staging = mkdtempSync(join(directory, '.axon-runtime-build-'))
  const prepared = join(staging, 'node_modules'), backup = join(staging, 'previous')
  let moved = false, published = false
  try {
    const dependencies = await copyRuntimeDependencies(collectExternalDependencies(join(import.meta.dir, '../../app-server')), prepared)
    writeFileSync(join(prepared, DEPENDENCY_MARKER), JSON.stringify({ package: 'axon-desktop-runtime', dependencies }))
    const current = owned()
    if (current?.dev !== previous?.dev || current?.ino !== previous?.ino) throw new Error('后端依赖目标在构建期间发生变化')
    if (previous) { renameSync(target, backup); moved = true }
    try { renameSync(prepared, target); published = true }
    catch (error) { if (moved) { renameSync(backup, target); moved = false }; throw error }
  } finally {
    // 回滚失败保留旧依赖；仅清理本次随机暂存目录，绝不删除陌生 node_modules。
    if (published || !moved) rmSync(staging, { recursive: true, force: true })
  }
}

/** 生产构建和独立执行测试共享同一输出配置，不为测试切换 Runtime 或业务装配。 */
export async function buildAppServer(outfile: string): Promise<void> {
  const common: BuildOptions = {
  bundle: true, platform: 'node', format: 'esm', target: 'node22',
  // SDK 与解析器保留自身模块路径及资源，随应用依赖解包；桌面主入口不再导入它们。
  external: ['sharp', 'pdf-parse', 'mammoth', '@earendil-works/pi-coding-agent', '@earendil-works/pi-agent-core', '@earendil-works/pi-ai', '@earendil-works/pi-tui', '@modelcontextprotocol/sdk/*'],
  banner: { js: "import { createRequire as axonCreateRequire } from 'node:module'; const require = axonCreateRequire(import.meta.url);" },
  }
  await build({ ...common, entryPoints: [join(import.meta.dir, '../../app-server/src/main.ts')], outfile })
  await build({ ...common, entryPoints: [join(import.meta.dir, '../../app-server/src/document-command-main.ts')],
    outfile: join(dirname(outfile), 'axon-doc.mjs') })
  const target = join(dirname(outfile), 'resources', 'builtin-skills')
  mkdirSync(target, { recursive: true })
  for (const name of ['pdf', 'documents']) cpSync(join(import.meta.dir, '../../app-server/resources/builtin-skills', name), join(target, name), { recursive: true })
  await buildRuntimeDependencies(dirname(outfile))
}

if (import.meta.main) await buildAppServer(join(import.meta.dir, '../dist/app-server.mjs'))
