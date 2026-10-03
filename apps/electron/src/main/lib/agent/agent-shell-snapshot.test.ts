import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentShellSnapshotEnvironment, prepareAgentShellSnapshotCommand, pruneAgentShellSnapshots } from './agent-shell-snapshot'
import type { AgentShellSnapshotOptions } from './agent-shell-snapshot'
import type { AgentShellType } from './agent-shell'

function fixture(type: AgentShellType, startup: string): {
  options: AgentShellSnapshotOptions
  directory: string
  cleanup: () => void
} {
  const directory = mkdtempSync(join(tmpdir(), 'axon-shell-snapshot-'))
  const home = join(directory, 'home')
  mkdirSync(home)
  const name = type === 'zsh' ? '.zshrc' : type === 'bash' ? '.bashrc' : '.shrc'
  writeFileSync(join(home, name), startup)
  return {
    directory,
    options: {
      sessionId: 'test-session', cwd: directory, shell: { type, path: `/bin/${type}` },
      directory: join(directory, 'snapshots'),
      environment: { HOME: home, ZDOTDIR: home, ENV: '$HOME/.shrc', PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' },
      timeoutMs: 2_000,
    },
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  }
}

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }

describe('Shell 快照遗留清理', () => {
  test('按主/子会话元数据清理孤儿和三天过期文件，活跃引用、未知文件与链接保持不变', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'axon-snapshot-prune-'))
    const now = 10 * 24 * 60 * 60 * 1_000
    const retention = 3 * 24 * 60 * 60 * 1_000
    const name = (id: string) => `${id}-12345678-1234-1234-1234-123456789abc.sh`
    const ids = ['recent', 'child', 'boundary', 'stale', 'orphan', 'active-stale', 'active-orphan']
    try {
      for (const id of ids) writeFileSync(join(directory, name(id)), '不需要读取正文')
      writeFileSync(join(directory, `${name('orphan')}.tmp`), 'unfinished')
      writeFileSync(join(directory, 'unrelated.sh'), 'keep')
      mkdirSync(join(directory, name('folder')))
      symlinkSync(join(directory, 'unrelated.sh'), join(directory, name('link')))
      await pruneAgentShellSnapshots({
        directory, now,
        sessionActivity: new Map([
          ['recent', now], ['child', now], ['boundary', now - retention],
          ['stale', now - retention - 1], ['active-stale', 0],
        ]),
        isReferenced: (id) => id.startsWith('active-'),
      })
      for (const id of ['recent', 'child', 'boundary', 'active-stale', 'active-orphan']) expect(existsSync(join(directory, name(id)))).toBe(true)
      for (const id of ['stale', 'orphan']) expect(existsSync(join(directory, name(id)))).toBe(false)
      expect(existsSync(join(directory, `${name('orphan')}.tmp`))).toBe(false)
      expect(readFileSync(join(directory, 'unrelated.sh'), 'utf8')).toBe('keep')
      expect(existsSync(join(directory, name('folder')))).toBe(true)
      expect(existsSync(join(directory, name('link')))).toBe(true)
      // lstat 前后都检查引用，不能删除扫描中途开始使用的文件。
      let checks = 0
      await pruneAgentShellSnapshots({ directory, now, sessionActivity: new Map(), isReferenced: () => ++checks > 1 })
      expect(existsSync(join(directory, name('recent')))).toBe(true)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  test('新安装目录缺失无需创建目录或报错', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'axon-snapshot-absent-'))
    try {
      await pruneAgentShellSnapshots({ directory: join(directory, 'absent'), sessionActivity: new Map(), isReferenced: () => false })
      expect(readdirSync(directory)).toEqual([])
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})

