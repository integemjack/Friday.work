import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import QuickInput from './components/QuickInput.vue'
import './styles/main.css'
import { applyTheme, loadTheme } from './lib/theme.js'
import { installTooltip } from './lib/tooltip.js'
import { CAST_MAX_H_CSS } from './lib/cast.js'
import { initTtsProgressListener, refreshCosyVoiceStatus } from './lib/speechOutput.js'

// 壁纸模式的置顶输入浮层（主进程以 ?quick=1 打开的小窗）：只挂 QuickInput，
// 不走 App（不连工作台、不挂桌面 HUD，进来就能打字）
const isQuickInput = new URLSearchParams(location.search).get('quick') === '1'

// 全局自绘 tooltip（两个窗口共用本入口）：接管所有 [title] 的原生提示，
// 换成无边框圆角的 .frid-tip 浮签（lib/tooltip.ts + styles/base.css）
installTooltip()

if (!isQuickInput) {
  // 挂载前先应用主题：首帧就是贾维斯/系统样式，不闪系统默认色
  applyTheme(loadTheme())
  // 挂载前注入投出物限高变量（单源 lib/cast.ts）：气泡/操作卡的限高 CSS 从 --cast-max-h 取值
  document.documentElement.style.setProperty('--cast-max-h', CAST_MAX_H_CSS)
  // 回复语音播报的模型进度事件（引擎启动/下载进度）：全局挂一次
  initTtsProgressListener()
  // 启动即拉一次音色列表：选中克隆音色时第一次播报就能用对——列表没到前 activeVoice()
  // 找不到克隆 id 会临时回落成默认音色（素绢）。引擎没跑时 voice:voices 直接扫
  // user-voices 目录（毫秒级、不拉引擎）；引擎删了音色的回落由这次刷新的权威路径照常处理
  void refreshCosyVoiceStatus()
}

createApp(isQuickInput ? QuickInput : App).use(createPinia()).mount('#app')
