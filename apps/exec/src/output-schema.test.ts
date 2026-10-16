import { describe, expect, test } from 'bun:test'
import { ExecOutputSchema, ExecSchemaError } from './output-schema'
import { ExecInputError } from './arguments'

const signal = (): AbortSignal => new AbortController().signal
describe('exec 最终 Schema 编译与校验', () => {
  test('三个草案、局部引用/组合/格式真正校验；允许 JSON 原始空白，不改写数值类型', async () => {
    for (const $schema of [undefined, 'https://json-schema.org/draft-07/schema#', 'https://json-schema.org/draft/2019-09/schema#', 'https://json-schema.org/draft/2020-12/schema']) {
      const schema = { ...($schema ? { $schema } : {}), type: 'object', additionalProperties: false,
        properties: { email: { type: 'string', format: 'email' }, count: { $ref: '#/$defs/count' } }, required: ['email', 'count'],
        $defs: { count: { type: 'integer', minimum: 1 } } }
      const good = await ExecOutputSchema.compile(schema, signal())
      expect(good.instruction).toContain('[最终输出要求]')
      expect(good.instruction).toContain('"$ref":"#/$defs/count"')
      await good.validate('  {"email":"example@example.test","count":2}\n\n', signal())
      for (const body of ['{"email":"bad","count":2}', '{"email":"example@example.test","count":"2"}', '{"email":"example@example.test","count":2,"extra":1}']) {
        const bad = await ExecOutputSchema.compile(schema, signal())
        await expect(bad.validate(body, signal())).rejects.toMatchObject({ kind: 'mismatch' })
        await bad.dispose()
      }
    }
    const union = await ExecOutputSchema.compile({ anyOf: [{ const: 'yes' }, { type: 'null' }] }, signal())
    await union.validate('null', signal())
  }, 15000)

  test('完整正文必须是 JSON，不剥代码围栏/解释，不补缺字段/default 或删除额外字段', async () => {
    for (const body of ['```json\n{}\n```', '结果：{}', '{} {}', '{"secret":"private-model-value"}', '']) {
      const schema = await ExecOutputSchema.compile({ type: 'object', required: ['count'], properties: { count: { type: 'integer', default: 1 } } }, signal())
      let error: unknown
      try { await schema.validate(body, signal()) } catch (value) { error = value }
      expect(error).toBeInstanceOf(ExecSchemaError)
      expect((error as Error).message).not.toContain('private-model-value')
      expect((error as ExecSchemaError).kind).toBe('mismatch')
    }
    const always = await ExecOutputSchema.compile(true, signal()); await always.validate('false', signal())
    const never = await ExecOutputSchema.compile(false, signal())
    await expect(never.validate('{}', signal())).rejects.toMatchObject({ kind: 'mismatch' })
  })

  test('坏字段/未知关键字/方言/外部引用/异步 Schema 预编译失败，错误不泄漏 Schema 内容', async () => {
    for (const value of [{ type: 'not-a-type', description: 'private-schema-value' }, { unknownKeyword: true },
      { $schema: 'https://example.test/private-schema-value' }, { $ref: 'https://example.test/private-schema-value' }, { $async: true, type: 'object' }, [], null]) {
      let error: unknown
      try { await ExecOutputSchema.compile(value, signal()) } catch (value) { error = value }
      expect(error).toBeInstanceOf(ExecInputError)
      expect((error as Error).message).not.toContain('private-schema-value')
    }
    let nested: unknown = true
    for (let index = 0; index < 102; index++) nested = { not: nested }
    await expect(ExecOutputSchema.compile(nested, signal())).rejects.toThrow('深度')
    await expect(ExecOutputSchema.compile({ description: 'x'.repeat(1024 * 1024) }, signal())).rejects.toThrow('1 MiB')
  })

  test('取消编译/校验实际释放线程，重复校验或 dispose 后校验不可用', async () => {
    const canceled = new AbortController(); canceled.abort(new Error('取消'))
    await expect(ExecOutputSchema.compile({}, canceled.signal)).rejects.toThrow('取消')
    const schema = await ExecOutputSchema.compile({ type: 'string', pattern: '(a+)+$' }, signal())
    const control = new AbortController(), begun = performance.now()
    const timer = setTimeout(() => control.abort(new Error('取消慢校验')), 30)
    try {
      await expect(schema.validate(JSON.stringify(`${'a'.repeat(30)}!`), control.signal)).rejects.toThrow('取消慢校验')
      expect(performance.now() - begun).toBeLessThan(2000)
    } finally { clearTimeout(timer); await schema.dispose() }
    await expect(schema.validate('"a"', signal())).rejects.toMatchObject({ kind: 'unavailable' })
    const once = await ExecOutputSchema.compile({}, signal()); await once.validate('{}', signal())
    await expect(once.validate('{}', signal())).rejects.toMatchObject({ kind: 'unavailable' })
    const disposed = await ExecOutputSchema.compile({}, signal()); await disposed.dispose()
    await expect(disposed.validate('{}', signal())).rejects.toMatchObject({ kind: 'unavailable' })
  }, 10000)
})
