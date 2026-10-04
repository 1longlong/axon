import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentWorkspaceFilePreview } from '@axon/shared'
import { ShikiCodeBlock } from '@/components/chat/ShikiCodeBlock'
import { WorkspaceTreeEntries } from './WorkspaceFileTree'
import { WorkspaceFilePreview, WorkspaceFileTabs } from './WorkspaceFileTabs'

const preview: AgentWorkspaceFilePreview = {
  kind: 'text', projectId: 'project-1', name: 'example.ts', relativePath: 'src/example.ts',
  size: 1200, content: 'alpha\nbeta\n',
}

function renderPreview(overrides: Partial<Parameters<typeof WorkspaceFilePreview>[0]> = {}): string {
  const props = {
    preview, relativePath: preview.relativePath, loading: false, error: false,
    ...overrides,
  }
  return renderToStaticMarkup(props.relativePath === null ? createElement(WorkspaceFilePreview, props) : createElement(WorkspaceFileTabs, {
    tabs: [{ ...props, relativePath: props.relativePath, requestId: 1 }], activePath: props.relativePath,
    onSelect: () => {}, onClose: () => {},
  }))
}

describe('工作区只读预览', () => {
  test('保留文件末尾换行与行号，标签仅显示文件名和关闭入口', () => {
    const html = renderPreview()
    const code = html.match(/<code>([\s\S]*?)<\/code>/)?.[1] ?? ''
    const source = code.replace(/<span aria-hidden="true"[^>]*>\d+<\/span>/g, '').replace(/<[^>]+>/g, '')
    expect(source).toBe(preview.content)
    expect(code.match(/aria-hidden="true"/g)).toHaveLength(3)
    expect(html).not.toContain('1.2 KB')
    expect(html).not.toContain('只读')
    expect(html).toContain('关闭文件 src/example.ts')
    expect(html).toContain('title="src/example.ts"')
  })

  test('文件里的 HTML 作为源码转义，不能成为可执行节点', () => {
    const html = renderPreview({ preview: { ...preview, content: '<script>alert(1)</script>' } })
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script>')
  })

  test('等待新文件时标题更新，旧内容和旧大小不继续显示', () => {
    const html = renderPreview({ relativePath: 'src/new.ts', loading: true })
    expect(html).toContain('title="src/new.ts"')
    expect(html).toContain('正在读取')
    expect(html).not.toContain('alpha')
    expect(html).not.toContain('1.2 KB')
  })

  test('不匹配当前路径的旧预览不会显示', () => {
    const html = renderPreview({ relativePath: 'src/new.ts' })
    expect(html).not.toContain('alpha')
    expect(html).toContain('从工作区文件树选择文件')
  })

  test('空态和读取失败保持明确，不显示假文件或代码', () => {
    const empty = renderPreview({ preview: null, relativePath: null })
    expect(empty).toContain('从工作区文件树选择文件')
    expect(empty).not.toContain('role="tab"')
    const failed = renderPreview({ preview: null, error: true })
    expect(failed).toContain('文件不存在或无法安全读取')
    expect(failed).not.toContain('<pre')
  })

  test('二进制与超大文件保持原有读取边界提示', () => {
    const metadata = { projectId: 'project-1', name: 'example.ts', relativePath: 'src/example.ts', size: 1024 * 1024 }
    const binary = renderPreview({ preview: { ...metadata, kind: 'binary' } })
    const large = renderPreview({ preview: { ...metadata, kind: 'too_large' } })
    expect(binary).toContain('二进制文件暂不预览')
    expect(large).toContain('文件超过 512 KB')
    expect(binary).not.toContain('<pre')
    expect(large).not.toContain('<pre')
  })

  test('消息代码块继续使用原有围栏换行处理与复制入口', () => {
    const html = renderToStaticMarkup(createElement(ShikiCodeBlock, { code: 'alpha\n', language: 'text' }))
    expect(html).toContain('复制')
    expect(html).not.toContain('aria-hidden="true"')
    expect(html).toContain('>alpha</span>')
  })
})

describe('工作区文件树', () => {
  test('目录递归展示、文件选中语义及符号链接边界继续保留', () => {
    const html = renderToStaticMarkup(createElement(WorkspaceTreeEntries, {
      entries: [
        { name: 'src', kind: 'directory', relativePath: 'src', children: [
          { name: 'config.json', kind: 'file', relativePath: 'src/config.json' },
        ] },
        { name: 'outside', kind: 'symlink', relativePath: 'outside' },
      ],
      selectedPath: 'src/config.json', onSelect: () => {},
    }))
    expect(html).toContain('<details')
    expect(html).toContain('aria-label="预览 src/config.json" aria-pressed="true"')
    expect(html).not.toContain('aria-label="预览 outside"')
    expect(html).toContain('outside')
  })
})
