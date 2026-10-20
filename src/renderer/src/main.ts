import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './style.css'
import './jarvis.css'
import { applyTheme, loadTheme } from './lib/theme.js'

// 挂载前先应用主题：首帧就是贾维斯/系统样式，不闪系统默认色
applyTheme(loadTheme())

createApp(App).use(createPinia()).mount('#app')
