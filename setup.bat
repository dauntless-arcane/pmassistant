@echo off
setlocal
cd /d "%~dp0"
echo === PM Assistant setup ===

where node >nul 2>nul || (echo Node.js 18+ is required. Install from https://nodejs.org & pause & exit /b 1)

if not exist server\.env (
  copy server\.env.example server\.env >nul
  echo.
  echo Created server\.env. Enter the values ^(Enter keeps the placeholder^):
  set /p ROUTER=ROVO_ROUTER_WEBHOOK_URL: 
  set /p TUNNEL=PUBLIC_CALLBACK_BASE_URL ^(your VS Code forwarded URL^): 
  set /p SECRET=CALLBACK_SHARED_SECRET ^(any random string^): 
  powershell -NoProfile -Command ^
    "$p='server\.env'; $c=Get-Content $p;" ^
    "if($env:ROUTER){$c=$c -replace '^ROVO_ROUTER_WEBHOOK_URL=.*',('ROVO_ROUTER_WEBHOOK_URL='+$env:ROUTER)};" ^
    "if($env:TUNNEL){$c=$c -replace '^PUBLIC_CALLBACK_BASE_URL=.*',('PUBLIC_CALLBACK_BASE_URL='+$env:TUNNEL)};" ^
    "if($env:SECRET){$c=$c -replace '^CALLBACK_SHARED_SECRET=.*',('CALLBACK_SHARED_SECRET='+$env:SECRET)};" ^
    "Set-Content $p $c"
)

echo Installing server dependencies...
call npm install --prefix server --omit=dev || (echo npm install failed & pause & exit /b 1)

if not exist client\dist\index.html (
  echo Building client...
  call npm install --prefix client || (pause & exit /b 1)
  call npm run build --prefix client || (pause & exit /b 1)
)

echo.
echo Setup done. Starting tunnel and server ^(Ctrl+C to stop^)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\run.ps1"
