/** 独立进程验证 console/直接写不能污染协议，也不回显诊断中的凭据。 */
import { isolateAppServerStdio } from '../src/stdio-isolation'

const io = isolateAppServerStdio()
console.log('sk-fixture-secret', { private: '/private/data' })
console.warn('sk-fixture-secret')
console.dir({ token: 'sk-fixture-secret' })
process.stdout.write('sk-fixture-secret stdout')
process.stderr.write('sk-fixture-secret stderr')
io.protocolOutput.end('{"protocol":true}\n', () => process.exit(0))
