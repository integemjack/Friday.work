// 会直接内嵌媒体的工具（看图 analyze_image / 看视频 analyze_video）：
// 工具名 → 参数里装媒体路径的字段名 + 媒体类型。toolMedia.ts（取媒体）与
// stores/app.ts（操作卡不自动渐隐）共用，放独立小模块避免 store ↔ composable 循环依赖。
export const TOOL_MEDIA_ARG: Record<string, { field: string; kind: 'image' | 'video' }> = {
  analyze_image: { field: 'image', kind: 'image' },
  analyze_video: { field: 'video', kind: 'video' }
}

/** 这个工具的调用要不要内嵌媒体（看图/看视频） */
export function isMediaTool(name: string): boolean {
  return Boolean(TOOL_MEDIA_ARG[name.toLowerCase()])
}
