# Generate a TLS certificate for the MCP listener.
#
# Uses Windows' own New-SelfSignedCertificate rather than openssl, which is not
# installed here. It needs no administrator rights, because the certificate is
# created in the CurrentUser store.
#
# ASCII ONLY in this file. Windows PowerShell 5.1 reads a .ps1 without a BOM as
# ANSI, so a non-ASCII character here becomes a parse error rather than a typo.
#
# Produces two files in certs\:
#   mcp-server.pfx  the private key + certificate, loaded by the server
#   mcp-server.cer  the PUBLIC certificate only, to install on client machines
#
# The client must trust mcp-server.cer or it will refuse the connection. That
# refusal is the point: a client that skips verification would accept any server
# claiming this address, which removes most of what TLS is for.

param(
  [string[]] $Address = @(),
  [int]      $ValidDays = 825,
  [string]   $OutDir = "certs"
)

$ErrorActionPreference = "Stop"

# Every address a client might use must be in the certificate, or verification
# fails for the ones that are missing.
if ($Address.Count -eq 0) {
  $ips = Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notlike '169.254.*' } |
    Select-Object -ExpandProperty IPAddress
  $Address = @($env:COMPUTERNAME, 'localhost') + $ips | Select-Object -Unique
}

Write-Host "Names in the certificate: $($Address -join ', ')"

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }

$pfxPath = Join-Path $OutDir "mcp-server.pfx"
$cerPath = Join-Path $OutDir "mcp-ca.cer"
$pemPath = Join-Path $OutDir "mcp-ca.pem"

if (Test-Path $pfxPath) {
  Write-Host "`n$pfxPath already exists. Delete it first if you mean to replace it." -ForegroundColor Yellow
  Write-Host "Replacing the certificate requires re-installing the new .cer on every client."
  exit 1
}

# Build the SAN extension by hand, splitting names into DNS and IPAddress
# entries.
#
# -DnsName cannot do this: it records EVERYTHING as a DNS name, including
# addresses. A TLS client connecting to an IP literal checks only the iPAddress
# entries, finds none, and fails with ERR_TLS_CERT_ALTNAME_INVALID reporting an
# empty list -- which is confusing, because the address plainly is in the
# certificate, just under the wrong entry type. Connecting by IP is the normal
# case on a LAN, so this matters here.
$sanParts = @()
foreach ($a in $Address) {
  $parsed = [ipaddress]::TryParse($a, [ref]([ipaddress]::None))
  if ($parsed) { $sanParts += "IPAddress=$a" } else { $sanParts += "DNS=$a" }
}
$sanText = "2.5.29.17={text}" + ($sanParts -join "&")
Write-Host "SAN extension: $($sanParts -join ', ')"

# A small CA that signs the server certificate, rather than one self-signed
# certificate doing both jobs.
#
# The reason is ROTATION, not necessity: reissue the server certificate from the
# same CA and no client has to be touched again, where replacing a bare
# self-signed certificate means re-installing it on every client machine. Two
# certificates cost one extra step here and behave the way every client already
# expects.
#
# An earlier version of this comment claimed a self-signed LEAF cannot be a trust
# anchor at all -- that it carries CA:FALSE, so Node reports
# DEPTH_ZERO_SELF_SIGNED_CERT and there is no way to accept it short of disabling
# verification. That is too strong, and measured 2026-09-04 it is wrong for the
# way this project supplies a certificate: Priority's own self-signed server
# certificate, exported to PEM and passed as Node's `ca:` option through
# PRIORITY_CA_BUNDLE, validates -- and it carries no basicConstraints at all.
# OpenSSL accepts a self-signed certificate found in its trust store as an anchor.
# So the CA below is the better shape, not the only workable one.
$ca = New-SelfSignedCertificate `
  -Subject "CN=priority-mcp local CA" `
  -CertStoreLocation "Cert:\CurrentUser\My" `
  -KeyExportPolicy Exportable `
  -KeyAlgorithm RSA `
  -KeyLength 2048 `
  -NotAfter (Get-Date).AddDays($ValidDays + 365) `
  -KeyUsage CertSign, CRLSign, DigitalSignature `
  -TextExtension @("2.5.29.19={text}CA=true&pathlength=0")

$cert = New-SelfSignedCertificate `
  -Subject "CN=priority-mcp" `
  -Signer $ca `
  -CertStoreLocation "Cert:\CurrentUser\My" `
  -KeyExportPolicy Exportable `
  -KeyAlgorithm RSA `
  -KeyLength 2048 `
  -NotAfter (Get-Date).AddDays($ValidDays) `
  -KeyUsage DigitalSignature, KeyEncipherment `
  -TextExtension @($sanText, "2.5.29.37={text}1.3.6.1.5.5.7.3.1")

# A random passphrase, written to .env rather than chosen by hand: the PFX sits
# next to the server and the passphrase protects it only at rest.
# RNGCryptoServiceProvider rather than RandomNumberGenerator::GetBytes: the
# static helper is .NET Core only, and Windows PowerShell 5.1 runs on .NET
# Framework where it does not exist.
$rngBytes = New-Object byte[] 24
$rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
$rng.GetBytes($rngBytes)
$rng.Dispose()
$pass = [Convert]::ToBase64String($rngBytes)
$secure = ConvertTo-SecureString -String $pass -Force -AsPlainText

# The server PFX carries the leaf plus its key; the CA is what clients trust.
Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $secure -ChainOption BuildChain | Out-Null
Export-Certificate  -Cert $ca -FilePath $cerPath -Type CERT | Out-Null

# Also emit PEM. Export-Certificate writes DER, which Windows imports happily and
# Node's NODE_EXTRA_CA_CERTS does not read.
$b64 = [Convert]::ToBase64String($ca.RawData, 'InsertLineBreaks')
$pem = "-----BEGIN CERTIFICATE-----`r`n$b64`r`n-----END CERTIFICATE-----`r`n"
[System.IO.File]::WriteAllText($pemPath, $pem, (New-Object System.Text.ASCIIEncoding))

# Remove both from the personal store. The server reads the file, and leaving
# copies behind just makes it unclear which one is in use. The CA's private key
# goes with it: nothing here needs to issue another certificate, and a signing key
# left lying around is a liability rather than a convenience.
Remove-Item "Cert:\CurrentUser\My\$($cert.Thumbprint)" -Force
Remove-Item "Cert:\CurrentUser\My\$($ca.Thumbprint)" -Force

Write-Host ""
Write-Host "Wrote $pfxPath (server) plus $cerPath and $pemPath (the CA to trust)" -ForegroundColor Green
Write-Host "CA fingerprint (SHA1): $($ca.Thumbprint)"
Write-Host ""
Write-Host "1. Add these two lines to .env:" -ForegroundColor Cyan
Write-Host "     MCP_TLS_PFX=$pfxPath"
Write-Host "     MCP_TLS_PFX_PASSWORD=$pass"
Write-Host ""
Write-Host "2. Copy $cerPath to the CLIENT machine and install it there:" -ForegroundColor Cyan
Write-Host "     Import-Certificate -FilePath mcp-ca.cer ``"
Write-Host "       -CertStoreLocation Cert:\LocalMachine\Root"
Write-Host "   (that command needs administrator rights on the client)"
Write-Host ""
Write-Host "3. Use https:// in the client's URL, and the hostname or IP exactly as"
Write-Host "   listed above. A name not in the certificate will fail verification."
