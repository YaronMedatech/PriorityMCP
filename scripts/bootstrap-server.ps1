# Bring a fresh Windows machine up as the PriorityMCP server.
#
# Run from the REPOSITORY ROOT in an ELEVATED PowerShell:
#   powershell -ExecutionPolicy Bypass -File scripts\bootstrap-server.ps1
#
# What it does, stopping at the first real failure:
#   1. checks Administrator, the repo root, Node 20+, node_modules and .env
#   2. regenerates the TLS certificate FOR THIS MACHINE -- a copied certificate
#      names whichever machine made it, so host verification fails on this one
#   3. writes the new PFX passphrase and a NEW MCP_AUTH_TOKEN into .env
#      (a token shared between two servers means one leak exposes both)
#   4. points service\priority-mcp.xml at the node.exe actually installed here
#   5. typecheck, the offline suites, then a live probe of Priority
#   6. installs the Windows service and opens inbound 3401 on Domain+Private
#   7. writes client-kit\ and verifies /health on the loopback
#
# Safe to re-run: the old certificate is moved aside rather than deleted, and
# install-service.ps1 removes an existing service before reinstalling.
#
# ASCII ONLY. Windows PowerShell 5.1 reads a .ps1 without a BOM as ANSI, so a
# non-ASCII character here becomes a parse error rather than a typo.

param(
  [int]    $Port = 3401,
  [switch] $SkipTests,
  [switch] $SkipService,
  # Reissue the TLS certificate even when the existing one already names this
  # machine. Every client that trusted the old CA has to install the new one.
  [switch] $ForceCert,
  # Rotate MCP_AUTH_TOKEN even though it was already rotated here. Invalidates
  # the token in every client kit already handed out.
  [switch] $RotateToken
)

$ErrorActionPreference = "Stop"

$script:step = 0
function Step([string] $title) {
  $script:step++
  Write-Host ""
  Write-Host ("=== {0}. {1}" -f $script:step, $title) -ForegroundColor Cyan
}
function Ok  ([string] $m) { Write-Host "    ok    $m" -ForegroundColor Green }
function Info([string] $m) { Write-Host "    ..    $m" }
function Warn([string] $m) { Write-Host "    warn  $m" -ForegroundColor Yellow }
function Die ([string] $m) { Write-Host "    FAIL  $m" -ForegroundColor Red; exit 1 }

# Replace or append one KEY=value line, preserving the rest of the file byte for
# byte. Written without a BOM: dotenv reads UTF-8, and a BOM ends up inside the
# first key's name.
function Set-EnvLine([string] $path, [string] $key, [string] $value) {
  $text = [IO.File]::ReadAllText($path)
  $pattern = '(?m)^' + [regex]::Escape($key) + '=.*$'
  # '$' is a substitution marker for Regex.Replace, so it has to be doubled.
  $safe = $value.Replace('$', '$$')
  if ([regex]::IsMatch($text, $pattern)) {
    $text = [regex]::Replace($text, $pattern, $key + '=' + $safe)
  } else {
    if ($text.Length -gt 0 -and $text[-1] -ne "`n") { $text += "`r`n" }
    $text += $key + '=' + $value + "`r`n"
  }
  [IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding($false)))
}

