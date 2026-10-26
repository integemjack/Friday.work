// 远程窗口控制（本机 UI 偏好，localStorage 范畴，和远程机器无关）：
// 会话（远端智能体）能不能自动打开/收起桌面上的终端、浏览器、文件窗口。
// 默认开 = 接受远程打开和关闭控制：会话用到对应工具时自动开窗（已开就置顶）、
// 标签全关/任务做完时自动收起。关掉后这些窗口只有用户手动开/关。
// 无论开关，用户手动最小化的窗口都不会被远程自动弹回（点顶部图标恢复）。
import { ref } from 'vue'

const KEY = 'desktop.remoteWindowControl'

/** 响应式的开关：store 的远程开窗/收窗路径用它，设置页用它点亮选中态 */
export const remoteWindowControl = ref<boolean>(loadRemoteWindowControl())

/** 读上次的偏好；没动过设置（无存档）时默认开（接受远程控制） */
function loadRemoteWindowControl(): boolean {
  try {
    const raw = localStorage.getItem(KEY)
    return raw === null ? true : raw === '1'
  } catch {
    // localStorage 不可用：走默认
  }
  return true
}

/** 切换：落盘 + 立即生效（设置页用） */
export function setRemoteWindowControl(enabled: boolean): void {
  remoteWindowControl.value = enabled
  try {
    localStorage.setItem(KEY, enabled ? '1' : '0')
  } catch {
    // localStorage 不可用：本次会话内生效即可
  }
}
