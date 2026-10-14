@echo off
rem ---------------------------------------------------------------------------
rem  quantower-mcp — lancement de install.ps1 avec une politique d'exécution
rem  adaptée (PowerShell 5.1, messages en français).
rem
rem  Usage : install.cmd [-DryRun] [-Demo] [-SkipClients] [-SetUrlAcl] [-Port 8765]
rem ---------------------------------------------------------------------------
setlocal

where powershell.exe >nul 2>nul
if errorlevel 1 (
  echo [ERREUR] PowerShell introuvable. Windows 10/11 le fournit normalement : ouvrez une invite de commandes et executez install.ps1 manuellement.
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set EXITCODE=%ERRORLEVEL%
endlocal & exit /b %EXITCODE%
