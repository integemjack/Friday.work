# Friday Desktop Work

连接远程机器上的 Friday（`friday-server`）的桌面客户端：整个应用是一张桌面，**会话、终端、文件、浏览器、子 Agent、活动总览、语音、设置都是可以拖动、缩放、层叠的窗口**。技术栈 Electron 44 + Vue 3 + TypeScript；协议对照 `Friday/qt/docs/REMOTE.md`（唯一真相来源）实现。

**0.3 起唯一的连接方式**：SChat 扫码 → 机器人列表 → **WebRTC 工作通道**（DataChannel 上跑 JSON-RPC，语音 / 视频走普通 WebRTC 通话，文字聊天走 schat-ws）。SSH / WSL / wss 直连均已移除。

## 跑起来

```powershell
npm install
npm run dev        # 开发（热更新）
npm run typecheck  # 类型检查（web + node 两套）
npm test           # 协议层单测（messagePatch / 指纹 / 消息树分叉）
npm run build      # 构建到 out/
npm run pack       # 免安装目录 dist/win-unpacked
npm run dist       # NSIS 安装包 + 便携 zip（dist/）
```

## 连一台机器（0.3：只有一种方式）

1. **设置 → SChat 扫码登录**（Secret-Chat 账号，凭据经主进程 `safeStorage` 加密落盘）。
2. **机器与会话 → ＋ 添加**：列出好友里的机器人，点一个就连。

连的方式是 **WebRTC 工作通道**（REMOTE.md §2）：经 chatserver 的 p2p 信令呼机器人（`callType "work"`），建立 DataChannel，
工作协议（JSON-RPC）一条帧一条消息照旧跑；身份是信令层验过的 SChat 主人，不用配对令牌。语音 / 视频通话（`audio` / `video`）
和文字聊天（schat-ws）与它并行。SSH、WSL、wss 直连、`/connect` 封装、配对二维码、自动装服务端都已移除。

服务端要求 ≥ 2.38（`callType "work"` 被叫支持）。

## 字体