# Run an external program and return both of its streams as one string, without
# letting stderr abort this one.
#
# Windows PowerShell 5.1 wraps every stderr line of a NATIVE command in a
# NativeCommandError record when the stream is redirected with 2>&1, and sets $?
# to false even when the program exited 0. Under $ErrorActionPreference = 'Stop'
# that is a TERMINATING error, so a script that only wanted to read the output
# dies on a program that is logging normally. Every run of this server is that
# case: it writes each diagnostic to stderr on purpose, because stdout is the
# JSON-RPC channel and one stray line there corrupts the protocol. Measured: the
# dictionary check aborted the script on its own success message.
#
# `2> file` does NOT avoid it either -- measured, twice: the wrapping happens on
# ANY redirection that goes through PowerShell's own streams, and the second
# attempt failed on this very line. Start-Process is the way out, because its
# -Redirect* parameters are handled by the OS and PowerShell never sees either
# stream. The exit code comes from the process object rather than $LASTEXITCODE,
# which Start-Process does not set.
function Invoke-Native {
  param(
    [Parameter(Mandatory)][string]   $Exe,
    [Parameter(Mandatory)][string[]] $Arguments
  )
  $id = [guid]::NewGuid().ToString('N').Substring(0, 8)
  $outFile = Join-Path $env:TEMP "priority-native-$id.out"
  $errFile = Join-Path $env:TEMP "priority-native-$id.err"
  # Start-Process joins the list with spaces, so an argument that CONTAINS one
  # has to carry its own quotes or it arrives as two.
  $quoted = @($Arguments | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } })
  try {
    $proc = Start-Process -FilePath $Exe -ArgumentList $quoted -WorkingDirectory $root `
      -NoNewWindow -Wait -PassThru -RedirectStandardOutput $outFile -RedirectStandardError $errFile
    $script:lastNativeExit = $proc.ExitCode
    $out = ""
    $err = ""
    # ReadAllText decodes UTF-8, which is what node writes. Get-Content -Raw
    # would decode as the ANSI codepage in 5.1 and mangle any Hebrew.
    if (Test-Path $outFile) { $out = [IO.File]::ReadAllText($outFile) }
    if (Test-Path $errFile) { $err = [IO.File]::ReadAllText($errFile) }
    return ($out + $err)
  } finally {
    foreach ($f in @($outFile, $errFile)) {
      if (Test-Path $f) { Remove-Item $f -Force -ErrorAction SilentlyContinue }
    }
  }
}

function Get-EnvValue([string] $path, [string] $key) {
  $line = Get-Content $path | Where-Object { $_ -match ('^' + [regex]::Escape($key) + '=') } | Select-Object -First 1
  if (-not $line) { return "" }
  return ($line -split '=', 2)[1].Trim()
}

function New-Secret {
  $b = New-Object byte[] 32
  $rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
  $rng.GetBytes($b)
  $rng.Dispose()
  return [Convert]::ToBase64String($b)
}

# ---------------------------------------------------------------------------
Step "Preflight"

$isAdmin = (New-Object Security.Principal.WindowsPrincipal(
  [Security.Principal.WindowsIdentity]::GetCurrent())
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Die "not Administrator. Registering a service and adding a firewall rule are machine-wide changes. Right-click PowerShell -> Run as administrator, then run this again."
}
Ok "running as Administrator"

$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
if (-not (Test-Path (Join-Path $root "package.json"))) { Die "no package.json in $root" }
$pkg = Get-Content (Join-Path $root "package.json") -Raw | ConvertFrom-Json
if ($pkg.name -ne "priority-mcp") { Die "$root is not the priority-mcp repository (package name: $($pkg.name))" }
Ok "repository root: $root"

$envFile = Join-Path $root ".env"
if (-not (Test-Path $envFile)) {
  Die "no .env. Copy .env.example to .env and fill it in -- it carries the Priority PAT, and the server exits immediately without it."
}
Ok ".env present"

# node.exe, by PATH and then by the usual install locations. A winget install in
# THIS session does not refresh the PATH of an already-running shell, so the
# fallbacks are the normal case rather than an edge one.
$node = $null
$viaPath = Get-Command node.exe -ErrorAction SilentlyContinue
if ($viaPath) { $node = $viaPath.Source }
if (-not $node) {
  foreach ($p in @(
      (Join-Path $env:ProgramFiles "nodejs\node.exe"),
      (Join-Path ${env:ProgramFiles(x86)} "nodejs\node.exe"),
      (Join-Path $env:LOCALAPPDATA "Programs\nodejs\node.exe"))) {
    if ($p -and (Test-Path $p)) { $node = $p; break }
  }
}
if (-not $node) {
  Die @"
Node.js is not installed. Install it first, in this same elevated window:

  winget install --id OpenJS.NodeJS.LTS --exact --scope machine --silent --accept-package-agreements --accept-source-agreements

then run this script again. Node 20 or newer is required.
"@
}
$nodeVer = (& $node -v).Trim()
$major = 0
[void][int]::TryParse((($nodeVer.TrimStart('v') -split '\.')[0]), [ref] $major)
if ($major -lt 20) { Die "Node $nodeVer is too old; 20 or newer is required." }
Ok "node $nodeVer at $node"

# Put node.exe on the PATH of THIS process, and so of everything it spawns.
#
# Finding node by absolute path is enough for this script's own calls and is not
# enough for npm: a package's postinstall runs through cmd.exe and calls a bare
# `node`. esbuild's does, and it fails with "'node' is not recognized" -- which
# reads like a broken package rather than a PATH that the MSI updated for the
# MACHINE while this already-running shell kept the old copy. Prepending it here
# costs nothing and removes the need to open a fresh window after installing Node.
$nodeDir = Split-Path $node -Parent
if (($env:PATH -split ';') -notcontains $nodeDir) {
  $env:PATH = $nodeDir + ';' + $env:PATH
  Ok "prepended $nodeDir to PATH for this process"
}

$tsx = Join-Path $root "node_modules\tsx\dist\cli.mjs"
$tsc = Join-Path $root "node_modules\typescript\bin\tsc"
if (-not (Test-Path $tsx)) {
  # There is no build step in this project -- tsx runs the TypeScript directly --
  # so node_modules is not an artefact, it IS the runtime. Install it here rather
  # than copying 8,600 small files over SMB.
  Info "node_modules is missing or incomplete; installing dependencies"
  if (-not (Test-Path (Join-Path $root "package-lock.json"))) {
    Die "no package-lock.json, so 'npm ci' cannot run. Copy node_modules across from a machine that has it."
  }
  # A partial tree left by an interrupted install is worse than none: npm ci
  # clears node_modules itself, but on Windows that removal can fail with EPERM
  # while a scanner or an editor still holds a handle, and npm reports that as a
  # cleanup warning and carries on into a half-built tree. Clear it here, with a
  # couple of retries, so the install starts from nothing.
  if (Test-Path (Join-Path $root "node_modules")) {
    foreach ($attempt in 1..3) {
      try {
        Remove-Item (Join-Path $root "node_modules") -Recurse -Force -ErrorAction Stop
        Info "cleared a partial node_modules"
        break
      } catch {
        if ($attempt -eq 3) {
          Die "could not delete node_modules ($($_.Exception.Message)). Something is holding a handle on it -- close any editor or terminal open in $root, then re-run."
        }
        Start-Sleep -Seconds 2
      }
    }
  }

  $npm = Join-Path $nodeDir "npm.cmd"
  if (-not (Test-Path $npm)) { $npm = "npm" }
  & $npm ci --no-audit --no-fund
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $tsx)) {
    Die @"
'npm ci' failed (exit $LASTEXITCODE). Read npm's own output above -- the cause is
usually one of these, and they need different fixes:

  - "'node' is not recognized"     a postinstall script could not find node on
                                   the PATH. This script prepends it, so if you
                                   still see this, node.exe moved after install.
  - ETIMEDOUT / ENOTFOUND          no route to the npm registry. Set a proxy in
                                   .npmrc, or copy node_modules\ across from a
                                   machine that has it and re-run.
  - EPERM / EBUSY                  a handle is held on node_modules. Close any
                                   editor or terminal open in this folder.

Copying node_modules\ wholesale always works: this script skips the install when
the tree is already complete.
"@
  }
  Ok "dependencies installed"
} else {
  Ok "node_modules present"
}

# programs.ts require()s priority-web-sdk LAZILY, so a missing copy does not stop
# the server -- it fails the first run_program call, whenever that happens, with
# "Cannot find module 'priority-web-sdk'". Measured on a real deploy: the package
# had been vendored by hand and never declared, so `npm ci` installed everything
# else and the program tools were quietly dead until someone tried to run a
# report. It is a declared dependency now, which closes that route in; this
# catches the other one, a node_modules copied from a machine that lacked it.
if (Test-Path (Join-Path $root "node_modules\priority-web-sdk")) {
  Ok "priority-web-sdk present -- the program tools can run"
} else {
  Warn "priority-web-sdk is MISSING. Discovery and the read tools are unaffected, but"
  Warn "run_program / start_program / continue_program will fail at first use. Run 'npm install' here."
}

$hosting = Get-EnvValue $envFile "PRIORITY_HOSTING"
$odataUrl = Get-EnvValue $envFile "PRIORITY_ODATA_URL"
Info "PRIORITY_HOSTING=$hosting"
Info "PRIORITY_ODATA_URL=$odataUrl"

# ---------------------------------------------------------------------------
Step "TLS certificate for this machine"

$pfx = Join-Path $root "certs\mcp-server.pfx"

# Is the certificate already this machine's own?
#
# This matters because the script is meant to be re-run: the probe against a live
# ERP is exactly the step that fails first, on a password or a permission, and
# every retry used to move the certificate aside, mint another, and rotate the
# bearer token again -- invalidating the client kit already handed out and piling
# up superseded- folders. So a certificate that names THIS machine is left alone,
# and -ForceCert is the way to deliberately reissue one.
$certIsOurs = $false
if ((Test-Path $pfx) -and -not $ForceCert) {
  $existingPass = Get-EnvValue $envFile "MCP_TLS_PFX_PASSWORD"
  if ($existingPass) {
    try {
      $secure = ConvertTo-SecureString -String $existingPass -Force -AsPlainText
      $c = New-Object Security.Cryptography.X509Certificates.X509Certificate2($pfx, $secure)
      $san = ($c.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.17' })
      $sanText = if ($san) { $san.Format($false) } else { "" }
      if ($sanText -match [regex]::Escape($env:COMPUTERNAME) -and $c.NotAfter -gt (Get-Date)) {
        $certIsOurs = $true
      }
    } catch {
      # Unreadable with the passphrase in .env, so it is not the one this .env
      # describes. Fall through and reissue.
    }
  }
}

if ($certIsOurs) {
  Ok "certificate already names $env:COMPUTERNAME and is in date -- keeping it (use -ForceCert to reissue)"
} else {
  if (Test-Path $pfx) {
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $old = Join-Path $root "certs\superseded-$stamp"
    New-Item -ItemType Directory -Path $old | Out-Null
    foreach ($f in @("mcp-server.pfx", "mcp-ca.cer", "mcp-ca.pem")) {
      $src = Join-Path $root "certs\$f"
      if (Test-Path $src) { Move-Item $src (Join-Path $old $f) }
    }
    Warn "an existing certificate was moved to certs\superseded-$stamp (it does not name this machine, or is expired)"
  }

  # make-cert.ps1 prints the passphrase it generated; it is the only copy, so the
  # output is captured rather than shown.
  $certOut = Invoke-Native "powershell" @("-ExecutionPolicy", "Bypass", "-File", (Join-Path $root "scripts\make-cert.ps1"))
  if ($script:lastNativeExit -ne 0 -or -not (Test-Path $pfx)) {
    Write-Host $certOut
    Die "make-cert.ps1 did not produce certs\mcp-server.pfx"
  }
  foreach ($line in ($certOut -split "`n")) {
    if ($line -match 'Names in the certificate:' -or $line -match 'CA fingerprint') { Info $line.Trim() }
  }
  $pfxPass = ""
  $m = [regex]::Match($certOut, 'MCP_TLS_PFX_PASSWORD=(\S+)')
  if ($m.Success) { $pfxPass = $m.Groups[1].Value }
  if (-not $pfxPass) { Die "could not read the generated PFX passphrase out of make-cert.ps1's output" }

  Set-EnvLine $envFile "MCP_TLS_PFX"          "certs\mcp-server.pfx"
  Set-EnvLine $envFile "MCP_TLS_PFX_PASSWORD" $pfxPass
  Ok "certificate written; MCP_TLS_PFX and MCP_TLS_PFX_PASSWORD point at it"
}

