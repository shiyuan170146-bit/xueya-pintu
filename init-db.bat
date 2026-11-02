@echo off
setlocal
rem ============================================================
rem  XueYa PinTu (local) - initialize database
rem  Runs server\sql\score_db_mysql.sql:
rem    drop + recreate score_db (9 tables, 3 views, 2 triggers,
rem    3 functions, 10 procedures, demo data)
rem  WARNING: existing data in score_db will be DELETED.
rem  MySQL password is read from server\db.local.txt if present.
rem ============================================================

set "MYSQL_HOST=127.0.0.1"
set "MYSQL_PORT=3306"
set "MYSQL_USER=root"
set "MYSQL_PASSWORD="
if exist "%~dp0server\db.local.txt" set /p MYSQL_PASSWORD=<"%~dp0server\db.local.txt"

rem Check Node.js (must be installed on the system and in PATH)
where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   [ERROR] Node.js is not installed on this computer.
  echo   Please install Node.js 18 or later first:
  echo       https://nodejs.org/zh-cn/download
  echo.
  pause
  exit /b 1
)

cd /d "%~dp0server"
if not exist node_modules (
  echo Installing backend dependencies...
  call npm install --no-audit --no-fund
)
node bootstrap.js
pause
