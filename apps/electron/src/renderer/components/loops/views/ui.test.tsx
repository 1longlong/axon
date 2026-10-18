import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { btn, btnPrimary, btnDanger, btnCost, btnSm, btnPrimaryPill, inputCls, Pill } from './ui'

test('Loop 按钮与文字标签使用完整胶囊，输入框保留原小圆角', () => {
  for (const classes of [btn, btnPrimary, btnDanger, btnCost, btnSm, btnPrimaryPill]) {
    expect(classes.split(' ')).toContain('rounded-full')
    expect(classes.split(' ')).not.toContain('rounded-control')
  }
  const pill = renderToStaticMarkup(<Pill>已完成</Pill>)
  expect(pill).toContain('rounded-full')
  expect(inputCls).toContain('rounded-control')
})