describe('会话 Shell 快照初始化', () => {
  for (const type of ['zsh', 'bash', 'sh'] as const) {
    test(`${type} 捕获完整多行变量、函数、别名与选项，私有验证后原子发布`, async () => {
      const value = '第一行\n空 格\t"引号" \' $HOME `echo no`'
      const setup = fixture(type, `printf '启动噪声\\n'\nexport AXON_TEST_VALUE=${quote(value)}\nexport PATH="$HOME/tools:$PATH"\naxon_test_fn() { printf 'function-ok'; }\nalias axon_test_alias='printf alias-ok'\nset -o noclobber\n`)
      const failures: string[] = []
      const environment = new AgentShellSnapshotEnvironment({ ...setup.options, onFailure: (reason) => failures.push(reason) })
      try {
        const snapshot = await environment.ready
        expect(failures).toEqual([])
        expect(snapshot).toBeDefined()
        if (!snapshot) throw new Error('快照未发布')
        expect(statSync(snapshot.path).mode & 0o777).toBe(0o600)
        expect(statSync(setup.options.directory).mode & 0o777).toBe(0o700)
        expect(readdirSync(setup.options.directory)).toEqual([snapshot.path.split('/').at(-1)!])
        const source = readFileSync(snapshot.path, 'utf8')
        expect(source).not.toContain('启动噪声')
        expect(source).not.toMatch(/(?:typeset|declare|export).*\b(?:PWD|OLDPWD)=/)
        expect(source).toContain('axon_test_fn')
        expect(source).toContain('axon_test_alias')
        const result = spawnSync(snapshot.shell.path, ['-c', `. ${quote(snapshot.path)}; printf '%s\\0' "$AXON_TEST_VALUE"; axon_test_fn`], {
          cwd: setup.options.cwd, env: setup.options.environment,
        })
        expect(result.status).toBe(0)
        expect(result.stdout.toString()).toBe(`${value}\0function-ok`)
        environment.dispose()
        expect(existsSync(snapshot.path)).toBe(false)
      } finally { environment.dispose(); setup.cleanup() }
    })
  }

  test('ZDOTDIR 指向的启动文件覆盖 HOME 默认位置', async () => {
    const setup = fixture('zsh', 'export AXON_TEST_VALUE=from-zdotdir')
    const otherHome = join(setup.directory, 'other-home')
    mkdirSync(otherHome)
    writeFileSync(join(otherHome, '.zshrc'), 'export AXON_TEST_VALUE=wrong')
    const environment = new AgentShellSnapshotEnvironment({
      ...setup.options, environment: { ...setup.options.environment, HOME: otherHome },
    })
    try {
      const snapshot = await environment.ready
      expect(snapshot).toBeDefined()
      expect(readFileSync(snapshot!.path, 'utf8')).toContain('from-zdotdir')
    } finally { environment.dispose(); setup.cleanup() }
  })

  for (const envPath of ['~/.shrc', '${HOME}/.shrc', '${AXON_MISSING:-$HOME}/.shrc', '${PATH%%:*}/.shrc']) {
    test(`sh ENV 路径支持 ${envPath} 的非执行式展开`, async () => {
      const setup = fixture('sh', 'export AXON_TEST_VALUE=env-loaded')
      writeFileSync(join(setup.options.environment!.HOME!, '.profile'), 'export PATH="$HOME:$PATH"\n')
      const environment = new AgentShellSnapshotEnvironment({
        ...setup.options, environment: { ...setup.options.environment, ENV: envPath },
      })
      try {
        const snapshot = await environment.ready
        expect(snapshot).toBeDefined()
        expect(readFileSync(snapshot!.path, 'utf8')).toContain('env-loaded')
      } finally { environment.dispose(); setup.cleanup() }
    })
  }

  test('sh 不执行 ENV 中的命令替换', async () => {
    const setup = fixture('sh', 'export AXON_TEST_VALUE=env-loaded')
    const unexpected = join(setup.directory, 'unexpected')
    const environment = new AgentShellSnapshotEnvironment({
      ...setup.options, environment: { ...setup.options.environment, ENV: `$(/usr/bin/touch ${quote(unexpected)})` },
    })
    try {
      expect(await environment.ready).toBeDefined()
      expect(existsSync(unexpected)).toBe(false)
    } finally { environment.dispose(); setup.cleanup() }
  })

  test('启动配置退出或输出不完整时只降级，不发布文件或泄漏启动输出', async () => {
    const setup = fixture('zsh', 'printf secret-token; exit 0')
    const failures: string[] = []
    const environment = new AgentShellSnapshotEnvironment({ ...setup.options, onFailure: (reason) => failures.push(reason) })
    try {
      expect(await environment.ready).toBeUndefined()
      expect(failures).toEqual(['invalidCapture'])
      expect(existsSync(setup.options.directory)).toBe(false)
    } finally { environment.dispose(); setup.cleanup() }
  })

  test('加载验证失败删除临时文件，不把不可用脚本发布给后续工具', async () => {
    const setup = fixture('zsh', 'export AXON_TEST_VALUE=valid')
    const fakeShell = join(setup.directory, 'fake-zsh')
    writeFileSync(fakeShell, '#!/bin/sh\nif [ "$1" = -lc ]; then exec /bin/zsh "$@"; else exit 2; fi\n', { mode: 0o700 })
    const failures: string[] = []
    const environment = new AgentShellSnapshotEnvironment({
      ...setup.options, shell: { type: 'zsh', path: fakeShell }, onFailure: (reason) => failures.push(reason),
    })
    try {
      expect(await environment.ready).toBeUndefined()
      expect(failures).toEqual(['validationFailed'])
      expect(readdirSync(setup.options.directory)).toEqual([])
    } finally { environment.dispose(); setup.cleanup() }
  })

  test('初始化超时终止进程，不等待工具调用，也不保留文件', async () => {
    const setup = fixture('zsh', '/bin/sleep 10')
    const failures: string[] = []
    const environment = new AgentShellSnapshotEnvironment({ ...setup.options, timeoutMs: 20, onFailure: (reason) => failures.push(reason) })
    try {
      expect(await environment.ready).toBeUndefined()
      expect(failures).toEqual(['captureFailed'])
      expect(existsSync(setup.options.directory)).toBe(false)
    } finally { environment.dispose(); setup.cleanup() }
  })

  test('输出超过上限拒绝整份快照，而非保存截断的声明', async () => {
    const setup = fixture('zsh', 'export AXON_TEST_VALUE=valid')
    const environment = new AgentShellSnapshotEnvironment({ ...setup.options, maxOutputBytes: 10 })
    try {
      expect(await environment.ready).toBeUndefined()
      expect(existsSync(setup.options.directory)).toBe(false)
    } finally { environment.dispose(); setup.cleanup() }
  })

  test('引用提前释放会取消预热，完成后也不能留下迟到文件', async () => {
    const setup = fixture('zsh', '/bin/sleep 10')
    const failures: string[] = []
    const environment = new AgentShellSnapshotEnvironment({ ...setup.options, onFailure: (reason) => failures.push(reason) })
    try {
      environment.dispose()
      expect(await environment.ready).toBeUndefined()
      expect(environment.snapshot).toBeUndefined()
      expect(failures).toEqual([])
      expect(existsSync(setup.options.directory)).toBe(false)
    } finally { environment.dispose(); setup.cleanup() }
  })

  test('缺失解释器与发布失败均是可选环境失败', async () => {
    const setup = fixture('zsh', 'export AXON_TEST_VALUE=valid')
    const failures: string[] = []
    const unavailable = new AgentShellSnapshotEnvironment({ ...setup.options, shell: undefined, onFailure: (reason) => failures.push(reason) })
    writeFileSync(setup.options.directory, '不是目录')
    const unwritable = new AgentShellSnapshotEnvironment({ ...setup.options, onFailure: (reason) => failures.push(reason) })
    try {
      expect(await unavailable.ready).toBeUndefined()
      expect(await unwritable.ready).toBeUndefined()
      expect(failures).toEqual(['shellUnavailable', 'publishFailed'])
    } finally { unavailable.dispose(); unwritable.dispose(); setup.cleanup() }
  })
})

