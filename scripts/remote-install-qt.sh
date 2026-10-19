#!/bin/sh
export PATH=/root/aqtenv/bin:$PATH
mkdir -p /root/qt611
cd /root || exit 1
nohup aqt install-qt linux desktop 6.11.3 linux_gcc_64 \
  --outputdir /root/qt611 \
  -m qtwebsockets qtshadertools \
  > /root/aqt-install.log 2>&1 &
echo "started pid=$!"
sleep 5
tail -3 /root/aqt-install.log
