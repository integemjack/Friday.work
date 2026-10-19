// 一次性：用密码把本机公钥装到远端，并探测远端环境。用完即删。
// 密码从环境变量 FRIDAY_TEST_PW 读。

const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { Client } = require('ssh2')

const password = process.env.FRIDAY_TEST_PW
if (!password) {
  console.error('没有 FRIDAY_TEST_PW')
  process.exit(1)
}

const pub = readFileSync(join(process.env.USERPROFILE, '.ssh', 'id_ed25519.pub'), 'utf8').trim()

const conn = new Client()
const commands = [
  'uname -s -m',
  'cat /etc/os-release 2>/dev/null | head -2',
  'mkdir -p ~/.ssh && chmod 700 ~/.ssh',
  `grep -qF '${pub}' ~/.ssh/authorized_keys 2>/dev/null || echo '${pub}' >> ~/.ssh/authorized_keys`,
  'chmod 600 ~/.ssh/authorized_keys',
  'echo KEY-INSTALLED',
  'ls -la ~/.friday-server/bin/ 2>/dev/null || echo NO-FRIDAY-SERVER',
  '~/.friday-server/bin/friday-server --version 2>/dev/null || true',
  'which ffmpeg || true',
  'hostname; whoami; echo $HOME'
]

conn
  .on('ready', () => {
    let i = 0
    const next = () => {
      if (i >= commands.length) {
        conn.end()
        return
      }
      const cmd = commands[i++]
      conn.exec(cmd, (err, stream) => {
        if (err) {
          console.error(`✗ ${cmd}: ${err.message}`)
          return next()
        }
        let out = ''
        stream
          .on('close', () => {
            console.log(`$ ${cmd}\n${out.trim()}\n`)
            next()
          })
          .on('data', (d) => (out += d.toString()))
          .stderr.on('data', (d) => (out += d.toString()))
      })
    }
    next()
  })
  .on('error', (err) => {
    console.error('连接失败:', err.message)
    process.exit(1)
  })
  .connect({
    host: '192.168.20.239',
    username: 'root',
    password,
    readyTimeout: 15_000
  })
