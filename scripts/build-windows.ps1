# Switches are parsed by hand: `pnpm windows:build -- -NoZip` forwards the
# literal "--", which PowerShell's -File parameter binder rejects as an
# ambiguous empty parameter name.
$ScriptArgs = @($args | Where-Object { $_ -ne "--" })
$unknown = @($ScriptArgs | Where-Object { $_ -notin @("-SkipPackage", "-NoZip") })
if ($unknown.Count -gt 0) { throw "Unknown argument(s): $($unknown -join ' ') (supported: -SkipPackage -NoZip)" }
$SkipPackage = $ScriptArgs -contains "-SkipPackage"
$NoZip = $ScriptArgs -contains "-NoZip"

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Dist = Join-Path $Root "dist"
$Cache = Join-Path $Dist "cache-windows"
$Sidecar = Join-Path $Dist "windows-sidecar"
$NodeOut = Join-Path $Dist "windows-node"
$LarkOut = Join-Path $Dist "windows-lark"
$WechatKeyOut = Join-Path $Dist "windows-wechat-key"
$AppStage = Join-Path $Dist "windows-app"
$NodeVersion = ((Get-Content (Join-Path $Root ".node-version") -Raw).Trim()).TrimStart("v")
$LarkVersion = if ($env:LARK_CLI_VERSION) { $env:LARK_CLI_VERSION } else { "1.0.95" }

function Log([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }
function Require-File([string]$Path, [string]$What) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$What not found: $Path" }
}
function Reset-Directory([string]$Path) {
  # All targets are explicit children of this repository's dist directory.
  if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Recurse -Force }
  New-Item -ItemType Directory -Path $Path -Force | Out-Null
}
function Invoke-Checked([string]$File, [string[]]$Arguments, [string]$WorkingDirectory = $Root) {
  Push-Location $WorkingDirectory
  try {
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$File exited with code $LASTEXITCODE" }
  } finally { Pop-Location }
}

New-Item -ItemType Directory -Path $Dist, $Cache -Force | Out-Null
$Package = [System.IO.File]::ReadAllText((Join-Path $Root "package.json"), [System.Text.Encoding]::UTF8) | ConvertFrom-Json

Log "Building the Windows sidecar (Node $NodeVersion)"
Reset-Directory $Sidecar
$esbuildArgs = @(
  "pnpm", "exec", "esbuild", "src/cli.ts", "--bundle", "--platform=node", "--format=esm", "--target=node22",
  "--outfile=$($Sidecar)\cli.mjs", "--alias:better-sqlite3-multiple-ciphers=./windows/sidecar/sqlite-shim.ts", "--alias:wreq-js=./windows/sidecar/wreq-shim.ts",
  "--external:bufferutil", "--external:utf-8-validate", "--banner:js=import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  "--log-level=warning"
)
Invoke-Checked "corepack" $esbuildArgs
Copy-Item -LiteralPath (Join-Path $Root "src\dashboard") -Destination (Join-Path $Sidecar "dashboard") -Recurse -Force

$sqliteVersion = ($Package.dependencies.'better-sqlite3-multiple-ciphers') -replace "[^0-9.]", ""
$wreqVersion = ($Package.dependencies.'wreq-js') -replace "[^0-9.]", ""
$sidecarPackage = [ordered]@{
  name = "fomomo-sidecar"
  private = $true
  type = "module"
  dependencies = [ordered]@{
    "better-sqlite3-multiple-ciphers" = $sqliteVersion
    "wreq-js" = $wreqVersion
    "koffi" = (($Package.dependencies.'koffi') -replace "[^0-9.]", "")
  }
}
[System.IO.File]::WriteAllText((Join-Path $Sidecar "package.json"), ($sidecarPackage | ConvertTo-Json -Depth 8), [System.Text.UTF8Encoding]::new($false))

