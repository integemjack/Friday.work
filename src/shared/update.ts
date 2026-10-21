// 客户端自动更新的共用类型与判断逻辑（方案 §10 M4「自动更新」）。
// 数据源：CI 出包时在每个 Release 里放一份 latest.json（scripts/make-update-manifest.cjs 生成），
// 格式沿用 Friday.build latest.json 的思路（version + 每个平台-架构的安装包 name/url/sha256/size）。
// 纯函数都放这里：主进程 ClientUpdate 与渲染层的提示共用同一套判断，单测也打这里。

export interface UpdatePackage {
  name: string
  url: string
  sha256: string
  size: number
}

export interface UpdateManifest {
  version: string
  /** 构建提交（rolling 通道：版本号没动也能靠它发现新构建） */
  commit?: string
  builtAt?: string
  /** 平台-架构 → 安装包：windows-x64 / windows-arm64 / macos-x64 / macos-arm64 / linux-x64 / linux-arm64 */
  client?: Record<string, UpdatePackage>
}

// downloading 后 Windows 有两条路：手动下载 → 退出时装（auto=false）；
// 自动管线 → ready 挂倒计时 → installing（拉起安装器并退出，--force-run 装完拉起新版本）。
export type UpdatePhase = 'idle' | 'checking' | 'available' | 'uptodate' | 'downloading' | 'ready' | 'installing' | 'error'

export interface UpdateState {
  phase: UpdatePhase
  currentVersion: string
  currentCommit: string
  /** 本机平台（主进程的 process.platform；渲染层用它决定安装按钮文案） */
  platform: string
  /** 可用的新版本（available / downloading / ready 时有） */
  version: string
  commit: string
  builtAt: string
  /** 下载进度 0–1（downloading 时有） */
  progress: number
  /** 这一轮是不是自动管线（定时检查发现后自动下载安装）：桌面浮层/设置页据此挑文案 */
  auto: boolean
  /** 自动重启的时刻（epoch ms；> 0 表示 ready 后挂了倒计时，到点主进程装并重启）。推迟后归 0 */
  restartAt: number
  /** 给人看的一句话（mac / linux 的手动安装提示等） */
  note: string
  error: string
}

export function emptyUpdateState(currentVersion = '', currentCommit = '', platform = ''): UpdateState {
  return {
    phase: 'idle',
    currentVersion,
    currentCommit,
    platform,
    version: '',
    commit: '',
    builtAt: '',
    progress: 0,
    auto: false,
    restartAt: 0,
    note: '',
    error: ''
  }
}

/** 阶段在忙（查 / 下 / 装中）：自动定时器看到忙就跳过这一轮，不叠加 */
export function isUpdateBusy(phase: UpdatePhase): boolean {
  return phase === 'checking' || phase === 'downloading' || phase === 'installing'
}

/** 平台键：process.platform/arch → latest.json 里 client 的键 */
export function updatePlatformKey(platform: string, arch: string): string {
  const key = arch === 'arm64' ? 'arm64' : 'x64'
  if (platform === 'win32') return `windows-${key}`
  if (platform === 'darwin') return `macos-${key}`
  if (platform === 'linux') return `linux-${key}`
  return ''
}

/** 比较版本号：逐段按数字比，缺的段补 0；a > b 返回 1，相等返回 0 */
export function compareVersions(a: string, b: string): number {
  const pa = String(a ?? '')
    .trim()
    .split('.')
  const pb = String(b ?? '')
    .trim()
    .split('.')
  const count = Math.max(pa.length, pb.length)
  for (let i = 0; i < count; i++) {
    const x = Number.parseInt(pa[i] ?? '0', 10) || 0
    const y = Number.parseInt(pb[i] ?? '0', 10) || 0
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

/** 有没有更新：版本更高；或版本相同但构建 commit 不同（rolling 通道）。开发构建（commit = dev）不参与 commit 比较 */
export function isUpdateAvailable(currentVersion: string, currentCommit: string, manifest: UpdateManifest): boolean {
  const byVersion = compareVersions(manifest.version, currentVersion)
  if (byVersion > 0) return true
  if (byVersion < 0) return false
  if (!manifest.commit || !currentCommit || currentCommit === 'dev') return false
  return manifest.commit !== currentCommit
}

/** 从 latest.json 挑本机平台要用的安装包 */
export function pickUpdatePackage(manifest: UpdateManifest, platform: string, arch: string): UpdatePackage | null {
  const key = updatePlatformKey(platform, arch)
  if (!key) return null
  return manifest.client?.[key] ?? null
}
