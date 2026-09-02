# Install PriorityMCP as a Windows service.
#
# MUST RUN AS ADMINISTRATOR. Registering a service is a machine-wide change and
# Windows does not allow it otherwise.
#
# ASCII ONLY. Windows PowerShell 5.1 reads a .ps1 without a BOM as ANSI, so a
# non-ASCII character here becomes a parse error rather than a typo.

$ErrorActionPreference = "Stop"

$isAdmin = (New-Object Security.Principal.WindowsPrincipal(
  [Security.Principal.WindowsIdentity]::GetCurrent())
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
  Write-Host "This must run as Administrator." -ForegroundColor Red
  Write-Host "Right-click PowerShell -> Run as administrator, then run this again."
  exit 1
}

$here = $PSScriptRoot
$exe  = Join-Path $here "priority-mcp.exe"
$xml  = Join-Path $here "priority-mcp.xml"
$root = Split-Path $here -Parent

foreach ($f in @($exe, $xml)) {
  if (-not (Test-Path $f)) { Write-Host "Missing $f" -ForegroundColor Red; exit 1 }
}

# Refuse early rather than installing a service that cannot possibly work. A
# service failing at boot is far harder to diagnose than a script saying no now.
$envFile = Join-Path $root ".env"
if (-not (Test-Path $envFile)) {
  Write-Host "No .env at $envFile - the server would exit immediately." -ForegroundColor Red
  exit 1
}

$existing = Get-Service -Name "PriorityMCP" -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "PriorityMCP is already installed. Stopping and removing it first..." -ForegroundColor Yellow
  & $exe stop    2>&1 | Out-Null
  & $exe uninstall 2>&1 | Out-Null
  Start-Sleep -Seconds 3
}

# A port already in use means something else is serving - installing over it
# would produce a service that fails to bind and looks broken for no clear reason.
$busy = Get-NetTCPConnection -LocalPort 3401 -State Listen -ErrorAction SilentlyContinue
if ($busy) {
  Write-Host "Port 3401 is already in use by PID $($busy[0].OwningProcess)." -ForegroundColor Yellow
  Write-Host "Stop that process first, or the service will fail to start."
  exit 1
}

Write-Host "Installing..." -ForegroundColor Cyan
& $exe install
if ($LASTEXITCODE -ne 0) { Write-Host "install failed ($LASTEXITCODE)" -ForegroundColor Red; exit 1 }

Write-Host "Starting..." -ForegroundColor Cyan
& $exe start
Start-Sleep -Seconds 8

$svc = Get-Service -Name "PriorityMCP"
Write-Host ""
Write-Host "Service status: $($svc.Status)  (startup: $((Get-CimInstance Win32_Service -Filter "Name='PriorityMCP'").StartMode))"

$listening = Get-NetTCPConnection -LocalPort 3401 -State Listen -ErrorAction SilentlyContinue
if ($listening) {
  Write-Host "Listening on port 3401." -ForegroundColor Green
} else {
  Write-Host "NOT listening yet. Check the log:" -ForegroundColor Yellow
  Write-Host "  $root\service\logs\PriorityMCP.err.log"
}

Write-Host ""
Write-Host "Manage it with:" -ForegroundColor Cyan
Write-Host "  Get-Service PriorityMCP"
Write-Host "  Restart-Service PriorityMCP"
Write-Host "  Stop-Service PriorityMCP"
Write-Host "  services.msc            (it appears as 'Priority MCP Server')"
Write-Host ""
Write-Host "Logs: $root\service\logs\"
Write-Host "Uninstall: run uninstall-service.ps1 as Administrator."
