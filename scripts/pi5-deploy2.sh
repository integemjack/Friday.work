#!/bin/sh
# Pi5 部署：把新构建装进 2.35.0 目录（升级器认 2.35.0 不会重装）、软链已指 2.35.0、重启守护
set -e
SRC=/root/friday-build/build/src/cli/friday-headless
DEST=/root/.friday-server/versions/2.35.0/bin

for round in 1 2 3; do
  for pid in $(ps -eo pid,args | grep friday | grep -v grep | grep -v defunct | awk '{print $1}'); do
    kill -9 "$pid" 2>/dev/null || true
  done
  sleep 3
  # 二进制还被占着就再来一轮（拉起的 sshd --attach 会跟着断）
  busy=$(fuser "$DEST/friday" 2>/dev/null | grep -cE '[0-9]' || true)
  [ "$busy" = "0" ] && break
done

rm -f "$DEST/friday"
cp "$SRC" "$DEST/friday"
chmod +x "$DEST/friday"

cd /root
setsid nohup /root/.friday-server/bin/friday-server server --daemon >> /root/friday-server.log 2>&1 < /dev/null &
sleep 12
PID=$(ps -eo pid,args | grep "[f]riday-server --daemon" | grep -v grep | awk '{print $1}' | head -1)
echo "daemon=$PID"
~/.friday-server/bin/friday-server --status 2>&1 | grep -E '"version"|"voice"' | head -3
