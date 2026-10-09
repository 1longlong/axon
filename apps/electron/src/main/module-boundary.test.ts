import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = dirname(fileURLToPath(import.meta.url))

/** 检查正式主进程依赖；隔离测试 child 的业务装配不纳入桌面生产源码。 */
function productionFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? productionFiles(path)
      : entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : []
  })
}

/** 字面量动态依赖也检查；注释不会造成误报，不允许不可审计的运行时模块名。 */
function specifiers(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const result: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) result.push(node.moduleSpecifier.text)
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
      const argument = node.arguments[0]
      if (!argument || !ts.isStringLiteral(argument)) throw new Error('主进程使用不可审计的模块依赖')
      result.push(argument.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return result
}

describe('Electron 独立后端边界', () => {
  test('正式主进程不装配业务、Runtime 或工具宿主；只有原生凭据端口消费纯 codec 子入口', () => {
    const violations: string[] = []
    for (const file of productionFiles(root)) {
      if (file.endsWith('-instance.ts')) violations.push(relative(root, file))
      for (const name of specifiers(file)) {
        if (name === '@axon/core/credential-codec' && relative(root, file) === 'lib/channel/electron-channel-credential-codec.ts') continue
        if (/^@axon\/(core|host-node|runtime-adapters)(\/|$)/.test(name)
          || name.startsWith('@earendil-works/') || name.startsWith('@modelcontextprotocol/')
          || name === 'pdf-parse' || name === 'mammoth'
          || /packages\/(core|host-node|runtime-adapters)\//.test(name)) {
          violations.push(`${relative(root, file)} → ${name}`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  test('随包 SDK/解析依赖归独立入口，不在桌面清单直接重复声明', () => {
    const manifest = JSON.parse(readFileSync(join(root, '../../package.json'), 'utf8')) as {
      dependencies: Record<string, string>
      devDependencies: Record<string, string>
    }
    expect(manifest.dependencies['@axon/app-server-app']).toBe('workspace:*')
    expect(manifest.dependencies['@axon/app-server']).toBe('workspace:*')
    for (const name of ['@axon/host-node', '@axon/runtime-adapters', '@earendil-works/pi-agent-core',
      '@earendil-works/pi-ai', '@earendil-works/pi-coding-agent', '@modelcontextprotocol/sdk', 'pdf-parse', 'mammoth']) {
      expect(manifest.dependencies[name]).toBeUndefined()
    }
    expect(manifest.devDependencies['@axon/host-node']).toBe('workspace:*')
    expect(manifest.devDependencies['@axon/runtime-adapters']).toBe('workspace:*')
  })
})
