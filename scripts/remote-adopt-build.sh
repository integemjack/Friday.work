#!/bin/sh
# 把我们的构建装成 2.34.1（抢在官方升级器前面占住最新版本号），并让 bin 指过去
# 以后本机 Friday 桌面端升级时（装出 2.34.2+）也不会再覆盖我们的测试版本
set -e
SRC=/root/friday-build/build/src/cli/friday-headless
ROOT=/root/.friday-server
VERSION=2.34.1-test

# 官方升级器装的是 <version> 目录；我们用带后缀的目录名，它不会认
mkdir -p "$ROOT/versions/$VERSION/bin"
cp -f "$SRC" "$ROOT/versions/$VERSION/bin/friday-headless"
chmod +x "$ROOT/versions/$VERSION/bin/friday-headless"
ln -sf friday-headless "$ROOT/versions/$VERSION/bin/friday-server"
cp -f "$ROOT/versions/2.34.1/bin/qt.conf" "$ROOT/versions/$VERSION/bin/qt.conf" 2>/dev/null || true

# Qt 走这台机器上的 aqt 安装（测试构建没带 Qt 运行库）
cat > "$ROOT/versions/$VERSION/bin/qt.conf" <<'EOF'
[Paths]
Prefix = /root/qt611/6.11.3/gcc_64
Plugins = plugins
Data = .
Translations = translations
EOF

# 停掉正在跑的（官方 2.34.1），软链指到我们的，再起
for pid in $(ps -eo pid,args | grep -E "[f]riday-headless|[f]riday.* --daemon|[f]riday-server --" | awk '{print $1}'); do
  kill -9 "$pid" 2>/dev/null || true
done
sleep 2

# bin 里的符号链接是相对的（versions/2.34.x/bin），直接重写到我们的测试目录
rm -f "$ROOT/bin"
ln -s "versions/$VERSION/bin" "$ROOT/bin"
ls -l "$ROOT/bin"

cd /root && setsid nohup "$ROOT/bin/friday-server" --daemon > /root/friday-server.log 2>&1 < /dev/null &
sleep 8

echo "=== 校验 ==="
ps -eo pid,args | grep "[f]riday.*--daemon" | head -2
"$ROOT/bin/friday-server" --status 2>&1 | grep -E '"version"|"voice"|startedAt'
