/** 只快照任务内容目录，不扫描整个工作区；历史读取只访问已登记的内容寻址产物。 */
import { createHash, randomUUID } from 'node:crypto'
import { isUtf8 } from 'node:buffer'
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync,
  renameSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, relative } from 'node:path'
import type { LoopArtifact, LoopArtifactContent, LoopArtifactDiff, LoopDefinition } from '@axon/shared'
import { artifactMeta } from '@axon/shared'
import { loopId, loopObject, LoopServiceError } from './loop-input'
import { ensureLoopDirectory } from './loop-repository'

const MAX_FILE = 2 * 1024 * 1024
const MAX_SNAPSHOT = 32 * 1024 * 1024
interface Manifest { version: 1; runId: string; at: number; complete: boolean; files: LoopArtifact[] }
function digest(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex') }
function readRegular(path: string, limit: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = fstatSync(fd)
    if (!before.isFile() || before.size > limit) throw new LoopServiceError('unavailable', '产物类型或长度超限')
    const bytes = readFileSync(fd)
    const after = fstatSync(fd)
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length > limit) throw new LoopServiceError('unavailable', '产物读取期间发生变化')
    return bytes
  } finally { closeSync(fd) }
}
function atomicJson(path: string, value: object): void {
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`)
  writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 })
  renameSync(temporary, path)
}
function mime(path: string): string {
  return ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
    '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
    '.md': 'text/markdown', '.markdown': 'text/markdown', '.json': 'application/json', '.html': 'text/html', '.htm': 'text/html', '.csv': 'text/csv' } as Record<string, string>)[extname(path).toLowerCase()] ?? 'text/plain'
}

export class LoopArtifactStore {
  constructor(private readonly directory: string) {}

  /** 真实执行结束后复制有界小产物；链接/超限/并发改写标为不完整，不把当前文件当历史。 */
  capture(definition: LoopDefinition, runId: string): boolean {
    loopId(runId)
    const source = dirname(definition.taskFile)
    if (source !== join(definition.workspacePath, 'axon-loops', definition.id) || realpathSync(source) !== source) {
      throw new LoopServiceError('forbidden', '产物目录已改变')
    }
    const directory = this.root(definition.id)
    ensureLoopDirectory(directory); ensureLoopDirectory(join(directory, 'blobs'))
    const manifest: Manifest = { version: 1, runId, at: Date.now(), complete: true, files: [] }
    let size = 0
    const walk = (path: string, depth: number): void => {
      if (depth > 8 || realpathSync(path) !== path) { manifest.complete = false; return }
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        if (['node_modules', '.git', '.cache', 'dist', 'build'].includes(entry.name)) { manifest.complete = false; continue }
        const file = join(path, entry.name)
        if (entry.isSymbolicLink()) { manifest.complete = false; continue }
        if (entry.isDirectory()) { walk(file, depth + 1); continue }
        if (!entry.isFile()) { manifest.complete = false; continue }
        try {
          if (manifest.files.length >= 256) { manifest.complete = false; return }
          const bytes = readRegular(file, MAX_FILE)
          if (size + bytes.length > MAX_SNAPSHOT) { manifest.complete = false; continue }
          const hash = digest(bytes)
          const blob = join(directory, 'blobs', hash)
          if (!existsSync(blob)) writeFileSync(blob, bytes, { flag: 'wx', mode: 0o600 })
          else if (digest(readRegular(blob, MAX_FILE)) !== hash) throw new Error('已存内容损坏')
          size += bytes.length
          const mediaType = mime(file) === 'text/plain' && (!isUtf8(bytes) || bytes.includes(0)) ? 'application/octet-stream' : mime(file)
          const meta = mediaType === 'text/markdown' ? artifactMeta(bytes.subarray(0, 9000).toString('utf8')) : null
          manifest.files.push({ path: relative(source, file).split('\\').join('/'), hash, size: bytes.length,
            modifiedAt: lstatSync(file).mtimeMs, mediaType, ...(meta ? { meta } : {}) })
        } catch { manifest.complete = false }
      }
    }
    walk(source, 0)
    manifest.files.sort((a, b) => a.path.localeCompare(b.path))
    atomicJson(join(directory, `${runId}.json`), manifest)
    atomicJson(join(directory, 'latest.json'), { runId })
    return manifest.complete
  }

  private root(id: string): string {
    const parent = join(this.directory, loopId(id))
    const info = lstatSync(parent)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new LoopServiceError('storage_error', 'Loop 产物父目录无效')
    return join(parent, 'artifacts')
  }
  private manifest(id: string, runId?: string): Manifest | null {
    const root = this.root(id)
    if (!existsSync(root)) return null
    ensureLoopDirectory(root)
    if (!runId) {
      const latest = join(root, 'latest.json')
      if (!existsSync(latest)) return null
      runId = loopId(loopObject(JSON.parse(readRegular(latest, 1024).toString('utf8'))).runId)
    }
    const path = join(root, `${loopId(runId)}.json`)
    if (!existsSync(path)) return null
    const value = loopObject(JSON.parse(readRegular(path, 2 * 1024 * 1024).toString('utf8')))
    if (value.version !== 1 || value.runId !== runId || typeof value.complete !== 'boolean' || !Number.isFinite(value.at) || !Array.isArray(value.files) || value.files.length > 256) {
      throw new LoopServiceError('storage_error', '产物清单无效')
    }
    for (const raw of value.files) {
      const file = loopObject(raw)
      if (typeof file.path !== 'string' || !file.path || file.path.includes('\\') || file.path.startsWith('/')
        || file.path.split('/').some((segment) => !segment || segment === '.' || segment === '..')
        || file.path.length > 4096 || !/^[a-f0-9]{64}$/.test(String(file.hash)) || !Number.isSafeInteger(file.size) || (file.size as number) < 0 || (file.size as number) > MAX_FILE
        || !Number.isFinite(file.modifiedAt) || !(file.mediaType === mime(file.path)
          || mime(file.path) === 'text/plain' && file.mediaType === 'application/octet-stream')) throw new LoopServiceError('storage_error', '产物记录无效')
      if (file.meta !== undefined) {
        const meta = loopObject(file.meta, ['type', 'title', 'date'])
        if (Object.values(meta).some((item) => typeof item !== 'string' || item.length > 500)) throw new LoopServiceError('storage_error', '产物元信息无效')
      }
    }
    return value as unknown as Manifest
  }
  list(id: string, runId?: string): LoopArtifact[] { return this.manifest(id, runId)?.files ?? [] }
  read(id: string, path: string, runId?: string): LoopArtifactContent {
    const file = this.list(id, runId).find((entry) => entry.path === path)
    if (!file) throw new LoopServiceError('not_found', '此执行没有登记该产物')
    const root = this.root(id)
    ensureLoopDirectory(join(root, 'blobs'))
    const bytes = readRegular(join(root, 'blobs', file.hash), MAX_FILE)
    if (digest(bytes) !== file.hash) throw new LoopServiceError('storage_error', '历史产物内容校验失败')
    const binary = file.mediaType.startsWith('image/') || file.mediaType === 'application/octet-stream'
    return { ...file, content: binary ? bytes.toString('base64') : bytes.toString('utf8'), encoding: binary ? 'base64' : 'utf8' }
  }
  /** Diff 比较两次历史清单；不完整清单不推断删除，不读取工作区当前版本。 */
  diff(id: string, runId: string, previousRunId?: string): LoopArtifactDiff[] {
    const current = this.manifest(id, runId)
    if (!current) return []
    const previous = previousRunId ? this.manifest(id, previousRunId) : null
    const before = new Map(previous?.files.map((file) => [file.path, file]) ?? [])
    const after = new Map(current.files.map((file) => [file.path, file]))
    const results: LoopArtifactDiff[] = []
    for (const path of new Set([...before.keys(), ...after.keys()])) {
      const old = before.get(path), next = after.get(path)
      if (old?.hash === next?.hash || !next && !current.complete) continue
      const text = (file: LoopArtifact | undefined, run?: string): string | null => {
        if (!file || file.mediaType.startsWith('image/') || file.mediaType === 'application/octet-stream') return null
        try { return this.read(id, file.path, run).content } catch { return null }
      }
      results.push({ path, status: !old ? 'added' : !next ? 'deleted' : 'modified', before: text(old, previousRunId), after: text(next, runId) })
    }
    return results
  }
}
