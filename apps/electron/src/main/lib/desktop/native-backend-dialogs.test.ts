import { describe, expect, test } from 'bun:test'
import { createRequire } from 'node:module'
import type { OpenDialogOptions, WebContents } from 'electron'
import type { pickAgentAttachments } from './native-backend-dialogs'

/** 隔离原生模块替身，不污染其他桌面测试的 Electron 模块注册表。 */
async function openPicker(canceled = false) {
  const calls: OpenDialogOptions[] = [], window = { isDestroyed: () => false }
  const sender = {} as WebContents
  const built = await Bun.build({ entrypoints: [`${import.meta.dir}/native-backend-dialogs.ts`], target: 'node', format: 'cjs', external: ['electron'] })
  if (!built.success) throw new Error('原生选择夹具构建失败')
  const module = { exports: {} as { pickAgentAttachments: typeof pickAgentAttachments } }, require = createRequire(import.meta.url)
  const run = new Function('require', 'module', 'exports', await built.outputs[0]!.text())
  run((name: string) => name === 'electron' ? {
    BrowserWindow: { fromWebContents: (value: WebContents) => value === sender ? window : undefined },
    dialog: { showOpenDialog: async (parent: unknown, options: OpenDialogOptions) => {
      expect(parent).toBe(window); calls.push(options)
      return { canceled, filePaths: ['/fixture/document.pdf', '/fixture/folder'] }
    } },
  } : require(name), module, module.exports)
  return { pick: module.exports.pickAgentAttachments, sender, calls, window }
}

describe('Agent 统一附件选择', () => {
  test('一个面板同时允许文件/目录和多选，真实路径原样交后端分类', async () => {
    const f = await openPicker()
    expect(await f.pick(f.sender)).toEqual(['/fixture/document.pdf', '/fixture/folder'])
    expect(f.calls).toEqual([{ title: '选择文件或文件夹', properties: ['openFile', 'openDirectory', 'multiSelections'] }])
  })
  test('取消不返回残留路径，未知或已销毁窗口不打开面板', async () => {
    const f = await openPicker(true)
    expect(await f.pick(f.sender)).toEqual([])
    await expect(f.pick({} as WebContents)).rejects.toThrow('窗口不可用')
    f.window.isDestroyed = () => true
    await expect(f.pick(f.sender)).rejects.toThrow('窗口不可用')
    expect(f.calls).toHaveLength(1)
  })
})
