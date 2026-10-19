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
