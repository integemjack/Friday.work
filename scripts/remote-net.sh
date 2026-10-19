#!/bin/sh
echo "=== network ==="
curl -sS -o /dev/null -w "download.qt.io: %{http_code}\n" --max-time 20 https://download.qt.io/online/qtsdkrepository/ || echo "qt unreachable"
curl -sS -o /dev/null -w "github: %{http_code}\n" --max-time 20 https://github.com || echo "github unreachable"
echo
echo "=== python ==="
python3 -V
which pip3 2>/dev/null || echo "no pip3"
python3 -m pip --version 2>/dev/null || echo "no pip module"
echo
echo "=== existing aqtenv ==="
cat /root/aqtenv/pyvenv.cfg 2>/dev/null
ls /root/aqtenv/bin 2>/dev/null | head -8
du -sh /root/aqtenv 2>/dev/null
echo
echo "=== system qt6 packages ==="
dpkg -l 2>/dev/null | grep -c '^ii  qt6'