# ---------------------------------------------------------------------------
Step "Bearer token"

# Rotated ONCE, not on every run. The token this .env arrived with belonged to
# whichever machine it was copied from, and a token shared between two servers
# means one leak exposes both -- but rotating it again on a retry would break the
# client kit already handed out, for no gain.
$existingToken = Get-EnvValue $envFile "MCP_AUTH_TOKEN"
$provisioned = Join-Path $root ".bootstrap-token-provisioned"
if ($RotateToken -or -not (Test-Path $provisioned) -or -not $existingToken) {
  $token = New-Secret
  Set-EnvLine $envFile "MCP_AUTH_TOKEN" $token
  Set-Content -Path $provisioned -Value ("rotated on {0} for {1}" -f (Get-Date -Format "s"), $env:COMPUTERNAME) -Encoding ASCII
  Ok ("MCP_AUTH_TOKEN rotated ({0} chars) -- this server's token is now its own" -f $token.Length)
} else {
  Ok ("MCP_AUTH_TOKEN kept ({0} chars) -- already rotated for this machine (use -RotateToken to change it)" -f $existingToken.Length)
}

# ---------------------------------------------------------------------------
Step "Service definition"

$xml = Join-Path $root "service\priority-mcp.xml"
if (-not (Test-Path $xml)) { Die "missing $xml" }
$xmlText = [IO.File]::ReadAllText($xml)
$declared = ([regex]::Match($xmlText, '<executable>(.*?)</executable>')).Groups[1].Value
if ($declared -ne $node) {
  $xmlText = [regex]::Replace($xmlText, '<executable>.*?</executable>', '<executable>' + $node.Replace('$', '$$') + '</executable>')
  [IO.File]::WriteAllText($xml, $xmlText, (New-Object Text.UTF8Encoding($false)))
  Ok "<executable> repointed: $declared -> $node"
} else {
  Ok "<executable> already correct: $node"
}

