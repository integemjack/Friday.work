import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  main: {
    // 构建提交：CI 打包时传 GIT_COMMIT（release.yml），本地 dev 是 'dev'
    define: { __APP_COMMIT__: JSON.stringify(process.env.GIT_COMMIT || 'dev') },
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          // 主进程入口 + 协议进程（utilityProcess）入口，各出一个文件
          index: resolve(__dirname, 'src/main/index.ts'),
          protocol: resolve(__dirname, 'src/protocol/index.ts')
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].js'
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    plugins: [vue()]
  }
})
