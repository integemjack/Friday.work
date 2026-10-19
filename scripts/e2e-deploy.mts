// M4 自动安装真机验证：把 friday-server 包装到临时目录（~/.friday-deploy-test），验证
// 下载 → 校验 → tar 流式上传 → 解包 → --version 核对 → 切换 bin → 清旧版本 全流程，最后清掉临时目录。
// 不动远程真正的 ~/.friday-server。

import {
  deployPackage,
  downloadPackage,
  fetchServerPackage,
  inspectRemote,
  platformKey,
  runRemoteForTest
} from '../src/protocol/deploy/RemoteDeploy.js'

const target = { kind: 'ssh' as const, host: 'root@192.168.20.239' }

async function main(): Promise<void> {
  const probe = await inspectRemote(target, false)
  console.log('探测:', JSON.stringify(probe))
  const key = platformKey(probe.system, probe.machine)
  const pkg = await fetchServerPackage(key, '.tmp/pkg', 1)
  if (!pkg) throw new Error('没拿到服务端包')
  console.log('包:', pkg.version, `${Math.round(pkg.size / 1048576)} MB`, 'protocol', pkg.protocol)

  console.log('下载并校验…')
  const path = await downloadPackage(pkg, '.tmp/pkg')
  console.log('✓ 校验通过:', path)

  console.log('装到临时目录 ~/.friday-deploy-test …')
  const report = await deployPackage(target, false, pkg.version, path, '', '.friday-deploy-test')
  console.log('✓ 部署回执:', JSON.stringify(report))

  const listing = await runRemoteForTest(
    target,
    `ls -l "$HOME/.friday-deploy-test/versions" 2>&1; echo "---"; "$HOME/.friday-deploy-test/bin/friday-server" --version 2>&1`
  )
  console.log('临时目录内容:\n' + listing.trim())

  console.log('清理临时目录…')
  await runRemoteForTest(target, 'rm -rf "$HOME/.friday-deploy-test"')
  const left = await runRemoteForTest(target, 'ls -d "$HOME/.friday-deploy-test" 2>/dev/null | wc -l')
  console.log('✓ 清理完成，残留目录数:', left.trim())
}

main().catch((error) => {
  console.error('✗ 失败:', error instanceof Error ? error.message : error)
  process.exit(1)
})
