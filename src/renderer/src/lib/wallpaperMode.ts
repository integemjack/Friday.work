// 桌面背景层模式（本机偏好，主进程 WallpaperLayer 驱动、状态持久化在 userData/desktop-mode.json）：
// 整个应用挂进 Windows 壁纸层（桌面图标之下）——Win+D / 显示桌面不再收走，其它窗口永远浮在
// 它上面。壁纸层拿不到键盘焦点（系统不转发输入），打字用 Ctrl+Alt+F 呼出置顶输入浮层。
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

/** 切换（设置页 / TitleBar 用）。返回是否成功——挂接失败（桌面层找不到）要提示 */
export async function setWallpaperMode(enabled: boolean): Promise<boolean> {
  return bridge.wallpaperSetEnabled(enabled)
}
