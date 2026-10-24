// 全屏桌面模式（本机偏好，主进程 WallpaperLayer 驱动、状态持久化在 userData/desktop-mode.json）：
// 整个应用无边框铺满整屏（无窗全屏），任务栏 / 桌面图标 / 其它窗口都在它上面；窗口有焦点时
// 可正常打字，被别的窗口盖住时 Ctrl+Alt+F 呼出置顶输入浮层。此模式下标题栏不可拖拽。
import { ref } from 'vue'

const bridge = window.fridayBridge

/** 响应式的模式开关：TitleBar 窗控 / 设置页用它点亮状态 */
export const wallpaperMode = ref(false)

let started = false

/** App.vue 挂载时调一次：拉当前状态 + 跟随主进程推送 */
export function initWallpaperMode(): void {
  if (started) return
  started = true
  void bridge.wallpaperGetState().then((state) => {
    wallpaperMode.value = state.enabled
  })
  bridge.onWallpaperState((enabled) => {
    wallpaperMode.value = enabled
  })
}

/** 切换（设置页 / TitleBar 用）。返回是否成功——切换失败（窗口未就绪）要提示 */
export async function setWallpaperMode(enabled: boolean): Promise<boolean> {
  return bridge.wallpaperSetEnabled(enabled)
}