$winsw = Join-Path $root "service\priority-mcp.exe"
if (-not (Test-Path $winsw)) {
  Die "missing service\priority-mcp.exe (WinSW). It is excluded from git -- copy it across, or download WinSW-x64.exe and save it under that name."
}
Ok "WinSW present"

# ---------------------------------------------------------------------------
if ($SkipTests) {
  Step "Verification (skipped)"
  Warn "-SkipTests was passed; nothing was verified before installing"
} else {
  Step "Typecheck"
  & $node $tsc --noEmit
  if ($LASTEXITCODE -ne 0) { Die "typecheck failed. Do not install a service over code that does not compile: it retries three times and then stays down." }
  Ok "tsc --noEmit clean"

  Step "Offline test suites"
  # Enumerated rather than taken from package.json's chained 'test' script, so a
  # suite added to tests\ is picked up without editing two places. Live scripts
  # are named live.*.ts and are deliberately not run here.
  $suites = Get-ChildItem (Join-Path $root "tests") -Filter "*.test.ts" | Sort-Object Name
  $failed = @()
  foreach ($s in $suites) {
    & $node $tsx $s.FullName | Out-Null
    if ($LASTEXITCODE -ne 0) { $failed += $s.Name; Write-Host "    FAIL  $($s.Name)" -ForegroundColor Red }
    else { Ok $s.Name }
  }
  if ($failed.Count -gt 0) { Die ("{0} of {1} suites failed: {2}" -f $failed.Count, $suites.Count, ($failed -join ", ")) }
  Ok ("all {0} offline suites passed" -f $suites.Count)

  Step "Live probe of Priority"
  # The probe does two jobs and only the first is a deployment gate: it checks
  # the connection, and then it validates the DOC_TYPES map in salesSchema.ts
  # against this server. It exits non-zero for either. But DOC_TYPES only feeds
  # get_sales, which is hidden unless PRIORITY_ENABLE_GET_SALES=1 -- so a screen
  # this installation does not expose, or a column that differs, would otherwise
  # block the install of a server that works perfectly.
  #
  # Section 1 of its output is the gate. It prints "connected and authenticated"
  # on success, and on failure says so and stops there.
  $probeOut = Invoke-Native $node @($tsx, (Join-Path $root "src\probe.ts"))
  $probeCode = $script:lastNativeExit
  Write-Host $probeOut
  if ($probeOut -notmatch 'connected and authenticated') {
    Die "the probe could not reach Priority or was refused -- see its output above. Fix that before installing the service: every tool here reads live ERP data, so a server that cannot reach Priority fails every call."
  }
  if ($probeCode -ne 0) {
    Warn "connected fine, but the probe reported problems with the sales screens above."
    Warn "Those only affect get_sales, which is hidden on this server (PRIORITY_ENABLE_GET_SALES=0), so the install continues."
  }
  Ok "Priority reachable and the credentials were accepted"

  Step "Dictionary"
  # The real deployment gate -- see scripts\check-dictionary.ts for why this and
  # not the probe. A successful run also warms the on-disk cache.
  $dictOut = Invoke-Native $node @($tsx, (Join-Path $root "scripts\check-dictionary.ts"))
  Write-Host $dictOut
  if ($dictOut -notmatch 'DICTOK') {
    Die @"
the screen dictionary could not be built, so discovery would not work.

EFORM is the only source of a screen's Hebrew title and its parent/child graph.
When it is refused, search_screens, describe_screen, help and readiness_report
all fail -- and a model with no way to look a screen up goes back to inferring
one from its English code, which is exactly the mistake this server exists to
prevent. So this is a gate, not a warning.

A 400 "the API cannot be enabled for this screen" has two causes that look
identical in the response: the screen is not opened for the API at all, or the
API user lacks permission for it. EFORM, EXEC, EREP and EPROG are all
system-maintenance screens, and granting the API user that module is usually
what is missing.
"@
  }
  Ok "dictionary built and cached"
}

