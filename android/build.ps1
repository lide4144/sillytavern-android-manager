# Requires PowerShell 5.1+ on Windows, JDK 17+, and an existing Android SDK.
#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ProjectPath,
    [string]$Platform,
    [string]$BuildToolsVersion,
    [switch]$ValidateOnly
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:OS -ne 'Windows_NT') { throw 'This build script requires Windows and PowerShell 5.1+.' }
function Invoke-Tool {
    param([string]$Tool, [string[]]$Arguments)
    & $Tool @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Tool failed: $([IO.Path]::GetFileName($Tool)) (exit $LASTEXITCODE)" }
}
function Require-File([string]$File) {
    if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { throw "Required file missing: $File" }
    return $File
}
$project = (Resolve-Path -LiteralPath $ProjectPath).Path
$manifest = Require-File (Join-Path $project 'AndroidManifest.xml')
foreach ($dir in @('src','res')) {
    if (-not (Test-Path -LiteralPath (Join-Path $project $dir) -PathType Container)) { throw "Missing project directory: $dir" }
}
$sdk = $env:ANDROID_SDK_ROOT
if (-not $sdk) { $sdk = $env:ANDROID_HOME }
if (-not $sdk) { throw 'Set ANDROID_SDK_ROOT or ANDROID_HOME to an installed Android SDK.' }
$sdk = (Resolve-Path -LiteralPath $sdk).Path
if (-not $Platform) {
    if (Test-Path -LiteralPath (Join-Path $sdk 'platforms/android-35/android.jar')) { $Platform = 'android-35' }
    else {
        $latest = Get-ChildItem -LiteralPath (Join-Path $sdk 'platforms') -Directory |
            Where-Object { $_.Name -match '^android-\d+$' -and [int]($_.Name -replace '^android-','') -ge 35 } |
            Sort-Object { [int]($_.Name -replace '^android-','') } -Descending | Select-Object -First 1
        if (-not $latest) { throw 'Install Android SDK Platform 35 or newer separately.' }
        $Platform = $latest.Name
    }
}
if ($Platform -notmatch '^android-(\d+)$' -or [int]$Matches[1] -lt 35) { throw 'Platform must be android-35 or a newer stable platform.' }
$androidJar = Require-File (Join-Path $sdk "platforms/$Platform/android.jar")
if (-not $BuildToolsVersion) {
    if (Test-Path -LiteralPath (Join-Path $sdk 'build-tools/34.0.0/aapt2.exe')) { $BuildToolsVersion = '34.0.0' }
    else {
        $latest = Get-ChildItem -LiteralPath (Join-Path $sdk 'build-tools') -Directory |
            Where-Object { $_.Name -match '^\d+\.\d+\.\d+$' -and [version]$_.Name -ge [version]'34.0.0' } |
            Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
        if (-not $latest) { throw 'Install Android SDK Build-Tools 34.0.0 or newer separately.' }
        $BuildToolsVersion = $latest.Name
    }
}
if ($BuildToolsVersion -notmatch '^\d+\.\d+\.\d+$' -or [version]$BuildToolsVersion -lt [version]'34.0.0') { throw 'BuildToolsVersion must be a stable version >= 34.0.0.' }
$bt = Join-Path $sdk "build-tools/$BuildToolsVersion"
foreach ($file in @('aapt2.exe','d8.bat','zipalign.exe','apksigner.bat')) { $null = Require-File (Join-Path $bt $file) }
$jdk = $env:JAVA_HOME
if (-not $jdk) {
    $javacCommand = Get-Command javac.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1
    $jdk = Split-Path (Split-Path $javacCommand.Source -Parent) -Parent
}
$jdk = (Resolve-Path -LiteralPath $jdk).Path
foreach ($file in @('java.exe','javac.exe','jar.exe','keytool.exe')) { $null = Require-File (Join-Path $jdk "bin/$file") }
$javac = Join-Path $jdk 'bin/javac.exe'
$compilerVersion = & $javac --version 2>&1
if ($LASTEXITCODE -ne 0 -or "$compilerVersion" -notmatch 'javac\s+(\d+)' -or [int]$Matches[1] -lt 17) { throw 'Use a full JDK 17+ via JAVA_HOME or javac on PATH.' }
[xml]$manifestXml = Get-Content -LiteralPath $manifest -Raw
$ns = 'http://schemas.android.com/apk/res/android'
$application = $manifestXml.manifest.application
if ($application.GetAttribute('debuggable',$ns) -ne 'false' -or $application.GetAttribute('allowBackup',$ns) -ne 'false') { throw 'Manifest must explicitly disable debugging and backup.' }
Write-Host "Validated toolchain: $Platform / Build-Tools $BuildToolsVersion / $compilerVersion"
if ($ValidateOnly) { return }

