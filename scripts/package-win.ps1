# Builds release\SolidFlow-win64.zip: a self-contained folder another Windows 11 PC can unzip and run.
$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$release = Join-Path $root "release"
$out = Join-Path $release "SolidFlow"
$publish = Join-Path $release "publish"
$app = Join-Path $out "app"
$nodeDir = Join-Path $out "node"
$cache = Join-Path $release "cache"
$zip = Join-Path $release "SolidFlow-win64.zip"

function Assert-LastExit($label) {
    if ($LASTEXITCODE -ne 0) {
        throw "$label failed with exit code $LASTEXITCODE"
    }
}

function ConvertTo-NodeVersion([string]$text) {
    $clean = ($text.Trim().TrimStart("v") -split "-")[0]
    return [version]$clean
}

function Get-BundledNodeVersion {
    $minimum = [version]"24.20.0"
    Write-Host "Looking up the newest Node.js 24 build..."
    $index = Invoke-RestMethod -Uri "https://nodejs.org/dist/index.json"
    foreach ($entry in $index) {
        if ($entry.version -notmatch "^v24\.") { continue }
        $parsed = ConvertTo-NodeVersion $entry.version
        if ($parsed -ge $minimum) { return $entry.version }
    }
    throw "nodejs.org has no Windows build of Node.js $minimum or newer."
}

function Copy-Tree($source, $destination) {
    New-Item -ItemType Directory -Force -Path $destination | Out-Null
    & robocopy $source $destination /E /NFL /NDL /NJH /NJS /nc /ns /np > $null
    if ($LASTEXITCODE -ge 8) {
        throw "Could not copy $source (robocopy exit $LASTEXITCODE)"
    }
    $global:LASTEXITCODE = 0
}

function Assert-NoLinks($dir) {
    $links = @(Get-ChildItem -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue |
        Where-Object { $_.LinkType })
    if ($links.Count -eq 0) { return }
    $sample = ($links | Select-Object -First 15 | ForEach-Object { $_.FullName }) -join [Environment]::NewLine
    throw "Packaged files still contain links, so another PC could not open them:`n$sample"
}

if ($env:PROCESSOR_ARCHITECTURE -ne "AMD64") {
    throw "This package is built for 64-bit Windows. This PC is $($env:PROCESSOR_ARCHITECTURE)."
}

Write-Host "Compiling SolidFlow..."
Push-Location $root
try {
    & pnpm exec tsc
    Assert-LastExit "TypeScript compile"
}
finally {
    Pop-Location
}

if (Test-Path $out) { Remove-Item -LiteralPath $out -Recurse -Force }
if (Test-Path $publish) { Remove-Item -LiteralPath $publish -Recurse -Force }
New-Item -ItemType Directory -Force -Path $out | Out-Null

Write-Host "Publishing SolidFlow.exe..."
& dotnet publish (Join-Path $root "desktop\SolidFlow.csproj") `
    -c Release `
    -r win-x64 `
    --self-contained true `
    -p:PublishSingleFile=true `
    -p:IncludeNativeLibrariesForSelfExtract=true `
    -p:EnableCompressionInSingleFile=true `
    -p:DebugType=None `
    -p:DebugSymbols=false `
    -p:SatelliteResourceLanguages=en `
    -o $publish
Assert-LastExit "dotnet publish"
Copy-Item (Join-Path $publish "SolidFlow.exe") (Join-Path $out "SolidFlow.exe")
Remove-Item -LiteralPath $publish -Recurse -Force

Write-Host "Copying the studio..."
New-Item -ItemType Directory -Force -Path $app, (Join-Path $app "src\studio"), (Join-Path $app "src\driver") | Out-Null
Copy-Item (Join-Path $root "package.json") (Join-Path $app "package.json")
Copy-Tree (Join-Path $root "dist") (Join-Path $app "dist")
Copy-Tree (Join-Path $root "schema") (Join-Path $app "schema")
Copy-Tree (Join-Path $root "src\studio\public") (Join-Path $app "src\studio\public")
Copy-Item (Join-Path $root "src\driver\native-frame.ps1") (Join-Path $app "src\driver\native-frame.ps1")

