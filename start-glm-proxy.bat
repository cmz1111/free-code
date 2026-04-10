@echo off
setlocal EnableExtensions EnableDelayedExpansion

cd /d "%~dp0"
set "SCRIPT_DIR=%CD%"
set "GLM_ENV_FILE=%SCRIPT_DIR%\.env.glm"

if /I "%~1"=="--inside-wt" (
    shift
)

call :load_local_config

if not defined GLM_API_BASE set "GLM_API_BASE=https://open.bigmodel.cn/api/coding/paas/v4"
if not defined GLM_MODEL set "GLM_MODEL=glm-5.1"
if not defined GLM_PROXY_PORT set "GLM_PROXY_PORT=3827"
if not defined GLM_MAX_TOKENS set "GLM_MAX_TOKENS=131072"
if not defined GLM_TEMPERATURE set "GLM_TEMPERATURE=0.2"

if not defined GLM_API_KEY (
    echo [ERROR] GLM_API_KEY is not set.
    echo [ERROR] Create "%GLM_ENV_FILE%" from ".env.glm.example" or set GLM_API_KEY in your terminal.
    call :maybe_pause
    exit /b 1
)

if /I not "%~1"=="--inside-wt" (
    if not defined WT_SESSION if /I not "%TERM_PROGRAM%"=="vscode" (
        where wt.exe >nul 2>&1
        if not errorlevel 1 (
            echo [INFO] Opening Windows Terminal for better Unicode rendering...
            start "" wt.exe -d "%SCRIPT_DIR%" cmd.exe /k "\"%~f0\" --inside-wt"
            exit /b 0
        )
    )
)

where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js was not found in PATH.
    call :maybe_pause
    exit /b 1
)

set "ANTHROPIC_API_KEY=%GLM_API_KEY%"
set "ANTHROPIC_BASE_URL=http://localhost:%GLM_PROXY_PORT%"

curl -s "http://localhost:%GLM_PROXY_PORT%/health" >nul 2>&1
if %errorlevel% equ 0 (
    echo [INFO] GLM proxy is already running on port %GLM_PROXY_PORT%.
    echo [INFO] Health check: http://localhost:%GLM_PROXY_PORT%/health
    call :maybe_pause
    exit /b 0
)

echo ============================================================
echo   Starting GLM Proxy
echo ============================================================
echo.
echo   Model:      %GLM_MODEL%
echo   GLM API:    %GLM_API_BASE%
echo   Proxy port: %GLM_PROXY_PORT%
echo.
echo   Press Ctrl+C to stop the proxy.
echo.

node glm-proxy.mjs
exit /b %ERRORLEVEL%

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

:maybe_pause
if defined GLM_SCRIPT_NO_PAUSE goto :eof
if not defined WT_SESSION if /I not "%TERM_PROGRAM%"=="vscode" pause
goto :eof
