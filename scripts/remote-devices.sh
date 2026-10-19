#!/bin/sh
echo "=== 设备（按 lastSeen 排序，最新在前） ==="
/root/.friday-server/bin/friday-server --devices 2>&1 | head -30
