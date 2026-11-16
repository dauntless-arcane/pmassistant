@echo off
setlocal
cd /d "%~dp0"
REM Builds the client and zips the project WITHOUT secrets, node_modules, .git or logs.
call npm install --prefix client || exit /b 1
call npm run build --prefix client || exit /b 1
set STAGE=%TEMP%\pm-assistant-pkg
if exist "%STAGE%" rmdir /s /q "%STAGE%"
robocopy . "%STAGE%\pm-assistant" /E /XD node_modules .git .claude logs /XF .env *.zip >nul
if exist pm-assistant.zip del pm-assistant.zip
powershell -NoProfile -Command "Compress-Archive -Path '%STAGE%\pm-assistant' -DestinationPath pm-assistant.zip"
rmdir /s /q "%STAGE%"
echo Created pm-assistant.zip ^(no .env included^)
