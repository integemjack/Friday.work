#!/bin/sh
# 把我们的构建直接装进官方 2.34.1 的目录（升级器看 server.json 的 2.34.1 就不会重装，
# 它在数据目录里记的是"已装 2.34.1"；官方包文件被换成我们的 2.34.0 内核 + voice）。
set -e
SRC=/root/friday-build/build/src/cli/friday-headless
DEST=/root/.friday-server/versions/2.34.1/bin

echo "=== 1. 杀掉在跑的（连拉起它的 sshd 会话一起，直到没有进程占着二进制）==="
for round in 1 2 3; do
  pids=$(fuser /root/.friday-server/versions/2.34.1/bin/friday 2>/dev/null | tr -s ' ' '\n' | grep -E '^[0-9]+$')
  for pid in $pids; do kill -9 "$pid" 2>/dev/null || true; done
  for pid in $(ps -eo pid,args | grep '/friday' | grep -v grep | grep -v defunct | awk '{print $1}'); do
    kill -9 "$pid" 2>/dev/null || true
  done
  sleep 3
  if ! fuser /root/.friday-server/versions/2.34.1/bin/friday >/dev/null 2>&1; then
    echo "第 $round 轮清干净"
    break
  fi
done

echo "=== 2. 替换官方 2.34.1 的二进制为我们的构建 ==="
rm -f "$DEST/friday"
cp "$SRC" "$DEST/friday"
# qt.conf 保留官方的（指向系统 Qt）；看一眼
cat "$DEST/qt.conf" 2>/dev/null | head -3
chmod +x "$DEST/friday"

echo "=== 3. 启动 ==="
cd /root
setsid nohup /root/.friday-server/bin/friday-server server --daemon >> /root/friday-server.log 2>&1 < /dev/null &
sleep 10

echo "=== 4. 校验 ==="
PID=$(ps -eo pid,args | grep "[f]riday-server --daemon" | grep -v grep | awk '{print $1}' | head -1)
echo "daemon pid=$PID"
ls -la "/proc/$PID/exe" 2>/dev/null
~/.friday-server/bin/friday-server --status 2>&1 | grep -E '"version"|"voice"' | head -3
