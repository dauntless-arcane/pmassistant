# Starts a Dev Tunnel (same service as VS Code port forwarding), writes its URL
# to server/.env as PUBLIC_CALLBACK_BASE_URL, then runs the server.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root "server\.env"

$port = 4000
$m = Select-String -Path $envFile -Pattern '^PORT=(\d+)' | Select-Object -First 1
if ($m) { $port = [int]$m.Matches[0].Groups[1].Value }

function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [Environment]::GetEnvironmentVariable("Path","User")
}

$tunnel = $null
try {
  Refresh-Path
  if (-not (Get-Command devtunnel -ErrorAction SilentlyContinue)) {
    Write-Host "devtunnel not found. Installing with winget..."
    winget install --id Microsoft.devtunnel -e --accept-source-agreements --accept-package-agreements
    Refresh-Path
  }
  if (-not (Get-Command devtunnel -ErrorAction SilentlyContinue)) { throw "devtunnel is not available" }

  # `user show` exits 0 even when signed out, so check its text instead.
  $who = (& devtunnel user show 2>&1 | Out-String)
  if ($who -notmatch "(?i)logged in as") {
    Write-Host "Sign in to Dev Tunnels with your work account (opens a browser)..."
    & devtunnel user login -e
    if ($LASTEXITCODE -ne 0) { throw "devtunnel login failed" }
    $who = (& devtunnel user show 2>&1 | Out-String)
  }

  # Guardrail: only HealthEdge work accounts may host a tunnel.
  if ($who -notmatch "(?i)logged in as\s+\S+@(\S+\.)?healthedge\.com\b") {
    & devtunnel user logout | Out-Null
    throw "Dev Tunnel must be hosted with a @healthedge.com account. Signed out; rerun and use your work account. ($($who.Trim()))"
  }

  $log = Join-Path $env:TEMP "pm-assistant-devtunnel.log"
  Remove-Item $log, "$log.err" -ErrorAction SilentlyContinue
  $tunnel = Start-Process devtunnel -ArgumentList "host","-p","$port","--allow-anonymous" `
    -RedirectStandardOutput $log -RedirectStandardError "$log.err" -PassThru -WindowStyle Hidden

  $url = $null
  for ($i = 0; $i -lt 60 -and -not $url; $i++) {
    Start-Sleep -Seconds 1
    if ($tunnel.HasExited) { throw "devtunnel exited: $(Get-Content $log, "$log.err" -ErrorAction SilentlyContinue)" }
    if (Test-Path $log) {
      $hit = Select-String -Path $log -Pattern "https://[a-z0-9-]+-$port\.[a-z0-9.]*devtunnels\.ms" | Select-Object -First 1
      if ($hit) { $url = $hit.Matches[0].Value }
    }
  }
  if (-not $url) { throw "Timed out waiting for the tunnel URL (see $log)" }

  $lines = Get-Content $envFile
  if ($lines -match '^PUBLIC_CALLBACK_BASE_URL=') {
    $lines = $lines -replace '^PUBLIC_CALLBACK_BASE_URL=.*', "PUBLIC_CALLBACK_BASE_URL=$url"
  } else { $lines += "PUBLIC_CALLBACK_BASE_URL=$url" }
  Set-Content $envFile $lines
  Write-Host "Tunnel up: $url  (saved to server\.env)"
}
catch {
  Write-Warning "Tunnel not started: $($_.Exception.Message)"
  Write-Warning "Continuing with PUBLIC_CALLBACK_BASE_URL already in server\.env."
}

try {
  Start-Process "http://localhost:$port"
  Push-Location (Join-Path $root "server")
  & npm start
}
finally {
  Pop-Location
  if ($tunnel -and -not $tunnel.HasExited) { Stop-Process -Id $tunnel.Id -Force }
}
