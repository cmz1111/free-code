@echo off
setlocal EnableExtensions EnableDelayedExpansion

cd /d "%~dp0"
set "SCRIPT_DIR=%CD%"
set "GLM_ENV_FILE=%SCRIPT_DIR%\.env.glm"
set "PROJECT_DIR=%SCRIPT_DIR%"
set "PROJECT_DIR_EXPLICIT="
set "FORWARD_ARGS="
set "RELAUNCH_ARGS="
call :parse_args %*

call :load_local_config

if not defined GLM_API_BASE set "GLM_API_BASE=https://open.bigmodel.cn/api/coding/paas/v4"
if not defined GLM_MODEL set "GLM_MODEL=glm-5.1"
if not defined GLM_PROXY_PORT set "GLM_PROXY_PORT=3827"
if not defined GLM_MAX_TOKENS set "GLM_MAX_TOKENS=131072"
if not defined GLM_TEMPERATURE set "GLM_TEMPERATURE=0.2"

if not defined GLM_API_KEY (
    echo [ERROR] GLM_API_KEY is not set.
    echo [ERROR] Create "%GLM_ENV_FILE%" from ".env.glm.example" or set GLM_API_KEY in your terminal.
    exit /b 1
)

if /I not "%~1"=="--inside-wt" (
    if not defined WT_SESSION if /I not "%TERM_PROGRAM%"=="vscode" (
        where wt.exe >nul 2>&1
        if not errorlevel 1 (
            echo [INFO] Opening Windows Terminal for better Unicode rendering...
            start "" wt.exe -d "%PROJECT_DIR%" cmd.exe /k "\"%~f0\" --inside-wt %RELAUNCH_ARGS%"
            exit /b 0
        )
        echo [WARN] Windows Terminal was not found.
        echo [WARN] Run this script from VS Code Terminal or Windows Terminal for the best UI rendering.
    )
)

where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js was not found in PATH.
    exit /b 1
)

where bun >nul 2>&1
if errorlevel 1 (
    echo [ERROR] bun was not found in PATH.
    exit /b 1
)

set "ANTHROPIC_API_KEY=%GLM_API_KEY%"
set "ANTHROPIC_BASE_URL=http://localhost:%GLM_PROXY_PORT%"

echo ============================================================
echo   Starting GLM proxy + free-code
echo ============================================================
echo.
echo   Model:      %GLM_MODEL%
echo   GLM API:    %GLM_API_BASE%
echo   Proxy port: %GLM_PROXY_PORT%
echo   Work dir:   %PROJECT_DIR%
echo.

call :ensure_proxy
if errorlevel 1 exit /b 1

echo [2/2] Starting free-code in the current terminal...
echo.
pushd "%PROJECT_DIR%" >nul
bun run "%SCRIPT_DIR%\src\entrypoints\cli.tsx" --model %GLM_MODEL% %FORWARD_ARGS%
set "EXIT_CODE=%ERRORLEVEL%"
popd >nul

exit /b %EXIT_CODE%

:ensure_proxy
curl -s "http://localhost:%GLM_PROXY_PORT%/health" >nul 2>&1
if %errorlevel% equ 0 (
    echo [1/2] Reusing GLM proxy on port %GLM_PROXY_PORT%.
    goto :eof
)

echo [1/2] Starting GLM proxy in the background...
for /f %%P in ('
    powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = Start-Process -FilePath 'node' -ArgumentList 'glm-proxy.mjs' -WorkingDirectory '%SCRIPT_DIR%' -WindowStyle Hidden -PassThru; $p.Id"
') do set "STARTED_PROXY_PID=%%P"

if not defined STARTED_PROXY_PID (
    echo [ERROR] Failed to start the GLM proxy process.
    exit /b 1
)

set "RETRY=0"
:wait_proxy
timeout /t 1 /nobreak >nul
set /a RETRY+=1
curl -s "http://localhost:%GLM_PROXY_PORT%/health" >nul 2>&1
if %errorlevel% neq 0 (
    if %RETRY% lss 15 goto :wait_proxy
    echo [ERROR] GLM proxy failed to become healthy.
    taskkill /PID %STARTED_PROXY_PID% /T /F >nul 2>&1
    exit /b 1
)

echo [OK] GLM proxy started.
goto :eof

:load_local_config
if not exist "%GLM_ENV_FILE%" goto :eof

for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%GLM_ENV_FILE%") do (
    set "KEY=%%~A"
    set "VALUE=%%~B"
    if /I "!KEY:~0,7!"=="export " set "KEY=!KEY:~7!"
    if defined VALUE if "!VALUE:~0,1!"=="^"" if "!VALUE:~-1!"=="^"" set "VALUE=!VALUE:~1,-1!"
    if defined KEY (
        if not defined !KEY! set "!KEY!=!VALUE!"
    )
)
goto :eof

:parse_args
if "%~1"=="" goto :eof
if /I "%~1"=="--inside-wt" (
    shift
    goto :parse_args
)
if not defined PROJECT_DIR_EXPLICIT if exist "%~1\NUL" (
    set "PROJECT_DIR=%~f1"
    set "PROJECT_DIR_EXPLICIT=%~f1"
    set "RELAUNCH_ARGS=!RELAUNCH_ARGS! \"%~f1\""
    shift
    goto :parse_args
)
set "FORWARD_ARGS=!FORWARD_ARGS! \"%~1\""
set "RELAUNCH_ARGS=!RELAUNCH_ARGS! \"%~1\""
shift
goto :parse_args
