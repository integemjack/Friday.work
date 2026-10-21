// 本地假更新源：端到端验证自动更新管线（配套 scripts/check-auto-update.cjs）。
// 用法：node scripts/serve-fake-update.cjs [端口=8787] [版本=999.0.0]
// latest.json 的 windows 包指向本机拷的小 exe（默认 where.exe）：下载 / SHA-256 校验 / 进度都是真的，
// 只是它不是真的 NSIS 安装器——客户端拉起它等于空跑（起完即退），用来验证「下载完自动安装并退出」。
// 注意 arm64 条目也指同一个文件，两种架构的机器都能挑到包。

const http = require('node:http')
const { createHash } = require('node:crypto')
const { readFileSync } = require('node:fs')

const PORT = Number(process.argv[2] || 8787)
const VERSION = process.argv[3] || '999.0.0'
const SOURCE = process.env.FRIDAY_FAKE_INSTALLER || 'C:\\Windows\\System32\\where.exe'
const pkgBytes = readFileSync(SOURCE)
const sha256 = createHash('sha256').update(pkgBytes).digest('hex')
const NAME = `Friday-Work-${VERSION}-win-x64.exe`

const manifest = {
  version: VERSION,
  commit: 'e2efake000000000000000000000000000000000',
  builtAt: new Date().toISOString(),
  note: '假更新源（scripts/serve-fake-update.cjs）',
  client: {
    'windows-x64': { name: NAME, url: `http://127.0.0.1:${PORT}/${NAME}`, sha256, size: pkgBytes.length },
    'windows-arm64': { name: NAME, url: `http://127.0.0.1:${PORT}/${NAME}`, sha256, size: pkgBytes.length }
  }
}

const server = http.createServer((request, response) => {
  if (request.url === '/latest.json') {
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    response.end(JSON.stringify(manifest))
  } else if (request.url === `/${NAME}`) {
    response.writeHead(200, { 'content-type': 'application/octet-stream' })
    response.end(pkgBytes)
  } else {
    response.writeHead(404)
    response.end('nope')
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`假更新源 http://127.0.0.1:${PORT}/latest.json 版本 ${VERSION}`)
  console.log(`安装包 ${NAME}（${pkgBytes.length} 字节，sha256 ${sha256.slice(0, 12)}…）来自 ${SOURCE}`)
})
