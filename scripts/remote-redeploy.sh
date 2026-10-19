#!/bin/sh
set -e
VERSION=${1:-2.34.0}
BIN=/root/.friday-server/versions/$VERSION/bin
SRC=/root/friday-build/build/src/cli/friday-headless

echo "=== 杀掉所有 friday 进程（按 pid，模式覆盖完整路径 / exec -a 两种名字） ==="
for pid in $(ps -eo pid,args | grep -E "[f]riday-headless server --daemon|[f]riday-server --daemon|[f]riday-server --attach" | awk '{print $1}'); do
  echo "kill $pid"
  kill "$pid" 2>/dev/null || true
done
sleep 3
left=$(ps -eo pid,args | grep -E "[f]riday-headless|[f]riday-server" | grep -v grep | wc -l)
echo "剩余 $left 个"

echo "=== 替换二进制 ==="
cp -f "$SRC" "$BIN/friday-headless"
chmod +x "$BIN/friday-headless"
md5sum "$SRC" "$BIN/friday-headless"

echo "=== 起新的 ==="
cd /root && setsid nohup "$BIN/friday-server" --daemon > /root/friday-server.log 2>&1 < /dev/null &
sleep 6
echo "=== ps ==="
ps -eo pid,args | grep "[f]riday-headless server --daemon" | head -2 || echo "(没有)"
echo "=== status ==="
"$BIN/friday-server" --status 2>&1 | head -3