Log "Downloading and verifying Node v$NodeVersion"
$nodeZipName = "node-v$NodeVersion-win-x64.zip"
$nodeZip = Join-Path $Cache $nodeZipName
$nodeBase = "https://nodejs.org/dist/v$NodeVersion"
$sums = Join-Path $Cache "SHASUMS256-$NodeVersion.txt"
if (-not (Test-Path -LiteralPath $nodeZip)) { Invoke-WebRequest "$nodeBase/$nodeZipName" -OutFile $nodeZip }
if (-not (Test-Path -LiteralPath $sums)) { Invoke-WebRequest "$nodeBase/SHASUMS256.txt" -OutFile $sums }
$expected = ((Select-String -LiteralPath $sums -Pattern ([regex]::Escape($nodeZipName) + "$") | Select-Object -First 1).Line -split "\s+")[0]
if (-not $expected) { throw "Could not find $nodeZipName in SHASUMS256.txt" }
$actual = (Get-FileHash -LiteralPath $nodeZip -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected.ToLowerInvariant()) { throw "Node archive SHA256 mismatch: $actual != $expected" }
$extract = Join-Path $Cache "node-extract"
if (Test-Path -LiteralPath $extract) { Remove-Item -LiteralPath $extract -Recurse -Force }
Expand-Archive -LiteralPath $nodeZip -DestinationPath $extract -Force
$nodeRoot = Join-Path $extract "node-v$NodeVersion-win-x64"
$nodeExe = Join-Path $nodeRoot "node.exe"
Require-File $nodeExe "Node"
Reset-Directory $NodeOut
Copy-Item -LiteralPath $nodeExe -Destination (Join-Path $NodeOut "node.exe") -Force

# Keep a local copy of the matching Node headers.  If the native package has
# no prebuilt binary for this exact Node release, node-gyp can compile without
# making a second (often proxy-sensitive) headers request.
$headersName = "node-v$NodeVersion-headers.tar.gz"
$headersArchive = Join-Path $Cache $headersName
$headersExtract = Join-Path $Cache "headers-extract"
if (-not (Test-Path -LiteralPath $headersArchive)) { Invoke-WebRequest "$nodeBase/$headersName" -OutFile $headersArchive }
if (Test-Path -LiteralPath $headersExtract) { Remove-Item -LiteralPath $headersExtract -Recurse -Force }
New-Item -ItemType Directory -Path $headersExtract -Force | Out-Null
Invoke-Checked "tar" @("-xzf", $headersArchive, "-C", $headersExtract)
$nodeHeaders = Join-Path $headersExtract "node-v$NodeVersion"
Require-File (Join-Path $nodeHeaders "include\node\node.h") "Node headers"

Log "Installing sidecar native dependencies with Node v$NodeVersion"
$npmCli = Join-Path $nodeRoot "node_modules\npm\bin\npm-cli.js"
Require-File $npmCli "Bundled npm"
$savedPath = $env:PATH
try {
  # npm lifecycle tools (node-gyp / prebuild-install) resolve `node` via PATH;
  # prepend the exact runtime so native addons target ABI 127 (Node 22), not
  # whichever Node happens to launch this PowerShell process.
  $env:PATH = "$nodeRoot;$savedPath"
  $env:npm_config_nodedir = $nodeHeaders
  Invoke-Checked $nodeExe @($npmCli, "install", "--omit=dev", "--no-package-lock", "--no-audit", "--no-fund", "--loglevel=error") $Sidecar
} finally {
  $env:PATH = $savedPath
  Remove-Item Env:npm_config_nodedir -ErrorAction SilentlyContinue
}
Require-File (Join-Path $Sidecar "node_modules\better-sqlite3-multiple-ciphers\build\Release\better_sqlite3.node") "better-sqlite3 Windows native module"
$wreqBinding = Get-ChildItem -LiteralPath (Join-Path $Sidecar "node_modules\@wreq-js") -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "binding-win32-x64-*" } | Select-Object -First 1
if (-not $wreqBinding) { throw "wreq-js Windows native module was not installed" }
$vendor = Join-Path $Sidecar "vendor"
Reset-Directory $vendor
Copy-Item -Path (Join-Path $Sidecar "node_modules\*") -Destination $vendor -Recurse -Force

Reset-Directory $WechatKeyOut
Copy-Item -LiteralPath (Join-Path $Root "resources\wechat_key_tool.dll") -Destination (Join-Path $WechatKeyOut "wechat_key_tool.dll") -Force

Log "Installing lark-cli $LarkVersion"
$larkCache = Join-Path $Cache "lark"
if (Test-Path -LiteralPath $larkCache) { Remove-Item -LiteralPath $larkCache -Recurse -Force }
New-Item -ItemType Directory -Path $larkCache -Force | Out-Null
Invoke-Checked "npm.cmd" @("install", "--prefix", $larkCache, "--no-package-lock", "--no-audit", "--no-fund", "--loglevel=error", "@larksuite/cli@$LarkVersion")
$larkCandidates = @(
  (Join-Path $larkCache "node_modules\@larksuite\cli\bin\lark-cli.exe"),
  (Join-Path $larkCache "node_modules\@larksuite\cli\bin\lark-cli")
)
$larkBin = $larkCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $larkBin) { throw "lark-cli Windows binary was not installed" }
Reset-Directory $LarkOut
Copy-Item -LiteralPath $larkBin -Destination (Join-Path $LarkOut "lark-cli.exe") -Force

