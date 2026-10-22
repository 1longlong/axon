/** Skill 自动读取与显式选择共用的安全文本读取边界。 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { AgentSkillActivation, AgentSkillActivationSource, AgentSkillSource } from '@axon/shared'

export const MAX_SKILL_RESOURCE_BYTES = 256 * 1024

export function escapeSkillMarkup(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
}

/** 先固定真实根/FD，再有界读取并复核身份；不允许目录替换或参考文件逃出 Skill。 */
export function readAgentSkillResource(skill: AgentSkillSource, relativePath = 'SKILL.md'): { content: string; path: string; contentHash: string } {
  const segments = relativePath.split('/')
  if (!relativePath || relativePath.includes('\\') || relativePath.includes('\0') || isAbsolute(relativePath)
    || segments.some((part) => !part || part === '.' || part === '..')) throw new Error('Skill 相对路径无效')
  const root = realpathSync.native(skill.directoryPath), rootInfo = lstatSync(root)
  if (root !== skill.directoryPath || !rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Skill 目录已变化')
  const path = realpathSync.native(resolve(root, relativePath)), within = relative(root, path)
  if (within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within) || relativePath === 'SKILL.md' && path !== skill.instructionPath) throw new Error('Skill 文件超出指定来源')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = fstatSync(fd)
    if (!before.isFile() || before.size > MAX_SKILL_RESOURCE_BYTES) throw new Error('Skill 资源不是 256 KiB 以内的普通文本')
    const bytes = Buffer.alloc(before.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (!count) throw new Error('Skill 读取不完整')
      offset += count
    }
    const after = fstatSync(fd), currentRoot = lstatSync(root)
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || currentRoot.dev !== rootInfo.dev || currentRoot.ino !== rootInfo.ino || !currentRoot.isDirectory() || currentRoot.isSymbolicLink()) throw new Error('Skill 在读取期间变化')
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (content.includes('\0')) throw new Error('Skill 资源不是文本')
    const contentHash = createHash('sha256').update(bytes).digest('hex')
    if (relativePath === 'SKILL.md' && contentHash !== skill.contentHash) throw new Error('Skill 正文已更新，请重新选择或发现')
    return { content, path, contentHash }
  } finally { closeSync(fd) }
}

export function skillActivationFrom(skill: AgentSkillSource, source: AgentSkillActivationSource): AgentSkillActivation {
  return { name: skill.name, directoryKind: skill.directoryKind, relativeInstructionPath: skill.relativeInstructionPath, sources: [source] }
}
