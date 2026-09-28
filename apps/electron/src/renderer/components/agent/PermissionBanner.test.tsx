import { describe, expect, test } from 'bun:test'
import type { AgentPermissionRequest } from '@axon/shared'
import { buildPermissionBannerContent } from './PermissionBanner'

function request(overrides: Partial<AgentPermissionRequest> = {}): AgentPermissionRequest {
  return {
    requestId: 'request-1', sessionId: 'session-1', runStartedAt: 1,
    toolUseId: 'tool-1', toolName: 'Bash', toolInput: { command: 'curl https://example.com' },
    description: '执行命令', dangerLevel: 'normal', allowAlways: true,
    createdAt: 1, expiresAt: 2,
    ...overrides,
  }
}

describe('Agent 权限横幅文案', () => {
  test('普通工具确认不伪装成沙箱升级', () => {
    expect(buildPermissionBannerContent(request())).toEqual({
      title: 'Agent 请求执行：Bash', description: '执行命令',
    })
  })

  test('网络升级展示原因与可能已有副作用的宿主说明', () => {
    expect(buildPermissionBannerContent(request({
      description: '允许命令访问网络',
      sandboxEscalation: {
        reason: 'networkAccess', permission: { type: 'network' },
        message: '命令的网络访问被基础沙箱拒绝；命令可能已产生部分本地副作用',
      },
    }))).toEqual({
      title: 'Agent 请求扩展沙箱权限：Bash', kind: '网络访问',
      description: '允许命令访问网络',
      detail: '命令的网络访问被基础沙箱拒绝；命令可能已产生部分本地副作用',
    })
  })

  test('文件升级展示规范化后的精确目标', () => {
    expect(buildPermissionBannerContent(request({
      toolName: 'Write', description: '写入工作区外路径：/tmp/a.txt',
      sandboxEscalation: {
        reason: 'filesystemWriteOutsideWorkspace',
        permission: { type: 'filesystemWrite', roots: ['/private/tmp/a.txt'] },
        target: '/private/tmp/a.txt', message: '文件写入目标越过沙箱可写根',
      },
    }))).toMatchObject({
      kind: '工作区外写入', target: '/private/tmp/a.txt',
      detail: '文件写入目标越过沙箱可写根',
    })
  })
})
