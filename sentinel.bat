@echo off
:: ==============================================================================
::  SENTINEL GUJARAT -- One-Click Docker Launcher  (Windows CMD / PowerShell)
::
::  Usage:
::    sentinel.bat              -> interactive menu
::    sentinel.bat start        -> start all services (detached)
::    sentinel.bat stop         -> stop all services
::    sentinel.bat restart      -> restart all services
::    sentinel.bat build        -> rebuild images then start
::    sentinel.bat logs         -> follow logs for all services
::    sentinel.bat logs backend -> follow logs for one service
::    sentinel.bat status       -> show running containers
::    sentinel.bat clean        -> stop + delete volumes (WIPES DB!)
::    sentinel.bat open         -> open app in browser
:: ==============================================================================
setlocal enabledelayedexpansion

:: Resolve the project root from this script's location
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "COMPOSE=%ROOT%\docker-compose.yml"
set "ENVFILE=%ROOT%\.env"

:: ---------------------------------------------------------------------------
:: Check prerequisites
:: ---------------------------------------------------------------------------
docker info >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERROR] Docker Desktop is not running or not installed.
    echo         Please start Docker Desktop and try again.
    echo.
    pause
    exit /b 1
)

docker compose version >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERROR] "docker compose" plugin not found.
    echo         Please update Docker Desktop.
    pause
    exit /b 1
)

if not exist "%ENVFILE%" (
    echo [WARN]  .env not found -- copying from .env.example ...
    if exist "%ROOT%\.env.example" (
        copy "%ROOT%\.env.example" "%ENVFILE%" >nul
        echo [OK]    .env created. Edit SANDBOX_HOST before starting.
    ) else (
        echo [ERROR] Neither .env nor .env.example found in: %ROOT%
        pause
        exit /b 1
    )
)

:: ---------------------------------------------------------------------------
:: Route command-line argument (if any)
:: ---------------------------------------------------------------------------
if not "%~1"=="" (
    set "CMD=%~1"
    set "SVC=%~2"
    goto DISPATCH
)

:: ---------------------------------------------------------------------------
:: Interactive menu
:: ---------------------------------------------------------------------------
:MENU
cls
echo.
echo  ============================================================
echo     SENTINEL GUJARAT -- Docker Control Panel
echo  ============================================================
echo.
echo   [1]  Start all services
echo   [2]  Stop all services
echo   [3]  Restart all services
echo   [4]  Rebuild + Start  ^<-- use this the FIRST TIME
echo   [5]  View logs  (all services)
echo   [6]  View logs  (backend only)
echo   [7]  View logs  (frontend only)
echo   [8]  View logs  (worker only)
echo   [9]  Show container status
echo   [O]  Open app in browser   (http://localhost:5173)
echo   [C]  Clean -- stop + wipe volumes  *** DELETES DATABASE ***
echo   [Q]  Quit
echo.
echo  Root: %ROOT%
echo.
set "CHOICE="
set /p "CHOICE=Enter choice: "

if /i "%CHOICE%"=="1" set "CMD=start"   & goto DISPATCH
if /i "%CHOICE%"=="2" set "CMD=stop"    & goto DISPATCH
if /i "%CHOICE%"=="3" set "CMD=restart" & goto DISPATCH
if /i "%CHOICE%"=="4" set "CMD=build"   & goto DISPATCH
if /i "%CHOICE%"=="5" set "CMD=logs"    & set "SVC="        & goto DISPATCH
if /i "%CHOICE%"=="6" set "CMD=logs"    & set "SVC=backend"  & goto DISPATCH
if /i "%CHOICE%"=="7" set "CMD=logs"    & set "SVC=frontend" & goto DISPATCH
if /i "%CHOICE%"=="8" set "CMD=logs"    & set "SVC=worker"   & goto DISPATCH
if /i "%CHOICE%"=="9" set "CMD=status"  & goto DISPATCH
if /i "%CHOICE%"=="o" set "CMD=open"    & goto DISPATCH
if /i "%CHOICE%"=="c" set "CMD=clean"   & goto DISPATCH
if /i "%CHOICE%"=="q" goto :EOF

echo Invalid choice. Press any key ...
pause >nul
goto MENU

:: ---------------------------------------------------------------------------
:DISPATCH
if /i "%CMD%"=="start"   goto DO_START
if /i "%CMD%"=="stop"    goto DO_STOP
if /i "%CMD%"=="restart" goto DO_RESTART
if /i "%CMD%"=="build"   goto DO_BUILD
if /i "%CMD%"=="logs"    goto DO_LOGS
if /i "%CMD%"=="status"  goto DO_STATUS
if /i "%CMD%"=="clean"   goto DO_CLEAN
if /i "%CMD%"=="open"    goto DO_OPEN

echo [ERROR] Unknown command: %CMD%
echo Usage: sentinel.bat [start^|stop^|restart^|build^|logs^|status^|clean^|open]
exit /b 1

:: ---------------------------------------------------------------------------
:DO_START
echo.
echo [sentinel] Starting all services ...
echo.
docker compose --project-directory "%ROOT%" -f "%COMPOSE%" up -d
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Failed to start. Check the output above.
    goto BACK
)
echo.
echo [OK] All services are running!
echo.
echo   Frontend  --  http://localhost:5173
echo   Backend   --  http://localhost:8000
echo   API Docs  --  http://localhost:8000/docs
echo   Health    --  http://localhost:8000/health
echo   Database  --  localhost:5432  (postgres / sentinel_db)
echo   Redis     --  localhost:6379
echo.
goto BACK