# ---------------------------------------------------------------------------
if ($SkipService) {
  Step "Service and firewall (skipped)"
  Warn "-SkipService was passed; run service\install-service.ps1 yourself when ready"
} else {
  Step "Windows service"
  & powershell -ExecutionPolicy Bypass -File (Join-Path $root "service\install-service.ps1")
  if ($LASTEXITCODE -ne 0) { Die "install-service.ps1 failed -- see its output above, and service\logs\priority-mcp.err.log" }

  Step "Firewall"
  # install-service.ps1 does not do this, and without it the listener answers
  # only on this machine: all three profiles default inbound to block.
  $ruleName = "Priority MCP $Port"
  Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort $Port `
    -Action Allow -Profile Domain,Private | Out-Null
  Ok "inbound TCP $Port allowed on the Domain and Private profiles (Public deliberately left closed)"
}

# ---------------------------------------------------------------------------
Step "Health check"

# curl, not Invoke-WebRequest.
#
# Measured: a raw SslStream handshakes with this listener happily -- TLS 1.3,
# AES256 -- and Invoke-WebRequest against the same URL fails with "The
# underlying connection was closed: An unexpected error occurred on a send",
# under forced TLS 1.2 and under SystemDefault alike. The .NET Framework HTTP
# stack behind Invoke-WebRequest does not get along with this Node listener, and
# reporting that as "the server did not answer" is a false alarm on a server that
# is serving. curl ships with Windows 10+ and Server 2019+, and answers
# correctly.
#
# The CA is passed rather than validation bypassed, so this verifies TRUST as
# well as reachability -- which is what a client will actually have to do.
# --ssl-revoke-best-effort is required on Windows and is not a way of skipping
# verification: curl there uses schannel, which insists on a revocation source,
# and a private CA publishes no CRL. The signature and host name are still
# checked.
$caPem = Join-Path $root "certs\mcp-ca.pem"
$curl = (Get-Command curl.exe -ErrorAction SilentlyContinue)
if (-not $curl) {
  Warn "curl.exe not found, so /health was not verified. Check it by hand from a client machine."
} else {
  $health = ""
  foreach ($attempt in 1..6) {
    $health = (Invoke-Native $curl.Source @(
        "--silent", "--show-error", "--max-time", "10",
        "--cacert", $caPem, "--ssl-revoke-best-effort",
        "https://$env:COMPUTERNAME`:$Port/health")).Trim()
    if ($health -match '"ok"\s*:\s*true') { break }
    Start-Sleep -Seconds 3
  }
  if ($health -match '"ok"\s*:\s*true') {
    Ok "GET /health -> $health"
    Ok "the CA in certs\mcp-ca.pem validates this listener, so the client kit is good"
  } else {
    Warn "/health did not answer as expected. curl said: $health"
    Warn "Check service\logs\priority-mcp.err.log -- the server logs the reason it refused to start."
  }
}

