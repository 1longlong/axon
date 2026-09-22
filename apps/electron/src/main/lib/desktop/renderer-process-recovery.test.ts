/**
 * Renderer 崩溃恢复窗口测试
 */

import { describe, expect, test } from 'bun:test'
import { canRecoverRenderer, MAX_RENDERER_RECOVERY_ATTEMPTS, RENDERER_RECOVERY_WINDOW_MS } from './renderer-process-recovery'

describe('canRecoverRenderer', () => {
  test('无历史失败时可恢复', () => {
    expect(canRecoverRenderer([], Date.now())).toBe(true)
  })

  test('窗口期内达到上限后不再恢复', () => {
    const now = Date.now()
    const attempts = Array.from({ length: MAX_RENDERER_RECOVERY_ATTEMPTS }, () => now - 1000)
    expect(canRecoverRenderer(attempts, now)).toBe(false)
  })

  test('窗口期外的旧失败不计入', () => {
    const now = Date.now()
    const attempts = Array.from({ length: MAX_RENDERER_RECOVERY_ATTEMPTS }, () => now - RENDERER_RECOVERY_WINDOW_MS - 1000)
    expect(canRecoverRenderer(attempts, now)).toBe(true)
  })
})
