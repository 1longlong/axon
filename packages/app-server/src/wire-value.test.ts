import { describe, expect, test } from 'bun:test'
import { toWireValue } from './wire-value'

describe('后端 DTO 显式 JSON 编码', () => {
  test('只省略对象可选字段，保留空值、布尔、数组和中文', () => {
    expect(toWireValue({ optional: undefined, nested: { absent: undefined, text: '中文' },
      values: [null, false, 0, '', { enabled: true }] }))
      .toEqual({ nested: { text: '中文' }, values: [null, false, 0, '', { enabled: true }] })
  })
  test('函数、信号、Buffer、非有限数、数组 undefined 和稀疏项不能隐式丢失', () => {
    for (const value of [() => {}, new AbortController().signal, Buffer.from('secret'), new Date(),
      NaN, Infinity, [undefined], new Array(1), { execute: () => {} }]) {
      expect(() => toWireValue(value)).toThrow()
    }
  })
  test('循环引用及过深 DTO 明确拒绝', () => {
    const cyclic: { next?: unknown } = {}
    cyclic.next = cyclic
    expect(() => toWireValue(cyclic)).toThrow('嵌套过深')
    let value: unknown = null
    for (let index = 0; index < 70; index += 1) value = { next: value }
    expect(() => toWireValue(value)).toThrow('嵌套过深')
  })
})
