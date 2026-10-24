# FridaySysStats —— Windows 服务器资源采集器

贾维斯 HUD 遥测的 Windows 服务器侧数据源。**目标服务器上不用开着 Friday Work**：
本程序每 3 秒采样本机 CPU / RAM / GPU / 显存 / 进程数，原子写
`%ProgramData%\Friday\sysstats.json`，客户端经协议 `fs.read` 读它（10 秒内 `at`
有变化视为新鲜）。与 Friday Work 主进程的常驻快照循环共写同一份文件，兼容并存。

## 部署到一台新服务器（两步）

1. 把 `FridaySysStats.exe` 拷到服务器任意位置（建议 `%ProgramData%\Friday\`）；
2. 双击运行 = 立即开始常驻采集；要开机自启，改用命令行跑一次：

   ```bat
   FridaySysStats.exe --startup
   ```

   它会注册 HKCU Run（`FridaySysStats` → 自身路径）然后同样常驻。

防多开：Global mutex，重复启动的实例自动退出，放心双击多次。

## 从源码重编

```bat
build.cmd
```

用的是 Windows 自带的 .NET Framework 4.x `csc.exe`（C# 5），不需要装任何 SDK。

## 验证

- 任务管理器里有 `FridaySysStats.exe`（无窗口、后台常驻）；
- `%ProgramData%\Friday\sysstats.json` 每 3 秒更新（看修改时间）；
- 失败才写 `%ProgramData%\Friday\sysstats-collector.log`（`write failed:` 行）。

## 数据口径（与客户端 SysStats.ts 对齐）

| 字段 | 来源 | 频率 |
|---|---|---|
| `cpuPct` | `GetSystemTimes` 差值（首轮无基准 → `null`） | 3 秒 |
| `ramPct` | `GlobalMemoryStatusEx` 的 `dwMemoryLoad` | 3 秒 |
| `gpuPct` / `vramUsedMiB` / `vramTotalMiB` | `nvidia-smi` 首卡，没有 NVIDIA → `null` | 15 秒缓存 |
| `procs` | `Process.GetProcesses().Length` | 15 秒缓存 |
| `at` | 写入时刻（服务器自己的钟，毫秒） | 3 秒 |

原子写：先写带 PID 的 `.tmp` 再 `MoveFileEx(REPLACE_EXISTING)`，客户端永远读到
完整文件；多个写者（本程序 + Friday Work）互不干扰，最后写者赢。