:: ---------------------------------------------------------------------------
:DO_STOP
echo.
echo [sentinel] Stopping all services ...
echo.
docker compose --project-directory "%ROOT%" -f "%COMPOSE%" down
echo.
echo [OK] All services stopped.
echo.
goto BACK

:: ---------------------------------------------------------------------------
:DO_RESTART
echo.
echo [sentinel] Restarting all services ...
echo.
docker compose --project-directory "%ROOT%" -f "%COMPOSE%" restart
echo.
echo [OK] Restart complete.
echo.
goto BACK

:: ---------------------------------------------------------------------------
:DO_BUILD
echo.
echo [sentinel] Rebuilding images and starting services ...
echo.
docker compose --project-directory "%ROOT%" -f "%COMPOSE%" up -d --build
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Build failed. Check the output above.
    goto BACK
)
echo.
echo [OK] Build complete. All services are up!
echo.
echo   Frontend  --  http://localhost:5173
echo   Backend   --  http://localhost:8000/docs
echo.
goto BACK

:: ---------------------------------------------------------------------------
:DO_LOGS
echo.
if "%SVC%"=="" (
    echo [sentinel] Streaming ALL logs -- press Ctrl+C to exit ...
    echo.
    docker compose --project-directory "%ROOT%" -f "%COMPOSE%" logs -f --tail=100
) else (
    echo [sentinel] Streaming logs for: %SVC% -- press Ctrl+C to exit ...
    echo.
    docker compose --project-directory "%ROOT%" -f "%COMPOSE%" logs -f --tail=100 %SVC%
)
goto BACK

:: ---------------------------------------------------------------------------
:DO_STATUS
echo.
echo [sentinel] Container status:
echo.
docker compose --project-directory "%ROOT%" -f "%COMPOSE%" ps
echo.
goto BACK

:: ---------------------------------------------------------------------------
:DO_CLEAN
echo.
echo  ============================================================
echo   WARNING: This will DELETE all containers AND volumes.
echo   Your PostgreSQL data will be permanently lost!
echo  ============================================================
echo.
set "CONFIRM="
set /p "CONFIRM=Type YES to confirm: "
if /i "%CONFIRM%" neq "YES" (
    echo [sentinel] Cancelled. Nothing was deleted.
    goto BACK
)
echo.
echo [sentinel] Wiping containers and volumes ...
echo.
docker compose --project-directory "%ROOT%" -f "%COMPOSE%" down -v --remove-orphans
echo.
echo [OK] Clean complete. All data removed.
echo.
goto BACK

:: ---------------------------------------------------------------------------
:DO_OPEN
start "" "http://localhost:5173"
echo [OK] Opened http://localhost:5173
echo.
goto BACK

:: ---------------------------------------------------------------------------
:BACK
:: If called with an argument, just pause and exit.
:: If interactive, return to the menu.
if not "%~1"=="" (
    pause
    exit /b 0
)
echo Press any key to return to the menu ...
pause >nul
goto MENU

:EOF
endlocal
exit /b 0
