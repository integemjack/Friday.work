#!/bin/sh
test_url() {
  code=$(curl -sSL -o /dev/null -w "%{http_code}" --max-time 25 -r 0-1024 "$1" 2>/dev/null || echo ERR)
  echo "$code  $1"
}
echo "=== direct release asset ==="
test_url "https://github.com/Mbed-TLS/mbedtls/releases/download/mbedtls-3.6.7/mbedtls-3.6.7.tar.bz2"
echo "=== via ghproxy mirror ==="
test_url "https://ghproxy.net/https://github.com/Mbed-TLS/mbedtls/releases/download/mbedtls-3.6.7/mbedtls-3.6.7.tar.bz2"
echo "=== codeload tarball ==="
test_url "https://codeload.github.com/Mbed-TLS/mbedtls/tar.gz/refs/tags/mbedtls-3.6.7"
echo "=== local 8080 as proxy ==="
curl -sS -o /dev/null -w "http-proxy 8080: %{http_code}\n" --max-time 15 -x http://127.0.0.1:8080 https://github.com 2>&1 || echo "proxy 8080 failed"
