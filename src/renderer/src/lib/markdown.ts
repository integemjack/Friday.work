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

// 渲染结果小缓存（按源文本，LRU）：一条消息里任何一块变了（工具卡状态、流式增量）整条消息重渲染，
// 其余没变的文本块不必再过一遍 markdown-it；桌面气泡与聊天栏渲染同一段文本也能共用
const CACHE_MAX = 240
const CACHE_MAX_SOURCE = 40_000
const cache = new Map<string, string>()

export function renderMarkdown(source: string | undefined | null): string {
  if (!source) return ''
  const hit = cache.get(source)
  if (hit !== undefined) {
    // 命中：挪到队尾（Map 按插入序，队首就是最久没用的）
    cache.delete(source)
    cache.set(source, hit)
    return hit
  }
  const html = md.render(source)
  if (source.length <= CACHE_MAX_SOURCE) {
    cache.set(source, html)
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!)
  }
  return html
}
