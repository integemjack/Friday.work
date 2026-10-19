#!/bin/sh
# 清掉所有 friday 进程（按 PID），确认软链，再启动我们的构建
for pid in $(ps -eo pid,args | grep '/friday' | grep -v grep | grep -v defunct | awk '{print $1}'); do
  kill -9 "$pid" 2>/dev/null || true
done
sleep 4
echo "=== 剩余 ==="
ps -eo pid,args | grep friday | grep -v grep | grep -v defunct | head -3
echo "=== 软链 ==="
ls -la /root/.friday-server/bin
readlink -f /root/.friday-server/bin/friday
echo "=== 启动我们的 ==="
cd /root
setsid nohup /root/.friday-server/bin/friday-server server --daemon >> /root/friday-server.log 2>&1 < /dev/null &
sleep 10
echo "=== 校验 ==="
DAEMON_PID=$(ps -eo pid,args | grep "[f]riday-server --daemon" | grep -v grep | awk '{print $1}' | head -1)
echo "daemon pid=$DAEMON_PID"
ls -la "/proc/$DAEMON_PID/exe" 2>/dev/null
~/.friday-server/bin/friday-server --status 2>&1 | grep -E '"version"|"voice"' | head -3
