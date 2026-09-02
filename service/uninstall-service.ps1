# Remove the PriorityMCP Windows service.
#
# MUST RUN AS ADMINISTRATOR.
#
# ASCII ONLY. Windows PowerShell 5.1 reads a .ps1 without a BOM as ANSI.

$ErrorActionPreference = "Stop"

$isAdmin = (New-Object Security.Principal.WindowsPrincipal(
  [Security.Principal.WindowsIdentity]::GetCurrent())
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
  Write-Host "This must run as Administrator." -ForegroundColor Red
  exit 1
}

$exe = Join-Path $PSScriptRoot "priority-mcp.exe"

if (-not (Get-Service -Name "PriorityMCP" -ErrorAction SilentlyContinue)) {
  Write-Host "PriorityMCP is not installed."
  exit 0
}

Write-Host "Stopping..." -ForegroundColor Cyan
& $exe stop 2>&1 | Out-Null
Start-Sleep -Seconds 3

Write-Host "Removing..." -ForegroundColor Cyan
& $exe uninstall

Start-Sleep -Seconds 2
if (Get-Service -Name "PriorityMCP" -ErrorAction SilentlyContinue) {
  Write-Host "Still registered. Windows sometimes defers removal until every"    -ForegroundColor Yellow
  Write-Host "services.msc window is closed. Close it and check again."
} else {
  Write-Host "Removed. Logs were left in service\logs\." -ForegroundColor Green
}
