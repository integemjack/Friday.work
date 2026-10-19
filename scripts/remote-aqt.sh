#!/bin/sh
export PATH=/root/aqtenv/bin:$PATH
echo "=== aqt ==="
aqt version 2>&1 | head -2
echo "=== 6.11 有哪些 ==="
aqt list-qt linux desktop --arch 6.11.3 2>&1 | head -5 || aqt list-qt linux desktop 2>&1 | tail -8
