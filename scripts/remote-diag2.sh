#!/bin/sh
echo "=== friday-server.log 里 voice/powers ==="
grep -iE "voice|本地能力" /root/.local/share/Friday/Logs/friday-server.log | tail -8
echo
echo "=== state.json 的 serve ==="
grep -A 12 '"serve"' /root/.local/share/Friday/Powers/state.json | head -14
echo
echo "=== friday-voice 进程 ==="
ps -eo args | grep "[f]riday-voice" | head -3
