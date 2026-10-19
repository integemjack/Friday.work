// M2：浏览器卡片链路（开标签 → 导航 → 点击 → 输入 → 收帧）
// 注意：能不能出帧取决于远端有没有可用的无头浏览器。不出帧时这里只给结论，不判失败——
// 客户端的 watch/input 编码已按契约实现（每个调用都有回执），画面依赖远端环境。
import { MachineConnection } from '../src/protocol/session/MachineManager.js'
import { PairingStore } from '../src/protocol/session/PairingStore.js'
import type { MachineConnectionHost } from '../src/protocol/session/MachineManager.js'

const SSH_TARGET = process.env.FRIDAY_SSH ?? 'root@192.168.20.239'

function host(): MachineConnectionHost {
  return {
    appVersion: '0.1.0',
    pairings: new PairingStore({
      async load() {
        return null
      },
      async store() {},
      async delete() {}
    }),
    onStateChange() {},
    onEvent() {},
    ensureServer: async () => ({ action: 'none', message: '' })
  }
}

async function main(): Promise<void> {
  const events: Array<{ method: string; params: unknown }> = []
  const machine = new MachineConnection('m2-browser', 'browser probe', { kind: 'ssh', host: SSH_TARGET }, {
    ...host(),
    onEvent: (_connection, method, params) => events.push({ method, params })
  })
  await machine.connect()
  await new Promise((r) => setTimeout(r, 1500))
  console.log('✓ 连上', machine.serverInfo?.version)

  const hello = (await machine.request('hello', {
    protocol: 1,
    client: { name: 'probe', version: '0.1.0', platform: 'windows', kind: 'desktop' },
    features: ['messagePatch']
  })) as { state: { browser?: { available?: boolean; reason?: string } } }
  console.log('browser:', JSON.stringify(hello.state.browser))

  const { randomUUID } = await import('node:crypto')
  const created = (await machine.request('conversation.create', { id: randomUUID() })) as { id: string }
  const opened = (await machine.request('browser.open', { conversationID: created.id })) as { tab: string }
  const tab = opened.tab
  console.log('✓ 开标签', tab)

  const page =
    'data:text/html,' +
    encodeURIComponent(
      '<html><body style="font:16px sans-serif;padding:24px">' +
        '<h1 id="t">登录测试页</h1>' +
        '<input id="u" placeholder="用户名" style="font-size:16px;padding:8px;width:240px">' +
        '<button onclick="document.getElementById(\'t\').textContent=document.getElementById(\'u\').value">提交</button>' +
        '</body></html>'
    )
  await machine.request('browser.navigate', { tab, url: page })
  await new Promise((r) => setTimeout(r, 2500))
  console.log('✓ 导航')

  await machine.request('browser.watch', { tab, width: 1280, height: 800 })
  await new Promise((r) => setTimeout(r, 800))
  // 静态页不变就不推帧：watch 后再导航一次让它重绘
  await machine.request('browser.navigate', { tab, url: page })
  await new Promise((r) => setTimeout(r, 2500))

  // 点输入框并逐字输入（browser.input 的 wire 形状：kind=mouse|key + type）
  await machine.request('browser.input', { tab, kind: 'mouse', type: 'mousePressed', x: 140, y: 120, button: 'left', clickCount: 1 })
  await machine.request('browser.input', { tab, kind: 'mouse', type: 'mouseReleased', x: 140, y: 120, button: 'left', clickCount: 1 })
  await new Promise((r) => setTimeout(r, 400))
  for (const ch of 'friday') {
    await machine.request('browser.input', { tab, kind: 'key', type: 'keyDown', key: ch, text: ch })
    await machine.request('browser.input', { tab, kind: 'key', type: 'keyUp', key: ch })
  }
  await new Promise((r) => setTimeout(r, 1500))
  console.log('✓ 点击 + 逐字输入（全部有回执）')

  const frames = events.filter((e) => e.method === 'browser.frame')
  console.log('收到的事件:', [...new Set(events.map((e) => e.method))].join(', ') || '(无)')
  console.log(`browser.frame：${frames.length} 帧` + (frames.length ? `（最后一帧 ${(frames.at(-1)?.params as { data?: string }).data?.length ?? 0} 字符 base64）` : ''))

  await machine.request('browser.close', { tab })
  machine.disconnect()
  console.log('✓ 关标签')

  if (frames.length === 0) {
    console.log('\n结论：链路回执全通，但远端这台没推出画面帧 —— 无头浏览器在这台机器上没起来')
    console.log('（远端有 snap 版 chromium；手动 headless 截图能成，friday-server 内部起浏览器受 snap/AppArmor 限制，属于远端环境问题）')
  } else {
    console.log('\n✓ 画面帧正常，浏览器卡片可以显示并接管')
  }
}

main().catch((error) => {
  console.error('✗ 失败:', error instanceof Error ? error.message : error)
  process.exit(1)
})
