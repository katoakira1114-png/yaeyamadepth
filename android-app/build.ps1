# 八重山 水深マップ Android版のビルド（Windows、Android Studio が入ったPC用）
# 使い方: PowerShell で  powershell -ExecutionPolicy Bypass -File android-app\build.ps1
# できるもの: リポジトリ直下の yaeyama-depth.apk（このPCのデバッグ鍵で署名。同じPCで作れば上書き更新できる）
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$android = Join-Path $here 'android'

# JDK 21: Android Studio 同梱の JBR を使う
if (-not $env:JAVA_HOME -or -not (Test-Path "$env:JAVA_HOME\bin\java.exe")) {
  $cands = @("$env:ProgramFiles\Android\Android Studio\jbr", "$env:LOCALAPPDATA\Programs\Android Studio\jbr", "${env:ProgramFiles(x86)}\Android\Android Studio\jbr")
  $env:JAVA_HOME = $cands | Where-Object { Test-Path "$_\bin\java.exe" } | Select-Object -First 1
  if (-not $env:JAVA_HOME) { throw 'Android Studio の JDK (jbr) が見つかりません。JAVA_HOME を JDK 21 に設定してください。' }
}
# java や gradle は警告を stderr に出す。Stop のままだと AIエージェント等から実行したとき、それだけで止まるので、ここからは Continue
$ErrorActionPreference = 'Continue'
& "$env:JAVA_HOME\bin\java.exe" -version 2>&1 | ForEach-Object { "$_" }

# Android SDK の場所（local.properties）
$lp = Join-Path $android 'local.properties'
if (-not (Test-Path $lp)) {
  $sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { "$env:LOCALAPPDATA\Android\Sdk" }
  if (-not (Test-Path $sdk)) { throw "Android SDK が見つかりません: $sdk （Android Studio の SDK Manager で場所を確認）" }
  "sdk.dir=$($sdk -replace '\\', '\\')" | Set-Content -Encoding ASCII $lp
}

Push-Location $android
try { & .\gradlew.bat --no-daemon assembleDebug 2>&1 | ForEach-Object { "$_" }; if ($LASTEXITCODE -ne 0) { throw "gradle が失敗しました（終了コード $LASTEXITCODE）" } }
finally { Pop-Location }

$apk = Join-Path $android 'app\build\outputs\apk\debug\app-debug.apk'
$out = Join-Path (Split-Path $here -Parent) 'yaeyama-depth.apk'
if (-not (Test-Path $apk)) { throw "APK ができていません: $apk" }
Copy-Item $apk $out -Force
Write-Host "できました: $out"
