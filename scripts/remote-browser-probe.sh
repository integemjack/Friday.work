#!/bin/sh
# 远端诊断：直接用无头 chromium 截一张图，看远端浏览器本身能不能跑
cd /tmp || exit 1
rm -f /tmp/probe.png
timeout 30 chromium-browser --headless=new --no-sandbox --disable-gpu --hide-scrollbars \
  --window-size=1280,800 --screenshot=/tmp/probe.png 'data:text/html,<h1>hello</h1>' 2>&1 | tail -8
echo "--- 截图 ---"
ls -l /tmp/probe.png 2>/dev/null || echo "(没有截图)"
