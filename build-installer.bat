@echo off
echo ========================================
echo Meeting Transcriber - Build Installer
echo ========================================
echo.

:: Check if Node.js is installed
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Node.js is not installed!
    echo Please install Node.js from https://nodejs.org/
    pause
    exit /b 1
)

:: Check if npm dependencies are installed
if not exist "node_modules\" (
    echo Installing Node.js dependencies...
    call npm install
    if %ERRORLEVEL% NEQ 0 (
        echo ERROR: Failed to install dependencies
        pause
        exit /b 1
    )
    echo.
)

:: Check if icon exists
if not exist "build\icon.ico" (
    echo ========================================
    echo WARNING: Application icon not found!
    echo ========================================
    echo.
    echo You need to create: build\icon.ico
    echo.
    echo The build will fail without this file.
    echo See build\ICON_NEEDED.txt for instructions.
    echo.
    pause
    exit /b 1
)

:: Check if build resources exist
if not exist "build\resources\python\python.exe" (
    echo Build resources not found. Running prebuild step...
    echo This will download Python and ffmpeg (may take 5-15 minutes)
    echo.
    call npm run prebuild
    if %ERRORLEVEL% NEQ 0 (
        echo ERROR: Prebuild failed
        pause
        exit /b 1
    )
    echo.
)

echo ========================================
echo Starting installer build...
echo ========================================
echo.

call npm run build

if %ERRORLEVEL% EQU 0 (
    echo.
    echo ========================================
    echo Build completed successfully!
    echo ========================================
    echo.
    echo Installer location: dist\Meeting Transcriber Setup 1.0.0.exe
    echo.
    echo You can now distribute this installer to users.
    echo.
) else (
    echo.
    echo ========================================
    echo Build failed!
    echo ========================================
    echo.
    echo Check the error messages above.
    echo.
)

pause