$out = Join-Path $project 'out'
$gen = Join-Path $project 'gen'
$classes = Join-Path $project 'classes'
$oldJavaHome = $env:JAVA_HOME
$oldPath = $env:PATH
$oldSignPass = $env:LOCAL_ANDROID_SIGN_PASS
try {
    $env:JAVA_HOME = $jdk
    $env:PATH = "$(Join-Path $jdk 'bin');$bt;$oldPath"
    foreach ($dir in @($out,$gen,$classes)) {
        if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    Invoke-Tool -Tool "$bt/aapt2.exe" -Arguments @('compile','--dir',"$project/res",'-o',"$out/res.zip")
    Invoke-Tool -Tool "$bt/aapt2.exe" -Arguments @('link','-o',"$out/unsigned.apk",'-I',$androidJar,'--manifest',$manifest,'--java',$gen,"$out/res.zip")
    $sources = @(Get-ChildItem -LiteralPath "$project/src",$gen -Recurse -Filter '*.java' -File | ForEach-Object FullName)
    Invoke-Tool -Tool $javac -Arguments (@('--release','11','-nowarn','-encoding','UTF-8','-cp',$androidJar,'-d',$classes) + $sources)
    $classFiles = @(Get-ChildItem -LiteralPath $classes -Recurse -Filter '*.class' -File | ForEach-Object FullName)
    New-Item -ItemType Directory -Path "$out/dex" -Force | Out-Null
    Invoke-Tool -Tool "$bt/d8.bat" -Arguments (@('--release','--lib',$androidJar,'--min-api','26','--output',"$out/dex") + $classFiles)
    Copy-Item -LiteralPath "$out/unsigned.apk" -Destination "$out/with-dex.apk"
    # Include all dex files if the application ever grows beyond one dex.
    Invoke-Tool -Tool "$jdk/bin/jar.exe" -Arguments @('uf',"$out/with-dex.apk",'-C',"$out/dex",'.')
    Invoke-Tool -Tool "$bt/zipalign.exe" -Arguments @('-f','-p','4',"$out/with-dex.apk","$out/aligned.apk")
    $signDir = Join-Path $project 'signing'
    New-Item -ItemType Directory -Path $signDir -Force | Out-Null
    $keystore = Join-Path $signDir 'app.jks'
    $passwordFile = Join-Path $signDir 'password.env'
    if (Test-Path -LiteralPath $keystore) {
        if ($env:ANDROID_SIGNING_PASSWORD) { $env:LOCAL_ANDROID_SIGN_PASS = $env:ANDROID_SIGNING_PASSWORD }
        elseif (Test-Path -LiteralPath $passwordFile) {
            $saved = [IO.File]::ReadAllText($passwordFile).Trim()
            if ($saved -notmatch '^ANDROID_SIGNING_PASSWORD=(.+)$') { throw 'Invalid local signing/password.env format.' }
            $env:LOCAL_ANDROID_SIGN_PASS = $Matches[1]
        } else { throw 'Keep signing/password.env with app.jks, or set ANDROID_SIGNING_PASSWORD.' }
    } else {
        if (Test-Path -LiteralPath $passwordFile) { throw 'Existing password.env without app.jks; restore the matching pair or move the file aside.' }
        $password = $env:ANDROID_SIGNING_PASSWORD
        if (-not $password) {
            $random = [Security.Cryptography.RandomNumberGenerator]::Create()
            try {
                $bytes = New-Object byte[] 32
                $random.GetBytes($bytes)
                $password = -join ($bytes | ForEach-Object { $_.ToString('x2') })
            } finally { $random.Dispose() }
        }
        if ($password.Length -lt 6 -or $password -match '[\r\n]') { throw 'Signing password must have at least six characters and no line breaks.' }
        $env:LOCAL_ANDROID_SIGN_PASS = $password
        [IO.File]::WriteAllText($passwordFile, "ANDROID_SIGNING_PASSWORD=$password`n")
        Invoke-Tool -Tool "$jdk/bin/keytool.exe" -Arguments @('-genkeypair','-keystore',$keystore,'-storepass:env','LOCAL_ANDROID_SIGN_PASS','-keypass:env','LOCAL_ANDROID_SIGN_PASS','-alias','app','-keyalg','RSA','-keysize','3072','-validity','10000','-dname','CN=Local Android Apps, O=Local Android Apps')
    }
    $apk = Join-Path $out 'app.apk'
    Invoke-Tool -Tool "$bt/apksigner.bat" -Arguments @('sign','--ks',$keystore,'--ks-key-alias','app','--ks-pass','env:LOCAL_ANDROID_SIGN_PASS','--key-pass','env:LOCAL_ANDROID_SIGN_PASS','--v1-signing-enabled','true','--v2-signing-enabled','true','--v3-signing-enabled','true','--out',$apk,"$out/aligned.apk")
    Invoke-Tool -Tool "$bt/apksigner.bat" -Arguments @('verify','--verbose','--print-certs',$apk)
    Invoke-Tool -Tool "$bt/zipalign.exe" -Arguments @('-c','-v','4',$apk)
    Invoke-Tool -Tool "$bt/aapt2.exe" -Arguments @('dump','badging',$apk)
    $hash = (Get-FileHash -LiteralPath $apk -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText((Join-Path $out 'sha256.txt'), "$hash  app.apk`n")
    Write-Host "APK: $apk"
} finally {
    $env:JAVA_HOME = $oldJavaHome
    $env:PATH = $oldPath
    $env:LOCAL_ANDROID_SIGN_PASS = $oldSignPass
}
