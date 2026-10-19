// 会话文本的 Markdown 渲染（markdown-it 单例）。
// html: false —— 富文本一律不透传原始 HTML，v-html 里只有 markdown-it 生成的标签，防 XSS。
import MarkdownIt from 'markdown-it'

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
})

// 链接一律新窗口打开（渲染进程不该被页面导航带走）
const defaultLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet('target', '_blank')
  tokens[idx].attrSet('rel', 'noopener noreferrer')
  return defaultLinkOpen(tokens, idx, options, env, self)
}

export function renderMarkdown(source: string | undefined | null): string {
  if (!source) return ''
  return md.render(source)
}
