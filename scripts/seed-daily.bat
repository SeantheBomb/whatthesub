@echo off
:: Daily puzzle seeder for WhatTheSub
:: Run via Windows Task Scheduler at 12:05 AM

set PROJECT=C:\Users\SeanF\Documents\DailyPuzzle
set WRANGLER_DIR=%PROJECT%\workers\api

:: Get today's date as YYYY-MM-DD
for /f "tokens=1-3 delims=-" %%a in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do (
  set TODAY=%%a-%%b-%%c
)
echo [%time%] Seeding puzzles for %TODAY%

:: ── WhatTheSub puzzle ────────────────────────────────────────────────────────
echo [%time%] Generating WhatTheSub puzzle...
cd /d %PROJECT%
node scripts\generate-puzzle.mjs --json-only %TODAY% > puzzle-today.json 2>> scripts\seed.log
if errorlevel 1 (
  echo [%time%] ERROR: generate-puzzle.mjs failed >> scripts\seed.log
  goto :done
)

echo [%time%] Writing WhatTheSub puzzle to KV...
cd /d %WRANGLER_DIR%
npx wrangler kv key put --binding=PUZZLES --remote --ttl=90000 "puzzle:%TODAY%" --path="%PROJECT%\puzzle-today.json" >> "%PROJECT%\scripts\seed.log" 2>&1
if errorlevel 1 (
  echo [%time%] ERROR: wrangler KV write failed for puzzle >> "%PROJECT%\scripts\seed.log"
  goto :done
)
echo [%time%] WhatTheSub puzzle OK >> "%PROJECT%\scripts\seed.log"

:: ── Find the Thread puzzle ────────────────────────────────────────────────────
echo [%time%] Generating Find the Thread puzzle...
cd /d %PROJECT%
node scripts\generate-thread.mjs --json-only %TODAY% > thread-today.json 2>> scripts\seed.log
if errorlevel 1 (
  echo [%time%] ERROR: generate-thread.mjs failed >> scripts\seed.log
  goto :done
)

echo [%time%] Writing Find the Thread puzzle to KV...
cd /d %WRANGLER_DIR%
npx wrangler kv key put --binding=PUZZLES --remote --ttl=90000 "thread:%TODAY%" --path="%PROJECT%\thread-today.json" >> "%PROJECT%\scripts\seed.log" 2>&1
if errorlevel 1 (
  echo [%time%] ERROR: wrangler KV write failed for thread >> "%PROJECT%\scripts\seed.log"
  goto :done
)
echo [%time%] Find the Thread puzzle OK >> "%PROJECT%\scripts\seed.log"

:done
echo [%time%] Done. >> "%PROJECT%\scripts\seed.log"
echo [%time%] Done.
