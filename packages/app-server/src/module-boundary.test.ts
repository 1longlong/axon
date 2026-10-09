import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import * as server from './index'

const root = dirname(fileURLToPath(import.meta.url))
function productionFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? productionFiles(path)
      : entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : []
  })
}

/** 协议包不装配 Runtime/宿主实现，core 也不能反向依赖协议包。 */
describe('app-server 协议包边界', () => {
  test('公共入口可在非 Electron 进程加载', () => {
    expect(process.versions.electron).toBeUndefined()
    for (const capability of [server.JsonRpcPeer, server.RpcFault, server.RpcConnectionError, server.RpcRequestError,
      server.AppServerConnection, server.registerPrivateHostBridge, server.createPrivateHostPorts]) {
      expect(typeof capability).toBe('function')
    }
  })

  test('生产源码只依赖包内模块、标准库与声明的中立后端包', () => {
    const manifest = JSON.parse(readFileSync(join(root, '../package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }
    const violations: string[] = []
    for (const file of productionFiles(root)) {
      const specifiers: string[] = []
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
      const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
          if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) specifiers.push(node.moduleSpecifier.text)
        } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
          specifiers.push(node.argument.literal.text)
        } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
          || ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
          const value = node.arguments[0]
          if (!value || !ts.isStringLiteral(value)) throw new Error('协议包的动态依赖必须可审计')
          specifiers.push(value.text)
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
      for (const specifier of specifiers) {
        if (specifier.startsWith('node:')) continue
        if (specifier.startsWith('.')) {
          const target = relative(root, resolve(dirname(file), specifier))
          if (target !== '..' && !target.startsWith('../')) continue
        }
        if (['@axon/shared', '@axon/core'].includes(specifier) && Object.hasOwn(manifest.dependencies, specifier)) continue
        violations.push(`${relative(root, file)} → ${specifier}`)
      }
    }
    expect(violations).toEqual([])
  })
})
