#!/bin/sh
# 把编好的 friday-headless 装成服务端包布局并重启守护进程
#   ~/.friday-server/versions/<ver>/bin/friday(+friday-server)
#   ~/.friday-server/bin -> versions/<ver>/bin
set -e
VERSION=${1:-2.34.0}
BUILD=/root/friday-build/build/src/cli
ROOT=/root/.friday-server
QT=/root/qt611/6.11.3/gcc_64

[ -x "$BUILD/friday-headless" ] || { echo "no binary: $BUILD/friday-headless"; exit 1; }

echo "=== 停掉正在跑的服务 ==="
pkill -x friday 2>/dev/null || true
pkill -f "friday server --daemon" 2>/dev/null || true
sleep 2
ps -ef | grep -c "[f]riday server" || true

echo "=== 装到 $ROOT/versions/$VERSION ==="
mkdir -p "$ROOT/versions/$VERSION/bin"
cp -f "$BUILD/friday-headless" "$ROOT/versions/$VERSION/bin/friday-headless"
chmod +x "$ROOT/versions/$VERSION/bin/friday-headless"

# 包装脚本：指到这台机器上的 Qt（测试构建，Qt 没打进包里）
cat > "$ROOT/versions/$VERSION/bin/friday" <<EOF
#!/bin/sh
export LD_LIBRARY_PATH=$QT/lib:\${LD_LIBRARY_PATH}
export QT_PLUGIN_PATH=$QT/plugins
exec "\$(dirname "\$0")/friday-headless" "\$@"
EOF
chmod +x "$ROOT/versions/$VERSION/bin/friday"
ln -sfn friday "$ROOT/versions/$VERSION/bin/friday-server"

echo "=== 切 bin ==="
ln -sfn "$ROOT/versions/$VERSION/bin" "$ROOT/bin"
ls -l "$ROOT/bin"

echo "=== 版本自检 ==="
"$ROOT/bin/friday-server" --version 2>&1 | head -3 || "$ROOT/bin/friday" version 2>&1 | head -3

echo "=== 起守护进程 ==="
nohup "$ROOT/bin/friday-server" server --daemon > /root/friday-server.log 2>&1 &
sleep 4
tail -5 /root/friday-server.log
echo "=== 进程 ==="
ps -ef | grep "[f]riday" | head -5
