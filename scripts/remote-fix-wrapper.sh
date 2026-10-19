#!/bin/sh
# 用带 exec -a 的包装脚本替换 bin/friday 与 bin/friday-server
set -e
VERSION=${1:-2.34.0}
BIN=/root/.friday-server/versions/$VERSION/bin

cat > "$BIN/friday" <<'EOF'
#!/bin/bash
# 测试构建的包装：程序按 argv[0] 认自己是不是服务端程序（RemoteServer::isServerProgram），
# 所以用 exec -a 把名字带过去；Qt 走这台机器上的 aqt 安装（测试构建没把 Qt 打进包里）。
QT=/root/qt611/6.11.3/gcc_64
DIR=$(dirname "$0")
export LD_LIBRARY_PATH=$QT/lib:${LD_LIBRARY_PATH}
export QT_PLUGIN_PATH=$QT/plugins
case "$(basename "$0")" in
  friday-server) exec -a friday-server "$DIR/friday-headless" "$@" ;;
  *) exec -a friday "$DIR/friday-headless" "$@" ;;
esac
EOF
chmod +x "$BIN/friday"
ln -sfn friday "$BIN/friday-server"

echo "=== 自检：既然叫 friday-server，应该直接是服务 ==="
"$BIN/friday-server" --version 2>&1 | head -2
echo
echo "=== attach 试一次（应打印 JSON 或错误而不是用法） ==="
timeout 3 "$BIN/friday-server" --attach < /dev/null 2>&1 | head -3
echo
echo "=== 重启守护进程 ==="
pkill -f "friday-headless server --daemon" 2>/dev/null || true
sleep 2
cd /root && setsid nohup "$BIN/friday-server" --daemon > /root/friday-server.log 2>&1 < /dev/null &
sleep 6
ps -ef | grep '[f]riday-headless' | head -2
echo "=== log ==="
tail -8 /root/friday-server.log
echo "=== status ==="
"$BIN/friday-server" --status 2>&1 | head -8
