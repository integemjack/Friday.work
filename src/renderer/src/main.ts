import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './styles/main.css'
import { applyTheme, loadTheme } from './lib/theme.js'
import { CAST_MAX_H_CSS } from './lib/cast.js'
import { initTtsProgressListener } from './lib/speechOutput.js'

// 挂载前先应用主题：首帧就是贾维斯/系统样式，不闪系统默认色
applyTheme(loadTheme())
// 挂载前注入投出物限高变量（单源 lib/cast.ts）：气泡/操作卡的限高 CSS 从 --cast-max-h 取值
document.documentElement.style.setProperty('--cast-max-h', CAST_MAX_H_CSS)
// 回复语音播报的模型进度事件（首次使用自动下载 kokoro 模型）：全局挂一次
initTtsProgressListener()

createApp(App).use(createPinia()).mount('#app')
