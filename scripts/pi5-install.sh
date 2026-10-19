#!/bin/sh
# Pi5：装我们的 2.34.0 构建为独立版本（2.34.1-voice），接管软链，重启守护进程
set -e
VERSION=2.34.1-voice
SRC=/root/friday-build/build/src/cli/friday-headless
ROOT=/root/.friday-server
DEST=$ROOT/versions/$VERSION

echo "=== 1. 停旧守护 ==="
for pid in $(ps -eo pid,args | grep "[f]riday.*--daemon" | grep -v grep | awk '{print $1}'); do
  kill "$pid" 2>/dev/null || true
done
sleep 3

echo "=== 2. 装 ==="
mkdir -p "$DEST/bin"
cp "$SRC" "$DEST/bin/friday-headless"
cd "$DEST/bin"
ln -sf friday-headless friday
ln -sf friday-headless friday-server
cp /root/friday-build/qt.conf . 2>/dev/null || cat > qt.conf <<'EOF'
[Paths]
Prefix=/opt/Qt6.11.3/6.11.3/gcc_arm64
EOF
chmod +x friday-headless friday friday-server

echo "=== 3. 软链接管 ==="
ln -sfn "versions/$VERSION/bin" "$ROOT/bin"
ls -la "$ROOT/bin"

echo "=== 4. 启动 ==="
cd /root
setsid nohup /root/.friday-server/bin/friday-server server --daemon >> /root/friday-server.log 2>&1 < /dev/null &
sleep 8

echo "=== 5. 校验 ==="
ps -eo pid,args | grep "[f]riday.*--daemon" | grep -v grep | head -2
~/.friday-server/bin/friday-server --status 2>&1 | grep -E '"version"|"voice"|startedAt' | head -4
