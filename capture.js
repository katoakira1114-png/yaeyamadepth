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
#capgo.on{background:#c62828;border-color:#ff8a80}
#capdim{position:fixed;inset:0;background:#000;z-index:21;display:flex;align-items:flex-end;justify-content:center;padding-bottom:40px;color:#556;font-size:14px;text-align:center;white-space:pre-line}
#capdim[hidden]{display:none}
#cap.rec video{flex:none;height:28vh}`;
  document.head.appendChild(css);
  const root = document.createElement('div');
  root.id = 'cap'; root.hidden = true;
  root.innerHTML = `<video id="capv" playsinline muted autoplay></video>
<div id="capbar"><div id="capstat">準備中…</div><div id="capmsg" style="font-size:13px;color:#ffe08a;white-space:pre-line"></div>
<div class="row"><select id="capres" class="fld" style="width:auto"><option value="2160">4K</option><option value="1080">1080p</option></select>
<select id="capmode" class="fld" style="width:auto"><option value="walk">歩き</option><option value="tow">海面曳航（長時間）</option></select>
<button class="pri" id="capgo">● 記録開始</button><button id="capclose">閉じる</button><button id="capdimb">画面を暗く</button></div>
<div class="row" id="capsendrow" hidden><select id="capsel" class="fld" style="width:auto;max-width:60%"></select><button id="capsend">PCに送る</button></div>
<small id="caphelp" style="color:#9fb0d8"></small></div>`;
  document.body.appendChild(root);
  const dim = document.createElement('div');
  dim.id = 'capdim'; dim.hidden = true; dim.textContent = '記録は続いています\nタップで画面を戻す';
  document.body.appendChild(dim);
  dim.onclick = () => { dim.hidden = true; };
  // 海面曳航: タッパー等に入れて引っぱり、真下（やや斜め）の海底を長時間撮る。
  // 落ちても失う分が少ないよう動画を5分ごとに別ファイルにし、送信は帰宅後に手動（自動でドライブへは送らない）。
  const MODES = {
    walk: {seg: 0, rate4k: 25e6, auto: true, help: 'スマホは横向きで、建物に向けて斜め前方を写しながら、ゆっくり歩いてください。1ブロック一周して始点に戻ると、ずれの計算がしやすくなります。'},
    tow: {seg: 300e3, rate4k: 16e6, auto: false, help: 'カメラを真下（少し斜め）の海底に向け、隣の列と半分以上重なるよう、まっすぐ往復してください。最初と最後にGPSの画面か時計を2〜3秒写すと時刻合わせが確実になります。動画は5分ごとに分けて保存し、送信は帰宅後にWi-Fiで「ドライブに送る」を押します。記録中は「画面を暗く」で発熱と電池を抑えられます。'}
  };
  const mode = () => MODES[$('capmode').value] || MODES.walk;
  try { const m = localStorage.getItem('capmode'); if (m && MODES[m]) $('capmode').value = m; } catch (e) {}
  const help = () => { $('caphelp').textContent = mode().help; };
  help();
  $('capmode').onchange = () => { try { localStorage.setItem('capmode', $('capmode').value); } catch (e) {} help(); };

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
  const note = t => { $('capmsg').textContent = t; }; // 保存・送信の知らせ（毎秒の状態表示で消えないよう別の行）

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
  const sens = {ori: 0, gyro: 0, q: 0, mag: 0, gps: 0, native: 0};
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
    if (gStop) gStop(); // 前の待ち受けが残ると同じ測位が何重にも記録される
    let lastEpoch = null;
    const log = (lat, lon, acc, alt, altAcc, hdg, spd, tEpoch) => {
      if (!S) return; S.lastFix = {acc, t: performance.now()};
      if (tEpoch && tEpoch === lastEpoch) return; lastEpoch = tEpoch;
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
    if (!S.rec) { say(`${gpsTxt}\n映像 ${S.vw || '?'}×${S.vh || '?'}　「記録開始」で動画とセンサーの記録を始めます。${app ? '' : '\n（ブラウザ版: 終わると数個のファイルを保存します）'}${S.lastSum ? '\n' + S.lastSum : ''}`); return; }
    const sec = Math.round((performance.now() - S.t0) / 1000);
    if (NSENS && S.meta.native_sensors) NSENS.status().then(r => { sens.native = r.rows; }).catch(() => {});
    const segTxt = S.seg ? `（${S.seg}本目）` : '', batTxt = S.bat ? `　電池 ${Math.round(S.bat.level * 100)}%` : '';
    say(`● 記録中 ${Math.floor(sec / 60)}:${pad(sec % 60)}　動画 ${(S.bytes / 1e6).toFixed(0)}MB${segTxt}${batTxt}\n${gpsTxt}\nセンサー ${NSENS ? `ネイティブ${sens.native || 0}` : `向き${sens.ori} ジャイロ${sens.gyro} 四元数${sens.q} 磁気${sens.mag}`} GPS${sens.gps}${S.err ? '\n⚠ 保存エラー: ' + S.err : ''}`);
  }

  // Pixel の WebView では4K記録中にタイマーや再描画が止まることがあるので、録画データが届くたびにも表示を更新する。
  // 記録中はプレビューを小さくして描画の負担を減らす
  let lastTick = 0;
  function tick() { const t = performance.now(); if (t - lastTick > 900) { lastTick = t; status(); } }
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
    try { S.bat = await navigator.getBattery(); } catch (e) {}
    document.addEventListener('visibilitychange', reWake);
    S.tick = setInterval(tick, 1000); status(); fillRecs();
  }
  async function reWake() { // 画面ロックが外れることがあるので、戻ってきたら取り直す
    if (S && document.visibilityState === 'visible' && (!S.wake || S.wake.released)) { try { S.wake = await navigator.wakeLock.request('screen'); } catch (e) {} }
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
    document.removeEventListener('visibilitychange', reWake); dim.hidden = true;
    $('capv').srcObject = null; S = null; root.hidden = true;
  }

  async function start() {
    const mime = pickMime();
    if (!mime) { toast('この端末では動画を記録できません'); return; }
    S.mr = null;
    // 画面を消したあとなどでカメラが止まっていることがある。止まっていれば開き直してから記録する
    const tr0 = S.stream && S.stream.getVideoTracks()[0];
    if (!tr0 || tr0.readyState === 'ended') {
      say('カメラを開き直しています…');
      try { await camStart(); } catch (e) { say('カメラを開けませんでした: ' + (e.message || e.name)); return; }
    }
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
    const h = +$('capres').value, M = mode();
    S.mode = $('capmode').value; S.meta.mode = S.mode; S.auto = M.auto;
    S.rate = h === 2160 ? M.rate4k : 12e6; S.mime = mime;
    S.ext = mime.includes('mp4') ? 'mp4' : 'webm';
    if (M.seg) { // 区切り: 新しい録画を始めてから古い方を止めるので、つなぎ目で映像が抜けない（数コマ重なる）
      S.meta.segments = []; S.seg = 0; S.mr = newRec();
      S.segT = setInterval(() => { if (!S || !S.rec) return; const old = S.mr; S.mr = newRec(); old.stop(); }, M.seg);
    } else {
      S.mr = new MediaRecorder(S.stream, {mimeType: mime, videoBitsPerSecond: S.rate});
      S.mr.onstart = () => { S.meta.rec_start_t_ms = performance.now(); };
      S.mr.ondataavailable = e => { if (e.data && e.data.size) { S.bytes += e.data.size; put('video.' + S.ext, e.data); tick(); } };
      S.mr.start(1000);
    }
    if (NSENS) { // WebView のセンサーイベントは届かない端末があるので、アプリではネイティブでも記録する
      const b = performance.now();
      try {
        const r = await NSENS.start({path: dir + '/' + S.name + '_sensors_native.csv', directory: dirKind});
        S.meta.native_sensors = {...r, perf_before: b, perf_after: performance.now(),
          notes: 't_ns は elapsedRealtimeNanos（センサー時刻）。perf_ms ≈ (t_ns - elapsed_ns)/1e6 + (perf_before+perf_after)/2。rotvec/gamerot は四元数 x,y,z,w（端末→東北上）、gyro_rads は rad/s、acc_mps2 は m/s²。'};
      } catch (e) { S.err = 'センサー記録: ' + (e.message || e); }
    }
    S.flushT = setInterval(flush, 3000);
    S.oriL = () => buf.push(`${f(performance.now(), 2)},screen_angle,${screen.orientation ? screen.orientation.angle : window.orientation},,,`);
    window.addEventListener('orientationchange', S.oriL); S.oriL();
    root.classList.add('rec'); $('capgo').textContent = '■ 記録終了'; $('capgo').classList.add('on'); $('capres').disabled = true; $('capmode').disabled = true; status();
  }
  function newRec() { // 区切り録画の1本（video_001.mp4 …）。開始・終了の時刻は meta.segments と sensors.csv に残す
    const n = ++S.seg, name = `video_${String(n).padStart(3, '0')}.${S.ext}`, seg = {file: S.name + '_' + name};
    const mr = new MediaRecorder(S.stream, {mimeType: S.mime, videoBitsPerSecond: S.rate});
    mr.onstart = () => { seg.start_t_ms = performance.now(); if (n === 1) S.meta.rec_start_t_ms = seg.start_t_ms; buf.push(`${f(seg.start_t_ms, 2)},seg_start,${n},,,`); };
    mr.ondataavailable = e => { if (e.data && e.data.size) { S.bytes += e.data.size; put(name, e.data); tick(); } };
    mr.addEventListener('stop', () => { seg.stop_t_ms = performance.now(); buf.push(`${f(seg.stop_t_ms, 2)},seg_stop,${n},,,`); });
    S.meta.segments.push(seg); mr.start(1000);
    return mr;
  }
  async function stop() {
    S.rec = false; clearInterval(S.flushT); clearInterval(S.segT); window.removeEventListener('orientationchange', S.oriL);
    await new Promise(r => { S.mr.addEventListener('stop', r); S.mr.stop(); });
    if (NSENS && S.meta.native_sensors) { try { const r = await NSENS.stop(); S.meta.native_sensors.rows = r.rows; sens.native = r.rows; } catch (e) {} }
    S.meta.rec_stop_t_ms = performance.now(); S.meta.video_bytes = S.bytes; S.meta.counts = {...sens};
    // 記録中の表示が止まる端末があるので、終わったあとに何が取れたかを必ず出す
    S.lastSum = `前回の記録: ${Math.round((S.meta.rec_stop_t_ms - S.t0) / 1000)}秒　動画 ${(S.bytes / 1e6).toFixed(1)}MB　GPS ${sens.gps}　ネイティブ ${sens.native}（向き${sens.ori} ジャイロ${sens.gyro} 四元数${sens.q} 磁気${sens.mag}）`;
    flush(); put('meta.json', JSON.stringify(S.meta, null, 1));
    root.classList.remove('rec'); status(); $('capgo').textContent = '● 記録開始'; $('capgo').classList.remove('on'); $('capres').disabled = false; $('capmode').disabled = false; dim.hidden = true;
    if (app) {
      note('保存しています…'); await q;
      note((S.err ? '⚠ 保存中にエラーがありました: ' + S.err + '\n' : '') + S.lastSum + `\n保存しました: 端末の ${dirKind === 'DOCUMENTS' ? 'Documents' : 'Android/data/jp.yaeyama.depthmap/files'}/${dir}/`);
      await fillRecs();
      if (DRIVE && S.auto) send(); // 歩きは撮り終えたら自動でドライブへ（海面曳航は帰宅後に手動）
      else if (!S.auto) note($('capmsg').textContent + '\n帰宅後、Wi-Fiにつないでから下の「' + $('capsend').textContent + '」を押してください。');
    } else { saveWeb(); note('ファイルを保存しました（ダウンロードフォルダ）。'); }
  }

  // ---------- PCへ送る ----------
  // 新しいAPK（DriveUpload あり）: Google ドライブの yaeyama_capture へ直接アップロード（モバイル通信可、PCの「ドライブ（パソコン版）」に届く）
  // 古いAPK: Android の共有画面で送る
  const NSENS = app && window.Capacitor.isPluginAvailable && window.Capacitor.isPluginAvailable('SensorLog') ? P.SensorLog : null;
  const DRIVE = app && window.Capacitor.isPluginAvailable && window.Capacitor.isPluginAvailable('DriveUpload') ? P.DriveUpload : null;
  if (DRIVE) {
    $('capsend').textContent = 'ドライブに送る';
    DRIVE.addListener('progress', d => note(`ドライブへ送信中 ${d.done}/${d.of}: ${d.file}\n${(d.sent / 1e6).toFixed(1)} / ${(d.total / 1e6).toFixed(1)} MB（アプリを閉じないでください）`));
  }
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
  let sending = false;
  async function send() {
    if (sending) return;
    const c = navigator.connection;
    if (c && c.type === 'cellular' && !confirm('いまはモバイル通信です。動画は数GBあるので、Wi-Fiでの送信をおすすめします。このまま送りますか？')) return;
    const [kind, name] = $('capsel').value.split('|'), path = 'yaeyama_capture/' + name;
    if (DRIVE) {
      sending = true; $('capsend').disabled = true;
      try {
        note('Google の許可を確認しています…');
        const {token} = await DRIVE.authorize();
        note('ドライブへ送り始めます…');
        const r = await DRIVE.upload({token, path, directory: kind});
        note(`ドライブに送りました（${r.uploaded}ファイル${r.skipped ? '、送信済み' + r.skipped + 'は省略' : ''}）。PCの マイドライブ\\yaeyama_capture に届きます。`);
      } catch (e) { note('⚠ 送れませんでした: ' + (e.message || e) + '\n電波の良い所で「ドライブに送る」を押すと、続きから送り直します。'); }
      finally { sending = false; $('capsend').disabled = false; }
      return;
    }
    const files = (await P.Filesystem.readdir({path, directory: kind})).files.filter(f => f.type === 'file');
    const uris = [];
    for (const f of files) uris.push((await P.Filesystem.getUri({path: path + '/' + f.name, directory: kind})).uri);
    note('送り先で「ドライブ」を選び、フォルダ yaeyama_capture に保存してください。');
    try { await P.Share.share({title: '撮影 ' + name, files: uris}); }
    catch (e) { if (!/cancel/i.test(e.message || '')) note('送れませんでした: ' + (e.message || e)); }
  }
  $('capsend').onclick = () => { send().catch(e => note('送れませんでした: ' + (e.message || e))); };

  $('capgo').onclick = () => {
    if (!S || S.busy) return; S.busy = true; // 連打で記録が細切れにならないよう、前の操作が終わるまで受け付けない
    (S.rec ? stop() : start()).catch(e => {
      if (S && S.rec && !S.mr) { S.rec = false; clearInterval(S.flushT); clearInterval(S.segT); } // 録画が始められなかった
      say('エラー: ' + (e.message || e) + '\nもう一度「記録開始」を押してください。');
    }).finally(() => { if (S) S.busy = false; });
  };
  $('capclose').onclick = () => { close(); };
  $('capdimb').onclick = () => { dim.hidden = false; };
  $('capres').onchange = async () => { if (S && !S.rec) { try { await camStart(); const st = S.stream.getVideoTracks()[0].getSettings(); S.vw = st.width; S.vh = st.height; status(); } catch (e) { say('カメラを切り替えられませんでした'); } } };
})();
