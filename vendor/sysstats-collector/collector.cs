// FridaySysStats —— Windows 服务器资源常驻采集器（独立于 Friday Work 运行）
//
// 用途：贾维斯 HUD 遥测的 Windows 服务器侧数据源。目标服务器上不必（往往不能）开着
// Friday Work，由本程序每 3 秒采样本机 CPU/RAM/GPU/显存/进程数，原子写
// %ProgramData%\Friday\sysstats.json；客户端经协议 fs.read 读该文件，
// 10 秒内 at 有变化就当作新鲜数据上屏。
//
// 用法：双击 = 后台常驻（无窗口，任务管理器可见 FridaySysStats.exe）；
//       FridaySysStats.exe --startup = 注册 HKCU Run 开机自启，然后同样常驻。
//       Global mutex 防多开：第二个实例直接退出。
//
// 与 Friday Work 主进程（Electron SysStats.ts）共写同一份 json：tmp 名带 PID
// 互不干扰，MoveFileEx(REPLACE_EXISTING) 原子替换，最后写者赢——两边数据都是
// 本机实测，谁赢都一样。CPU/RAM/进程数口径与 SysStats.ts 对齐：
//   CPU%   = GetSystemTimes 差值（kernel+user，kernel 含 idle；首轮无基准 → null）
//   RAM%   = GlobalMemoryStatusEx 的 dwMemoryLoad
//   GPU    = nvidia-smi 首卡利用率/显存，15 秒缓存（单次要几百 ms）；没有就 null
//   进程数 = Process.GetProcesses().Length，15 秒缓存
//
// 编译（Windows 自带，无需安装任何东西）：
//   build.cmd 或
//   C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /target:winexe /optimize+
//     /out:FridaySysStats.exe collector.cs

using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32;

static class Program
{
    // ---- Win32 ----
    [StructLayout(LayoutKind.Sequential)]
    struct FILETIME { public uint Low; public uint High; }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetSystemTimes(out FILETIME idle, out FILETIME kernel, out FILETIME user);

    [StructLayout(LayoutKind.Sequential)]
    struct MEMORYSTATUSEX
    {
        public uint Length;
        public uint MemoryLoad;
        public ulong TotalPhys, AvailPhys, TotalPageFile, AvailPageFile, TotalVirtual, AvailVirtual, AvailExtendedVirtual;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GlobalMemoryStatusEx(ref MEMORYSTATUSEX buffer);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool MoveFileEx(string from, string to, int flags); // 1 = MOVEFILE_REPLACE_EXISTING

    const int MOVEFILE_REPLACE_EXISTING = 1;
    const string MutexName = "Global\\FridaySysStats";

    static string DataDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Friday");
    static string JsonPath = Path.Combine(DataDir, "sysstats.json");
    static string LogPath = Path.Combine(DataDir, "sysstats-collector.log");

    static int Main(string[] args)
    {
        for (int i = 0; i < args.Length; i++)
        {
            string a = args[i];
            if (a == "--startup" || a == "/startup") RegisterAutostart();
        }

        // 防多开：拿不到全局互斥量就悄悄退出（开机自启 + 手动双击并存时只留一个）
        bool createdNew;
        using (var mutex = new Mutex(true, MutexName, out createdNew))
        {
            if (!createdNew) return 0;
            RunLoop();
        }
        return 0;
    }

    // ---- 采样 ----

    static bool TryReadCpuTimes(out ulong idle, out ulong total)
    {
        FILETIME i, k, u;
        if (!GetSystemTimes(out i, out k, out u)) { idle = 0; total = 0; return false; }
        idle = ((ulong)i.High << 32) | i.Low;
        // kernel 时间已含 idle，加 user 即总时间片
        total = (((ulong)k.High << 32) | k.Low) + (((ulong)u.High << 32) | u.Low);
        return true;
    }

    /// nvidia-smi 首卡 [利用率%, 显存已用MiB, 显存总量MiB]；跑不起来 / 解析不出 → null。
    /// 与 SysStats.ts 相同口径：多卡只取第一行，列缺失或非数字视为没有。
    static double[] TryReadGpu()
    {
        try
        {
            var psi = new ProcessStartInfo("nvidia-smi",
                "--query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits");
            psi.UseShellExecute = false;
            psi.RedirectStandardOutput = true;
            psi.CreateNoWindow = true;
            using (var p = Process.Start(psi))
            {
                if (p == null) return null;
                string line = p.StandardOutput.ReadLine();
                if (!p.WaitForExit(4000)) { try { p.Kill(); } catch { } return null; }
                if (line == null) return null;
                string[] parts = line.Split(',');
                if (parts.Length < 3) return null;
                double util, used, total;
                if (!double.TryParse(parts[0].Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out util)) return null;
                if (!double.TryParse(parts[1].Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out used)) return null;
                if (!double.TryParse(parts[2].Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out total)) return null;
                return new double[] { util, used, total };
            }
        }
        catch { return null; }
    }

    static int ReadProcessCount()
    {
        try { return Process.GetProcesses().Length; }
        catch { return -1; }
    }

    // ---- 输出 ----