# ---------------------------------------------------------------------------
Step "Client kit"

& powershell -ExecutionPolicy Bypass -File (Join-Path $root "scripts\client-kit.ps1") -Port $Port
if ($LASTEXITCODE -ne 0) { Warn "client-kit.ps1 failed; run it by hand once the certificate is in place" }

Write-Host ""
Write-Host "=== Done" -ForegroundColor Green
$addr = (Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
  Select-Object -First 1 -ExpandProperty IPAddress)
Write-Host "  server      https://${addr}:$Port/mcp"
Write-Host "  bearer      MCP_AUTH_TOKEN in .env (rotated just now -- read it from there)"
Write-Host "  client kit  client-kit\  -- hand the folder to each client machine"
Write-Host "  logs        service\logs\"
Write-Host "  deploy      edit src\, run npm run typecheck, then Restart-Service PriorityMCP"

if ($hosting -eq "cloud") {
  Write-Host ""
  Write-Host "NOTE for a CLOUD installation:" -ForegroundColor Yellow
  Write-Host "  client-kit's config templates use X-Priority-User / X-Priority-Pass, and"
  Write-Host "  Priority's cloud REFUSES a username and password for OData (HTTP 401)."
  Write-Host "  Each caller needs their own Personal Access Token instead:"
  Write-Host ""
  Write-Host '      "headers": { "X-Priority-Token": "<the caller PAT>" }'
  Write-Host ""
  Write-Host "  Or Authorization: Bearer <MCP_AUTH_TOKEN> to share this server's identity."
}
