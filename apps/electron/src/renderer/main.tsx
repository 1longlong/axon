import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles/globals.css'
import 'katex/dist/katex.min.css'

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('找不到 #root 挂载点')
}

// 标记主窗口：globals.css 据此禁止 html/body 成为滚动容器（滚动留在各面板内）
document.documentElement.classList.add('axon-main-window')
if (new URLSearchParams(window.location.search).get('quick') === '1') {
  document.documentElement.classList.add('axon-quick-window')
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
