import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireBackendDirectoryLease, BACKEND_DIRECTORY_LOCK_FILE } from './backend-directory-lease'
import type { BackendDirectoryLease } from './backend-directory-lease'

let directory: string
const cleanups: Array<() => void | Promise<void>> = []
beforeEach(() => { directory = realpathSync(mkdtempSync(join(tmpdir(), 'axon-directory-lease-'))) })
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  rmSync(directory, { recursive: true, force: true })
})
function acquire(path: string): BackendDirectoryLease {
  const lease = acquireBackendDirectoryLease(path)
  cleanups.push(() => lease.release())
  return lease
}

describe.skipIf(process.platform !== 'darwin')('真实 macOS 数据目录独占锁', () => {
  test('内核拒绝第二次打开，释放幂等，不删除锁文件，之后仍复用同一 inode', () => {
    const data = join(directory, 'data')
    const lease = acquire(data)
    const file = join(data, BACKEND_DIRECTORY_LOCK_FILE), inode = statSync(file).ino
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readFileSync(file, 'utf8')).toBe('')
    expect(() => acquireBackendDirectoryLease(data)).toThrow('已有后端运行')
    lease.release(); lease.release()
    expect(existsSync(file)).toBe(true)
    const next = acquire(data)
    expect(next.directory).toBe(data)
    expect(statSync(file).ino).toBe(inode)
  })

  test('目录别名不能绕过同一真实 inode，不同目录可分别持有', () => {
    const data = join(directory, 'data'), alias = join(directory, 'alias')
    acquire(data)
    symlinkSync(data, alias)
    expect(() => acquireBackendDirectoryLease(alias)).toThrow('已有后端运行')
    expect(acquire(join(directory, 'other')).directory).toBe(join(directory, 'other'))
  })

  test('锁文件的符号链接、硬链接和非私有权限拒绝，不改写目标内容', () => {
    const data = join(directory, 'data'); mkdirSync(data)
    const file = join(data, BACKEND_DIRECTORY_LOCK_FILE), target = join(directory, 'target')
    writeFileSync(target, 'do-not-change', { mode: 0o600 })
    symlinkSync(target, file)
    expect(() => acquireBackendDirectoryLease(data)).toThrow('无法取得')
    expect(readFileSync(target, 'utf8')).toBe('do-not-change')
    rmSync(file); linkSync(target, file)
    expect(() => acquireBackendDirectoryLease(data)).toThrow('无法取得')
    rmSync(file); writeFileSync(file, 'do-not-change', { mode: 0o644 }); chmodSync(file, 0o644)
    expect(() => acquireBackendDirectoryLease(data)).toThrow('无法取得')
    expect(readFileSync(file, 'utf8')).toBe('do-not-change')
  })

  test('FIFO/目录/文件祖先不会变成锁；非阻塞打开不挂起', () => {
    const fifoDir = join(directory, 'fifo'); mkdirSync(fifoDir)
    execFileSync('mkfifo', [join(fifoDir, BACKEND_DIRECTORY_LOCK_FILE)], { timeout: 3_000 })
    expect(() => acquireBackendDirectoryLease(fifoDir)).toThrow('无法取得')
    const dir = join(directory, 'nested-directory'); mkdirSync(join(dir, BACKEND_DIRECTORY_LOCK_FILE), { recursive: true })
    expect(() => acquireBackendDirectoryLease(dir)).toThrow('无法取得')
    const file = join(directory, 'file'); writeFileSync(file, 'do-not-change')
    expect(() => acquireBackendDirectoryLease(join(file, 'data'))).toThrow('无法取得')
  })

  test('锁 FD 不进入实际 exec 子进程；后代仍存活也不会阻止原持有者释放', async () => {
    const data = join(directory, 'data'), lease = acquire(data)
    const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready\\n"); process.stdin.resume()'], { stdio: 'pipe' })
    const exited = new Promise<void>((resolve, reject) => { child.once('close', () => resolve()); child.once('error', reject) })
    cleanups.push(async () => { child.stdin.end(); await exited })
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('执行子进程未就绪')), 3_000)
      child.stdout.once('data', () => { clearTimeout(timeout); resolve() })
      child.once('error', (error) => { clearTimeout(timeout); reject(error) })
    })
    expect(child.exitCode).toBeNull()
    lease.release()
    expect(acquire(data).directory).toBe(data)
    expect(child.exitCode).toBeNull()
  })
})

test('非法路径先拒绝，不猜正式数据目录', () => {
  for (const path of ['', 'relative', '/private/tmp/axon\0']) expect(() => acquireBackendDirectoryLease(path)).toThrow('不可用')
})
