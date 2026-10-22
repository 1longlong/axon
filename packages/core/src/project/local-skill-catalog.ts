/** 读取可信随包目录并生成普通安装目录；不扫描其他位置、不下载或执行 Skill 文件。 */
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import type { InstallableSkillFile, InstallableSkillPackage } from '@axon/shared'
import type { AgentSkillCatalogProvider } from './agent-skill-catalog'
import { parseSkillFrontmatter } from './project-skill-discovery'
import { validateInstallableSkillPackage } from './agent-skill-installation-service'

export interface LocalSkillPackageDefinition { catalogId: string; name: string; version: string }

/** 安装层还会复核哈希；来源层提前限制数量/大小且拒绝符号链接，避免读取越界资源。 */
export function createLocalSkillCatalogProvider(rootPath: string, definitions: readonly LocalSkillPackageDefinition[]): AgentSkillCatalogProvider {
  if (!isAbsolute(rootPath) || rootPath.includes('\0')) throw new Error('Skill 安装源必须是可信绝对目录')
  const root = realpathSync.native(rootPath)
  return { getCatalog: () => ({ packages: definitions.map((definition) => loadPackage(root, definition)) }) }
}

function loadPackage(root: string, definition: LocalSkillPackageDefinition): InstallableSkillPackage {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(definition.name)) throw new Error('随包 Skill 名称无效')
  const directory = join(root, definition.name), files: InstallableSkillFile[] = []
  let totalBytes = 0, entries = 0
  const scan = (path: string, depth = 0): void => {
    if (++entries > 512 || depth > 32) throw new Error('随包 Skill 目录层级或项目数量超限')
    const metadata = lstatSync(path)
    if (metadata.isSymbolicLink()) throw new Error('随包 Skill 不允许符号链接')
    const canonical = realpathSync.native(path), within = relative(directory, canonical)
    if (within.startsWith('..') || isAbsolute(within)) throw new Error('随包 Skill 来源越界')
    if (metadata.isDirectory()) {
      for (const entry of readdirSync(path).sort()) scan(join(path, entry), depth + 1)
      return
    }
    if (!metadata.isFile() || metadata.size > 2 * 1024 * 1024 || files.length >= 256) throw new Error('随包 Skill 文件超限')
    totalBytes += metadata.size
    if (totalBytes > 8 * 1024 * 1024) throw new Error('随包 Skill 超过 8 MiB')
    const bytes = readFileSync(path)
    if (bytes.length !== metadata.size) throw new Error('随包 Skill 在读取时变化')
    files.push({ path: within.split('\\').join('/'), contentBase64: bytes.toString('base64'),
      sha256: createHash('sha256').update(bytes).digest('hex'), ...(metadata.mode & 0o111 ? { executable: true } : {}) })
  }
  scan(directory)
  const instruction = files.find((file) => file.path === 'SKILL.md')
  if (!instruction) throw new Error('随包 Skill 缺少 SKILL.md')
  const { description } = parseSkillFrontmatter(Buffer.from(instruction.contentBase64, 'base64').toString('utf8'), definition.name)
  const canonical = [...files].sort((left, right) => left.path.localeCompare(right.path))
    .map((file) => `${file.path}\0${file.sha256}\n`).join('')
  const result: InstallableSkillPackage = { ...definition, description, files,
    contentHash: createHash('sha256').update(canonical).digest('hex') }
  validateInstallableSkillPackage(result)
  return result
}