界面正文使用 [MiSans](https://hyperos.mi.com/font/)（小米公司发布，免费商用；经 npm 包 `misans` 子集化 WOFF2 分片内置，无需系统安装）。依据《MiSans 字体知识产权许可协议》，在此特别注明：本软件使用了 MiSans 字体。代码块与 HUD 遥测数字仍用等宽字体（Cascadia Code / Consolas）。

## 窗口

| 窗口 | 内容 |
|---|---|
| 机器与会话 | 机器列表（连接/断开/删除，从 SChat 机器人添加）、会话列表 |
| 会话（每段一个窗口） | 消息树（含分叉 `‹ 2/3 ›` 切换）、流式增量、工具卡片（含子 Agent 运行记录递归）、审批横幅、附件、停止生成 |
| 终端 | 远端伪终端的字节流镜像（xterm.js），`htop`/`vim` 等全屏程序可直接用；Agent 用 `run_in_terminal` 开的终端会自动弹窗 |
| 文件 | 目录树、只读预览、本次会话改动与撤销（`fs.changes` / `fs.diff` / `fs.revert`）、「让 Friday 改」预填消息 |
| 浏览器 | 远端浏览器实时画面（`browser.frame`）、鼠标键盘转发、标签切换、下载进度、`handOver` 自动弹窗 |
| 子 Agent | 后台子 Agent 的活动、步数、耗时、速度、排队消息；停 / 插话 |
| 活动总览 | 这台机器上所有会话的实时动静（生成中 / 等确认 / 卡住 / 出错），点击跳转 |
| 语音 | 两种：①按住说话（录音上传 → `assistant.say` → 流式回复 → 本机朗读）；②**实时语音＝给机器人打电话**（WebRTC，方案 D 档首选）：UDP+Opus 20ms 真实时、可插话、Friday 的音色，服务端 AssistantCalls 已带说完判断 |
| 扫码一键连 | Secret-Chat 扫码登录（`/login-sessions`）、好友里的机器人列表（显示备注）、和 Friday bot 对话（`schat-ws/v1`，含 `bot_stream_delta` 流式拼装） |
| 通话 | 给机器人打语音/视频电话（WebRTC）：`p2p_request`/`p2p_response`/`p2p_signaling` 信令 + `GET /calls/ice-servers` 的 TURN；Opus 48 kHz 单声道；没有麦克风时自动退回只收（能听不能说） |
| 设置 | 远端引擎、Agent 设置、服务状态（只读）、SChat 扫码登录 |

底部任务栏：左侧是各类窗口入口（带数量角标），中间是已开窗口（单击切换/最小化、双击关闭），右侧是当前机器与连接状态、待确认数量。

## 进程结构

```
主进程            窗口、单实例、凭据（safeStorage）、协议进程监护
 ├ utilityProcess  协议进程：所有网络与子进程 I/O、JSON-RPC、messagePatch、终端/浏览器/文件/子 Agent 状态、断线重连、自动装服务端
 └ 渲染进程        Vue 3 窗口界面（sandbox + contextIsolation，不接触 Node/令牌）
```

数据面是渲染进程与协议进程之间的 `MessagePort`（高频事件不经过主进程）；控制面只有：选文件、拖放登记、录音落盘、系统通知。

## 已实现 / 未实现

**已实现并验证**（真机：Ubuntu 24.04 + friday-server 2.33.1）
- M1 协议层、会话流、附件上传、断线重连、`messagePatch` 增量；验收已量：错误指纹必断且一帧不发、杀远端桥后自动重连、长会话只挂 60 条消息
- M2 终端 / 文件 / 浏览器 / 子 Agent / 活动总览 / 助手时间线
- 桌面窗口范式、任务栏、多会话窗口并存
- M3-A 语音（录音消息 + 本地朗读，识别与理解在远端）
- M4：多机器后台常连、密码添加 SSH、二维码配对、自动安装/升级远程 friday-server、设置页、打包（NSIS + zip）
- 客户端自动更新（M4 的「再议」项，已做成全自动）：CI 在每个 Release 里放 latest.json（version/commit +
  各平台安装包的 SHA-256），rolling 通道靠构建 commit 识别「版本没动但构建新了」（`src/main/ClientUpdate.ts` +
  `src/shared/update.ts`，单测 `test/update.test.cjs`）。启动 6s 后查一次 + 每 1 分钟定时查
  （`FRIDAY_WORK_UPDATE_INTERVAL_MIN` 可调，单位分钟）→ 发现新版本 Windows 下自动下载（SHA-256 校验）→ 下载进度显示在
  桌面浮层（`UpdateOverlay.vue`：进度条 / 8s 倒计时，可「稍后」或「立即重启」）→ 到点静默安装并自动拉起新版本
  （`--updated /S --force-run`，参数同 electron-updater 的 doInstall）；「退出时静默装」仍是兜底，设置页手动
  查/下载照旧。mac/Linux 没有无头静默安装的路，自动管线只到发现新版本，下载安装仍由用户触发。
  dev 里 `FRIDAY_WORK_AUTO_UPDATE=1` 打开自动管线联调（`scripts/serve-fake-update.cjs` + `check-auto-update.cjs` 端到端验证）。
- 窗口布局持久化：关掉重开后窗口的开关/位置/大小/层叠/最小化/最大化原样回来；
  会话窗口在机器连上后自动重新订阅补开（会话已删则丢弃）；存 localStorage（方案 §2 允许的「UI 偏好」），通话窗口不恢复。
  主窗口本身的大小/位置/最大化也持久化（主进程存 userData/window-state.json，动/缩/最大化后防抖落盘、关窗兜底，
  自动更新静默装完重启后同样原样恢复；保存的坐标不在任何显示器上时退回默认居中）
- M1.5 客户端侧：扫码登录（生产 chatserver 真实建码 + 轮询 + 批准）、schat-ws 连接、机器人列表（按备注显示）、和 bot 对话与流式拼装（凭据经 safeStorage 加密）
- 真机验证：扫码登录后给备注「Linux 239」的机器人发消息，助手回复正常显示（含流式增量）
- M3-D 语音通话：真机拨给「Linux 239」，对端接受 → WebRTC ICE/连接均 connected → 收到对方音轨、计时正常、挂断干净（这台机器没有麦克风，自动退回只收模式）；助手主动来电也能弹窗接听，接通后同样 connected
- **M1.5 的 `/connect`（服务端已改）**：Friday 侧加了封装配对凭据 + 受信级别（`/connect`、`/devices`、`/trust`、`server.trust`），
  本机编好 2.34.0 装到 239 实测：点 ⚡ → 聊天往返 → 解密 → 连上 `wss://192.168.20.239:7443`；
  不受信时终端/浏览器/文件被拒并说出原因；`/trust <id> on` 后重连即解锁（`terminalsAvailable: true`）。
  同一版构建里语音通话仍然正常（ICE connected、收到对方声音）。
- ~~自动更新（方案里写的「M4 再议」）~~：已做掉（见上）。

**实时语音用 D 档（机器人通话）**：方案 §6 原话「建议：D 档为主」。B 档 `voice.*` 的协议已实现（服务端 2.34.0 带 `voice` feature、8 个方法），但它的本地语音推理包要 **AVX2**，而 239 是 QEMU 虚拟机（CPU 只到 SSE4.2）跑不起来；D 档延迟更低（UDP 对 TCP）、回声消除更好、打断 / 来电都是现成的，所以实时语音以 D 档为准，`voice.*` 代码两边留看，等有 AVX2 的机器再启用。

**浏览器画面帧受测试机限制**：239 是 snap 版 Chromium，`friday-server` 内部起无头浏览器受 snap/AppArmor 限制不出帧；链路已验（`browser.open`/`navigate`/`input`/`close` 全有回执）。换装 deb 版 Chrome 的机器即可出帧。

**需要服务端或用户参与，尚未完成**
- M1.5 的「一键连到工作通道」：**已经做通**（见上），前提是那台机器装的是带 `/connect` 的包装（本机编的 2.34.0，见 `scripts/BUILD-239.md`）。
- `voice.*`（B 档）：协议已实现、留看待有 AVX2 的硬件；实时语音用 D 档通话（见上）。（后续进展：本机 Friday 2.36.0 已带 voice.*，端到端全通，见 git log）

## 快捷键与细节

- 双击窗口标题栏 = 最大化/还原；点任务栏 chip 两次 = 最小化。
- 会话窗口里 `Enter` 发送、`Shift+Enter` 换行；语音窗口按住 `Ctrl` 或按住说话按钮。
- 工具卡片点击展开完整参数与结果；待确认的调用不折叠，橙色标记。

## 目录

```
src/main          主进程（窗口、凭据、协议进程监护、IPC）
src/protocol      协议进程（transport / rpc / session / deploy / media）
src/preload       最小 API 面（端口、选文件、录音落盘、通知）
src/renderer      渲染进程（desktop 窗口系统 + components 窗口内容 + stores）
test              协议层单测；scripts/ 真机联调脚本（e2e-*.mts）
```
