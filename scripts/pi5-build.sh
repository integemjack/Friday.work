#!/bin/sh
# Pi5 上配置并编译 friday-headless（ARM64）
set -e
QTDIR=$(echo /opt/Qt6.11.3/6.11.3/gcc_arm64)
mkdir -p /root/friday-build/build
cd /root/friday-build/build

{
  echo "cmake -G Ninja .."
  echo "  -DCMAKE_BUILD_TYPE=Release"
  echo "  -DCMAKE_PREFIX_PATH=$QTDIR"
  echo "  -DFRIDAY_VERSION=2.34.0"
  echo "  -DFRIDAY_BUILD_NUMBER=1"
  echo "  -DFRIDAY_BUILD_GUI=OFF"
  echo "  -DFRIDAY_BUILD_TESTS=OFF"
  echo "  -DFRIDAY_BUILD_INSTALLER=OFF"
  echo "=== configure ==="
} > /root/friday-build.log

cmake -G Ninja .. \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_PREFIX_PATH="$QTDIR" \
  -DFRIDAY_VERSION=2.34.0 \
  -DFRIDAY_BUILD_NUMBER=1 \
  -DFRIDAY_BUILD_GUI=OFF \
  -DFRIDAY_BUILD_TESTS=OFF \
  -DFRIDAY_BUILD_INSTALLER=OFF \
  -DFETCHCONTENT_SOURCE_DIR_MBEDTLS=/root/deps/mbedtls \
  -DFETCHCONTENT_SOURCE_DIR_LIBDATACHANNEL=/root/deps/libdatachannel \
  -DFETCHCONTENT_SOURCE_DIR_OPUS=/root/deps/opus \
  -DFETCHCONTENT_SOURCE_DIR_OPENH264=/root/deps/openh264 \
  >> /root/friday-build.log 2>&1

echo "=== build ==="
echo "ninja friday-headless（4 核，约 40-70 分钟）" >> /root/friday-build.log
cmake --build . --target friday-headless -j 4 >> /root/friday-build.log 2>&1
echo "=== done ==="
ls -l src/cli/friday-headless
