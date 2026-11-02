@echo off
setlocal
rem ============================================================
rem  XueYa PinTu (local) - start server
rem  Browser opens automatically at: http://127.0.0.1:8787/
rem  NOTE: the URL must include the port :8787
rem  Closing this window stops the server.
rem
rem  Run init-db.bat first if the database is not initialized.
rem  MySQL password is read from server\db.local.txt if present
rem  (that file is NOT included in the source zip).
rem ============================================================

set "MYSQL_HOST=127.0.0.1"
set "MYSQL_PORT=3306"
set "MYSQL_USER=root"
set "MYSQL_PASSWORD="
if exist "%~dp0server\db.local.txt" set /p MYSQL_PASSWORD=<"%~dp0server\db.local.txt"
set "MYSQL_DATABASE=score_db"
set "PORT=8787"

rem Check Node.js (must be installed on the system and in PATH)
where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   [ERROR] Node.js is not installed on this computer.
  echo.
  echo   Please install Node.js 18 or later ^(the LTS version is fine^):
  echo       https://nodejs.org/zh-cn/download
  echo   Download the Windows Installer ^(.msi^), keep the default
  echo   options ^(make sure "Add to PATH" is ticked^), finish the
  echo   installation, then double-click start.bat again.
  echo.
  start "" "https://nodejs.org/zh-cn/download/"
  pause
  exit /b 1
)

echo.
echo   ============================================
echo     XueYa PinTu - local server
echo     URL : http://127.0.0.1:%PORT%/   ^(must include port :8787^)
echo     Close this window to stop the server.
echo   ============================================
echo.

rem Launch browser once the port is really up (wait up to 30s, non-blocking)
start "" /min powershell -NoProfile -WindowStyle Hidden -Command "for($i=0;$i -lt 60;$i++){try{($c=New-Object Net.Sockets.TcpClient).Connect('127.0.0.1',%PORT%);$c.Close();Start-Process('http://127.0.0.1:%PORT%/');exit}catch{Start-Sleep -Milliseconds 500}};Start-Process('http://127.0.0.1:%PORT%/')"

cd /d "%~dp0server"
node index.js
echo.
echo Server exited. If the error above is EADDRINUSE (port already in use),
echo the server is already running in another window - just open
echo http://127.0.0.1:%PORT%/ in your browser.
pause
