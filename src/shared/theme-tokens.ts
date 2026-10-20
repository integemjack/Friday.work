// 主题相关常量的唯一真相来源。渲染层 CSS 变量在 src/renderer/src/styles/tokens.css，
// 两者用注释锚点互指，改一处务必同步另一处：
// - THEME_BG：窗口底色。主进程 BrowserWindow 的 backgroundColor 是 CSS 管不到的层（启动闪色就是它），
//   渲染层应用主题时经 IPC 上报：lib/theme.ts → preload/index.ts → main/ipc/bridge.ts setBackgroundColor。
// - XTERM_THEMES：xterm 终端色板。xterm 的配色在 JS 层（CSS 盖不到），
//   热切换由 TerminalCard 订阅 uiTheme 实现（经验 m10e24）。

/** 窗口底色：jarvis = tokens.css [data-theme='jarvis'] 的 --bg；system 深浅各一（tokens.css 对应 --bg） */
export const THEME_BG = {
  system: { dark: '#1e1f22', light: '#f6f6f7' },
  jarvis: '#060b14'
} as const

/** xterm 色板（值与贾维斯 CSS 令牌同源：accent #22d3ee 等，见 tokens.css） */
export const XTERM_THEMES = {
  system: {
    /* 半透明深底：融合（需要 allowTransparency，见 new Terminal） */
    background: 'rgba(20, 21, 26, 0.55)',
    foreground: '#e6e6e8',
    cursor: '#8ab4f8',
    selectionBackground: '#3a4a6b'
  },
  jarvis: {
    // 透明底：终端文字直接浮在全息网格背景上（需要 allowTransparency，见 new Terminal）
    background: 'rgba(6, 11, 20, 0)',
    foreground: '#c9e7f2',
    cursor: '#22d3ee',
    cursorAccent: '#071018',
    selectionBackground: 'rgba(34, 211, 238, 0.28)',
    black: '#0c1a2a',
    red: '#ff6b81',
    green: '#3ddc97',
    yellow: '#ffd166',
    blue: '#6bb8ff',
    magenta: '#c792ea',
    cyan: '#4dd9e8',
    white: '#c9d6e3',
    brightBlack: '#4a6a80',
    brightRed: '#ff8fa0',
    brightGreen: '#6fe7b4',
    brightYellow: '#ffe08a',
    brightBlue: '#93ccff',
    brightMagenta: '#dcb3f5',
    brightCyan: '#7ce6f2',
    brightWhite: '#eef8fc'
  }
} as const