# Electron itself only needs the small Windows shell.  Keep the sidecar's
# native dependencies in extraResources and give electron-builder a minimal
# app manifest; otherwise it would try to rebuild the macOS/Node native addon
# for Electron's V8 ABI even though the shell never loads it.
Reset-Directory $AppStage
Copy-Item -LiteralPath (Join-Path $Root "windows") -Destination (Join-Path $AppStage "windows") -Recurse -Force
$appPackage = [ordered]@{
  name = "fomomo-windows"
  version = $Package.version
  private = $true
  main = "windows/main.cjs"
  description = "fomomo Windows Feishu desktop shell"
}
[System.IO.File]::WriteAllText((Join-Path $AppStage "package.json"), ($appPackage | ConvertTo-Json -Depth 5), [System.Text.UTF8Encoding]::new($false))
"packages: []" | Set-Content -LiteralPath (Join-Path $AppStage "pnpm-workspace.yaml") -Encoding ascii

if ($SkipPackage) {
  Log "Skipped electron-builder; sidecar is at $Sidecar"
  exit 0
}

Log "Packaging Electron Windows x64 directory"
$builderArgs = @("pnpm", "exec", "electron-builder", "--dir", "--win", "--x64")
Invoke-Checked "corepack" $builderArgs

# electron-builder fetches its own 7za toolset to unpack NSIS; that download
# can hang indefinitely behind a local proxy.  Fetch the identical release
# asset ourselves, verify electron-builder's pinned SHA-256, and hand it over.
$sevenZipDir = Join-Path $Cache "7zip"
$sevenZipExe = Join-Path $sevenZipDir "7zip\bin\7za.exe"
if (-not (Test-Path -LiteralPath $sevenZipExe)) {
  Log "Downloading 7zip toolset for electron-builder"
  New-Item -ItemType Directory -Path $sevenZipDir -Force | Out-Null
  $sevenZipTar = Join-Path $sevenZipDir "7zip-win-x64.tar.gz"
  Invoke-WebRequest "https://github.com/electron-userland/electron-builder-binaries/releases/download/7zip%401.0.0/7zip-win-x64.tar.gz" -OutFile $sevenZipTar
  $sum = (Get-FileHash -LiteralPath $sevenZipTar -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($sum -ne "be071f15bd6da2f78fe81c6ddef2009b0c4d8a51f36b780cb806c7e6df95e1b3") { throw "7zip toolset SHA256 mismatch: $sum" }
  Invoke-Checked "tar" @("-xzf", $sevenZipTar, "-C", $sevenZipDir)
  Require-File $sevenZipExe "7za"
}
$env:ELECTRON_BUILDER_7ZIP_PATH = $sevenZipExe

# Installer from the same unpacked directory (no second packaging pass).
# User data lives in %LOCALAPPDATA%\Fomomo, so uninstalling keeps settings.
Log "Building NSIS installer"
Invoke-Checked "corepack" @("pnpm", "exec", "electron-builder", "--win", "nsis", "--x64", "--prepackaged", (Join-Path (Join-Path $Dist "windows") "win-unpacked"))

if (-not $NoZip) {
  $zipOut = Join-Path (Join-Path $Dist "windows") "fomomo-$($Package.version)-win-x64.zip"
  if (Test-Path -LiteralPath $zipOut) { Remove-Item -LiteralPath $zipOut -Force }
  Log "Creating $zipOut"
  Invoke-Checked "tar" @("-a", "-cf", $zipOut, ".") (Join-Path (Join-Path $Dist "windows") "win-unpacked")
  Require-File $zipOut "Windows zip"
}

Write-Host ""
Write-Host "Windows build completed" -ForegroundColor Green
Write-Host "   Output directory: $(Join-Path $Dist 'windows')"
Get-ChildItem -LiteralPath (Join-Path $Dist "windows") -Include "*.exe", "*.zip" -File -Recurse -Depth 0 -ErrorAction SilentlyContinue | ForEach-Object {
  Write-Host "   $($_.FullName)  $([math]::Round($_.Length / 1MB, 1)) MB"
}
