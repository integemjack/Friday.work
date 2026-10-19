# Friday Desktop Work

连接远程机器上的 Friday（`friday-server`）的桌面客户端：整个应用是一张桌面，**会话、终端、文件、浏览器、子 Agent、活动总览、语音、设置都是可以拖动、缩放、层叠的窗口**。技术栈 Electron 44 + Vue 3 + TypeScript；协议对照 `Friday/qt/docs/REMOTE.md`（唯一真相来源）实现。

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

## 连一台机器

「机器与会话」窗口 → **＋ 添加**，三种方式：

- `root@192.168.1.10`、`user@host:端口`：走系统 `ssh`（密钥 / ssh-agent / `~/.ssh/config` / 跳板机都照常生效），远端运行 `~/.friday-server/bin/friday-server --attach`。
- 填了**密码**：只登录这一次，把本机公钥（`~/.ssh/id_ed25519.pub`）装进远端 `authorized_keys`，之后不再用密码，密码不落盘。
- `wsl:发行版`：本机的 WSL。
- 粘贴 `friday://pair?u=wss://…&t=…&f=…` 配对链接：走 WebSocket（wss），令牌与证书 SHA-256 指纹由主进程 `safeStorage`（Windows DPAPI）加密保存，比对指纹通过前不发送 `hello`。

在任意已连上的机器上可以 **配对新设备（二维码）**（`server.pair`）：生成一次性链接，手机/另一台电脑扫码或粘贴即可连上。

## 窗口

| 窗口 | 内容 |
|---|---|
| 机器与会话 | 机器列表（连接/断开/删除/装服务端）、会话列表、配对入口 |
| 会话（每段一个窗口） | 消息树（含分叉 `‹ 2/3 ›` 切换）、流式增量、工具卡片（含子 Agent 运行记录递归）、审批横幅、附件、停止生成 |
| 终端 | 远端伪终端的字节流镜像（xterm.js），`htop`/`vim` 等全屏程序可直接用；Agent 用 `run_in_terminal` 开的终端会自动弹窗 |
| 文件 | 目录树、只读预览、本次会话改动与撤销（`fs.changes` / `fs.diff` / `fs.revert`）、「让 Friday 改」预填消息 |
| 浏览器 | 远端浏览器实时画面（`browser.frame`）、鼠标键盘转发、标签切换、下载进度、`handOver` 自动弹窗 |
| 子 Agent | 后台子 Agent 的活动、步数、耗时、速度、排队消息；停 / 插话 |
| 活动总览 | 这台机器上所有会话的实时动静（生成中 / 等确认 / 卡住 / 出错），点击跳转 |
| 语音 | 按住说话 → 录音上传 → `assistant.say(source=voice)` → `assistant.entry` 回复 → 系统语音朗读（方案 §6.1 M3-A） |
| 扫码一键连 | Secret-Chat 扫码登录（`/login-sessions`）、好友里的机器人列表（显示备注）、和 Friday bot 对话（`schat-ws/v1`，含 `bot_stream_delta` 流式拼装） |
| 通话 | 给机器人打语音电话（WebRTC）：`p2p_request`/`p2p_response`/`p2p_signaling` 信令 + `GET /calls/ice-servers` 的 TURN；Opus 48 kHz 单声道；没有麦克风时自动退回只收（能听不能说） |
| 设置 | 远端引擎、Agent 设置、服务状态（只读） |

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
- M1 协议层、会话流、附件上传、断线重连、`messagePatch` 增量
- M2 终端 / 文件 / 浏览器 / 子 Agent / 活动总览
- 桌面窗口范式、任务栏、多会话窗口并存
- M3-A 语音（录音消息 + 本地朗读，识别与理解在远端）
- M4：多机器后台常连、密码添加 SSH、二维码配对、自动安装/升级远程 friday-server、设置页、打包（NSIS + zip）
- M1.5 客户端侧：扫码登录（生产 chatserver 真实建码 + 轮询 + 批准）、schat-ws 连接、机器人列表（按备注显示）、和 bot 对话与流式拼装（凭据经 safeStorage 加密）
- 真机验证：扫码登录后给备注「Linux 239」的机器人发消息，助手回复正常显示（含流式增量）
- M3-D 语音通话：真机拨给「Linux 239」，对端接受 → WebRTC ICE/连接均 connected → 收到对方音轨、计时正常、挂断干净（这台机器没有麦克风，自动退回只收模式）

**需要服务端或用户参与，尚未完成**
- M1.5 的「一键连到工作通道」：扫码登录本身能跑，但登录后要用 `/connect` 领配对凭据才能连上工作通道，这条命令在 friday-server 里还不存在（方案 §7.4 缺口 #3）；受信级别也是缺口 #2。手机扫一下确认登录这一步需要用户本人。
- M3-B `voice.*` 协议（真正实时语音、Friday 的音色）：需要改 Friday 本体（按 Friday 仓库流程）。
- 机器人主动来电的 UI（契约支持，现在只做了主叫；来电需要在协议进程收 `p2p_request` 后弹窗、`p2p_response{accepted}` + answer）
- 自动更新（方案里写的「M4 再议」）。

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
