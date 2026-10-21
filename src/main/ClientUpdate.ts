// 客户端自动更新（方案 §10 M4 里写「再议」的那件，现在做掉）。
//
// 复用 Friday.build latest.json 的思路：CI 出包时在每个 Release 里放一份 latest.json
// （version / commit / 每个平台-架构的安装包 name/url/sha256/size，见 scripts/make-update-manifest.cjs），
// 客户端取它、与本机版本（同版本再比构建 commit，rolling 通道靠这个发现新构建）判断要不要更新：
//   Windows   下载 NSIS 安装包 → 核对 SHA-256 → 应用退出时静默安装（/S）；
//   macOS / Linux 下载核对后打开镜像 / 定位安装包，装的动作交给用户（没有无头静默安装的路）。
// 状态经 IPC 推给渲染层（设置窗口 + 桌面浮层 UpdateOverlay 展示进度）。
// 自动管线（仅打包版；FRIDAY_WORK_AUTO_UPDATE=1 可在 dev 里打开调试）：
//   启动 6s 后查一次，之后每 30 分钟（FRIDAY_WORK_UPDATE_INTERVAL_MIN 可调）再查；
//   发现更新 → 自动下载（进度推给浮层）→ ready 挂 8s 倒计时（可推迟）→ 到点拉起安装器
//   （--updated /S --force-run，参数同 electron-updater 的 doInstall）并退出，
//   NSIS 静默装完 --force-run 把新版本拉起来 = 自动重启。推迟后回到「退出时静默装」。
//   mac / Linux 没有无头静默安装的路，自动管线只到「发现更新」为止，下载安装仍由用户点。
// 网络放在主进程是刻意的：更新与应用生命周期（退出、起安装器）绑在一起，不属于数据面。

import { app, ipcMain, shell, type WebContents } from 'electron'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, mkdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  emptyUpdateState,
  isUpdateAvailable,
  isUpdateBusy,
  pickUpdatePackage,
  type UpdateManifest,
  type UpdatePackage,
  type UpdateState
} from '../shared/update.js'

const REPO = 'integemjack/Friday.work'
const MANIFEST_URLS = [
  process.env.FRIDAY_WORK_UPDATE_MANIFEST || '',
  `https://github.com/${REPO}/releases/latest/download/latest.json`,
  `https://github.com/${REPO}/releases/download/rolling/latest.json`
].filter(Boolean)

/** 自动检查间隔（分钟）；<=0 关掉定时，只剩启动那一次 */
const CHECK_INTERVAL_MIN = Number(process.env.FRIDAY_WORK_UPDATE_INTERVAL_MIN || 30)
/** 自动下载完成后到重启的倒计时（给浮层「稍后」留出反应时间） */
const AUTO_RESTART_DELAY_MS = 8_000

async function fileSha256(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject)
  })
}

