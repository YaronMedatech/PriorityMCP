# Package everything a new client machine needs into one folder.
#
# The CA has to be installed once per MACHINE, not per LLM -- trust lives in the
# operating system or the Node runtime, not in the model. This script exists to
# make that one step instead of several: hand over the folder, run one command
# inside it, paste one config.
#
# ASCII ONLY. Windows PowerShell 5.1 reads a .ps1 without a BOM as ANSI, so a
# non-ASCII character here is a parse error rather than a typo.

param(
  [string] $OutDir = "client-kit",
  [string] $ServerAddress = "",
  [int]    $Port = 3401
)

$ErrorActionPreference = "Stop"

if (-not $ServerAddress) {
  $ServerAddress = (Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
    Select-Object -First 1 -ExpandProperty IPAddress)
}

$caCer = "certs\mcp-ca.cer"
$caPem = "certs\mcp-ca.pem"
foreach ($f in @($caCer, $caPem)) {
  if (-not (Test-Path $f)) {
    Write-Host "Missing $f. Run scripts\make-cert.ps1 first." -ForegroundColor Red
    exit 1
  }
}

if (Test-Path $OutDir) { Remove-Item -LiteralPath $OutDir -Recurse -Force }
New-Item -ItemType Directory -Path $OutDir | Out-Null

Copy-Item $caCer (Join-Path $OutDir "mcp-ca.cer")
Copy-Item $caPem (Join-Path $OutDir "mcp-ca.pem")

$url = "https://$ServerAddress`:$Port/mcp"

# --- install script for the client machine --------------------------------
$install = @"
# Run this ON THE CLIENT MACHINE, as Administrator.
# It teaches this machine to trust the PriorityMCP server. One time, per machine.

`$cer = Join-Path `$PSScriptRoot 'mcp-ca.cer'
Import-Certificate -FilePath `$cer -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
Write-Host 'CA installed.' -ForegroundColor Green

# Verify before configuring anything: this separates a trust problem from a
# config problem, and the two produce very similar-looking failures.
try {
  `$r = Invoke-WebRequest -Uri 'https://${ServerAddress}:${Port}/health' -TimeoutSec 10 -UseBasicParsing
  Write-Host "Server reachable and trusted: `$(`$r.Content)" -ForegroundColor Green
} catch {
  Write-Host "Could not reach the server: `$(`$_.Exception.Message)" -ForegroundColor Red
  Write-Host 'Check that the server is running and that port ${Port} is open.'
}
"@
Set-Content -Path (Join-Path $OutDir "install-ca.ps1") -Value $install -Encoding ASCII

# --- client configuration templates ---------------------------------------
$claude = @"
{
  "mcpServers": {
    "priority": {
      "type": "http",
      "url": "$url",
      "headers": {
        "X-Priority-User": "YOUR_PRIORITY_USERNAME",
        "X-Priority-Pass": "YOUR_PRIORITY_PASSWORD"
      }
    }
  }
}
"@
Set-Content -Path (Join-Path $OutDir "claude-config.json") -Value $claude -Encoding UTF8

$gemini = @"
{
  "mcpServers": {
    "priority": {
      "httpUrl": "$url",
      "headers": {
        "X-Priority-User": "YOUR_PRIORITY_USERNAME",
        "X-Priority-Pass": "YOUR_PRIORITY_PASSWORD"
      },
      "timeout": 120000,
      "trust": false,
      "excludeTools": ["run_program"]
    }
  }
}
"@
Set-Content -Path (Join-Path $OutDir "gemini-settings.json") -Value $gemini -Encoding UTF8

$readme = @"
PriorityMCP client kit
======================

Server: $url

1. Right-click install-ca.ps1 -> Run with PowerShell (as Administrator).
   This installs the CA and immediately verifies the connection.

   If you cannot use Administrator, set this instead before launching a
   Node-based client (Claude Code, Gemini CLI):

     `$env:NODE_EXTRA_CA_CERTS = "<full path to mcp-ca.pem>"

2. Copy the config for your client and fill in your Priority username and
   password:

     claude-config.json     -> .mcp.json in a project, or Claude Desktop config
     gemini-settings.json   -> ~/.gemini/settings.json

   Those credentials are YOURS. Every query you make runs under your Priority
   user and sees exactly what you are allowed to see.

3. Do NOT disable certificate verification to get past an error. A client that
   skips verification accepts any server claiming this address.

Troubleshooting, in order. Stop at the first that fails:

  a. Is the server up and the port open?

       curl --cacert mcp-ca.pem --ssl-revoke-best-effort https://${ServerAddress}:${Port}/health

     Expect: {"ok":true,"transport":"streamable-http","auth":"bearer"}

     --ssl-revoke-best-effort is required on WINDOWS and is not a way of
     skipping verification. curl on Windows uses schannel, which insists on a
     revocation source; this CA is private and publishes no CRL, so schannel
     reports CERT_TRUST_REVOCATION_STATUS_UNKNOWN and refuses a certificate
     that is in fact valid. The flag relaxes the revocation check ONLY -- the
     signature and the host name are still verified. On Linux and macOS curl
     uses OpenSSL and the flag is neither needed nor accepted.

  b. Trust: if (a) fails with a certificate error, the CA is not installed.
     Re-run install-ca.ps1 as Administrator, or set NODE_EXTRA_CA_CERTS.

     Node-based clients (Claude Code, Gemini CLI) do not need the flag from
     (a): Node uses OpenSSL, which does not require a revocation source.

  c. Client connects but lists no tools -> the credentials are wrong.

Never add -k, --insecure, or NODE_TLS_REJECT_UNAUTHORIZED=0. Those accept any
server claiming this address, which is the one thing the certificate prevents.
"@
Set-Content -Path (Join-Path $OutDir "README.txt") -Value $readme -Encoding UTF8

Write-Host ""
Write-Host "Client kit written to $OutDir\" -ForegroundColor Green
Get-ChildItem $OutDir | ForEach-Object { Write-Host "  $($_.Name)" }
Write-Host ""
Write-Host "Hand this folder to each client machine. Nothing in it is secret:"
Write-Host "the CA is a public certificate, and the config templates have no"
Write-Host "credentials in them."
