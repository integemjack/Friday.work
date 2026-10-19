#!/bin/sh
# 把 Friday 通话依赖提前取到 /root/deps（GitHub 直连不稳，走 ghproxy 镜像）
set -e
mkdir -p /root/deps
cd /root/deps

echo "=== mbedtls 3.6.7 (tarball via mirror) ==="
if [ ! -f mbedtls-3.6.7.tar.bz2 ]; then
  curl -fSL --retry 3 --retry-delay 2 -o mbedtls-3.6.7.tar.bz2 \
    "https://ghproxy.net/https://github.com/Mbed-TLS/mbedtls/releases/download/mbedtls-3.6.7/mbedtls-3.6.7.tar.bz2"
fi
ls -l mbedtls-3.6.7.tar.bz2
rm -rf mbedtls && mkdir mbedtls && tar xf mbedtls-3.6.7.tar.bz2 -C mbedtls --strip-components=1
echo "mbedtls ok: $(ls mbedtls | head -3 | tr '\n' ' ')"

echo "=== git deps ==="
git config --global url."https://ghproxy.net/https://github.com/".insteadOf "https://github.com/"
clone() {
  name=$1; url=$2; tag=$3
  if [ -d "$name/.git" ]; then echo "$name already"; return; fi
  rm -rf "$name"
  git clone --depth 1 --branch "$tag" --recurse-submodules --shallow-submodules "$url" "$name"
  echo "$name ok"
}
clone opus https://github.com/xiph/opus.git v1.5.2
clone openh264 https://github.com/cisco/openh264.git v2.6.0
clone libdatachannel https://github.com/paullouisageneau/libdatachannel.git v0.24.5

echo "=== 结果 ==="
du -sh /root/deps/* 2>/dev/null
