@echo off
REM Course Module Copy Script (Windows)
REM Usage: copy-course-module.bat "C:\path\to\teneo-production"

if "%~1"=="" (
  echo Usage: copy-course-module.bat "C:\path\to\target-project"
  echo.
  echo Example:
  echo   copy-course-module.bat "E:\TE-Code\teneo-production"
  exit /b 1
)

set TARGET_PATH=%~1

if not exist "%TARGET_PATH%" (
  echo Error: Target path does not exist: %TARGET_PATH%
  exit /b 1
)

echo ========================================
echo   Course Module Copy Script
echo ========================================
echo.
echo Target: %TARGET_PATH%
echo.

REM Create course-module directory
echo [1/7] Creating course-module directory...
mkdir "%TARGET_PATH%\course-module" 2>nul

REM Copy frontend files
echo [2/7] Copying frontend files...
mkdir "%TARGET_PATH%\course-module\frontend\css" 2>nul
mkdir "%TARGET_PATH%\course-module\frontend\js" 2>nul

xcopy /Y "marketplace\frontend\course-player.html" "%TARGET_PATH%\course-module\frontend\" >nul
xcopy /Y "marketplace\frontend\admin-course-builder.html" "%TARGET_PATH%\course-module\frontend\" >nul
xcopy /Y "marketplace\frontend\css\course-player.css" "%TARGET_PATH%\course-module\frontend\css\" >nul
xcopy /Y "marketplace\frontend\js\course-player.js" "%TARGET_PATH%\course-module\frontend\js\" >nul
xcopy /Y "marketplace\frontend\js\video-controls.js" "%TARGET_PATH%\course-module\frontend\js\" >nul
xcopy /Y "marketplace\frontend\js\course-progress.js" "%TARGET_PATH%\course-module\frontend\js\" >nul

echo    - Frontend files copied

REM Create backend structure
echo [3/7] Creating backend structure...
mkdir "%TARGET_PATH%\course-module\backend\routes" 2>nul
mkdir "%TARGET_PATH%\course-module\backend\services" 2>nul
mkdir "%TARGET_PATH%\course-module\backend\database" 2>nul

echo    - Backend structure created

REM Copy config
echo [4/7] Copying configuration...
mkdir "%TARGET_PATH%\course-module\config" 2>nul
xcopy /Y "course-module\config\course-config.js" "%TARGET_PATH%\course-module\config\" >nul

echo    - Configuration copied

REM Copy documentation
echo [5/7] Copying documentation...
xcopy /Y "course-module\README.md" "%TARGET_PATH%\course-module\" >nul
xcopy /Y "COURSE_MODULE_MIGRATION_GUIDE.md" "%TARGET_PATH%\" >nul
xcopy /Y "COURSE_PLATFORM_DESIGN.md" "%TARGET_PATH%\" >nul

echo    - Documentation copied

REM Create .env.example
echo [6/7] Creating .env.example...
(
echo # Course Module Configuration
echo.
echo # API
echo COURSE_API_BASE_URL=/api
echo SITE_URL=http://localhost:3001
echo.
echo # Video Hosting
echo VIDEO_PROVIDER=self
echo BUNNY_STREAM_API_KEY=
echo.
echo # Features
echo ENABLE_DRIP_CONTENT=true
echo ENABLE_CERTIFICATES=true
echo ENABLE_DISCUSSIONS=true
echo.
echo # Database
echo DB_TYPE=sqlite
echo COURSE_DB_PATH=./courses.db
) > "%TARGET_PATH%\course-module\.env.example"

echo    - .env.example created

REM Create quick start guide
echo [7/7] Creating quick start guide...
(
echo # Quick Start - Course Module
echo.
echo ## 1. Install Dependencies
echo ```bash
echo npm install multer better-sqlite3
echo ```
echo.
echo ## 2. Mount in Server
echo See COURSE_MODULE_MIGRATION_GUIDE.md
echo.
echo ## 3. Test
echo ```
echo http://localhost:3001/courses/course-player.html
echo ```
) > "%TARGET_PATH%\course-module\QUICK_START.md"

echo    - Quick start guide created

echo.
echo ========================================
echo   Course Module Copied Successfully!
echo ========================================
echo.
echo Files copied to: %TARGET_PATH%\course-module\
echo.
echo Next steps:
echo   1. cd "%TARGET_PATH%"
echo   2. Read course-module\QUICK_START.md
echo   3. Configure .env
echo   4. Integrate with your server
echo.
echo Happy course building!
