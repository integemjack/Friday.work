// 界面主题（本机 UI 偏好，方案 §2 允许的 localStorage 范畴，和远程机器无关）：
// 默认「贾维斯」——应用一开就是深空青色全息风（<html> 带 data-theme="jarvis"，变量见 styles/tokens.css [data-theme='jarvis']）；
// 在设置里点「跟随系统」后回到原来的浅/深自适应，选择会落盘记住。
import { ref } from 'vue'
import { THEME_BG } from '../../../shared/theme-tokens.js'

const KEY = 'ui.theme'

export type UITheme = 'system' | 'jarvis'

/** 响应式的当前主题：App.vue 用它决定挂不挂贾维斯 HUD，设置页用它点亮选中态 */
export const uiTheme = ref<UITheme>(loadTheme())

/** 读上次的主题偏好；没动过设置（无存档）时默认贾维斯 */
export function loadTheme(): UITheme {
  try {
    const saved = localStorage.getItem(KEY)
    if (saved === 'system' || saved === 'jarvis') return saved
  } catch {
    // localStorage 不可用：走默认
  }
  return 'jarvis'
}

/** 只应用当前主题到 <html>，不落盘（启动时恢复用） */
export function applyTheme(theme: UITheme): void {
  if (theme === 'jarvis') document.documentElement.dataset.theme = 'jarvis'
  else delete document.documentElement.dataset.theme
  uiTheme.value = theme
  // 窗口底色跟主题走（主进程 BrowserWindow 的底色 CSS 管不到，启动闪色就是它）；
  // 底色单源在 shared/theme-tokens.ts（与 styles/tokens.css 的 --bg 互为锚点）
  const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true
  window.fridayBridge?.setWindowBackground(theme === 'jarvis' ? THEME_BG.jarvis : dark ? THEME_BG.system.dark : THEME_BG.system.light)
}

/** 切换主题：落盘 + 立即生效（设置页用）。两个选项都要落盘，否则「跟随系统」会被默认值盖回去 */
export function setTheme(theme: UITheme): void {
  try {
    localStorage.setItem(KEY, theme)
  } catch {
    // localStorage 不可用：本次会话内生效即可
  }
  applyTheme(theme)
}
