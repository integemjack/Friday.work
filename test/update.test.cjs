// 客户端更新判断逻辑的单元测试（src/shared/update.ts，主进程与渲染层共用）。
const test = require('node:test')
const assert = require('node:assert')
const {
  compareVersions,
  emptyUpdateState,
  isUpdateAvailable,
  isUpdateBusy,
  updatePlatformKey,
  pickUpdatePackage
} = require('../.tmp/update.cjs')

test('初始状态：auto/restartAt 字段在（浮层和主进程都依赖）', () => {
  const state = emptyUpdateState('0.1.0', 'abc', 'win32')
  assert.equal(state.auto, false)
  assert.equal(state.restartAt, 0)
  assert.equal(state.phase, 'idle')
})

test('阶段在忙：查/下/装中（定时器看到就跳过，不叠加）', () => {
  assert.equal(isUpdateBusy('checking'), true)
  assert.equal(isUpdateBusy('downloading'), true)
  assert.equal(isUpdateBusy('installing'), true)
  assert.equal(isUpdateBusy('idle'), false)
  assert.equal(isUpdateBusy('available'), false)
  assert.equal(isUpdateBusy('ready'), false)
  assert.equal(isUpdateBusy('uptodate'), false)
  assert.equal(isUpdateBusy('error'), false)
})

test('版本比较：逐段数字比，缺段补 0', () => {
  assert.equal(compareVersions('0.2.0', '0.1.0'), 1)
  assert.equal(compareVersions('0.1.0', '0.2.0'), -1)
  assert.equal(compareVersions('0.2.0', '0.2.0'), 0)
  assert.equal(compareVersions('0.2', '0.2.0'), 0)
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1) // 按数字不按字典序
  assert.equal(compareVersions('', '0.1.0'), -1)
  assert.equal(compareVersions('0.1.0', ''), 1)
})

test('有更新：版本更高就算', () => {
  assert.equal(isUpdateAvailable('0.1.0', 'abc1234', { version: '0.2.0' }), true)
  assert.equal(isUpdateAvailable('0.2.0', 'abc1234', { version: '0.1.0' }), false)
})

test('有更新：同版本不同构建（rolling），开发构建不参与', () => {
  assert.equal(isUpdateAvailable('0.2.0', 'aaa', { version: '0.2.0', commit: 'bbb' }), true)
  assert.equal(isUpdateAvailable('0.2.0', 'aaa', { version: '0.2.0', commit: 'aaa' }), false)
  assert.equal(isUpdateAvailable('0.2.0', 'dev', { version: '0.2.0', commit: 'bbb' }), false)
  assert.equal(isUpdateAvailable('0.2.0', 'aaa', { version: '0.2.0' }), false)
})

test('平台键：平台+架构 → latest.json 的 client 键', () => {
  assert.equal(updatePlatformKey('win32', 'x64'), 'windows-x64')
  assert.equal(updatePlatformKey('win32', 'arm64'), 'windows-arm64')
  assert.equal(updatePlatformKey('darwin', 'arm64'), 'macos-arm64')
  assert.equal(updatePlatformKey('linux', 'x64'), 'linux-x64')
  assert.equal(updatePlatformKey('freebsd', 'x64'), '')
})

test('挑包：本机平台有就用，没有回 null', () => {
  const manifest = {
    version: '1.0.0',
    client: {
      'windows-x64': { name: 'a.exe', url: 'https://x/a.exe', sha256: 'aa', size: 1 },
      'linux-x64': { name: 'b.AppImage', url: 'https://x/b', sha256: 'bb', size: 2 }
    }
  }
  assert.equal(pickUpdatePackage(manifest, 'win32', 'x64')?.name, 'a.exe')
  assert.equal(pickUpdatePackage(manifest, 'darwin', 'x64'), null)
  assert.equal(pickUpdatePackage(manifest, 'linux', 'arm64'), null)
})
