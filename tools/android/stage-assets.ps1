# Stages Fritzing's read-only data into the Android build as APK assets.
#
# Produces <AndroidBuildDir>/assets/fritzing-data.zip (help, sketches,
# translations) and fritzing-data.version. On first launch the app extracts the
# zip to app storage (see ensureAndroidDataExtracted() in src/utils/folderutils.cpp).
# Run after `make` and before androiddeployqt.
#
# The parts library is NOT packed into the APK: the app downloads it from
# Cloudflare on first launch (src/utils/cloudparts.cpp). Publish a new parts
# bundle with `npm run upload-parts` in tools/fritzing-cli/worker.
#
# Example:
#   .\tools\android\stage-assets.ps1 -AndroidBuildDir C:\Android\build\android-build

param(
	[Parameter(Mandatory = $true)][string]$AndroidBuildDir
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path "$PSScriptRoot\..\..").Path

$staging = Join-Path $env:TEMP "fritzing-android-staging"
if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
New-Item -ItemType Directory $staging | Out-Null

foreach ($dir in 'help', 'sketches') {
	robocopy "$repo\$dir" "$staging\$dir" /E /NFL /NDL /NJH /NJS /NP | Out-Null
	if ($LASTEXITCODE -ge 8) { throw "robocopy of $dir failed ($LASTEXITCODE)" }
}

# Only compiled translations (.qm) and the syntax files are needed at runtime.
New-Item -ItemType Directory "$staging\translations\syntax" -Force | Out-Null
Get-ChildItem "$repo\translations" -Filter *.qm | Where-Object Length -gt 128 | Copy-Item -Destination "$staging\translations"
Copy-Item "$repo\translations\syntax\*.xml" "$staging\translations\syntax"

$assets = Join-Path $AndroidBuildDir "assets"
New-Item -ItemType Directory $assets -Force | Out-Null
$zip = Join-Path $assets "fritzing-data.zip"
if (Test-Path $zip) { Remove-Item $zip }

Write-Host "Zipping to $zip..."
Push-Location $staging
try {
	# Windows' bsdtar writes zip; Git Bash's GNU tar (if first on PATH) can't.
	& (Join-Path $env:SystemRoot "System32\tar.exe") -a -cf $zip *
	if ($LASTEXITCODE -ne 0) { throw "tar failed ($LASTEXITCODE)" }
} finally { Pop-Location }

# Version stamp: changes whenever the app revision changes, which makes the
# app re-extract the data after an update.
$appRev = (git -C $repo rev-parse --short HEAD).Trim()
$stamp = "$appRev-" + (Get-Date -Format "yyyyMMddHHmmss")
Set-Content -Path (Join-Path $assets "fritzing-data.version") -Value $stamp -Encoding ascii -NoNewline

Remove-Item -Recurse -Force $staging
$size = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host "Staged fritzing-data.zip ($size MB), version $stamp"
