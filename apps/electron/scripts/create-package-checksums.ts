import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

interface PackageMetadata {
  version: string
}

const electronRoot = resolve(import.meta.dir, '..')
const releaseDirectory = join(electronRoot, 'release')
const architecture = process.arch === 'arm64' ? 'arm64' : 'x64'
const metadata = JSON.parse(readFileSync(join(electronRoot, 'package.json'), 'utf8')) as PackageMetadata
const artifactPattern = new RegExp(`^Axon-${metadata.version}-${architecture}\\.(dmg|zip)$`)

/**
 * 为当前架构的 DMG 与 ZIP 生成统一 SHA-256 清单，供 GitHub Release 下载后校验。
 */
async function createChecksums(): Promise<void> {
  const artifacts = readdirSync(releaseDirectory)
    .filter((name) => artifactPattern.test(name))
    .sort()
  if (artifacts.length !== 2) {
    throw new Error(`预期找到 DMG 和 ZIP，实际找到：${artifacts.join(', ') || '无'}`)
  }

  const result = Bun.spawnSync({
    cmd: ['shasum', '-a', '256', ...artifacts],
    cwd: releaseDirectory,
    stdout: 'pipe',
    stderr: 'inherit',
  })
  if (result.exitCode !== 0) throw new Error(`shasum 退出码：${result.exitCode}`)
  await Bun.write(join(releaseDirectory, 'SHA256SUMS.txt'), result.stdout)
}

await createChecksums()
