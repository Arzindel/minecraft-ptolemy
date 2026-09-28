# Downloads the latest Node.js 22 (LTS) for this PC into -Dest, for start.bat. Nothing is installed
# system-wide: delete the folder to remove it. The download is checked against nodejs.org's checksums.
param([Parameter(Mandatory = $true)][string]$Dest)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # the progress bar makes Invoke-WebRequest very slow
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$base = 'https://nodejs.org/dist/latest-v22.x'
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } elseif ([Environment]::Is64BitOperatingSystem) { 'x64' } else { 'x86' }
try {
  $sums = (Invoke-WebRequest -UseBasicParsing "$base/SHASUMS256.txt").Content
  $line = ($sums -split "`n") | Where-Object { $_ -match "node-v[\d.]+-win-$arch\.zip$" } | Select-Object -First 1
  if (-not $line) { throw "no Node.js download for win-$arch" }
  $hash, $file = $line.Trim() -split '\s+'
  $tmp = Join-Path ([IO.Path]::GetTempPath()) "ptolemy-node-$([Guid]::NewGuid())"
  New-Item -ItemType Directory -Path $tmp | Out-Null
  $zip = Join-Path $tmp $file
  Write-Host "Downloading $file..."
  Invoke-WebRequest -UseBasicParsing "$base/$file" -OutFile $zip
  if ((Get-FileHash $zip -Algorithm SHA256).Hash.ToLower() -ne $hash.ToLower()) { throw 'the download is damaged (checksum mismatch)' }
  Write-Host 'Unpacking...'
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $inner = Join-Path $tmp ($file -replace '\.zip$', '')
  if (Test-Path $Dest) { Remove-Item -Recurse -Force $Dest }
  Move-Item $inner $Dest
  Remove-Item -Recurse -Force $tmp
  Write-Host "Node.js is in $Dest"
} catch {
  Write-Host "Couldn't get Node.js: $($_.Exception.Message)"
  Write-Host 'You can also install it yourself from https://nodejs.org (the LTS version) and run start.bat again.'
  exit 1
}
