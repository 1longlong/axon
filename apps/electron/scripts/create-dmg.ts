import { existsSync, readFileSync, symlinkSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'

interface PackageMetadata {
  version: string
}

const electronRoot = resolve(import.meta.dir, '..')
const releaseDirectory = join(electronRoot, 'release')
const architecture = process.arch === 'arm64' ? 'arm64' : 'x64'
const unpackedDirectory = join(releaseDirectory, `mac-${architecture}`)
const appPath = join(unpackedDirectory, 'Axon.app')
const applicationsLink = join(unpackedDirectory, 'Applications')
const metadata = JSON.parse(readFileSync(join(electronRoot, 'package.json'), 'utf8')) as PackageMetadata
const outputPath = join(releaseDirectory, `Axon-${metadata.version}-${architecture}.dmg`)

/**
 * 使用 macOS 自带 hdiutil 将已验证的 Axon.app 封装为 DMG，避免再次下载外部 DMG 工具。
 * 输入是 electron-builder 的 mac-<arch> 目录，输出与 ZIP 并列放入 release。
 */
function createDmg(): void {
  if (!existsSync(appPath)) {
    throw new Error(`未找到已打包应用：${appPath}`)
  }

  // 临时加入 Applications 快捷方式，让用户挂载后可以直接拖拽安装。
  if (existsSync(applicationsLink)) unlinkSync(applicationsLink)
  symlinkSync('/Applications', applicationsLink, 'dir')

  try {
    const result = Bun.spawnSync({
      cmd: [
        'hdiutil', 'create',
        '-volname', 'Axon',
        '-srcfolder', unpackedDirectory,
        '-ov',
        '-format', 'UDZO',
        outputPath,
      ],
      stdout: 'inherit',
      stderr: 'inherit',
    })
    if (result.exitCode !== 0) throw new Error(`hdiutil 退出码：${result.exitCode}`)
  } finally {
    // 快捷方式只属于 DMG 布局，不保留在未压缩应用目录中。
    if (existsSync(applicationsLink)) unlinkSync(applicationsLink)
  }
}

createDmg()
