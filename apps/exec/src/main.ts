#!/usr/bin/env bun
import { homedir } from 'node:os'
import { runExecCommand } from './command'
import { runLoopCli } from '@axon/app-server'

/** 仅提供真实进程上下文；业务、取消及输出交付由同一命令编排链负责。 */
process.exitCode = process.argv[2] === 'loop' ? await runLoopCli(process.argv.slice(3)) : await runExecCommand({ argv: process.argv.slice(2), originalCwd: process.cwd(), homeDir: homedir(),
  platform: process.platform, environment: process.env, stdin: process.stdin, stdout: process.stdout,
  stderr: process.stderr, signals: { on: (event, listener) => process.on(event, listener),
    // 保留真实 Process 解绑行为，避开当前 Bun 类型对重载的错误收窄。
    removeListener: (event, listener) => Reflect.apply(process.removeListener, process, [event, listener]) } })