$deps = Join-Path $env:TEMP ("solidflow-deps-" + [guid]::NewGuid().ToString("n"))
New-Item -ItemType Directory -Force -Path $deps | Out-Null
try {
    Copy-Item (Join-Path $root "package.json") (Join-Path $deps "package.json")
    Copy-Item (Join-Path $root "pnpm-lock.yaml") (Join-Path $deps "pnpm-lock.yaml")
    Write-Host "Installing runtime dependencies..."
    Push-Location $deps
    try {
        & pnpm install --prod --frozen-lockfile --ignore-scripts --node-linker=hoisted
        Assert-LastExit "pnpm install"
    }
    finally {
        Pop-Location
    }
    $bin = Join-Path $deps "node_modules\.bin"
    if (Test-Path $bin) { Remove-Item -LiteralPath $bin -Recurse -Force }
    Copy-Tree (Join-Path $deps "node_modules") (Join-Path $app "node_modules")
}
finally {
    if (Test-Path $deps) { Remove-Item -LiteralPath $deps -Recurse -Force }
}
Assert-NoLinks (Join-Path $app "node_modules")

$nodeVersion = Get-BundledNodeVersion
$nodeZipName = "node-$nodeVersion-win-x64.zip"
$nodeZip = Join-Path $cache $nodeZipName
New-Item -ItemType Directory -Force -Path $cache, $nodeDir | Out-Null
if (-not (Test-Path $nodeZip)) {
    $url = "https://nodejs.org/dist/$nodeVersion/node-$nodeVersion-win-x64.zip"
    Write-Host "Downloading $url"
    $ProgressPreference = "SilentlyContinue"
    Invoke-WebRequest -Uri $url -OutFile $nodeZip
}
$nodeExtract = Join-Path $env:TEMP ("solidflow-node-" + [guid]::NewGuid().ToString("n"))
try {
    Expand-Archive -LiteralPath $nodeZip -DestinationPath $nodeExtract
    $unpacked = Get-ChildItem -LiteralPath $nodeExtract -Directory | Select-Object -First 1
    if (-not $unpacked) { throw "The Node.js archive did not contain a folder." }
    Copy-Item (Join-Path $unpacked.FullName "node.exe") (Join-Path $nodeDir "node.exe")
    Copy-Item (Join-Path $unpacked.FullName "LICENSE") (Join-Path $nodeDir "LICENSE")
}
finally {
    if (Test-Path $nodeExtract) { Remove-Item -LiteralPath $nodeExtract -Recurse -Force }
}

@"
SolidFlow

Unzip this folder, then double-click SolidFlow.exe.
Windows 11 already includes what the window needs. Node.js and .NET do not have to be installed.

Keep SolidFlow.exe together with the app and node folders.
The first time it opens, choose a workspace folder outside this SolidFlow folder.

Windows SmartScreen may warn that the exe is unrecognized because it is not signed.
Choose More info, then Run anyway.
"@ | Set-Content -LiteralPath (Join-Path $out "README.txt") -Encoding utf8

Write-Host "Checking the packaged studio..."
& (Join-Path $nodeDir "node.exe") (Join-Path $app "dist\cli.js") devices
Assert-LastExit "Packaged studio"

if (Test-Path $zip) { Remove-Item -LiteralPath $zip -Force }
Write-Host "Zipping..."
& tar.exe -a -c -f $zip -C $release "SolidFlow"
Assert-LastExit "tar"

$exe = Get-Item (Join-Path $out "SolidFlow.exe")
$archive = Get-Item $zip
Write-Host ("SolidFlow.exe  {0:N1} MB  {1}" -f ($exe.Length / 1MB), $exe.FullName)
Write-Host ("Share this zip {0:N1} MB  {1}" -f ($archive.Length / 1MB), $archive.FullName)
