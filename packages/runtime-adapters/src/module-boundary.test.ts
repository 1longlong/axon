import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import type { AgentProviderAdapter, AgentQueryInput } from '@axon/shared'
import * as adapters from './index'

const sourceRoot = dirname(fileURLToPath(import.meta.url))

function productionFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return productionFiles(path)
    return entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : []
  })
}

/** 连类型 import 也计入依赖；SDK 不能从 adapter 实现扩散到 helper 或公开入口。 */
function dependencies(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) found.push(node.moduleSpecifier.text)
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
      && ts.isStringLiteral(node.argument.literal)) {
      found.push(node.argument.literal.text)
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || ts.isIdentifier(node.expression) && ['require', 'dynamicImport'].includes(node.expression.text))) {
      const value = node.arguments[0]
      if (!value || !ts.isStringLiteral(value)) throw new Error('adapter 的动态依赖必须使用明确的包名')
      found.push(value.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

describe('Runtime adapter 包边界', () => {
  test('非 Electron 入口只公开 adapter 与中立连接校验，不公开 SDK 消息或私有传输', async () => {
    expect(process.versions.electron).toBeUndefined()
    expect(Object.keys(adapters).sort()).toEqual(['PiAgentAdapter', 'ZimaAgentAdapter', 'assertZimaConnection'])
    const pi: AgentProviderAdapter = new adapters.PiAgentAdapter()
    const zima: AgentProviderAdapter = new adapters.ZimaAgentAdapter('/unused/python', 'fixture')
    try {
      expect(pi.getSandboxCapability?.({ platform: 'macos' })).toMatchObject({
        supported: false, limitation: 'hostExecutorUnavailable',
      })
      expect(zima.getSandboxCapability?.({ platform: 'macos' })).toMatchObject({
        supported: false, limitation: 'runtimeToolDelegationUnavailable',
      })
      const query: AgentQueryInput = {
        sessionId: 'boundary', prompt: '禁止无沙箱运行', model: 'fixture',
        connection: { provider: 'custom', baseUrl: 'http://127.0.0.1:1/v1', apiKey: '' },
        runtimeConfigDir: '/unused-config', runtimeSessionDir: '/unused-session',
        systemPrompt: '',
        executionPolicy: { sandboxMode: 'workspaceWrite', approvalPolicy: 'onRequest', approvalReviewer: 'user' },
      }
      // 迭代器的首次 next 才进入查询，缺少宿主时不能加载 SDK 或启动工具。
      await expect(pi.query(query)[Symbol.asyncIterator]().next()).rejects.toThrow('宿主沙箱')
    } finally {
      pi.dispose()
      zima.dispose()
      await Promise.all([pi.drain(), zima.drain()])
    }
  })

  test('源码不依赖 Electron、应用或具体宿主；Pi SDK 只存在于 Pi adapter 文件', () => {
    const manifest = JSON.parse(readFileSync(join(sourceRoot, '../package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }
    const violations: string[] = []
    for (const file of productionFiles(sourceRoot)) {
      const name = relative(sourceRoot, file)
      for (const dependency of dependencies(file)) {
        if (dependency.startsWith('node:') || dependency === '@axon/core' || dependency === '@axon/shared') continue
        if (dependency.startsWith('.')) {
          const path = relative(sourceRoot, resolve(dirname(file), dependency))
          if (path !== '..' && !path.startsWith('../')) continue
        }
        const packageName = dependency.split('/').slice(0, 2).join('/')
        if (name === 'pi-agent-adapter.ts' && packageName.startsWith('@earendil-works/')
          && Object.hasOwn(manifest.dependencies, packageName)) continue
        violations.push(`${name} → ${dependency}`)
      }
    }
    expect(violations).toEqual([])
  })
})
