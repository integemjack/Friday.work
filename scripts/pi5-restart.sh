#!/bin/sh
# 完全重启（我们在 22:54 已经把官方 2.34.1 的 friday 换成我们的构建）
for pid in $(ps -eo pid,args | grep friday | grep -v grep | grep -v defunct | awk '{print $1}'); do
  kill -9 "$pid" 2>/dev/null || true
done
sleep 4
cd /root
setsid nohup /root/.friday-server/bin/friday-server server --daemon >> /root/friday-server.log 2>&1 < /dev/null &
sleep 12
PID=$(ps -eo pid,args | grep "[f]riday-server --daemon" | grep -v grep | awk '{print $1}' | head -1)
echo "daemon=$PID exe=$(readlink /proc/$PID/exe 2>/dev/null)"
~/.friday-server/bin/friday-server --status 2>&1 | grep -E '"voice"|"version"'