    static string JsonEscape(string s)
    {
        var sb = new StringBuilder(s.Length + 8);
        for (int i = 0; i < s.Length; i++)
        {
            char c = s[i];
            if (c == '\\' || c == '"') { sb.Append('\\'); sb.Append(c); }
            else if (c < ' ') sb.AppendFormat("\\u{0:x4}", (int)c);
            else sb.Append(c);
        }
        return sb.ToString();
    }

    /// null → JSON null；数值一律 invariant 输出（防区域设置的逗号小数点）
    static string Num(double v) { return Math.Round(v).ToString(CultureInfo.InvariantCulture); }

    static void WriteSnapshot(string hostname, double? cpuPct, uint ramPct, double[] gpu, int procs)
    {
        var sb = new StringBuilder(256);
        sb.Append("{\"hostname\":\"").Append(JsonEscape(hostname)).Append('"');
        sb.Append(",\"cpuPct\":").Append(cpuPct.HasValue ? Num(cpuPct.Value) : "null");
        sb.Append(",\"ramPct\":").Append(ramPct);
        sb.Append(",\"gpuPct\":").Append(gpu != null ? Num(gpu[0]) : "null");
        sb.Append(",\"vramUsedMiB\":").Append(gpu != null ? Num(gpu[1]) : "null");
        sb.Append(",\"vramTotalMiB\":").Append(gpu != null ? Num(gpu[2]) : "null");
        sb.Append(",\"procs\":").Append(procs >= 0 ? procs.ToString(CultureInfo.InvariantCulture) : "null");
        sb.Append(",\"at\":").Append(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        sb.Append('}');

        try
        {
            if (!Directory.Exists(DataDir)) Directory.CreateDirectory(DataDir);
            // tmp 带 PID：与 Friday Work / 其他实例互不干扰；MoveFileEx 原子替换，读者永远读到完整文件
            string tmp = JsonPath + "." + Process.GetCurrentProcess().Id + ".tmp";
            // 无 BOM 的 UTF-8：客户端拿到后直接 JSON.parse（BOM 会让它失败）
            File.WriteAllText(tmp, sb.ToString(), new UTF8Encoding(false));
            if (!MoveFileEx(tmp, JsonPath, MOVEFILE_REPLACE_EXISTING))
                throw new IOException("MoveFileEx failed, win32 error " + Marshal.GetLastWin32Error());
        }
        catch (Exception ex)
        {
            Log("write failed: " + ex.Message);
        }
    }

    // 失败才写日志（成功是常态，不写）；超过 256KB 先清空，防持续失败刷爆磁盘
    static void Log(string msg)
    {
        try
        {
            if (!Directory.Exists(DataDir)) Directory.CreateDirectory(DataDir);
            var fi = new FileInfo(LogPath);
            if (fi.Exists && fi.Length > 256 * 1024) File.WriteAllText(LogPath, "");
            File.AppendAllText(LogPath,
                DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture) + " " + msg + Environment.NewLine,
                new UTF8Encoding(false));
        }
        catch { }
    }

    static void RegisterAutostart()
    {
        try
        {
            string exe = Process.GetCurrentProcess().MainModule.FileName;
            using (var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true))
            {
                if (key == null) throw new IOException("HKCU Run key not found");
                key.SetValue("FridaySysStats", "\"" + exe + "\"");
            }
        }
        catch (Exception ex)
        {
            Log("register autostart failed: " + ex.Message);
        }
    }

    static void RunLoop()
    {
        string hostname = Environment.MachineName;
        ulong prevIdle = 0, prevTotal = 0;
        bool hasPrevCpu = false;
        double[] gpu = null;
        int procs = -1;
        long lastGpuAt = 0, lastProcAt = 0;
        const long CacheMs = 15000;

        while (true)
        {
            try
            {
                // CPU：与上一轮的时间片做差
                double? cpuPct = null;
                ulong idle, total;
                if (TryReadCpuTimes(out idle, out total))
                {
                    if (hasPrevCpu)
                    {
                        ulong dTotal = total - prevTotal;
                        ulong dIdle = idle - prevIdle;
                        if (dTotal > 0)
                        {
                            double pct = (1.0 - (double)dIdle / dTotal) * 100.0;
                            if (pct < 0) pct = 0;
                            if (pct > 100) pct = 100;
                            cpuPct = pct;
                        }
                    }
                    prevIdle = idle; prevTotal = total; hasPrevCpu = true;
                }

                // RAM
                var ms = new MEMORYSTATUSEX();
                ms.Length = (uint)Marshal.SizeOf(typeof(MEMORYSTATUSEX));
                uint ramPct = 0;
                if (GlobalMemoryStatusEx(ref ms)) ramPct = ms.MemoryLoad;

                // GPU / 进程数：重查询走 15 秒缓存
                long now = Environment.TickCount;
                if (gpu == null || unchecked(now - lastGpuAt) >= CacheMs)
                {
                    gpu = TryReadGpu();
                    lastGpuAt = now;
                }
                if (procs < 0 || unchecked(now - lastProcAt) >= CacheMs)
                {
                    procs = ReadProcessCount();
                    lastProcAt = now;
                }

                WriteSnapshot(hostname, cpuPct, ramPct, gpu, procs);
            }
            catch (Exception ex)
            {
                Log("sample failed: " + ex.Message);
            }
            Thread.Sleep(3000);
        }
    }
}
