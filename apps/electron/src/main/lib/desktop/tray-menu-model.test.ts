import { describe, expect, test } from 'bun:test'
import { createTrayMenuModel } from './tray-menu-model'

describe('createTrayMenuModel', () => {
  test('窗口状态决定显示或隐藏文案', () => {
    expect(createTrayMenuModel(true, [])[0]).toMatchObject({ command: 'toggle_window', label: '隐藏 Axon' })
    expect(createTrayMenuModel(false, [])[0]).toMatchObject({ command: 'toggle_window', label: '显示 Axon' })
  })

  test('Agent 项目按名称排序且不修改输入', () => {
    const projects = [{ id: '2', name: 'Beta' }, { id: '1', name: 'Alpha' }]
    const entry = createTrayMenuModel(false, projects).find((item) => item.kind === 'submenu')
    expect(entry?.kind === 'submenu' ? entry.projects.map((item) => item.name) : []).toEqual(['Alpha', 'Beta'])
    expect(projects.map((item) => item.name)).toEqual(['Beta', 'Alpha'])
  })
})
