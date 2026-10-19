# scripts

验证 / 联调脚本。都对着真实的远端跑（默认 `root@192.168.20.239`，可用环境变量覆盖）。
除单测外都不是自动化测试，而是「量出证据」的探针。

## 单测与构建

| 脚本 | 做什么 |
|---|---|
| `run-tests.cjs` | `npm test` 的入口：esbuild 打包协议层为 cjs，再 `node --test test/` |

## 真机联调（协议层）

| 脚本 | 验证什么 |
|---|---|
| `e2e-real.mts` | M1：SSH 连上 friday-server → hello → 会话快照 → 建会话 → 订阅 → 发消息 → `message.patch` 增量 → 删会话 |
| `e2e-m2.mts` | M2：`term.*`（开终端跑命令）、`fs.*`（列目录/读文件/改动）、`browser.*`（开标签、抓帧） |
| `e2e-voice.mts` | M3-A：造一段 wav → `file.upload` → `assistant.say(source=voice)` → 等 `assistant.entry` |
| `e2e-pair.mts` | 配对：`server.pair` 生成链接 → 用链接走 wss（指纹校验）→ 看到会话；WS 通道下终端不可用（受信级别缺口） |
| `e2e-deploy.mts` | M4：最新包探测 + 下载校验 + tar 流式上传 + 在临时目录解包切换（不动真实的 `~/.friday-server`） |
| `e2e-fingerprint.mts` | M1 验收：**错误指纹必断且一帧不发**（比对通过前不发 hello）；正确指纹可握手 |

## 验收探针（读 UI / 造场景，量出数字）

| 脚本 | 验证什么 |
|---|---|
| `check-reconnect.cjs` | M1 验收：远端杀掉 `--attach` 桥 → 客户端自己重连并重新拉起（远端 PID 换新） |
| `check-longconv.cjs` | M1/M2 验收：往会话注入 200 条链式消息，量 DOM 只挂 60 条、上滑渐进加载 |
| `check-timeline.cjs` | 助手时间线窗口能读到真实记录（含错误条目） |
| `check-packaged.cjs` | 打包后的 `Friday Work.exe` 能启动、连上远端、显示会话 |
| `check-schat.cjs` / `check-incoming.cjs` | 扫码通道状态 / 来电是否弹窗 |

## 驱动 UI（CDP）

`drive-desktop.cjs`（桌面窗口：开窗/拖动/缩放/最小化/任务栏）、`drive-detail.cjs`（消息与终端内容）、
`drive-tool.cjs`（工具卡片）、`drive-windows.cjs`（各窗口冒烟）、`drive-schat.cjs` / `drive-schat-send.cjs` /
`drive-schat-live.cjs` / `drive-schat-bot.cjs`（扫码窗口与机器人对话）、`drive-call.cjs`（主叫拨号）、
`drive-incoming.cjs`（等来电并接听）、`drive-answer.cjs`（接听后的观察）、`drive-showcase.cjs`（摆一桌窗口截图用）。

用法：先 `npx electron . --remote-debugging-port=9222`，再 `node scripts/<脚本>`。

`shot.ps1` 截整屏（`powershell -File scripts/shot.ps1 <输出目录> <文件名>`）。

one-off-install-key.cjs 是一次性的（用密码把本机公钥装到远端），非必要不要跑。
inspect-ui.cjs 打印页面文字与布局尺寸。
