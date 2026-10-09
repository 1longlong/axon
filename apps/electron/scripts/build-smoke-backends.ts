/** 显式构建指定测试 child；它们不替换生产 app-server，也不进入发行包。 */
import { build } from 'esbuild'
import { join } from 'node:path'

const entries: Record<string, string> = {
  agent: 'agent-smoke-backend.ts',
  shell: 'shell-smoke-backend.ts',
  zima: 'zima-live-backend.ts',
}
const names = process.argv.slice(2)
if (!names.length || names.some((name) => !Object.hasOwn(entries, name))) throw new Error('请指定 agent、shell 或 zima 测试入口')
await build({
  entryPoints: names.map((name) => join(import.meta.dir, '../test-support', entries[name]!)),
  outdir: join(import.meta.dir, '../dist'), outExtension: { '.js': '.mjs' },
  bundle: true, platform: 'node', format: 'esm', target: 'node22',
  external: ['pdf-parse', 'mammoth', '@earendil-works/pi-coding-agent', '@earendil-works/pi-agent-core', '@earendil-works/pi-ai', '@earendil-works/pi-tui', '@modelcontextprotocol/sdk/*'],
  banner: { js: "import { createRequire as axonCreateRequire } from 'node:module'; const require = axonCreateRequire(import.meta.url);" },
})
