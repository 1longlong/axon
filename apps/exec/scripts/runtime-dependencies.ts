/** 构建保存依赖真实包目录和资源；保留每个包自己的版本关系，不复制源码 workspace/Electron。 */
import { readFileSync, realpathSync } from 'node:fs'
import { cp, mkdir, symlink } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'

interface Manifest {
  name: string
  version: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}
export interface RuntimeDependency { name: string; version: string; location: string }
export interface ExternalDependency { name: string; directory: string }

function manifest(directory: string): Manifest {
  return JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as Manifest
}

/** exports 可把 package.json 指向 dist 子目录，必须向上找到名称匹配的实际包根。 */
function packageDirectory(name: string, importer: string): string {
  let entry: string
  try { entry = Bun.resolveSync(`${name}/package.json`, importer) }
  catch { entry = Bun.resolveSync(name, importer) }
  let directory = dirname(realpathSync(entry))
  while (true) {
    try { if (manifest(directory).name === name) return directory } catch { /* 子目录未必有包清单。 */ }
    const parent = dirname(directory)
    if (parent === directory) throw new Error(`依赖包根无法解析：${name}`)
    directory = parent
  }
}

/** 从后端清单遍历 workspace 边界，收集实际外部入口；不靠维护一份手写 SDK 资源名单。 */
export function collectExternalDependencies(backendDirectory: string): ExternalDependency[] {
  const visited = new Set<string>(), external = new Map<string, ExternalDependency>()
  const visit = (directory: string): void => {
    if (visited.has(directory)) return
    visited.add(directory)
    for (const [name, version] of Object.entries(manifest(directory).dependencies ?? {}).sort()) {
      const dependency = packageDirectory(name, directory)
      if (version.startsWith('workspace:')) visit(dependency)
      else {
        const previous = external.get(name)
        if (previous && previous.directory !== dependency) throw new Error(`后端入口依赖版本冲突：${name}`)
        external.set(name, { name, directory: dependency })
      }
    }
  }
  visit(realpathSync(backendDirectory))
  return [...external.values()].sort((left, right) => left.name.localeCompare(right.name))
}

/** 每个已安装包复制一次；相对链接还原各自依赖，版本冲突/循环不靠扁平化猜测。 */
export async function copyRuntimeDependencies(externals: ExternalDependency[], destination: string): Promise<RuntimeDependency[]> {
  const copied = new Map<string, { directory: string; record: RuntimeDependency }>()
  const visit = async (source: string): Promise<string> => {
    const existing = copied.get(source)
    if (existing) return existing.directory
    const data = manifest(source), location = `.axon-deps/${String(copied.size).padStart(4, '0')}`,
      directory = join(destination, location)
    const record: RuntimeDependency = { name: data.name, version: data.version, location }
    // 先登记再遍历，避免循环依赖递归展开；包内资源解引用，不留下源码目录绝对链接。
    copied.set(source, { directory, record })
    await cp(source, directory, { recursive: true, dereference: true,
      filter: (path) => path !== join(source, 'node_modules') })
    const required = new Map(Object.keys(data.dependencies ?? {}).map((name) => [name, true]))
    for (const name of Object.keys(data.peerDependencies ?? {})) required.set(name, required.get(name) === true || data.peerDependenciesMeta?.[name]?.optional !== true)
    for (const name of Object.keys(data.optionalDependencies ?? {})) required.set(name, false)
    for (const [name, mandatory] of [...required].sort()) {
      let target: string
      try { target = packageDirectory(name, source) }
      catch (error) { if (mandatory) throw error; else continue }
      const packageRoot = await visit(target), link = join(directory, 'node_modules', name)
      await mkdir(dirname(link), { recursive: true })
      await symlink(relative(dirname(link), packageRoot), link, 'dir')
    }
    return directory
  }
  await mkdir(destination, { recursive: true })
  for (const external of externals) {
    const packageRoot = await visit(external.directory), link = join(destination, external.name)
    await mkdir(dirname(link), { recursive: true })
    await symlink(relative(dirname(link), packageRoot), link, 'dir')
  }
  return [...copied.values()].map(({ record }) => record)
}
