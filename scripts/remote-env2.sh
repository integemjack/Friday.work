#!/bin/sh
echo "=== aqt Qt 版本 ==="
ls /root/aqtenv/lib/cmake 2>/dev/null | head -3
/root/aqtenv/bin/qmake -query QT_VERSION 2>/dev/null || echo "(没有 qmake)"
ls /root/aqtenv/include | head -3
echo
echo "=== 系统 Qt6 版本 ==="
dpkg -l 2>/dev/null | grep -E 'qt6-base-dev|libqt6core6' | head -3
echo
echo "=== 需要的模块 ==="
for m in Qt6WebSockets Qt6Network Qt6Qml Qt6Quick Qt6Sql Qt6Multimedia; do
  printf '%-16s' "$m"
  test -d /root/aqtenv/lib/cmake/$m && echo ok || echo "(missing)"
done
echo
echo "=== 已装 Friday 的版本 ==="
/root/.local/opt/Friday/usr/bin/friday server --version 2>&1 | head -2 || echo "(跑不起来)"