async function fetchManifest(): Promise<UpdateManifest> {
  let lastError = ''
  for (const url of MANIFEST_URLS) {
    try {
      const response = await fetch(url, { headers: { 'cache-control': 'no-cache' } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const manifest = (await response.json()) as UpdateManifest
      if (!manifest || typeof manifest.version !== 'string') throw new Error('latest.json 里没有 version')
      return manifest
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
  }
  throw new Error(`读不到 latest.json：${lastError}`)
}

export class ClientUpdate {
  private state: UpdateState = emptyUpdateState()
  private available: { manifest: UpdateManifest; pkg: UpdatePackage } | null = null
  /** 下载好、等退出时静默安装的 Windows 安装包 */
  private installerPath = ''
  /** 定时检查（自动管线） */
  private checkTimer: NodeJS.Timeout | null = null
  /** ready 后自动重启的倒计时（推迟可取消） */
  private restartTimer: NodeJS.Timeout | null = null

  constructor(private readonly getWebContents: () => WebContents | null) {}

  /** 当前状态（渲染层初次拉取用） */
  current(): UpdateState {
    return this.state
  }

  /** 注册 IPC（update:state / update:check / update:install / update:postpone / update:apply） */
  register(): void {
    ipcMain.handle('update:state', () => this.state)
    ipcMain.handle('update:check', () => this.check())
    ipcMain.handle('update:install', () => this.install())
    ipcMain.handle('update:postpone', () => this.postpone())
    ipcMain.handle('update:apply', () => this.applyNow())
  }

  /** 自动管线开没开：打包版常开；dev 里用 FRIDAY_WORK_AUTO_UPDATE=1 打开（联调用） */
  autoEnabled(): boolean {
    return app.isPackaged || process.env.FRIDAY_WORK_AUTO_UPDATE === '1'
  }

  /** 启动自动管线：6s 后静默查一次，之后每 CHECK_INTERVAL_MIN 分钟再查（仅打包版） */
  startAutoUpdate(): void {
    if (!this.autoEnabled()) return
    setTimeout(() => {
      void this.autoCheck()
    }, 6_000)
    if (CHECK_INTERVAL_MIN > 0) {
      this.checkTimer = setInterval(() => {
        void this.autoCheck()
      }, CHECK_INTERVAL_MIN * 60_000)
      this.checkTimer.unref?.()
    }
  }

  /** 定时检查：忙着（查/下/装）或已有结论（待下载/已就绪）就跳过；出错下轮再试。
   *  只在 Windows 上接自动下载安装（mac/Linux 没有静默安装的路，留给用户手动）。 */
  private async autoCheck(): Promise<void> {
    const phase = this.state.phase
    if (isUpdateBusy(phase) || phase === 'available' || phase === 'ready') return
    const state = await this.check()
    if (state.phase === 'available' && process.platform === 'win32') {
      await this.install({ auto: true })
    }
  }

  /** 查 latest.json，判断有没有更新 */
  async check(): Promise<UpdateState> {
    this.state = { ...emptyUpdateState(app.getVersion(), __APP_COMMIT__, process.platform), phase: 'checking' }
    this.push()
    try {
      const manifest = await fetchManifest()
      const pkg = pickUpdatePackage(manifest, process.platform, process.arch)
      if (!pkg) throw new Error(`latest.json 里没有 ${process.platform}-${process.arch} 的安装包`)
      this.available = { manifest, pkg }
      if (isUpdateAvailable(app.getVersion(), __APP_COMMIT__, manifest)) {
        this.state = {
          ...this.base(),
          phase: 'available',
          version: manifest.version,
          commit: manifest.commit ?? '',
          builtAt: manifest.builtAt ?? '',
          note: ''
        }
      } else {
        this.state = { ...this.base(), phase: 'uptodate', note: '' }
      }
    } catch (error) {
      this.state = { ...this.base(), phase: 'error', error: error instanceof Error ? error.message : String(error) }
    }
    this.push()
    return this.state
  }

  /** 下载可用更新并核对。auto=true（定时发现）时 Windows 下载完挂倒计时自动安装重启；
   *  手动点（auto=false）维持原行为：退出时静默安装。从 ready 进来 = 重新下载。 */
  async install(options: { auto?: boolean } = {}): Promise<UpdateState> {
    const auto = options.auto === true
    if (!this.available) await this.check()
    const target = this.available
    if (!target || (this.state.phase !== 'available' && this.state.phase !== 'ready')) return this.state
    const { manifest, pkg } = target
    this.clearRestart()
    this.state = { ...this.base(), phase: 'downloading', version: manifest.version, commit: manifest.commit ?? '', progress: 0, auto }
    this.push()
    try {
      const dir = join(app.getPath('temp'), 'friday-work-update')
      const path = await this.download(pkg, dir)
      if (process.platform === 'win32') {
        this.installerPath = path
        if (auto) {
          // 自动管线：挂 8s 倒计时（浮层有「稍后」），到点安装并重启
          this.state = {
            ...this.base(),
            phase: 'ready',
            version: manifest.version,
            auto: true,
            restartAt: Date.now() + AUTO_RESTART_DELAY_MS,
            note: `新版本已下载，${AUTO_RESTART_DELAY_MS / 1000} 秒后自动重启更新（可稍后）`
          }
          this.push()
          this.scheduleRestart(AUTO_RESTART_DELAY_MS)
        } else {
          this.state = {
            ...this.base(),
            phase: 'ready',
            version: manifest.version,
            note: '安装包已就绪：退出 Friday Work 时会自动开始静默安装'
          }
          this.push()
        }
      } else if (process.platform === 'darwin') {
        await shell.openPath(path)
        this.state = {
          ...this.base(),
          phase: 'ready',
          version: manifest.version,
          note: '已打开安装镜像：把 Friday Work 拖进「应用程序」完成更新'
        }
        this.push()
      } else {
        await chmod(path, 0o755).catch(() => {})
        shell.showItemInFolder(path)
        this.state = {
          ...this.base(),
          phase: 'ready',
          version: manifest.version,
          note: '安装包已放在下载目录：关掉应用后运行它即可更新'
        }
        this.push()
      }
    } catch (error) {
      this.state = { ...this.base(), phase: 'error', error: error instanceof Error ? error.message : String(error) }
      this.push()
    }
    return this.state
  }

  /** 推迟自动重启：取消倒计时，回到「退出时静默安装」（定时器不再重弹：ready 直接跳过） */
  postpone(): UpdateState {
    this.clearRestart()
    if (this.state.phase !== 'ready') return this.state
    this.state = {
      ...this.state,
      auto: false,
      restartAt: 0,
      note: '已推迟：退出 Friday Work 时会自动静默安装这次更新'
    }
    this.push()
    return this.state
  }

  /** 立刻安装并重启（浮层「立即重启」）：拉起安装器（静默 + 装完自启）后退出，NSIS 接管。
   *  参数与 electron-updater 的 doInstall 一致：--updated 标记更新安装、/S 静默、--force-run 装完拉起新版本。 */
  async applyNow(): Promise<UpdateState> {
    this.clearRestart()
    if (!this.installerPath || this.state.phase !== 'ready') return this.state
    this.state = { ...this.state, phase: 'installing', auto: true, restartAt: 0, progress: 1, error: '', note: '正在静默安装，应用即将重启…' }
    this.push()
    try {
      const child = spawn(this.installerPath, ['--updated', '/S', '--force-run'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      })
      child.unref()
      this.installerPath = '' // 清掉：will-quit 里的兑底安装不再重复拉起
    } catch (error) {
      // 拉不起来：不退出，留着安装包走「退出时静默安装」的兑底
      this.state = { ...this.state, phase: 'error', error: `拉起安装器失败：${error instanceof Error ? error.message : String(error)}` }
      this.push()
      return this.state
    }
    app.quit()
    return this.state
  }

  /** Windows：退出时把静默安装器拉起来（will-quit 里 spawn，本进程让路后 NSIS 接管）。
   *  注意这里不带 --force-run：用户主动退出的场景不该装完又把应用拉起来。 */
  spawnInstallerOnQuit(): void {
    app.once('will-quit', () => {
      const path = this.installerPath
      if (!path) return
      try {
        const child = spawn(path, ['/S'], { detached: true, stdio: 'ignore', windowsHide: true })
        child.unref()
      } catch {
        // 拉不起来就让用户手动跑下载目录里的安装包
      }
    })
  }

  private base(): UpdateState {
    return { ...this.state, progress: 0, error: '', restartAt: 0 }
  }

  private scheduleRestart(delayMs: number): void {
    this.clearRestart()
    this.restartTimer = setTimeout(() => {
      void this.applyNow()
    }, delayMs)
  }

  private clearRestart(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
  }

  private push(): void {
    this.getWebContents()?.send('update:state', this.state)
  }

  /** 下载安装包（带进度），已有同名且校验通过的复用 */
  private async download(pkg: UpdatePackage, dir: string): Promise<string> {
    await mkdir(dir, { recursive: true })
    const path = join(dir, pkg.name)
    const expected = pkg.sha256.toLowerCase()
    try {
      const info = await stat(path)
      if (info.size === pkg.size && (await fileSha256(path)) === expected) return path
    } catch {
      // 没下过
    }
    const response = await fetch(pkg.url)
    if (!response.ok || !response.body) throw new Error(`下载安装包失败：HTTP ${response.status}`)
    const total = Number(response.headers.get('content-length') || 0) || pkg.size || 0
    let seen = 0
    let lastPush = 0
    const onProgress = (ratio: number): void => {
      this.state = { ...this.state, phase: 'downloading', progress: ratio }
      this.push()
    }
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        seen += chunk.length
        const now = Date.now()
        if (total > 0 && now - lastPush > 200) {
          lastPush = now
          onProgress(Math.min(1, seen / total))
        }
        callback(null, chunk)
      }
    })
    await pipeline(Readable.fromWeb(response.body as never), counter, createWriteStream(path))
    const hash = await fileSha256(path)
    if (hash !== expected) {
      await rm(path, { force: true })
      throw new Error(`安装包校验不对（下载的 ${hash.slice(0, 12)}…，应为 ${expected.slice(0, 12)}…），已删掉重下即可`)
    }
    return path
  }
}
