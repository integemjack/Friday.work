// 生成客户端自动更新的 latest.json（CI 的 release job 里跑；客户端主进程 ClientUpdate 消费）。
// 扫描 electron-builder 的产物目录，按 平台-架构 挑安装包
// （Windows: NSIS exe；macOS: dmg；Linux: AppImage），算 SHA-256 与大小，
// 加上版本（package.json）与构建 commit，写成 Friday.build latest.json 的客户端版：
//   { version, commit, builtAt, client: { "windows-x64": { name, url, sha256, size }, … } }
// 用法：node scripts/make-update-manifest.cjs <产物目录> <release tag>
//   环境变量：REPO_SLUG（owner/repo，拼下载 URL 用）、GIT_COMMIT（构建提交）

const { createHash } = require('node:crypto')
const { createReadStream, readdirSync } = require('node:fs')
const { join, resolve } = require('node:path')

const dir = resolve(process.argv[2] || 'artifacts')
const tag = process.argv[3] || 'rolling'
const repo = process.env.REPO_SLUG || 'integemjack/Friday.work'
const commit = process.env.GIT_COMMIT || ''
const version = require(join(__dirname, '..', 'package.json')).version

// 各平台-架构要进 manifest 的安装包后缀（与 electron-builder.yml 的 artifactName 对齐）
const WANT = [
  ['windows-x64', /-win-x64\.exe$/],
  ['windows-arm64', /-win-arm64\.exe$/],
  ['macos-x64', /-mac-x64\.dmg$/],
  ['macos-arm64', /-mac-arm64\.dmg$/],
  ['linux-x64', /-linux-x64\.AppImage$/],
  ['linux-arm64', /-linux-arm64\.AppImage$/]
]

function sha256File(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolveHash(hash.digest('hex')))
      .on('error', reject)
  })
}

async function main() {
  const files = readdirSync(dir)
  const client = {}
  for (const [key, pattern] of WANT) {
    const name = files.find((file) => pattern.test(file))
    if (!name) continue
    const path = join(dir, name)
    const sha256 = await sha256File(path)
    client[key] = {
      name,
      url: `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`,
      sha256,
      size: require('node:fs').statSync(path).size
    }
  }
  const missing = WANT.map(([key]) => key).filter((key) => !client[key])
  if (Object.keys(client).length === 0) {
    console.error('产物目录里没有可识别的安装包（exe/dmg/AppImage）')
    process.exit(1)
  }
  if (missing.length > 0) console.error(`注意：这几个平台-架构没有产物，latest.json 里没有它们：${missing.join(', ')}`)
  process.stdout.write(
    JSON.stringify({ version, commit, builtAt: new Date().toISOString(), client }, null, 2) + '\n'
  )
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
