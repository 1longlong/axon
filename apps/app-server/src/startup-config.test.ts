import { describe, expect, test } from 'bun:test'
import { parseAppServerStartupConfig } from './startup-config'

const args = ['--data-dir', '/private/tmp/axon', '--home-dir', '/private/tmp/axon-home', '--application-version', '0.1.3']
describe('独立后端可信启动参数', () => {
  test('只接受显式绝对目录/版本；受控解释器可来自启动参数或约定环境', () => {
    expect(parseAppServerStartupConfig(args, {})).toEqual({ dataDir: '/private/tmp/axon', homeDir: '/private/tmp/axon-home', applicationVersion: '0.1.3' })
    expect(parseAppServerStartupConfig(args, { AXON_ZIMA_PYTHON: ' /usr/bin/python3 ' }).zimaPython).toBe('/usr/bin/python3')
    expect(parseAppServerStartupConfig([...args, '--zima-python', '/chosen/python'], { AXON_ZIMA_PYTHON: '/other/python' }).zimaPython).toBe('/chosen/python')
  })
  test('拒绝缺失/重复/未知参数、相对目录和 NUL；不猜默认正式目录', () => {
    for (const invalid of [[], ['--data-dir', '/tmp'], [...args, '--data-dir', '/other'], [...args, '--unknown', 'value'], [...args, '--zima-python'],
      ['--data-dir', 'relative', '--home-dir', '/tmp', '--application-version', '1'],
      ['--data-dir', '/tmp\0secret', '--home-dir', '/tmp', '--application-version', '1']]) {
      expect(() => parseAppServerStartupConfig(invalid, {})).toThrow('后端启动参数无效')
    }
  })
})
