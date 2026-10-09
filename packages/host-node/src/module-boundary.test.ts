import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import * as host from './index'

const sourceRoot = dirname(fileURLToPath(import.meta.url))

function productionFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return productionFiles(path)
    return entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : []
  })
}

/** 宿主源码不能反向依赖桌面或具体 Runtime；测试夹具不计入发布依赖图。 */
function dependencies(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) found.push(node.moduleSpecifier.text)
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
      const value = node.arguments[0]
      if (!value || !ts.isStringLiteral(value)) throw new Error('宿主依赖必须可静态审计')
      found.push(value.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

describe('宿主模块单向依赖', () => {
  test('公共入口不需要 Electron，暴露实际执行与快照能力', () => {
    expect(process.versions.electron).toBeUndefined()
    for (const capability of [host.AgentSandboxCommandService, host.AgentShellSnapshotEnvironment,
      host.prepareAgentShellSnapshotCommand, host.pruneAgentShellSnapshots, host.resolveAgentShell,
      host.compileSeatbeltProfile, host.detectSeatbeltCapability, host.checkAgentEnvironment]) {
      expect(typeof capability).toBe('function')
    }
  })

  test('生产源码只依赖包内模块、标准库、core 与 shared', () => {
    const violations: string[] = []
    for (const file of productionFiles(sourceRoot)) {
      const name = relative(sourceRoot, file)
      for (const dependency of dependencies(file)) {
        if (dependency.startsWith('node:') || dependency === '@axon/core' || dependency === '@axon/shared') continue
        if (dependency.startsWith('.')) {
          const path = relative(sourceRoot, resolve(dirname(file), dependency))
          if (path !== '..' && !path.startsWith('../')) continue
        }
        violations.push(`${name} → ${dependency}`)
      }
    }
    expect(violations).toEqual([])
  })
})
