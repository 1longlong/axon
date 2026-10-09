/** 构建独立 Node 后端入口；执行器由 Electron 自带，不依赖用户安装 Bun/Node。 */
import { build } from 'esbuild'
import { join } from 'node:path'

/** 生产构建和独立执行测试共享同一输出配置，不为测试切换 Runtime 或业务装配。 */
export async function buildAppServer(outfile: string): Promise<void> {
  await build({
  entryPoints: [join(import.meta.dir, '../../app-server/src/main.ts')],
  outfile,
  bundle: true, platform: 'node', format: 'esm', target: 'node22',
  // SDK 与解析器保留自身模块路径及资源，随应用依赖解包；桌面主入口不再导入它们。
  external: ['pdf-parse', 'mammoth', '@earendil-works/pi-coding-agent', '@earendil-works/pi-agent-core', '@earendil-works/pi-ai', '@earendil-works/pi-tui', '@modelcontextprotocol/sdk/*'],
  banner: { js: "import { createRequire as axonCreateRequire } from 'node:module'; const require = axonCreateRequire(import.meta.url);" },
  })
}

if (import.meta.main) await buildAppServer(join(import.meta.dir, '../dist/app-server.mjs'))
