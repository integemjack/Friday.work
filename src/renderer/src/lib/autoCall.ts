// 通话偏好（本机 UI 偏好，localStorage 范畴，和远程机器无关）：
// 「进入工作台自动与助手视频通话」默认关——连上机器不自动拨，想打随时用聊天面板头部的
// 视频/语音按钮；在设置 › 通话里打开后恢复旧行为（进工作台自动拨 + busy 重试 + 断线补接）。
import { ref } from 'vue'

const KEY = 'call.autoOnWorkbench'

/** 响应式的开关：CallWidget 的自动拨号 watch 用它，设置页用它点亮选中态 */
export const autoCallEnabled = ref<boolean>(loadAutoCall())

/** 读上次的偏好；没动过设置（无存档）时默认关（不自动拨打） */
function loadAutoCall(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    // localStorage 不可用：走默认
  }
  return false
}

/** 切换：落盘 + 立即生效（设置页用） */
export function setAutoCall(enabled: boolean): void {
  autoCallEnabled.value = enabled
  try {
    localStorage.setItem(KEY, enabled ? '1' : '0')
  } catch {
    // localStorage 不可用：本次会话内生效即可
  }
}
