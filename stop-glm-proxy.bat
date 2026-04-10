@echo off
setlocal EnableExtensions EnableDelayedExpansion

cd /d "%~dp0"
set "SCRIPT_DIR=%CD%"
set "GLM_ENV_FILE=%SCRIPT_DIR%\.env.glm"

call :load_local_config

if not defined GLM_PROXY_PORT set "GLM_PROXY_PORT=3827"

for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":%GLM_PROXY_PORT% .*LISTENING"') do (
    if not defined GLM_PROXY_PID set "GLM_PROXY_PID=%%P"
)

if not defined GLM_PROXY_PID (
    echo [INFO] No listening GLM proxy was found on port %GLM_PROXY_PORT%.
    call :maybe_pause
    exit /b 0
)

echo [INFO] Stopping GLM proxy on port %GLM_PROXY_PORT% ^(PID %GLM_PROXY_PID%^)^...
taskkill /PID %GLM_PROXY_PID% /T /F >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Failed to stop PID %GLM_PROXY_PID%.
    call :maybe_pause
    exit /b 1
)

echo [OK] GLM proxy stopped.
call :maybe_pause
exit /b 0

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
