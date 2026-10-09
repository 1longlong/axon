import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import * as core from './index'

const sourceRoot = dirname(fileURLToPath(import.meta.url))

/** 只检查生产源码，测试夹具不参与后端发布依赖图。 */
function productionFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return productionFiles(path)
    return entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')
      ? [path]
      : []
  })
}

/** 使用语法树收集静态及字面量动态依赖，避免注释中的 import 示例误报。 */
function moduleSpecifiers(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const specifiers: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        specifiers.push(node.moduleSpecifier.text)
      }
    } else if (ts.isCallExpression(node) && (
      node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === 'require')
    )) {
      const argument = node.arguments[0]
      if (!argument || !ts.isStringLiteral(argument)) {
        throw new Error(`${relative(sourceRoot, file)} 使用不可审计的动态模块依赖`)
      }
      specifiers.push(argument.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return specifiers
}

describe('core 单向模块边界', () => {
  test('公共入口在非 Electron 进程可加载，暴露实际配置与持久化能力', () => {
    expect(process.versions.electron).toBeUndefined()
    for (const capability of [
      core.createBackendPaths,
      core.createBackend,
      core.BackendClientRegistry,
      core.AgentRunCoordinator,
      core.ChatRunCoordinator,
      core.AgentProjectController,
      core.AgentMemoryController,
      core.AgentPermissionService,
      core.AgentAskUserService,
      core.initializeBackendDirectories,
      core.createCredentialCodec,
      core.ChannelManager,
      core.ChannelNetworkService,
      core.ChannelController,
      core.ConversationManager,
      core.ChatService,
      core.AttachmentService,
      core.AttachmentController,
      core.AgentTaskController,
      core.createDocumentParser,
      core.AgentSessionManager,
      core.AgentRootStateStore,
      core.AgentDelegationManager,
      core.AgentProjectManager,
      core.resolveProjectInstructions,
      core.discoverAgentSkills,
      core.createAgentSkillReadScope,
      core.AgentSkillInstallationService,
      core.AgentSkillSettingsController,
      core.listWorkspaceDirectory,
      core.readWorkspaceFilePreview,
      core.readWorkspaceFileDiff,
      core.WorkspaceWatcher,
      core.McpProjectConfigManager,
      core.McpProjectController,
      core.McpToolProvider,
      core.parseMcpProjectConfig,
      core.getBuiltinMcpCatalog,
      core.AgentMemoryService,
      core.createAgentMemoryTools,
      core.resolveAgentMemoryContext,
      core.AgentMemoryWatcher,
      core.AgentMemoryController,
      core.AgentService,
      core.AgentEventBus,
      core.buildRecoveryPrompt,
      core.createAgentTitleGenerator,
      core.createAgentToolSearchTool,
      core.buildAgentSandboxPolicy,
      core.AgentCollaborationService,
      core.createAgentCollaborationTools,
      core.getSettings,
      core.updateSettings,
      core.getUserProfile,
      core.updateUserProfile,
      core.writeJsonFileAtomic,
      core.readJsonFileSafe,
    ]) expect(typeof capability).toBe('function')
  })

  test('生产依赖只指向 core 内部、shared、标准库及明确声明的第三方包', () => {
    const manifest = JSON.parse(readFileSync(join(sourceRoot, '../package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }
    const violations: string[] = []
    for (const file of productionFiles(sourceRoot)) {
      for (const specifier of moduleSpecifiers(file)) {
        if (specifier.startsWith('node:')) continue
        if (specifier.startsWith('.')) {
          const target = relative(sourceRoot, resolve(dirname(file), specifier))
          if (target !== '..' && !target.startsWith('../')) continue
        } else {
          const packageName = specifier.startsWith('@')
            ? specifier.split('/').slice(0, 2).join('/')
            : specifier.split('/')[0]!
          if (packageName !== 'electron' && packageName !== '@axon/core'
            && packageName !== '@axon/runtime-adapters' && packageName !== '@axon/host-node'
            && packageName !== '@axon/app-server'
            && !packageName.startsWith('@earendil-works/')
            && Object.hasOwn(manifest.dependencies, packageName)) continue
        }
        violations.push(`${relative(sourceRoot, file)} → ${specifier}`)
      }
    }
    expect(violations).toEqual([])
  })
})
