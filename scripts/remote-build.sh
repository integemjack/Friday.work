#!/bin/sh
set -e
QTDIR=/root/qt611/6.11.3/gcc_64
mkdir -p /root/friday-build/build
cd /root/friday-build/build

{
  echo "=== configure $(date) ==="
  cmake .. \
    -G Ninja \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_PREFIX_PATH="$QTDIR" \
    -DFRIDAY_VERSION=2.34.0 \
    -DFRIDAY_BUILD_NUMBER=1 \
    -DFRIDAY_BUILD_GUI=OFF \
    -DFRIDAY_BUILD_TESTS=OFF \
    -DFRIDAY_BUILD_INSTALLER=OFF \
    -DFRIDAY_BROWSER=OFF \
    -DFRIDAY_CALLS=ON \
    -DFETCHCONTENT_SOURCE_DIR_MBEDTLS=/root/deps/mbedtls \
    -DFETCHCONTENT_SOURCE_DIR_LIBDATACHANNEL=/root/deps/libdatachannel \
    -DFETCHCONTENT_SOURCE_DIR_OPUS=/root/deps/opus \
    -DFETCHCONTENT_SOURCE_DIR_OPENH264=/root/deps/openh264
  echo "=== build $(date) ==="
  cmake --build . --target friday-headless -j 8
  echo "=== done $(date) ==="
} > /root/friday-build.log 2>&1

echo "EXIT=$?"
