@echo off
setlocal EnableExtensions

cd /d "%~dp0"
set "SCRIPT_DIR=%CD%"
set "GLM_SCRIPT_NO_PAUSE=1"

call "%SCRIPT_DIR%\stop-glm-proxy.bat"
set "STOP_EXIT_CODE=%ERRORLEVEL%"
if not "%STOP_EXIT_CODE%"=="0" exit /b %STOP_EXIT_CODE%

call "%SCRIPT_DIR%\start-glm-proxy.bat" %*
exit /b %ERRORLEVEL%
