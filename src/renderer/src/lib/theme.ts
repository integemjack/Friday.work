// 界面主题（本机 UI 偏好，方案 §2 允许的 localStorage 范畴，和远程机器无关）：
// 默认「贾维斯」——应用一开就是深空青色全息风（<html> 带 data-theme="jarvis"，样式见 style.css [data-theme='jarvis']）；
// 在设置里点「跟随系统」后回到原来的浅/深自适应，选择会落盘记住。
const KEY = 'ui.theme'

export type UITheme = 'system' | 'jarvis'

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
