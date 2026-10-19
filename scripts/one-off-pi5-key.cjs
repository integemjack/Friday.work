// 一次性：用密码把本机公钥装到 Pi5（root@192.168.20.91），顺带打印环境。用完即删。
const { readFileSync } = require('node:fs')
const { Client } = require('ssh2')

const host = process.argv[2] ?? '192.168.20.91'
const password = process.env.PS5_PW
if (!password) {
  console.error('需要 PS5_PW 环境变量')
  process.exit(1)
}

const pub = readFileSync(`${process.env.USERPROFILE}/.ssh/id_ed25519.pub`, 'utf8').trim()

const conn = new Client()
conn
  .on('ready', () => {
    const cmd = `mkdir -p ~/.ssh && chmod 700 ~/.ssh && grep -qF '${pub}' ~/.ssh/authorized_keys 2>/dev/null || echo '${pub}' >> ~/.ssh/authorized_keys; chmod 600 ~/.ssh/authorized_keys; echo KEY-INSTALLED`
    conn.exec(cmd, (err, stream) => {
      if (err) throw err
      let out = ''
      stream.on('data', (d) => (out += d))
      stream.on('close', () => {
        console.log(out.trim())
        conn.end()
      })
    })
  })
  .on('error', (e) => {
    console.error('SSH 失败:', e.message)
    process.exit(1)
  })
  .connect({ host, port: 22, username: 'root', password, readyTimeout: 20000 })
