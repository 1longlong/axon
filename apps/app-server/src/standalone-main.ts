/** 独立构建启动器自带 Bun，后端模块仍从可信产物位置加载，保留依赖资源的真实目录语义。 */
import { realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

try {
  const entry = join(dirname(realpathSync(process.execPath)), 'app-server.mjs')
  await import(pathToFileURL(entry).href)
} catch {
  process.stderr.write('Axon：独立后端资源无法加载。\n')
  process.exitCode = 1
}
