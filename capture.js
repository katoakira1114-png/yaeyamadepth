'use strict';
// 撮影モード（試験）: 歩きながら動画を撮り、同じ時計でスマホの向き・ジャイロ・加速度・磁気・GPSを記録する。
// 後で動画から切り出したコマを写真照合（COLMAP）にかけ、スマホのセンサー値がどれだけずれていたかを測るための素材。
// 時刻はすべて performance.now() の ms（t_ms）。GPS は端末の時刻（epoch ms）も残し、meta.json の epoch0/perf0 で相互に換算できる。
// 書き出し: アプリでは 端末の Documents/yaeyama_capture/<日時>/ に直接、ブラウザでは終了時にファイルを保存する。
(() => {
  const $ = id => document.getElementById(id);
  const P = (window.Capacitor && window.Capacitor.Plugins) || {};
  const app = !!NATIVE;
  let S = null; // 撮影中の状態

  const css = document.createElement('style');
  css.textContent = `#cap{position:fixed;inset:0;background:#000;z-index:20;display:flex;flex-direction:column}
#cap[hidden]{display:none}#cap video{flex:1;min-height:0;width:100%;object-fit:contain;background:#000}
#capbar{padding:10px 12px calc(var(--sb,0px) + 10px);background:rgba(10,20,50,.92);display:flex;flex-direction:column;gap:8px}
#capstat{font-size:13px;line-height:1.5;color:#dfe8ff;white-space:pre-line}
#capbar .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
#capgo.on{background:#c62828;border-color:#ff8a80}`;
  document.head.appendChild(css);
  const root = document.createElement('div');
  root.id = 'cap'; root.hidden = true;
  root.innerHTML = `<video id="capv" playsinline muted autoplay></video>
<div id="capbar"><div id="capstat">準備中…</div>
<div class="row"><select id="capres" class="fld" style="width:auto"><option value="2160">4K</option><option value="1080">1080p</option></select>
<button class="pri" id="capgo">● 記録開始</button><button id="capclose">閉じる</button></div>
<div class="row" id="capsendrow" hidden><select id="capsel" class="fld" style="width:auto;max-width:60%"></select><button id="capsend">PCに送る</button></div>
<small style="color:#9fb0d8">スマホは横向きで、建物に向けて斜め前方を写しながら、ゆっくり歩いてください。1ブロック一周して始点に戻ると、ずれの計算がしやすくなります。</small></div>`;
  document.body.appendChild(root);

  const row = $('bTrkClose') && $('bTrkClose').parentNode;
  if (row) {
    const b = document.createElement('button');
    b.id = 'bCap'; b.textContent = '動画で位置ズレ計測（試験）';
    row.insertBefore(b, row.firstChild);
    b.onclick = () => { $('trk').hidden = true; open(); };
  }

  const pad = n => String(n).padStart(2, '0');
  const stamp = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const f = (v, k = 4) => v == null || Number.isNaN(v) ? '' : (+v).toFixed(k);
  const say = t => { $('capstat').textContent = t; };

  // ---------- ファイル書き出し（アプリ: 追記で直接保存、ブラウザ: メモリに溜めて最後に保存）----------
  let q = Promise.resolve(), dir = null, dirKind = null;
  const enq = fn => (q = q.then(fn).catch(e => { if (S) S.err = (e && e.message) || String(e); }));
  async function mkdir(name) {
    for (const kind of ['DOCUMENTS', 'EXTERNAL']) {
      try { await P.Filesystem.mkdir({path: 'yaeyama_capture/' + name, directory: kind, recursive: true}); dir = 'yaeyama_capture/' + name; dirKind = kind; return; }
      catch (e) { if (/exist/i.test(e.message || '')) { dir = 'yaeyama_capture/' + name; dirKind = kind; return; } }
    }
    throw new Error('保存先フォルダを作れませんでした');
  }
  const b64 = async blob => {
    const u8 = new Uint8Array(await blob.arrayBuffer()); let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const web = {};
  function put(name, data) { // data: string（UTF-8）か Blob
    if (!app) { (web[name] = web[name] || []).push(data); return; }
    enq(async () => {
      const path = dir + '/' + S.name + '_' + name; // 送ったあと1か所に混ざっても区別できるよう、ファイル名にも日時を付ける
      if (typeof data === 'string') await P.Filesystem.appendFile({path, directory: dirKind, data, encoding: 'utf8'});
      else await P.Filesystem.appendFile({path, directory: dirKind, data: await b64(data)});
    });
  }
  function saveWeb() {
    for (const [name, parts] of Object.entries(web)) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob(parts)); a.download = S.name + '_' + name;
      document.body.appendChild(a); a.click(); a.remove();
    }
  }

  // ---------- センサー ----------
  const sens = {ori: 0, gyro: 0, q: 0, mag: 0, gps: 0};
  let buf = [], gbuf = [], fbuf = [];
  function onOri(e) { if (!S || !S.rec) return; sens.ori++; buf.push(`${f(e.timeStamp, 2)},ori${e.absolute ? '_abs' : ''},${f(e.alpha)},${f(e.beta)},${f(e.gamma)},`); }
  function onMotion(e) {
    if (!S || !S.rec) return; sens.gyro++;
    const r = e.rotationRate || {}, a = e.accelerationIncludingGravity || {};
    buf.push(`${f(e.timeStamp, 2)},gyro_degps,${f(r.alpha)},${f(r.beta)},${f(r.gamma)},${f(e.interval, 2)}`);
    buf.push(`${f(e.timeStamp, 2)},acc_g,${f(a.x)},${f(a.y)},${f(a.z)},`);
  }
  const extra = [];
  function genericSensors() { // Chrome の Generic Sensor API（使えれば四元数と磁気の生値も残す）
    const t = () => performance.now();
    try {
      if ('AbsoluteOrientationSensor' in window) {
        const s = new AbsoluteOrientationSensor({frequency: 100, referenceFrame: 'device'});
        s.onreading = () => { if (S && S.rec) { sens.q++; const v = s.quaternion; buf.push(`${f(t(), 2)},quat_abs,${f(v[0], 6)},${f(v[1], 6)},${f(v[2], 6)},${f(v[3], 6)}`); } };
        s.onerror = () => {}; s.start(); extra.push(s);
      }
    } catch (e) {}
    try {
      if ('Magnetometer' in window) {
        const s = new Magnetometer({frequency: 50});
        s.onreading = () => { if (S && S.rec) { sens.mag++; buf.push(`${f(t(), 2)},mag_uT,${f(s.x)},${f(s.y)},${f(s.z)},`); } };
        s.onerror = () => {}; s.start(); extra.push(s);
      }
    } catch (e) {}
  }
  async function askMotion() { // iPhone は許可が要る（Android では何もしない）
    for (const E of [window.DeviceOrientationEvent, window.DeviceMotionEvent]) if (E && E.requestPermission) { try { await E.requestPermission(); } catch (e) {} }
  }

  // ---------- GPS（撮影専用に毎回の測位を残す）----------
  let gStop = null;
  function gpsStart() {
    const log = (lat, lon, acc, alt, altAcc, hdg, spd, tEpoch) => {
      if (!S) return; S.lastFix = {acc, t: performance.now()};
      if (!S.rec) return; sens.gps++;
      gbuf.push(`${f(performance.now(), 2)},${tEpoch || ''},${f(lat, 8)},${f(lon, 8)},${f(acc, 2)},${f(alt, 2)},${f(altAcc, 2)},${f(hdg, 2)},${f(spd, 2)}`);
    };
    if (app && P.BackgroundGeolocation) {
      let id = null, off = false;
      P.BackgroundGeolocation.addWatcher({requestPermissions: true, stale: false, distanceFilter: 0}, loc => {
        if (loc) log(loc.latitude, loc.longitude, loc.accuracy, loc.altitude, loc.altitudeAccuracy, loc.bearing, loc.speed, loc.time);
      }).then(x => { id = x; if (off) P.BackgroundGeolocation.removeWatcher({id}); });
      gStop = () => { off = true; if (id) P.BackgroundGeolocation.removeWatcher({id}).catch(() => {}); };
    } else if (navigator.geolocation) {
      const id = navigator.geolocation.watchPosition(p => { const c = p.coords; log(c.latitude, c.longitude, c.accuracy, c.altitude, c.altitudeAccuracy, c.heading, c.speed, p.timestamp); },
        () => {}, {enableHighAccuracy: true, maximumAge: 0});
      gStop = () => navigator.geolocation.clearWatch(id);
    }
  }

  // ---------- カメラ ----------
  async function camStart() {
    if (S.stream) S.stream.getTracks().forEach(t => t.stop());
    const h = +$('capres').value, w = h === 2160 ? 3840 : 1920;
    S.stream = await navigator.mediaDevices.getUserMedia({audio: false, video: {facingMode: {ideal: 'environment'}, width: {ideal: w}, height: {ideal: h}, frameRate: {ideal: 30}}});
    const tr = S.stream.getVideoTracks()[0];
    try { await tr.applyConstraints({advanced: [{focusMode: 'continuous'}]}); } catch (e) {}
    $('capv').srcObject = S.stream;
  }
  function pickMime() {
    for (const m of ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'])
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
    return '';
  }
  // 画面に出たコマの時刻（captureTime はカメラが撮った瞬間。動画とセンサーの時刻合わせに使う）
  function frameLoop() {
    const v = $('capv');
    if (!v.requestVideoFrameCallback) return;
    const cb = (now, md) => {
      if (!S) return;
      if (S.rec) fbuf.push(`${f(now, 2)},${f(md.mediaTime, 4)},${md.presentedFrames},${f(md.captureTime, 2)},${f(md.expectedDisplayTime, 2)}`);
      v.requestVideoFrameCallback(cb);
    };
    v.requestVideoFrameCallback(cb);
  }

  function flush() {
    if (buf.length) { put('sensors.csv', buf.join('\n') + '\n'); buf = []; }
    if (gbuf.length) { put('gps.csv', gbuf.join('\n') + '\n'); gbuf = []; }
    if (fbuf.length) { put('frames.csv', fbuf.join('\n') + '\n'); fbuf = []; }
  }
  function status() {
    if (!S) return;
    const fx = S.lastFix, gpsTxt = fx ? `GPS 誤差 約${Math.round(fx.acc)}m（${Math.round((performance.now() - fx.t) / 1000)}秒前）` : 'GPS 待ち';
    if (!S.rec) { say(`${gpsTxt}\n映像 ${S.vw || '?'}×${S.vh || '?'}　「記録開始」で動画とセンサーの記録を始めます。${app ? '' : '\n（ブラウザ版: 終わると数個のファイルを保存します）'}`); return; }
    const sec = Math.round((performance.now() - S.t0) / 1000);
    say(`● 記録中 ${Math.floor(sec / 60)}:${pad(sec % 60)}　動画 ${(S.bytes / 1e6).toFixed(1)}MB\n${gpsTxt}\nセンサー 向き${sens.ori} ジャイロ${sens.gyro} 四元数${sens.q} 磁気${sens.mag} GPS${sens.gps}${S.err ? '\n⚠ 保存エラー: ' + S.err : ''}`);
  }

  async function open() {
    root.hidden = false; say('カメラを起動しています…');
    S = {rec: false, bytes: 0};
    try {
      await askMotion(); await camStart();
      const st = S.stream.getVideoTracks()[0].getSettings(); S.vw = st.width; S.vh = st.height;
    } catch (e) { say('カメラを開けませんでした: ' + (e.message || e.name) + '\nアプリの権限でカメラを許可してください。'); return; }
    gpsStart(); genericSensors(); frameLoop();
    window.addEventListener('deviceorientationabsolute', onOri); window.addEventListener('deviceorientation', onOri); window.addEventListener('devicemotion', onMotion);
    try { S.wake = await navigator.wakeLock.request('screen'); } catch (e) {}
    S.tick = setInterval(status, 1000); status(); fillRecs();
  }
  async function close() {
    if (S && S.rec) { if (!confirm('記録を終了して閉じますか？')) return; await stop(); }
    if (S) {
      clearInterval(S.tick); if (S.stream) S.stream.getTracks().forEach(t => t.stop());
      if (S.wake) S.wake.release().catch(() => {});
    }
    if (gStop) gStop(); gStop = null;
    extra.splice(0).forEach(s => { try { s.stop(); } catch (e) {} });
    window.removeEventListener('deviceorientationabsolute', onOri); window.removeEventListener('deviceorientation', onOri); window.removeEventListener('devicemotion', onMotion);
    $('capv').srcObject = null; S = null; root.hidden = true;
  }

  async function start() {
    const mime = pickMime();
    if (!mime) { toast('この端末では動画を記録できません'); return; }
    const now = new Date(); S.name = stamp(now);
    if (app) { try { await mkdir(S.name); } catch (e) { say(e.message); return; } }
    Object.keys(web).forEach(k => delete web[k]); Object.keys(sens).forEach(k => { sens[k] = 0; });
    buf = []; gbuf = []; fbuf = [];
    put('sensors.csv', 't_ms,kind,a,b,c,d\n');
    put('gps.csv', 't_ms,t_epoch_ms,lat,lon,acc_m,alt_m,alt_acc_m,heading_deg,speed_mps\n');
    put('frames.csv', 't_ms,media_time_s,presented_frames,capture_time_ms,expected_display_ms\n');
    const tr = S.stream.getVideoTracks()[0];
    let caps = {}; try { caps = tr.getCapabilities ? tr.getCapabilities() : {}; } catch (e) {}
    S.meta = {app: app ? 'android' : 'web', ua: navigator.userAgent, started: now.toISOString(), epoch0: Date.now(), perf0: performance.now(),
      video: {mime, settings: tr.getSettings(), capabilities: caps, label: tr.label}, screen: {w: screen.width, h: screen.height, angle: screen.orientation ? screen.orientation.angle : window.orientation},
      notes: 'センサーと frames の t_ms は performance.now()。epoch_ms = t_ms - perf0 + epoch0。ori の alpha/beta/gamma は度（W3C DeviceOrientation、ori_abs は北基準）。gyro は端末座標の回転速度（度/秒）、acc_g は重力込み加速度（m/s²）、quat_abs は端末→地球（東北上）の四元数 x,y,z,w。'};
    S.rec = true; S.t0 = performance.now(); S.bytes = 0; S.err = null;
    const h = +$('capres').value;
    S.mr = new MediaRecorder(S.stream, {mimeType: mime, videoBitsPerSecond: h === 2160 ? 25e6 : 12e6});
    S.ext = mime.includes('mp4') ? 'mp4' : 'webm';
    S.mr.onstart = () => { S.meta.rec_start_t_ms = performance.now(); };
    S.mr.ondataavailable = e => { if (e.data && e.data.size) { S.bytes += e.data.size; put('video.' + S.ext, e.data); } };
    S.mr.start(1000);
    S.flushT = setInterval(flush, 3000);
    S.oriL = () => buf.push(`${f(performance.now(), 2)},screen_angle,${screen.orientation ? screen.orientation.angle : window.orientation},,,`);
    window.addEventListener('orientationchange', S.oriL); S.oriL();
    $('capgo').textContent = '■ 記録終了'; $('capgo').classList.add('on'); $('capres').disabled = true; status();
  }
  async function stop() {
    S.rec = false; clearInterval(S.flushT); window.removeEventListener('orientationchange', S.oriL);
    await new Promise(r => { S.mr.onstop = r; S.mr.stop(); });
    S.meta.rec_stop_t_ms = performance.now(); S.meta.video_bytes = S.bytes; S.meta.counts = {...sens};
    flush(); put('meta.json', JSON.stringify(S.meta, null, 1));
    $('capgo').textContent = '● 記録開始'; $('capgo').classList.remove('on'); $('capres').disabled = false;
    if (app) {
      say('保存しています…'); await q;
      say((S.err ? '⚠ 保存中にエラーがありました: ' + S.err + '\n' : '') + `保存しました: 端末の ${dirKind === 'DOCUMENTS' ? 'Documents' : 'Android/data/jp.yaeyama.depthmap/files'}/${dir}/\n（video.${S.ext}, sensors.csv, gps.csv, frames.csv, meta.json）「PCに送る」→「ドライブ」でモバイル通信のまま PC に届けられます（USBでもOK）。`);
      fillRecs();
    } else { saveWeb(); say('ファイルを保存しました（ダウンロードフォルダ）。'); }
  }

  // ---------- PCへ送る（Android の共有。Quick Share で Windows へ、または Google ドライブへ）----------
  async function listRecs() {
    const out = [];
    for (const kind of ['DOCUMENTS', 'EXTERNAL']) {
      try { (await P.Filesystem.readdir({path: 'yaeyama_capture', directory: kind})).files.forEach(f => { if (f.type === 'directory') out.push({name: f.name, kind}); }); } catch (e) {}
    }
    return out.sort((a, b) => b.name.localeCompare(a.name));
  }
  async function fillRecs() {
    if (!app) return;
    const recs = await listRecs(), sel = $('capsel');
    sel.innerHTML = recs.map(r => `<option value="${r.kind}|${r.name}">${r.name.replace(/^(\d{4})(\d\d)(\d\d)_(\d\d)(\d\d)(\d\d)$/, '$2/$3 $4:$5')}</option>`).join('');
    $('capsendrow').hidden = !recs.length;
  }
  async function send() {
    const [kind, name] = $('capsel').value.split('|'), path = 'yaeyama_capture/' + name;
    const files = (await P.Filesystem.readdir({path, directory: kind})).files.filter(f => f.type === 'file');
    const uris = [];
    for (const f of files) uris.push((await P.Filesystem.getUri({path: path + '/' + f.name, directory: kind})).uri);
    const mb = files.reduce((a, f) => a + (f.size || 0), 0) / 1e6;
    say(`送り先を選んでください（${files.length}ファイル、約${Math.round(mb)}MB）。\nモバイル通信なら「ドライブ」を選び、フォルダ yaeyama_capture に保存。\n（PCの Google ドライブ（パソコン版）に自動で届きます。近くにPCがあれば Quick Share でも可）`);
    try { await P.Share.share({title: '撮影 ' + name, files: uris}); }
    catch (e) { if (!/cancel/i.test(e.message || '')) say('送れませんでした: ' + (e.message || e)); }
  }
  $('capsend').onclick = () => { send().catch(e => say('送れませんでした: ' + (e.message || e))); };

  $('capgo').onclick = () => { if (!S) return; (S.rec ? stop() : start()).catch(e => say('エラー: ' + (e.message || e))); };
  $('capclose').onclick = () => { close(); };
  $('capres').onchange = async () => { if (S && !S.rec) { try { await camStart(); const st = S.stream.getVideoTracks()[0].getSettings(); S.vw = st.width; S.vh = st.height; status(); } catch (e) { say('カメラを切り替えられませんでした'); } } };
})();
