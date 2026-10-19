#!/bin/sh
# Pi5 预取 Friday 通话依赖（github 直连不稳，走镜像/重试）
set -e
mkdir -p /root/deps
cd /root/deps

fetch() {
  url=$1
  out=$2
  if [ -f "$out" ]; then echo "have $out"; return 0; fi
  for i in 1 2 3; do
    if curl -sSL --max-time 600 -o "$out" "$url"; then echo "ok $out"; return 0; fi
    echo "retry $i $out"
    sleep 3
  done
  return 1
}

echo "=== mbedtls tarball（直连+镜像各试一次）==="
fetch "https://github.com/Mbed-TLS/mbedtls/releases/download/mbedtls-3.6.7/mbedtls-3.6.7.tar.bz2" mbedtls.tar.bz2 ||
  fetch "https://ghproxy.net/https://github.com/Mbed-TLS/mbedtls/releases/download/mbedtls-3.6.7/mbedtls-3.6.7.tar.bz2" mbedtls.tar.bz2

echo "=== git deps（insteadof 镜像）==="
git config --global url."https://ghproxy.net/https://github.com/".insteadOf "https://github.com/" || true

for repo in "paullouisageneau/libdatachannel v0.24.5" "xiph/opus v1.5.2" "cisco/openh264 v2.6.0"; do
  set -- $repo
  name=$(basename $1)
  if [ -d "$name" ]; then echo "have $name"; continue; fi
  git clone --depth 1 --branch $2 https://github.com/$1.git $name
done

echo "=== 解开 mbedtls ==="
cd /root/deps
[ -d mbedtls ] || tar xjf mbedtls.tar.bz2 && mv mbedtls-3.6.7 mbedtls
echo "DEPS-DONE"
ls /root/deps
