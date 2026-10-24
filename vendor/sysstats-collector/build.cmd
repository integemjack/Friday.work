@echo off
rem Build FridaySysStats.exe using the csc.exe that ships with Windows (.NET Framework 4.x).
rem NOTE: keep this file ASCII-only -- cmd.exe mis-parses UTF-8 batch files.
setlocal
set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" set CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe
if not exist "%CSC%" (
  echo csc.exe not found: .NET Framework 4.x is required, built into Windows 10/11.
  exit /b 1
)
"%CSC%" /nologo /target:winexe /optimize+ /out:"%~dp0FridaySysStats.exe" "%~dp0collector.cs"
if errorlevel 1 exit /b 1
echo Built %~dp0FridaySysStats.exe
