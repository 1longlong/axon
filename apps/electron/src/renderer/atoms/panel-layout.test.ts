import { describe, expect, test } from 'bun:test'
import { clampPanelWidth } from './panel-layout'

describe('可调整面板宽度', () => {
  test('拒绝非法恢复值并限制拖拽范围', () => {
    expect(clampPanelWidth(undefined, 256, 220, 380)).toBe(256)
    expect(clampPanelWidth(Number.NaN, 256, 220, 380)).toBe(256)
    expect(clampPanelWidth(100, 256, 220, 380)).toBe(220)
    expect(clampPanelWidth(900, 256, 220, 380)).toBe(380)
    expect(clampPanelWidth(271.6, 256, 220, 380)).toBe(272)
  })
})
