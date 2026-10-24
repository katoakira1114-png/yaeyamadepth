'use strict';
// Android app (Capacitor) bridge. On the website this is null and everything uses the browser APIs.
// In the app: location comes from a foreground service so the track keeps recording with the screen off,
// dictation uses the system speech recogniser, files are shared through the Android share sheet,
// and the back button hides the app instead of closing it (closing would stop the log).
const NATIVE = (() => {
  const C = window.Capacitor;
  if (!C || !C.isNativePlatform || !C.isNativePlatform()) return null;
  const P = C.Plugins;
  let watcherId = null;

  async function startGPS(onPos, onErr) {
    if (watcherId) { try { await P.BackgroundGeolocation.removeWatcher({id: watcherId}); } catch (e) {} watcherId = null; }
    const bg = localStorage.getItem('bgrec') !== '0';
    const opt = {requestPermissions: true, stale: false, distanceFilter: 3};
    if (bg) Object.assign(opt, {backgroundTitle: '八重山 水深マップ', backgroundMessage: '航跡を記録しています'});
    watcherId = await P.BackgroundGeolocation.addWatcher(opt, (loc, err) => {
      if (err) { onErr({code: err.code === 'NOT_AUTHORIZED' ? 1 : 2}); return; }
      if (loc) onPos({coords: {latitude: loc.latitude, longitude: loc.longitude, accuracy: loc.accuracy}, timestamp: loc.time || Date.now()});
    });
  }
  const openLocationSettings = () => P.BackgroundGeolocation.openSettings();

  // dictation: onText gets the running transcript, onEnd when recognition stops
  async function dictate(onText, onEnd) {
    const S = P.SpeechRecognition;
    if (!(await S.available()).available) throw new Error('unavailable');
    let perm = await S.checkPermissions();
    if (perm.speechRecognition !== 'granted') perm = await S.requestPermissions();
    if (perm.speechRecognition !== 'granted') throw new Error('not-allowed');
    await S.removeAllListeners();
    await S.addListener('partialResults', d => { if (d.matches && d.matches[0]) onText(d.matches[0]); });
    await S.addListener('listeningState', d => { if (d.status === 'stopped') onEnd(); });
    await S.start({language: 'ja-JP', partialResults: true, popup: false, maxResults: 1});
  }
  const stopDictate = () => P.SpeechRecognition.stop().catch(() => {});

  async function shareFile(name, text) {
    const {uri} = await P.Filesystem.writeFile({path: name, data: text, directory: 'CACHE', encoding: 'utf8'});
    await P.Share.share({title: name, files: [uri]});
  }

  P.App.addListener('backButton', () => {
    const open = [...document.querySelectorAll('.sheet')].filter(s => !s.hidden);
    if (open.length) { open[open.length - 1].hidden = true; return; }
    const v3 = document.getElementById('v3');
    if (v3 && !v3.hidden) { document.getElementById('v3back').click(); return; }
    P.App.minimizeApp();
  });

  return {startGPS, openLocationSettings, dictate, stopDictate, shareFile};
})();
