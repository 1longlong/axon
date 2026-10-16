/** schema 编译/解析/校验隔离于工作线程；不联网、不修改数据、不回传原始错误或模型正文。 */
import { parentPort, workerData } from 'node:worker_threads'
import Ajv from 'ajv'
import Ajv2019 from 'ajv/dist/2019'
import Ajv2020 from 'ajv/dist/2020'
import addFormats from 'ajv-formats'
import type { AnySchema, ValidateFunction } from 'ajv'

const port = parentPort!
let validate: ValidateFunction<unknown>
try {
  const schema = (workerData as { schema: boolean | Record<string, unknown> }).schema
  const declared = typeof schema === 'object' ? schema.$schema : undefined
  const draft = typeof declared === 'string' ? declared.replace(/#$/, '') : declared
  const options = { strict: true, strictTypes: false, strictTuples: false, strictRequired: false,
    allErrors: false, ownProperties: true, logger: false as const, messages: false }
  const validator = draft === undefined || draft === 'http://json-schema.org/draft-07/schema' || draft === 'https://json-schema.org/draft-07/schema' ? new Ajv(options)
    : draft === 'https://json-schema.org/draft/2019-09/schema' ? new Ajv2019(options)
      : draft === 'https://json-schema.org/draft/2020-12/schema' ? new Ajv2020(options) : undefined
  if (!validator || typeof schema === 'object' && schema.$async !== undefined) throw new Error()
  // 同一已支持草案的 HTTPS/空片段别名规范化到内置元 schema；不开放任意远程方言。
  if (typeof schema === 'object' && draft !== undefined) schema.$schema = draft === 'https://json-schema.org/draft-07/schema'
    || draft === 'http://json-schema.org/draft-07/schema' ? 'http://json-schema.org/draft-07/schema#' : draft
  addFormats(validator)
  // 不配置 loadSchema/compileAsync；仅解析同一文档内能解析的引用，不能额外读取文件或 URL。
  validate = validator.compile<unknown>(schema as AnySchema)
  port.postMessage({ type: 'ready' })
  port.on('message', (text: unknown) => {
    if (typeof text !== 'string') { port.postMessage({ type: 'error' }); return }
    let value: unknown
    try { value = JSON.parse(text) as unknown }
    catch { port.postMessage({ type: 'validation', valid: false }); return }
    try { port.postMessage({ type: 'validation', valid: validate(value) === true }) }
    catch { port.postMessage({ type: 'error' }) }
  })
} catch { port.postMessage({ type: 'invalid_schema' }) }
