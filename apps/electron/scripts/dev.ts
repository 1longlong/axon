/**
 * 开发脚本：一条命令拉起完整 dev 链路
 *
 * 流程：
 * 1. 清理本 worktree 残留的 Electron 进程（避免旧实例持有单实例锁）
 * 2. 启动 Vite dev server（renderer）
 * 3. 等待 5173 端口就绪
 * 4. esbuild 构建 main / preload
 * 5. 启动 Electron（加载 http://127.0.0.1:5173）
 * 6. Electron 退出后清理 Vite
 *
 * 主进程代码变更后需重启 dev（watch 模式随需要再加）。
 */
import { execSync, spawn } from 'child_process'
import { resolve } from 'path'

const ROOT = resolve(import.meta.dir, '..')
const VITE_PORT = 5173

function killStaleElectron(): void {
  try {
    // 只清理加载本 worktree dist/main.cjs 的 Electron 进程
    const pattern = `${ROOT}/dist/main.cjs`
    execSync(`pkill -f '${pattern}' 2>/dev/null`, { stdio: 'ignore' })
  } catch {
    // 没有匹配进程，忽略
  }
}

async function waitForVite(): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${VITE_PORT}`)
      if (res.ok) return
    } catch {
      // 尚未就绪
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`Vite dev server 在 30s 内未就绪（127.0.0.1:${VITE_PORT}）`)
}

function run(command: string, args: string[], name: string): ReturnType<typeof spawn> {
  const child = spawn(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      FORCE_COLOR: '1',
      // 宿主环境（如 Electron 系 CLI）可能带有该变量，会让 Electron 以纯 Node 模式
      // 启动、丢失内置 electron 模块，必须剔除
      ELECTRON_RUN_AS_NODE: undefined,
    },
  })
  child.on('error', (err) => {
    console.error(`[dev] ${name} 启动失败:`, err)
    process.exit(1)
  })
  return child
}

async function main(): Promise<void> {
  killStaleElectron()

  const vite = run('bunx', ['vite', 'dev'], 'vite')
  const electronChild = { current: null as ReturnType<typeof spawn> | null }

  const cleanup = (): void => {
    if (electronChild.current && !electronChild.current.killed) electronChild.current.kill()
    if (vite.pid && !vite.killed) vite.kill()
  }
  process.on('SIGINT', () => {
    cleanup()
    process.exit(0)
  })
  process.on('SIGTERM', () => {
    cleanup()
    process.exit(0)
  })
  vite.on('exit', (code) => {
    if (electronChild.current) return // Electron 退出引发级联时不重复处理
    console.error(`[dev] Vite 意外退出（code=${code}），终止开发会话`)
    process.exit(1)
  })

  await waitForVite()
  console.log('[dev] Vite 就绪，构建 main / preload …')

  execSync('bun run build:main && bun run build:preload', { cwd: ROOT, stdio: 'inherit' })

  console.log('[dev] 启动 Electron …')
  const child = run('bunx', ['electron', '.'], 'electron')
  electronChild.current = child
  child.on('exit', (code) => {
    console.log(`[dev] Electron 退出（code=${code}）`)
    cleanup()
    process.exit(code ?? 0)
  })
}

void main()
