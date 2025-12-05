@echo off
if "%1"=="" (
  echo Usage: review project-path
  exit /b 1
)
pushd %~dp0\..\runner
where npm >nul 2>nul || (echo Please install Node.js and npm & exit /b 1)
if not exist node_modules (
  echo Installing deps...
  npm install
)
node index.js %~1
popd