describe('Shell 快照命令准备', () => {
  for (const type of ['zsh', 'bash', 'sh'] as const) {
    test(`${type} 在包装进程恢复环境，原始命令及参数完整交给 exec 子 Shell`, () => {
      const setup = fixture(type, '')
      const path = join(setup.directory, "snapshot with ' quote.sh")
      writeFileSync(path, 'printf snapshot-noise\nexport AXON_SNAPSHOT_VALUE="来自快照"\nexport PATH=/snapshot/bin\nfalse\n')
      const command = 'printf "%s\\0%s\\0%s\\0" "$AXON_SNAPSHOT_VALUE" "$0" "$1"'
      const argv = [`/bin/${type}`, '-lc', command, "a' b", '第二行\n$() `text`']
      const prepared = prepareAgentShellSnapshotCommand({ argv, cwd: setup.options.cwd }, {
        path, shell: setup.options.shell!, cwd: setup.options.cwd,
      })
      try {
        const result = spawnSync(prepared.argv[0]!, prepared.argv.slice(1), {
          cwd: setup.options.cwd, env: { ...setup.options.environment, ...prepared.environment },
        })
        expect(prepared.argv[1]).toBe('-c')
        expect(argv).toEqual([`/bin/${type}`, '-lc', command, "a' b", '第二行\n$() `text`'])
        expect(result.status).toBe(0)
        expect(result.stdout.toString()).toBe("来自快照\0a' b\0第二行\n$() `text`\0")
        expect(result.stderr.toString()).toBe('')
      } finally { setup.cleanup() }
    })
  }

  test('未就绪、cwd/解释器/参数不匹配、文件丢失均保留原始 argv，不临时创建快照', () => {
    const setup = fixture('zsh', '')
    const path = join(setup.directory, 'snapshot.sh')
    writeFileSync(path, 'export AXON_SNAPSHOT_VALUE=1')
    const snapshot = { path, shell: setup.options.shell!, cwd: setup.options.cwd }
    const input = { argv: ['/bin/zsh', '-lc', 'true'], cwd: setup.options.cwd }
    try {
      expect(prepareAgentShellSnapshotCommand(input).argv).toBe(input.argv)
      for (const modified of [
        { ...input, cwd: join(input.cwd, 'child') },
        { ...input, argv: ['/bin/bash', '-lc', 'true'] },
        { ...input, argv: ['/bin/zsh', '-c', 'true'] },
        { ...input, argv: ['/bin/zsh', '-lc'] },
      ]) expect(prepareAgentShellSnapshotCommand(modified, snapshot).argv).toBe(modified.argv)
      rmSync(path)
      expect(prepareAgentShellSnapshotCommand(input, snapshot).argv).toBe(input.argv)
    } finally { setup.cleanup() }
  })

  test('显式覆盖、空值和删除优先于快照，私有暂存不泄漏值到 argv 或子进程', () => {
    const setup = fixture('zsh', '')
    const path = join(setup.directory, 'snapshot.sh')
    writeFileSync(path, 'export AXON_OVERRIDE=old\nexport AXON_EMPTY=old\nexport AXON_DELETED=old\nexport TMPDIR=/old\nexport TMP=/old\nexport TEMP=/old\n')
    const secret = 'secret:引号\'"\n$HOME `touch bad`'
    const overrides = { AXON_OVERRIDE: secret, AXON_EMPTY: '', AXON_DELETED: undefined, 'BAD;KEY': '忽略非法名称' }
    const prepared = prepareAgentShellSnapshotCommand({
      argv: ['/bin/zsh', '-lc', 'printf "%s\\0%s\\0%s\\0%s\\0%s\\0%s\\0" "$AXON_OVERRIDE" "$AXON_EMPTY" "${AXON_DELETED-unset}" "$TMPDIR" "$TMP" "$TEMP"; /usr/bin/env'],
      cwd: setup.options.cwd, environmentOverrides: overrides,
    }, { path, cwd: setup.options.cwd, shell: setup.options.shell! })
    try {
      expect(prepared.argv.join(' ')).not.toContain(secret)
      expect(prepared.argv.join(' ')).not.toContain('BAD;KEY')
      const result = spawnSync(prepared.argv[0]!, prepared.argv.slice(1), {
        cwd: setup.options.cwd,
        env: { ...setup.options.environment, ...overrides, ...prepared.environment, TMPDIR: '/controlled', TMP: '/controlled', TEMP: '/controlled' },
      })
      expect(result.status).toBe(0)
      expect(result.stdout.toString()).toStartWith(`${secret}\0\0unset\0/controlled\0/controlled\0/controlled\0`)
      expect(result.stdout.toString()).not.toContain('__AXON_SNAPSHOT_')
    } finally { setup.cleanup() }
  })

  test('继承 PATH 不覆盖快照，运行时目录按前缀添加；显式 PATH 则采用精确覆盖', () => {
    const setup = fixture('zsh', '')
    const path = join(setup.directory, 'snapshot.sh')
    writeFileSync(path, 'export PATH=/snapshot/bin\n')
    const input = { argv: ['/bin/zsh', '-lc', 'printf %s "$PATH"'], cwd: setup.options.cwd, pathPrepend: ["/runtime/'bin"] }
    try {
      for (const environmentOverrides of [{}, { PATH: '/explicit/bin' }]) {
        const prepared = prepareAgentShellSnapshotCommand({ ...input, environmentOverrides }, {
          path, shell: setup.options.shell!, cwd: setup.options.cwd,
        })
        const result = spawnSync(prepared.argv[0]!, prepared.argv.slice(1), {
          cwd: setup.options.cwd, env: { ...setup.options.environment, ...environmentOverrides, ...prepared.environment },
        })
        expect(result.status).toBe(0)
        expect(result.stdout.toString()).toBe('PATH' in environmentOverrides ? '/explicit/bin' : "/runtime/'bin:/snapshot/bin")
      }
    } finally { setup.cleanup() }
  })

  for (const type of ['zsh', 'bash', 'sh'] as const) {
    test(`${type} 准备后快照消失，加载诊断被屏蔽且原始命令仍执行`, () => {
      const setup = fixture(type, '')
      const path = join(setup.directory, 'snapshot.sh')
      writeFileSync(path, 'export AXON_SNAPSHOT_VALUE=old\n')
      const prepared = prepareAgentShellSnapshotCommand({ argv: [`/bin/${type}`, '-lc', 'printf original'], cwd: setup.options.cwd }, {
        path, cwd: setup.options.cwd, shell: setup.options.shell!,
      })
      rmSync(path)
      try {
        const result = spawnSync(prepared.argv[0]!, prepared.argv.slice(1), { cwd: setup.options.cwd, env: setup.options.environment })
        expect(result.status).toBe(0)
        expect(result.stdout.toString()).toBe('original')
        expect(result.stderr.toString()).toBe('')
      } finally { setup.cleanup() }
    })
  }

  test('快照打开 xtrace 时，内部覆盖恢复也不把密钥写到输出或 argv', () => {
    const setup = fixture('zsh', '')
    const path = join(setup.directory, 'snapshot.sh')
    const secret = 'axon-secret-should-not-leak'
    writeFileSync(path, 'export AXON_OVERRIDE=old\nset -x\n')
    const prepared = prepareAgentShellSnapshotCommand({
      argv: ['/bin/zsh', '-lc', 'true'], cwd: setup.options.cwd, environmentOverrides: { AXON_OVERRIDE: secret },
    }, { path, cwd: setup.options.cwd, shell: setup.options.shell! })
    try {
      const result = spawnSync(prepared.argv[0]!, prepared.argv.slice(1), {
        cwd: setup.options.cwd, env: { ...setup.options.environment, AXON_OVERRIDE: secret, ...prepared.environment },
      })
      expect(result.status).toBe(0)
      expect(result.stdout.toString()).not.toContain(secret)
      expect(result.stderr.toString()).not.toContain(secret)
      expect(prepared.argv.join(' ')).not.toContain(secret)
    } finally { setup.cleanup() }
  })
})
