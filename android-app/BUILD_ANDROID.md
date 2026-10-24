# Android版のビルド手順（人とAIエージェント共通）

八重山 水深マップの Android 版は、リポジトリ直下のWebサイト（index.html, app.js, extras.js, view3d.js, native.js, lib/, data/）を
Capacitor 7 のアプリに詰めたものです。アプリ固有のコードは native.js（画面オフでも航跡を記録・音声入力・共有・戻るボタン）だけで、
Webサイトと同じファイルがそのまま使われます。データは暗号化されたまま入っていて、初回に合言葉を聞きます。

## 必要なもの
- Windows PC と Android Studio（バージョンは問わない。JDK 21 は build.ps1 が自動で用意する）
- Android SDK Platform 35（なければ Android Studio の SDK Manager で入れる）
- Node.js は不要（プラグインのソースは android-app/vendor/ に同梱済み）

## ビルド
1. リポジトリを取得（または `git pull`）。
2. PowerShell でリポジトリ直下に移動して:
   `powershell -ExecutionPolicy Bypass -File android-app\build.ps1`
3. 成功すると、リポジトリ直下に `yaeyama-depth.apk` ができる。

Android Studio で開く場合は `android-app/android` フォルダを開き、Build → Build App Bundle(s) / APK(s) → Build APK(s)。
ビルドのたびに、Webサイトのファイルが自動で `app/src/main/assets/public` にコピーされる（app/build.gradle の copyWebAssets）。

## スマホに入れる
- USBでつなぐ場合: スマホで「開発者向けオプション」→「USBデバッグ」をオン。
  `%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe install -r yaeyama-depth.apk`
- ファイルで送る場合: APK を Google ドライブ等でスマホに送り、開いて「この提供元を許可」→インストール。
- 更新も同じ手順（同じPCで作ったAPKなら、データを残したまま上書きできる）。
- 初回: 合言葉 → 位置情報「アプリの使用中のみ許可」→ 通知を許可。航跡を画面オフでも残すには、
  「航跡と写真」→「画面を消しても記録する」をオン。設定 → アプリ → 八重山水深マップ → 電池 →「制限なし」にすると途切れにくい。

## AIエージェントへの厳守事項（Antigravity 等に任せる場合）
このフォルダの作業は「ビルドしてAPKを作る」ことだけ。次を必ず守ること。
1. **リポジトリ直下のWebサイトのファイル（*.html, *.js, lib/, data/, sw.js, manifest）を一切変更しない。** 見た目や機能の修正はしない。
2. **`npx cap sync` / `npx cap update` / `npx cap add` / `npm install` を実行しない。** vendor/ を指す capacitor.settings.gradle が元に戻って壊れる。
3. **Capacitor・Android Gradle Plugin・Gradle・プラグインのバージョンを上げない／下げない。** applicationId（jp.yaeyama.depthmap）を変えない。
4. **プラグインやライブラリを追加・削除しない。** AndroidManifest の権限を減らさない。
5. **署名の設定を変えない**（デバッグ署名のまま）。keystore を作らない。
6. **git commit / git push をしない。APK をインターネットに公開しない**（海図の著作権のため。データは暗号化されているが配布しない）。
7. data/ の中身（*.enc, key.json）を開いたり、復号したり、作り直したりしない。合言葉をファイルに書かない。
8. 変更してよいのは次だけ: `android-app/android/local.properties`（SDKの場所）、JAVA_HOME などの環境変数、Android Studio の SDK Manager での SDK の追加。
9. エラーが出たら、勝手に別の方法を試さず、**エラーメッセージ全文**と実行したコマンドを報告して止まる。よくある原因:
   - `Unsupported class file major version` / `invalid source release: 21` → Java のバージョンが合わない（Gradle 8.11 は Java 17〜23 でしか動かない。Android Studio 同梱の jbr が Java 25 のことがある）。build.ps1 は合う JDK を探し、なければ JDK 21 を android-app\.jdk21 に自動で取ってくる。最新の build.ps1 を `git pull` で取ってから再実行する。Gradle や AGP のバージョンを上げて解決しようとしてはいけない。
   - `SDK location not found` → local.properties の sdk.dir を SDK Manager に表示される場所にする。
   - `Failed to find target with hash string 'android-35'` → SDK Manager で Android 15 (API 35) の SDK Platform を入れる。
10. 完了の報告は「APKのパス」「ファイルサイズ」「build.ps1 の最後の出力」だけ。推測で「動作確認済み」と書かない。
