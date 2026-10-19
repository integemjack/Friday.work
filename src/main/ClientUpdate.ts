// 客户端自动更新（方案 §10 M4 里写「再议」的那件，现在做掉）。
//
// 复用 Friday.build latest.json 的思路：CI 出包时在每个 Release 里放一份 latest.json
// （version / commit / 每个平台-架构的安装包 name/url/sha256/size，见 scripts/make-update-manifest.cjs），
// 客户端取它、与本机版本（同版本再比构建 commit，rolling 通道靠这个发现新构建）判断要不要更新：
//   Windows   下载 NSIS 安装包 → 核对 SHA-256 → 应用退出时静默安装（/S）；
//   macOS / Linux 下载核对后打开镜像 / 定位安装包，装的动作交给用户（没有无头静默安装的路）。
// 状态经 IPC 推给渲染层（设置窗口展示）。打包版启动后静默查一次；下载与安装都由用户点。
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

  constructor(private readonly getWebContents: () => WebContents | null) {}

  /** 当前状态（渲染层初次拉取用） */
  current(): UpdateState {
    return this.state
  }

  /** 注册 IPC（update:state / update:check / update:install） */
  register(): void {
    ipcMain.handle('update:state', () => this.state)
    ipcMain.handle('update:check', () => this.check())
    ipcMain.handle('update:install', () => this.install())
  }

  /** 打包版启动后静默查一次（不下载、不弹窗，结果进设置窗口） */
  autoCheck(): void {
    if (!app.isPackaged) return
    setTimeout(() => {
      this.check().catch(() => {})
    }, 6_000)
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

  /** 下载可用更新并核对；Windows 记下安装包等退出时装，mac/Linux 打开/定位安装包 */
  async install(): Promise<UpdateState> {
    if (!this.available) await this.check()
    const target = this.available
    if (!target || this.state.phase !== 'available') return this.state
    const { manifest, pkg } = target
    this.state = { ...this.base(), phase: 'downloading', version: manifest.version, commit: manifest.commit ?? '', progress: 0 }
    this.push()
    try {
      const dir = join(app.getPath('temp'), 'friday-work-update')
      const path = await this.download(pkg, dir)
      if (process.platform === 'win32') {
        this.installerPath = path
        this.state = {
          ...this.base(),
          phase: 'ready',
          version: manifest.version,
          note: '安装包已就绪：退出 Friday Work 时会自动开始静默安装'
        }
      } else if (process.platform === 'darwin') {
        await shell.openPath(path)
        this.state = {
          ...this.base(),
          phase: 'ready',
          version: manifest.version,
          note: '已打开安装镜像：把 Friday Work 拖进「应用程序」完成更新'
        }
      } else {
        await chmod(path, 0o755).catch(() => {})
        shell.showItemInFolder(path)
        this.state = {
          ...this.base(),
          phase: 'ready',
          version: manifest.version,
          note: '安装包已放在下载目录：关掉应用后运行它即可更新'
        }
      }
    } catch (error) {
      this.state = { ...this.base(), phase: 'error', error: error instanceof Error ? error.message : String(error) }
    }
    this.push()
    return this.state
  }

  /** Windows：退出时把静默安装器拉起来（will-quit 里 spawn，本进程让路后 NSIS 接管） */
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
    return { ...this.state, progress: 0, error: '' }
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
