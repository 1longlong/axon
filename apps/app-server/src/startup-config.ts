/** 可信进程启动参数；JSON-RPC 握手不能改数据目录、版本或解释器。 */
import { isAbsolute } from 'node:path'

export interface AppServerStartupConfig {
  dataDir: string
  homeDir: string
  applicationVersion: string
  zimaPython?: string
  entry?: 'exec'
  builtinSkillsRoot?: string
  documentHelper?: string
}

/** 必填目录避免独立测试/其他宿主意外写入正式数据；未知/重复参数直接拒绝。 */
export function parseAppServerStartupConfig(argv: readonly string[], environment: NodeJS.ProcessEnv): AppServerStartupConfig {
  const fields = new Map<string, string>()
  const allowed = ['--data-dir', '--home-dir', '--application-version', '--zima-python', '--entry', '--builtin-skills-root', '--document-helper']
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]!, value = argv[index + 1]
    if (!allowed.includes(key) || fields.has(key) || value === undefined || !value.trim() || value.includes('\0')) throw new Error('后端启动参数无效')
    fields.set(key, value)
  }
  const dataDir = fields.get('--data-dir'), homeDir = fields.get('--home-dir'), applicationVersion = fields.get('--application-version')
  if (!dataDir || !homeDir || !isAbsolute(dataDir) || !isAbsolute(homeDir)
    || !applicationVersion || applicationVersion.length > 100 || /[\r\n]/.test(applicationVersion)) throw new Error('后端启动参数无效')
  const zimaPython = fields.get('--zima-python') ?? environment.AXON_ZIMA_PYTHON?.trim()
  const entry = fields.get('--entry')
  if (entry !== undefined && entry !== 'exec') throw new Error('后端启动参数无效')
  const builtinSkillsRoot = fields.get('--builtin-skills-root'), documentHelper = fields.get('--document-helper')
  if (Boolean(builtinSkillsRoot) !== Boolean(documentHelper) || builtinSkillsRoot && !isAbsolute(builtinSkillsRoot)
    || documentHelper && (!isAbsolute(documentHelper) || !documentHelper.endsWith('.mjs'))
    || entry === 'exec' && documentHelper) throw new Error('内置文档资源配置无效')
  return { dataDir, homeDir, applicationVersion, ...(zimaPython ? { zimaPython } : {}), ...(entry ? { entry } : {}),
    ...(builtinSkillsRoot && documentHelper ? { builtinSkillsRoot, documentHelper } : {}) }
}
