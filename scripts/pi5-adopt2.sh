#!/bin/sh
# Pi5：把我们的构建装成 2.34.2-test（比官方 2.34.1 新，升级器不会再抢），接管软链
set -e
VERSION=2.34.2-test
SRC=/root/friday-build/build/src/cli/friday-headless
ROOT=/root/.friday-server
DEST=$ROOT/versions/$VERSION

echo "=== 装 $DEST ==="
mkdir -p "$DEST/bin"
cp "$SRC" "$DEST/bin/friday-headless"
cd "$DEST/bin"
ln -sf friday-headless friday
ln -sf friday-headless friday-server
cat > qt.conf <<'EOF'
[Paths]
Prefix=/opt/Qt6.11.3/6.11.3/gcc_arm64
EOF
chmod +x friday-headless friday friday-server
cat > server.json <<EOF
{"tag":"v$VERSION","arch":"arm64","platform":"linux","protocol":1,"version":"2.34.0"}
EOF

echo "=== 软链（短时间抢回，防止升级器再切：先写个标记文件让它的升级器认为已是这版）==="
ln -sfn "versions/$VERSION/bin" "$ROOT/bin"
# 升级器认版本看的是 installed 标记；给官方版本目录留个说明（它不读，人读）
echo "2.34.2-test = 本地构建（/connect + 受信 + voice.*），不要用升级器覆盖。官方 2.34.1 在 versions/2.34.1/" > "$ROOT/versions/README-TEST-BUILD.txt"
ls -la "$ROOT/bin"

echo "=== 杀旧守护、启动我们的 ==="
for pid in $(ps -eo pid,args | grep '/friday' | grep -v grep | grep -v defunct | awk '{print $1}'); do
  kill "$pid" 2>/dev/null || true
done
sleep 4
cd /root
setsid nohup /root/.friday-server/bin/friday-server server --daemon >> /root/friday-server.log 2>&1 < /dev/null &
sleep 10

echo "=== 校验 ==="
DAEMON_PID=$(ps -eo pid,args | grep "[f]riday-server --daemon" | grep -v grep | awk '{print $1}' | head -1)
ls -la "/proc/$DAEMON_PID/exe" 2>/dev/null
~/.friday-server/bin/friday-server --status 2>&1 | grep -E '"version"|"voice"|startedAt' | head -4
