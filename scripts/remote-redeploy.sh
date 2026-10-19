#!/bin/sh
# 严格部署：杀干净 → 等退出 → 拷贝 → 启动 → 校验 /proc/exe 与 features
set -e
VERSION=${1:-2.34.0}
BIN=/root/.friday-server/versions/$VERSION/bin
SRC=/root/friday-build/build/src/cli/friday-headless

echo "=== 1. 杀 ==="
for pid in $(ps -eo pid,args | grep -E "[f]riday-headless|[f]riday-server --" | awk '{print $1}'); do
  kill -9 "$pid" 2>/dev/null || true
done
for i in 1 2 3 4 5 6 7 8 9 10; do
  n=$(ps -eo args | grep -cE "[f]riday-headless|[f]riday-server --" || true)
  [ "$n" = "0" ] && break
  sleep 1
done
echo "还剩: $(ps -eo args | grep -cE '[f]riday-headless|[f]riday-server --' || true)"

echo "=== 2. 拷贝 ==="
rm -f "$BIN/friday-headless"
cp -f "$SRC" "$BIN/friday-headless"
chmod +x "$BIN/friday-headless"
md5sum "$SRC" "$BIN/friday-headless"

echo "=== 3. 启动 ==="
cd /root && setsid nohup "$BIN/friday-server" --daemon > /root/friday-server.log 2>&1 < /dev/null &
sleep 8

echo "=== 4. 校验 ==="
PID=$(ps -eo pid,args | grep "[f]riday-headless server --daemon" | awk '{print $1}' | head -1)
echo "pid=$PID"
ls -l "/proc/$PID/exe" 2>/dev/null
echo "features:"
"$BIN/friday-server" --status 2>&1 | grep -E '"voice"|"version"|startedAt'
