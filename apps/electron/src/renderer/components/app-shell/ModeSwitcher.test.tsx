import { expect, test } from 'bun:test'
import { Provider, createStore } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import { navigateAppAtom } from '../../atoms/app-navigation'
import { ModeSwitcher } from './ModeSwitcher'

test('展开和收起均保留三个模块入口，只有当前模块高亮', () => {
  const store = createStore()
  for (const section of ['agent', 'chat', 'loop'] as const) {
    store.set(navigateAppAtom, { section })
    for (const collapsed of [false, true]) {
      const html = renderToStaticMarkup(<Provider store={store}><ModeSwitcher collapsed={collapsed} /></Provider>)
      expect(html.match(/aria-pressed="true"/g)).toHaveLength(1)
      for (const label of ['Agent', 'Chat', 'Loop']) expect(html).toContain(`aria-label="${label} 模块"`)
      expect(html).toContain(`aria-pressed="true" aria-label="${section === 'agent' ? 'Agent' : section === 'chat' ? 'Chat' : 'Loop'} 模块"`)
    }
  }
})
