# 八重山 水深マップ Android版のビルド（Windows、Android Studio が入ったPC用）
# 使い方: PowerShell で  powershell -ExecutionPolicy Bypass -File android-app\build.ps1
# できるもの: リポジトリ直下の yaeyama-depth.apk（このPCのデバッグ鍵で署名。同じPCで作れば上書き更新できる）
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$android = Join-Path $here 'android'

# JDK 17〜23 が必要（Gradle 8.11 は Java 24 以降では動かない。最近の Android Studio 同梱の jbr は Java 25 のことがある）
function Get-JavaMajor($h) {
  if (-not $h -or -not (Test-Path "$h\bin\java.exe") -or -not (Test-Path "$h\release")) { return 0 }
  $m = Select-String -Path "$h\release" -Pattern 'JAVA_VERSION="(\d+)' | Select-Object -First 1
  if ($m) { return [int]$m.Matches[0].Groups[1].Value } else { return 0 }
}
function Test-JdkOk($h) { $v = Get-JavaMajor $h; return ($v -ge 17 -and $v -le 23) }
$localJdk = Join-Path $here '.jdk21'
$cands = @($env:JAVA_HOME, "$env:ProgramFiles\Android\Android Studio\jbr", "$env:LOCALAPPDATA\Programs\Android Studio\jbr", "${env:ProgramFiles(x86)}\Android\Android Studio\jbr")
foreach ($root in @("$env:ProgramFiles\Eclipse Adoptium", "$env:ProgramFiles\Microsoft", "$env:ProgramFiles\Java", "$env:ProgramFiles\Zulu")) {
  if (Test-Path $root) { $cands += (Get-ChildItem $root -Directory -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }) }
}
if (Test-Path $localJdk) { $cands = @((Get-ChildItem $localJdk -Directory | ForEach-Object { $_.FullName })) + $cands }
$jdk = $cands | Where-Object { Test-JdkOk $_ } | Select-Object -First 1
if (-not $jdk) {
  # 見つからなければ JDK 21（Eclipse Temurin、約190MB）を android-app\.jdk21 に取ってくる。PCへのインストールはしない
  Write-Host 'JDK 21 が見つからないので、android-app\.jdk21 にダウンロードします（約190MB、初回だけ）'
  $zip = Join-Path $env:TEMP 'temurin21.zip'
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $ProgressPreference = 'SilentlyContinue'
  Invoke-WebRequest -UseBasicParsing -Uri 'https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jdk/hotspot/normal/eclipse' -OutFile $zip
  if (Test-Path $localJdk) { Remove-Item $localJdk -Recurse -Force }
  Expand-Archive -Path $zip -DestinationPath $localJdk -Force
  Remove-Item $zip -Force
  $jdk = Get-ChildItem $localJdk -Directory | ForEach-Object { $_.FullName } | Where-Object { Test-JdkOk $_ } | Select-Object -First 1
  if (-not $jdk) { throw 'JDK 21 のダウンロード・展開に失敗しました。' }
}
$env:JAVA_HOME = $jdk
$env:Path = "$jdk\bin;$env:Path"
Write-Host "使う JDK: $jdk"
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
