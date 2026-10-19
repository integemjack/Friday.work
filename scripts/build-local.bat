@echo off
REM 本机 Windows 编译（增量）：带我们这轮的改动（/connect + 受信 + voice.*）
cd /d C:\Users\ultra\Desktop\Friday\qt\build-app\build || exit /b 1
cmake --build . --target friday-headless 2>&1
echo === exit %ERRORLEVEL% ===
