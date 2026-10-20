// 桌面投出物（思考/回复气泡、操作卡）限高的同源常数。
// 一条限高公式原本三份写（DesktopBubbles 的 JS、DesktopOps 的 CSS、app.ts 的避让估算），
// 数值靠注释约定同步；现在改数值只改这里：
//   - TS 侧直接 import（app.ts 避让估算、DesktopBubbles.adjust）
//   - CSS 侧由 main.ts 启动时把 CAST_MAX_H_CSS 注入 :root 的 --cast-max-h

/** 限高上限：思考/回复气泡与全量内容卡一致（再大会把随机落点的采样空间挤到退让） */
export const CAST_MAX_H = 400
/** 窗口极矮时的下限（当前 minHeight 600 下不可达，防御性保留） */
export const CAST_MIN_H = 120
/** 100vh 基准的竖向扣除 = 标题栏 44 + 桌面顶安全 60 + 底安全 12（DesktopBubbles 的 TOP/BOTTOM_SAFE + 标题栏高） */
export const CAST_VH_SAFE = 116

/** CSS 侧限高表达式（main.ts 注入为 --cast-max-h） */
export const CAST_MAX_H_CSS = `min(${CAST_MAX_H}px, max(${CAST_MIN_H}px, calc(100vh - ${CAST_VH_SAFE}px)))`

/** JS 侧限高：传基准高（通常 window.innerHeight），返回该窗口下的实际限高 */
export function castLimitH(vh: number): number {
  return Math.min(CAST_MAX_H, Math.max(CAST_MIN_H, vh - CAST_VH_SAFE))
}
