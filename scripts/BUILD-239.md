## 给 239 编 Friday 服务端（含 `/connect` + 受信级别）

这一版 Friday 的改动**只在工作目录里，没有 commit / push**（用户要求：改别的项目不提交）。
本机没有 Linux 工具链，所以按「在本机拿源码 → 换机（239）编译 → 装回服务端」的路子做。

远端准备（一次性）：

| 脚本 | 干什么 |
|---|---|
| `remote-env.sh` / `remote-env2.sh` | 看工具链、Qt、内存磁盘 |
| `remote-install-qt.sh` | 用 aqt 装 Qt 6.11.3 到 `/root/qt611`（1.5G，约 1 分钟） |
| `remote-deps.sh` | 把通话/密码学依赖取到 `/root/deps`（GitHub 直连不稳，走 ghproxy 镜像；约 10 分钟） |
| `remote-gitmirror.sh` | 验证 `git config url.<mirror>.insteadOf` 能用 |

编译与部署：

| 脚本 | 干什么 |
|---|---|
| `remote-build.sh` | cmake 配置 + 编 `friday-headless`（GUI/TESTS/INSTALLER/BROWSER 关，CALLS 开），日志 `/root/friday-build.log` |
| `remote-wait-build.sh` | 等编译结束并摘出 error |
| `remote-install.sh` | 装成 `~/.friday-server/versions/<版本>/bin`，切 `bin` 软链 |
| `remote-friday-wrapper.sh` / `remote-fix-wrapper.sh` | 包装脚本：用 `exec -a` 把 `friday-server` 这个名字带给可执行文件（程序按 argv[0] 认自己是不是服务端） |
| `remote-redeploy.sh` | 杀旧进程（按 pid）、换二进制、重启 `--daemon` |
| `remote-devices.sh` / `remote-cleanup-devices.sh` | 看/清理配对设备 |

踩过的坑（都已修）：

1. **本机 `git archive > 文件` 会写成 UTF-16**：要用 `git archive -o 文件`，再用 `scp` 传（PowerShell 管道也会毁二进制）。
2. **PowerShell 会吞掉 ssh 命令里的引号**：远端脚本一律写成文件、`scp` 过去再 `sh`，不要在 `ssh "..."` 里拼复杂引号。
3. **GitHub 直连不通但 release 资源能下**：`git clone` 依赖走 `ghproxy.net` 重写；`FetchContent` 的 tarball 用本地 `FETCHCONTENT_SOURCE_DIR_*` 绕开。
4. **mbedtls 3.6 的 ECDH 结构体不再公开**：X25519 要用 `psa_raw_key_agreement`（`psa_key_derivation_key_agreement` 对蒙哥马利曲线不适用）。
5. **Electron 跑 BoringSSL，没有 ChaCha20-Poly1305**：`/connect` 的封装改用 AES-256-GCM。
6. **`pkill -f` 会把自己匹配进去**：按 pid 杀；而且改过的守护进程命令行是完整路径（`.../friday-headless server --daemon`），模式要盖住。
