'use strict';
// Track log, waypoints, geotagged photos and the switch to the 3D view.
// Shares app.js's top-level bindings (META, here, view, g2s, requestDraw, ...); app.js calls the hooks
// drawOverlays / onFix / tapHit / tapExtra / tapWire / extrasInit when they exist.

// ---------- small IndexedDB key-value store (survives better than localStorage, holds photo blobs) ----------
const kv = (() => {
  let dbp = null;
  const db = () => dbp || (dbp = new Promise((ok, ng) => {
    const r = indexedDB.open('yaeyama', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => ok(r.result); r.onerror = () => ng(r.error);
  }));
  const tx = async (mode, f) => {
    const d = await db();
    return new Promise((ok, ng) => { const t = d.transaction('kv', mode), r = f(t.objectStore('kv')); t.oncomplete = () => ok(r && r.result); t.onerror = () => ng(t.error); });
  };
  return {get: k => tx('readonly', s => s.get(k)), set: (k, v) => tx('readwrite', s => s.put(v, k)), del: k => tx('readwrite', s => s.delete(k)), keys: () => tx('readonly', s => s.getAllKeys())};
})();

const pad2 = n => String(n).padStart(2, '0');
const dayKey = t => { const d = new Date(t); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const hm = t => { const d = new Date(t); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const fmtDist = m => m >= 1000 ? (m / 1000).toFixed(2) + ' km' : Math.round(m) + ' m';
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]);
function toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(() => { t.hidden = true; }, 3500); }

// ---------- track ----------
// points are [time ms, lat, lon, accuracy m]; one record per day ("trk:YYYY-MM-DD")
let trk = {day: dayKey(Date.now()), pts: []}, trkDirty = false, shownDay = dayKey(Date.now()), shownPts = null, showTrack = true;
async function loadTrack(day) { return (await kv.get('trk:' + day).catch(() => null)) || []; }
async function saveTrack() { if (!trkDirty) return; trkDirty = false; await kv.set('trk:' + trk.day, trk.pts).catch(() => { trkDirty = true; }); }
setInterval(saveTrack, 15000);
document.addEventListener('visibilitychange', () => { if (document.hidden) saveTrack(); else if (wakeOn) requestWake(); });
addEventListener('pagehide', saveTrack);
function curShown() { return shownDay === trk.day ? trk.pts : (shownPts || []); }

function onFix(p) {
  const {latitude: lat, longitude: lon, accuracy: acc} = p.coords, t = p.timestamp || Date.now();
  if (acc > 50) return;
  const day = dayKey(t);
  if (day !== trk.day) { saveTrack(); if (shownDay === trk.day) shownDay = day; trk = {day, pts: []}; }
  const last = trk.pts[trk.pts.length - 1];
  if (last) {
    const [a, b] = ll2g(last[1], last[2]), [c, d] = ll2g(lat, lon), m = Math.hypot(a - c, b - d);
    if (m < 5 && t - last[0] < 60000) return;
    if (m < 1) return;
  }
  trk.pts.push([t, +lat.toFixed(6), +lon.toFixed(6), Math.round(acc)]); trkDirty = true;
  clearTimeout(onFix.h);
  if (document.hidden) saveTrack(); else onFix.h = setTimeout(saveTrack, 2000); // the page can be killed at any moment on a phone
  window.dispatchEvent(new Event('trackchange'));
}
function trackStats(pts) {
  let m = 0;
  for (let i = 1; i < pts.length; i++) { const [a, b] = ll2g(pts[i - 1][1], pts[i - 1][2]), [c, d] = ll2g(pts[i][1], pts[i][2]); m += Math.hypot(a - c, b - d); }
  return {m, t0: pts.length ? pts[0][0] : 0, t1: pts.length ? pts[pts.length - 1][0] : 0};
}
// position at time t from the track of that day (interpolated, within 10 minutes of a fix)
async function positionAt(t) {
  const pts = dayKey(t) === trk.day ? trk.pts : await loadTrack(dayKey(t));
  if (!pts.length) return null;
  let i = pts.findIndex(p => p[0] >= t);
  if (i === 0) return t >= pts[0][0] - 600000 ? {lat: pts[0][1], lon: pts[0][2]} : null;
  if (i < 0) { const l = pts[pts.length - 1]; return t - l[0] <= 600000 ? {lat: l[1], lon: l[2]} : null; }
  const a = pts[i - 1], b = pts[i];
  if (b[0] - a[0] > 1200000) { const n = t - a[0] < b[0] - t ? a : b; return Math.abs(n[0] - t) <= 600000 ? {lat: n[1], lon: n[2]} : null; }
  const f = (t - a[0]) / Math.max(b[0] - a[0], 1);
  return {lat: a[1] + (b[1] - a[1]) * f, lon: a[2] + (b[2] - a[2]) * f};
}

// ---------- waypoints & photos ----------
let wpts = [], photos = [];
const saveWpts = () => kv.set('wpts', wpts).catch(() => toast('保存できませんでした'));
const savePhotos = () => kv.set('photos', photos).catch(() => toast('保存できませんでした'));
async function addWaypoint(lat, lon, name) {
  const [gx, gy] = ll2g(lat, lon), r = await depthAt(gx, gy);
  const w = {id: Date.now().toString(36), name: name || `地点${wpts.length + 1}`, lat: +lat.toFixed(6), lon: +lon.toFixed(6), d: r && r.d >= 0 ? +r.d.toFixed(1) : null, t: Date.now()};
  wpts.push(w); await saveWpts(); requestDraw(); window.dispatchEvent(new Event('marks'));
  toast(`「${w.name}」を登録しました${w.d != null ? `（水深 ${w.d} m）` : ''}`);
  return w;
}

async function resizeJPEG(file, max) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height)), c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise(ok => c.toBlob(ok, 'image/jpeg', 0.85));
}
async function addPhoto(file, pos, t, src) {
  const id = t.toString(36) + Math.random().toString(36).slice(2, 6);
  const [big, th] = [await resizeJPEG(file, 1600), await resizeJPEG(file, 240)];
  await kv.set('ph:' + id, big); await kv.set('th:' + id, th);
  const [gx, gy] = ll2g(pos.lat, pos.lon), r = await depthAt(gx, gy);
  photos.push({id, t, lat: +pos.lat.toFixed(6), lon: +pos.lon.toFixed(6), d: r && r.d >= 0 ? +r.d.toFixed(1) : null, src});
  photos.sort((a, b) => a.t - b.t); await savePhotos(); requestDraw(); window.dispatchEvent(new Event('marks'));
}

// minimal EXIF reader: DateTimeOriginal (+offset) and GPS position from a JPEG
async function readExif(file) {
  try {
    const v = new DataView(await file.slice(0, 256 * 1024).arrayBuffer());
    if (v.getUint16(0) !== 0xFFD8) return {};
    let o = 2;
    while (o < v.byteLength - 4) {
      const m = v.getUint16(o), len = v.getUint16(o + 2);
      if (m === 0xFFE1 && v.getUint32(o + 4) === 0x45786966) {
        const T = o + 10, le = v.getUint16(T) === 0x4949, u16 = p => v.getUint16(T + p, le), u32 = p => v.getUint32(T + p, le);
        const ifd = p => { const n = u16(p), e = {}; for (let i = 0; i < n; i++) { const q = p + 2 + i * 12; e[u16(q)] = {type: u16(q + 2), cnt: u32(q + 4), at: q + 8}; } return e; };
        const str = en => { const p = en.cnt > 4 ? u32(en.at) : en.at; let s = ''; for (let i = 0; i < en.cnt - 1; i++) s += String.fromCharCode(v.getUint8(T + p + i)); return s; };
        const rats = en => { const p = u32(en.at), a = []; for (let i = 0; i < en.cnt; i++) a.push(u32(p + i * 8) / u32(p + i * 8 + 4)); return a; };
        const ref = en => String.fromCharCode(v.getUint8(T + en.at));
        const out = {}, i0 = ifd(u32(4));
        if (i0[0x8769]) {
          const ex = ifd(u32(i0[0x8769].at));
          if (ex[0x9003]) {
            const s = str(ex[0x9003]).match(/(\d+):(\d+):(\d+) (\d+):(\d+):(\d+)/), off = ex[0x9011] ? str(ex[0x9011]) : null;
            if (s) out.t = off ? Date.parse(`${s[1]}-${s[2]}-${s[3]}T${s[4]}:${s[5]}:${s[6]}${off}`) : new Date(+s[1], s[2] - 1, +s[3], +s[4], +s[5], +s[6]).getTime();
          }
        }
        if (i0[0x8825]) {
          const g = ifd(u32(i0[0x8825].at));
          if (g[2] && g[4]) {
            const dms = a => a[0] + a[1] / 60 + a[2] / 3600;
            out.lat = dms(rats(g[2])) * (g[1] && ref(g[1]) === 'S' ? -1 : 1); out.lon = dms(rats(g[4])) * (g[3] && ref(g[3]) === 'W' ? -1 : 1);
          }
        }
        return out;
      }
      if ((m & 0xFF00) !== 0xFF00) break;
      o += 2 + len;
    }
  } catch (e) {}
  return {};
}

$('cam').onchange = async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  const t = Date.now();
  let pos = here && here.t && t - here.t < 120000 ? {lat: here.lat, lon: here.lon} : await positionAt(t);
  if (!pos) { toast('位置がわからないので、写真の場所を記録できませんでした（位置情報が取れているか確認してください）'); return; }
  toast('写真を保存しています…');
  try { await addPhoto(f, pos, t, 'camera'); toast('写真を撮った場所に記録しました'); } catch (err) { toast('写真を保存できませんでした'); }
};
$('imp').onchange = async e => {
  const files = [...e.target.files]; e.target.value = '';
  let ok = 0, ng = 0;
  toast(`${files.length}枚を読み込んでいます…`);
  for (const f of files) {
    const x = await readExif(f), t = x.t || f.lastModified;
    const pos = x.lat != null ? {lat: x.lat, lon: x.lon} : await positionAt(t);
    if (!pos) { ng++; continue; }
    try { await addPhoto(f, pos, t, 'import'); ok++; } catch (err) { ng++; }
  }
  toast(`${ok}枚に場所を付けました${ng ? `。${ng}枚は撮った時刻の航跡がないため、付けられませんでした` : ''}`);
  if (!$('trk').hidden) openTrack(shownDay);
};

// ---------- 2D overlays ----------
const TRK_COL = Array.from({length: 16}, (_, i) => { const f = i / 15; return `rgb(255,${Math.round(230 - 170 * f)},${Math.round(90 - 60 * f)})`; });
function drawOverlays() {
  const pts = showTrack ? curShown() : [];
  if (pts.length > 1) {
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = 3 * dpr; ctx.globalAlpha = .85;
    const n = pts.length, bins = TRK_COL.length;
    for (let b = 0; b < bins; b++) {
      const i0 = Math.floor(b * (n - 1) / bins), i1 = Math.floor((b + 1) * (n - 1) / bins);
      if (i1 <= i0) continue;
      ctx.strokeStyle = TRK_COL[b]; ctx.beginPath();
      for (let i = i0; i <= i1; i++) { const [gx, gy] = ll2g(pts[i][1], pts[i][2]), [sx, sy] = g2s(gx, gy); i === i0 ? ctx.moveTo(sx, sy) : ctx.lineTo(sx, sy); }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    const [sx, sy] = g2s(...ll2g(pts[0][1], pts[0][2]));
    ctx.fillStyle = '#ffe066'; ctx.strokeStyle = '#333'; ctx.lineWidth = 1.5 * dpr; ctx.beginPath(); ctx.arc(sx, sy, 5 * dpr, 0, 7); ctx.fill(); ctx.stroke();
  }
  const label = view.s * META.st >= 1.5;
  ctx.font = `600 ${12 * dpr}px sans-serif`; ctx.textBaseline = 'middle';
  for (const w of wpts) {
    const [sx, sy] = g2s(...ll2g(w.lat, w.lon)), r = 7 * dpr;
    ctx.fillStyle = '#ff4fa3'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 * dpr;
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx - r * .8, sy - r * 1.6); ctx.arc(sx, sy - r * 2, r, Math.PI * .8, Math.PI * .2); ctx.closePath(); ctx.fill(); ctx.stroke();
    if (label) { ctx.lineWidth = 3 * dpr; ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.strokeText(w.name, sx + r * 1.4, sy - r * 2); ctx.fillStyle = '#fff'; ctx.fillText(w.name, sx + r * 1.4, sy - r * 2); }
  }
  for (const p of photos) {
    if (showTrack === false && dayKey(p.t) === shownDay) continue;
    const [sx, sy] = g2s(...ll2g(p.lat, p.lon)), r = 7 * dpr;
    ctx.fillStyle = '#a259ff'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 * dpr;
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(sx - r, sy - r * .75, r * 2, r * 1.5, 3 * dpr) : ctx.rect(sx - r, sy - r * .75, r * 2, r * 1.5); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(sx, sy, r * .38, 0, 7); ctx.fill();
  }
}
function tapHit(sx, sy) {
  const lim = 22 * dpr;
  let best = null, bd = lim;
  for (const p of photos) { const [x, y] = g2s(...ll2g(p.lat, p.lon)), d = Math.hypot(x - sx, y - sy); if (d < bd) { bd = d; best = p; } }
  if (best) { openPhoto(best.id); return true; }
  for (const w of wpts) { const [x, y] = g2s(...ll2g(w.lat, w.lon)), d = Math.hypot(x - sx, y - (sy + 14 * dpr)); if (d < lim) { tapPt = ll2g(w.lat, w.lon); requestDraw(); showTap(); return true; } }
  return false;
}
function wpAt(pt) { return wpts.find(w => { const [gx, gy] = ll2g(w.lat, w.lon); return Math.hypot(gx - pt[0], gy - pt[1]) < 1; }); }
function tapExtra(pt) {
  const w = wpAt(pt);
  return w ? `<br><b style="color:#ff8cc6">登録地点「${esc(w.name)}」</b>（${new Date(w.t).toLocaleString('ja-JP')}）${w.note ? `<div class="memo">${esc(w.note).replace(/\n/g, '<br>')}</div>` : ''}<br><button id="bTapEdit" data-id="${w.id}" style="margin-top:6px;padding:5px 12px">詳細・メモ</button>`
    : `<br><button id="bTapReg" style="margin-top:6px;padding:5px 12px">ここを地点登録</button>`;
}
function tapWire() {
  const b = $('bTapReg');
  if (b) b.onclick = async () => { const [lat, lon] = g2ll(tapPt[0], tapPt[1]); const w = await addWaypoint(lat, lon); showTap(); openWpEdit(w); };
  const e = $('bTapEdit');
  if (e) e.onclick = () => openWpEdit(wpts.find(w => w.id === e.dataset.id));
}

// ---------- sheets ----------
function openWp() {
  const rows = wpts.slice().reverse().map(w => {
    const dist = here ? ' ・ ' + fmtDist(Math.hypot(...[0, 1].map(i => ll2g(w.lat, w.lon)[i] - [here.gx, here.gy][i]))) : '';
    return `<div class="li"><div><b>${esc(w.name)}</b><br><small>${w.d != null ? w.d + ' m' : '—'} ・ ${new Date(w.t).toLocaleString('ja-JP', {month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'})}${dist}</small>${w.note ? `<div class="memo">${esc(w.note)}</div>` : ''}</div>
      <div class="ops"><button data-go="${w.id}">地図</button><button data-ren="${w.id}">詳細</button></div></div>`;
  }).join('') || '<p>まだ登録した地点はありません。</p>';
  $('wplist').innerHTML = rows;
  $('wp').hidden = false;
}
$('wplist').onclick = async e => {
  const b = e.target.closest('button'); if (!b) return;
  const id = b.dataset.go || b.dataset.ren || b.dataset.del, w = wpts.find(x => x.id === id); if (!w) return;
  if (b.dataset.go) { $('wp').hidden = true; goTo(w.lat, w.lon); tapPt = ll2g(w.lat, w.lon); showTap(); }
  if (b.dataset.ren) openWpEdit(w);
};
function goTo(lat, lon) { setFollow(false); const [gx, gy] = ll2g(lat, lon); view.cx = gx; view.cy = gy; if (view.s < 0.1 * dpr) view.s = 0.15 * dpr; requestDraw(); }
$('bWp').onclick = openWp;
$('bWpHere').onclick = async () => { if (!here) { toast('現在地がまだわかりません'); return; } const w = await addWaypoint(here.lat, here.lon); openWp(); openWpEdit(w); };

// edit name and memo of a waypoint; the memo can be dictated
let wpEdit = null;
function openWpEdit(w) {
  if (!w) return;
  wpEdit = w; $('wpename').value = w.name; $('wpenote').value = w.note || '';
  $('wpeinfo').textContent = `${w.d != null ? '推定水深 ' + w.d + ' m ・ ' : ''}${new Date(w.t).toLocaleString('ja-JP')}`;
  $('wpe').hidden = false;
}
$('bWpeSave').onclick = async () => {
  stopDictation();
  wpEdit.name = $('wpename').value.trim() || wpEdit.name; wpEdit.note = $('wpenote').value.trim();
  await saveWpts(); $('wpe').hidden = true; requestDraw(); window.dispatchEvent(new Event('marks'));
  if (!$('wp').hidden) openWp();
  if (tapPt && !$('tap').hidden) showTap();
};
$('bWpeDel').onclick = async () => {
  if (!(await deleteWaypoint(wpEdit))) return;
  stopDictation(); $('wpe').hidden = true;
  if (!$('wp').hidden) openWp();
  if (tapPt && !$('tap').hidden) { tapPt = null; $('tap').hidden = true; }
};
async function deleteWaypoint(w) {
  if (!w || !confirm(`「${w.name}」を削除しますか？（メモも消えます）`)) return false;
  wpts = wpts.filter(x => x !== w); await saveWpts(); requestDraw(); window.dispatchEvent(new Event('marks'));
  toast(`「${w.name}」を削除しました`); return true;
}
$('bWpeCancel').onclick = () => { stopDictation(); $('wpe').hidden = true; };
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
function stopDictation() { if (rec) { try { rec.stop(); } catch (e) {} rec = null; } $('bMic').classList.remove('on'); }
$('bMic').onclick = () => {
  if (rec) { stopDictation(); return; }
  if (NATIVE) {
    const ta = $('wpenote'), base = ta.value ? ta.value.replace(/\s*$/, '') + '\n' : '';
    rec = {stop: NATIVE.stopDictate}; $('bMic').classList.add('on'); toast('話してください（もう一度押すと終了）');
    NATIVE.dictate(txt => { ta.value = base + txt; }, () => { rec = null; $('bMic').classList.remove('on'); })
      .catch(e => { toast(e.message === 'not-allowed' ? 'マイクの使用が許可されていません' : '音声認識が使えません。キーボードのマイクを使ってください'); rec = null; $('bMic').classList.remove('on'); });
    return;
  }
  if (!SR) { toast('この端末ではマイクボタンが使えません。キーボードのマイクで音声入力してください'); return; }
  const ta = $('wpenote'), base = ta.value ? ta.value.replace(/\s*$/, '') + '\n' : '';
  rec = new SR(); rec.lang = 'ja-JP'; rec.interimResults = true; rec.continuous = true;
  rec.onresult = ev => { let txt = ''; for (let i = 0; i < ev.results.length; i++) txt += ev.results[i][0].transcript; ta.value = base + txt; };
  rec.onerror = ev => { toast(ev.error === 'network' ? '音声認識には通信が必要です。圏外ではキーボードのマイクを使ってください' : ev.error === 'not-allowed' ? 'マイクの使用が許可されていません' : '音声認識が止まりました'); stopDictation(); };
  rec.onend = () => stopDictation();
  try { rec.start(); $('bMic').classList.add('on'); toast('話してください（もう一度押すと終了）'); } catch (e) { stopDictation(); }
};
$('bWpGpx').onclick = () => exportGPX('地点', [], wpts, []);
$('bWpClose').onclick = () => { $('wp').hidden = true; };

async function openTrack(day) {
  await saveTrack();
  shownDay = day || shownDay;
  shownPts = shownDay === trk.day ? null : await loadTrack(shownDay);
  const keys = ((await kv.keys().catch(() => [])) || []).filter(k => typeof k === 'string' && k.startsWith('trk:')).map(k => k.slice(4));
  if (!keys.includes(trk.day)) keys.push(trk.day);
  keys.sort().reverse();
  $('trkday').innerHTML = keys.map(k => `<option value="${k}"${k === shownDay ? ' selected' : ''}>${k}${k === trk.day ? '（今日）' : ''}</option>`).join('');
  const pts = curShown(), s = trackStats(pts);
  $('trkstat').innerHTML = pts.length > 1 ? `${hm(s.t0)}〜${hm(s.t1)} ・ 距離 <b>${fmtDist(s.m)}</b> ・ ${pts.length}点` : 'この日の航跡はまだありません。';
  const ph = photos.filter(p => dayKey(p.t) === shownDay);
  $('phlist').innerHTML = ph.length ? '' : '<p><small>この日の写真はありません。</small></p>';
  for (const p of ph) {
    const im = document.createElement('img'); im.className = 'th'; im.dataset.id = p.id; im.alt = hm(p.t);
    kv.get('th:' + p.id).then(b => { if (b) im.src = URL.createObjectURL(b); });
    $('phlist').appendChild(im);
  }
  $('trkshow').checked = showTrack; $('wake').checked = wakeOn; $('bgrec').checked = localStorage.getItem('bgrec') !== '0';
  $('trk').hidden = false; requestDraw(); window.dispatchEvent(new Event('trackchange'));
}
$('bTrk').onclick = () => openTrack();
$('bCam').onclick = () => $('cam').click();
$('trkday').onchange = e => openTrack(e.target.value);
$('trkshow').onchange = e => { showTrack = e.target.checked; requestDraw(); window.dispatchEvent(new Event('trackchange')); };
$('phlist').onclick = e => { const im = e.target.closest('img'); if (im) openPhoto(im.dataset.id); };
$('bTrkGpx').onclick = () => exportGPX('航跡_' + shownDay, curShown(), [], photos.filter(p => dayKey(p.t) === shownDay));
$('bTrkDel').onclick = async () => {
  if (!confirm(`${shownDay} の航跡を消しますか？（写真と地点は残ります）`)) return;
  if (shownDay === trk.day) { trk.pts = []; trkDirty = false; }
  await kv.del('trk:' + shownDay); openTrack(shownDay);
};
$('bTrkClose').onclick = () => { $('trk').hidden = true; };
$('bImp').onclick = () => $('imp').click();

let photoCur = null;
async function openPhoto(id) {
  const p = photos.find(x => x.id === id); if (!p) return;
  photoCur = p;
  const b = await kv.get('ph:' + id);
  $('phimg').src = b ? URL.createObjectURL(b) : '';
  $('phinfo').innerHTML = `${new Date(p.t).toLocaleString('ja-JP')} ・ 水深 ${p.d != null ? p.d + ' m' : '—'}<br>${fmtDM(p.lat, '北緯', '南緯')} ${fmtDM(p.lon, '東経', '西経')}${p.src === 'import' ? '<br><small>写真アプリから読み込み（位置は撮影時刻と航跡から推定）</small>' : ''}`;
  $('ph').hidden = false;
}
$('bPhMap').onclick = () => { $('ph').hidden = true; $('trk').hidden = true; window.dispatchEvent(new Event('leave3d')); goTo(photoCur.lat, photoCur.lon); };
$('bPhDel').onclick = async () => {
  if (!confirm('この写真を削除しますか？')) return;
  photos = photos.filter(x => x !== photoCur); await savePhotos(); await kv.del('ph:' + photoCur.id); await kv.del('th:' + photoCur.id);
  $('ph').hidden = true; requestDraw(); window.dispatchEvent(new Event('marks')); if (!$('trk').hidden) openTrack(shownDay);
};
$('bPhClose').onclick = () => { $('ph').hidden = true; };

// ---------- keep the screen on so the log keeps running ----------
let wakeOn = false, wakeLock = null;
async function requestWake() { try { wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { wakeLock = null; } }
$('wake').onchange = async e => {
  wakeOn = e.target.checked;
  if (wakeOn) { if (!('wakeLock' in navigator)) { toast('この端末では使えません。端末の「自動ロック」を「なし」にしてください'); e.target.checked = wakeOn = false; return; } await requestWake(); }
  else if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
};

// ---------- GPX export ----------
async function exportGPX(name, pts, wps, phs) {
  const iso = t => new Date(t).toISOString();
  const wx = [...wps.map(w => ({lat: w.lat, lon: w.lon, t: w.t, n: w.name, d: w.d})), ...phs.map(p => ({lat: p.lat, lon: p.lon, t: p.t, n: '写真 ' + hm(p.t), d: p.d}))]
    .map(w => `<wpt lat="${w.lat}" lon="${w.lon}"><time>${iso(w.t)}</time><name>${esc(w.n)}</name>${w.d != null ? `<desc>推定水深 ${w.d} m</desc>` : ''}</wpt>`).join('\n');
  const tr = pts.length ? `<trk><name>${esc(name)}</name><trkseg>\n${pts.map(p => `<trkpt lat="${p[1]}" lon="${p[2]}"><time>${iso(p[0])}</time></trkpt>`).join('\n')}\n</trkseg></trk>` : '';
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="八重山 水深マップ" xmlns="http://www.topografix.com/GPX/1/1">\n${wx}\n${tr}\n</gpx>\n`;
  if (NATIVE) { try { await NATIVE.shareFile(name + '.gpx', gpx); } catch (e) { if (!/cancel/i.test(e.message || '')) toast('書き出せませんでした'); } return; }
  const file = new File([gpx], name + '.gpx', {type: 'application/gpx+xml'});
  try { if (navigator.canShare && navigator.canShare({files: [file]})) { await navigator.share({files: [file]}); return; } } catch (e) { if (e.name === 'AbortError') return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name; document.body.appendChild(a); a.click(); a.remove();
}

// ---------- 海底の色を2D地図に重ねる（ボタンで 切 → 衛星そのまま → 補正色(推定) → 切）----------
let botMode = 0, botImgs = {};
const BOTF = {1: 'data/v3/bottom_sat.webp', 2: 'data/v3/bottom.webp', 3: 'data/v3/benthic.webp', 4: 'data/v3/wetland.webp'};
$('bBot').onclick = async () => {
  botMode = (botMode + 1) % 5; $('bBot').classList.toggle('on', botMode > 0);
  if (botMode && !botImgs[botMode]) {
    try { botImgs[botMode] = await loadBitmap(await getData(BOTF[botMode])); }
    catch (e) { toast('海底の色データを読み込めませんでした'); botMode = 0; $('bBot').classList.remove('on'); }
  }
  toast(['海底の色: なし', '海底の色: 衛星写真そのまま（浅場。石垣島周辺のみ）', '海底の色: 補正色（水深10m以内、推定。明るい=砂、暗い=岩・サンゴ・海藻）', '底質（Allen Coral Atlas、八重山全域。赤=サンゴ/藻、茶=岩、黄=砂、橙茶=礫、緑=海草。非商用データ）', '潮間帯・湿地（青=満潮と干潮で水の反応が変わる帯、濃緑=マングローブ、薄緑=湿地。衛星の光スペクトルとWorldCover）'][botMode]);
  requestDraw();
};
let benVec = null, benVecLoading = false;
const BEN_RGB = ['rgb(255,95,60)', 'rgb(110,95,90)', 'rgb(248,232,150)', 'rgb(190,150,105)', 'rgb(40,165,75)', 'rgb(130,205,130)'];
async function loadBenVec() {
  if (benVec || benVecLoading) return; benVecLoading = true;
  try {
    const blob = await getData('data/v3/benthic_vec.json.gz');
    const txt = await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).text();
    benVec = JSON.parse(txt).map(([c, rings]) => {
      const R = rings.map(o => { const a = new Float32Array(o.length); let x = o[0], y = o[1]; a[0] = x; a[1] = y; for (let i = 2; i < o.length; i += 2) { x += o[i]; y += o[i + 1]; a[i] = x; a[i + 1] = y; } return a; });
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; const o = R[0];
      for (let i = 0; i < o.length; i += 2) { if (o[i] < x0) x0 = o[i]; if (o[i] > x1) x1 = o[i]; if (o[i + 1] < y0) y0 = o[i + 1]; if (o[i + 1] > y1) y1 = o[i + 1]; }
      return {c, R, bb: [x0, y0, x1, y1]};
    });
    requestDraw();
  } catch (e) { benVec = null; }
}
function drawBenVec() { // polygons in the visible window, at the zoom where the 20 m raster looks blocky
  const [gx0, gy0] = s2g(0, 0), [gx1, gy1] = s2g(VW, VH);
  ctx.save(); ctx.globalAlpha = 0.8;
  for (const p of benVec) {
    const b = p.bb; if (b[2] < gx0 || b[0] > gx1 || b[3] < gy0 || b[1] > gy1) continue;
    ctx.beginPath();
    for (const r of p.R) { for (let i = 0; i < r.length; i += 2) { const [sx, sy] = g2s(r[i], r[i + 1]); i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); } ctx.closePath(); }
    ctx.fillStyle = BEN_RGB[p.c]; ctx.fill('evenodd');
  }
  ctx.restore();
}
function drawBottom() {
  if (botMode === 3 && view.s > 0.08) { if (benVec) { drawBenVec(); return; } loadBenVec(); }
  const im = botMode && botImgs[botMode]; if (!im) return;
  const full = botMode === 3, [x, y] = g2s(full ? 0 : 67340, full ? 0 : 5940); ctx.save(); ctx.globalAlpha = botMode === 1 ? 0.9 : botMode === 3 ? 0.8 : botMode === 4 ? 0.9 : 0.72; ctx.imageSmoothingEnabled = true;
  ctx.drawImage(im, x, y, (full ? 5672 : 2048) * 20 * view.s, (full ? 4080 : 2197) * 20 * view.s); ctx.restore();
}


// ---------- 川・池・道路を2D地図に重ねる（OpenStreetMap）----------
let landOn = false, landData = null;
const decL = o => { const p = []; let x = o[0], y = o[1]; p.push([x, y]); for (let i = 2; i < o.length; i += 2) { x += o[i]; y += o[i + 1]; p.push([x, y]); } return p; };
const ROAD_W = ['#f0b040', '#f5d880', '#ececdf', '#d8d8d8', '#b8b8b8'];
$('bLand').onclick = async () => {
  landOn = !landOn; $('bLand').classList.toggle('on', landOn);
  if (landOn && !landData) {
    try { const d = JSON.parse(await (await getData('data/v3/land.json')).text()); landData = {rivers: d.rivers.map(([w, o]) => [w, decL(o)]), water: d.water.map(decL), roads: d.roads.map(([k, o]) => [k, decL(o)])}; }
    catch (e) { toast('川・道路のデータを読み込めませんでした'); landOn = false; $('bLand').classList.remove('on'); return; }
  }
  toast(landOn ? '川・池・道路を表示（石垣島。OpenStreetMap）' : '川・池・道路: なし');
  requestDraw();
};
function drawLand() {
  if (!landOn || !landData) return;
  const path = (pts, close) => { pts.forEach(([x, y], i) => { const [sx, sy] = g2s(x, y); i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); }); if (close) ctx.closePath(); };
  ctx.save(); ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.fillStyle = 'rgba(60,140,255,0.55)'; ctx.strokeStyle = '#3c8cff'; ctx.lineWidth = 1;
  for (const w of landData.water) { ctx.beginPath(); path(w, true); ctx.fill(); ctx.stroke(); }
  for (const [k, pts] of landData.roads) { ctx.strokeStyle = ROAD_W[k] || ROAD_W[4]; ctx.lineWidth = Math.max(0.6, (k < 2 ? 5 : 3) * view.s); ctx.beginPath(); path(pts); ctx.stroke(); }
  ctx.strokeStyle = '#2f80ff';
  for (const [w, pts] of landData.rivers) { ctx.lineWidth = Math.max(1.4, w * view.s); ctx.beginPath(); path(pts); ctx.stroke(); }
  ctx.restore();
}

// ---------- 最新版に更新 ----------
// ブラウザ版: アプリ本体のキャッシュを捨てて取り直す。
// Android アプリ: GitHub Pages の files.json と手元の版を比べ、変わったファイルだけ落として 'ota' キャッシュに入れる（sw.js が同梱ファイルより先に使う）。
const OTA_BASE = 'https://katoakira1114-png.github.io/yaeyamadepth/';
const UPD_LABEL = '最新版に更新（オンライン時）';
async function diagText() {
  const out = [];
  try { out.push('SW: ' + (navigator.serviceWorker ? (navigator.serviceWorker.controller ? '動作中' : '未制御') : 'なし') + (window.__swErr ? '(エラー ' + window.__swErr + ')' : '')); } catch (e) { out.push('SW: ?'); }
  try { const c = await caches.open('ota'); out.push('入替ファイル ' + (await c.keys()).length + '個'); } catch (e) { out.push('キャッシュ?'); }
  return out.join(' / ');
}
async function showDiag() { try { $('verNote').textContent = $('verNote').textContent.split(' 診断:')[0] + ' 診断: ' + (window.__otaInfo ? window.__otaInfo + ' / ' : '') + await diagText(); } catch (e) {} }
async function otaBuild() { // [packaged build, ota build]
  const j = async (u) => { try { const r = await fetch(u, {cache: 'no-store'}); return r.ok ? await r.json() : null; } catch (e) { return null; } };
  const pk = await j('files.json?b=1');
  const c = await caches.open('ota'); const m = await c.match(location.origin + '/__manifest');
  return [pk, m ? await m.json() : null, c];
}
async function otaUpdate() {
  const [pk, cur0, c] = await otaBuild();
  let cur = cur0;
  if (cur && pk && cur.build < pk.build) { await caches.delete('ota'); cur = null; } // a newer APK was installed: its files win
  const base = cur || pk || {files: {}};
  const r = await fetch(OTA_BASE + 'files.json?t=' + Date.now(), {cache: 'no-store'}); if (!r.ok) throw new Error('files.json ' + r.status);
  const remote = await r.json();
  const todo = Object.keys(remote.files).filter(p => base.files[p] !== remote.files[p]);
  window.__otaInfo = '公開の版 ' + remote.build + ' / 手元の版 ' + (base.build || '?') + ' / 差分 ' + todo.length + '個';
  if (!todo.length) return 0;
  await caches.delete('ota-stage'); const st = await caches.open('ota-stage');
  let done = 0, i = 0;
  const worker = async () => {
    while (i < todo.length) {
      const p = todo[i++];
      const rr = await fetch(OTA_BASE + p + '?h=' + remote.files[p], {cache: 'no-store'}); if (!rr.ok) throw new Error(p + ' ' + rr.status);
      await st.put(location.origin + '/' + p, rr); done++;
      $('bUpd').textContent = '更新中… ' + done + '/' + todo.length;
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  const oc = await caches.open('ota'); // all downloaded: switch over
  for (const q of await st.keys()) await oc.put(q, await st.match(q));
  await oc.put(location.origin + '/__manifest', new Response(JSON.stringify(remote), {headers: {'content-type': 'application/json'}}));
  await caches.delete('ota-stage');
  return todo.length;
}
$('verNote').textContent = NATIVE ? 'ボタンを押すと、インターネット上（GitHub）の最新の内容に入れ替えます。画面や3D・データが対象で、新しい APK を入れ直す必要はありません。' : 'ブラウザ版は、オンラインのときに上のボタンで最新版に入れ替えます。';
// which version is running (so a stale install can be told from a missing feature)
(async () => {
  const fmt = b => b ? new Date(b * 1000).toLocaleString('ja-JP', {month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'}) : 'なし';
  try {
    const j = async u => { try { const r = await fetch(u); return r.ok ? (await r.json()).build : 0; } catch (e) { return 0; } };
    const run = await j('files.json'), pk = NATIVE ? await j('files.json?b=1') : 0;
    $('verNote').textContent += ' 現在の版: ' + fmt(run) + (NATIVE ? '（同梱 ' + fmt(pk) + '）' : ''); setTimeout(showDiag, 1500);
  } catch (e) {}
})();
$('bUpd').onclick = async () => {
  if (!navigator.onLine) { toast('オフラインです。電波のあるところで押してください'); return; }
  $('bUpd').textContent = '更新中…'; $('bUpd').disabled = true;
  try {
    if (NATIVE) {
      const n = await otaUpdate();
      if (!n) { toast('すでに最新です（' + window.__otaInfo + '）'); $('bUpd').textContent = UPD_LABEL; $('bUpd').disabled = false; showDiag(); return; }
      toast(n + ' 個のファイルを更新しました（' + window.__otaInfo + '）。再読み込みします');
    } else {
      for (const k of await caches.keys()) if (k.startsWith('shell-')) await caches.delete(k);
      const r = await navigator.serviceWorker.getRegistration(); if (r) await r.update();
      toast('更新しました。再読み込みします');
    }
    setTimeout(() => location.reload(), 800);
  } catch (e) { $('bUpd').textContent = UPD_LABEL; $('bUpd').disabled = false; toast('更新できませんでした（' + e.message + '）'); }
  showDiag();
};

// ---------- 3D ----------
let v3 = null;
$('b3d').onclick = async () => {
  try { v3 = v3 || await import('./view3d.js'); v3.open(API3); }
  catch (e) { toast('立体表示を開けませんでした（' + e.message + '）'); }
};
// finest loaded sample at a grid point, synchronous (for building meshes)
function sampleSync(gx, gy) {
  const [ci, cj] = chunkOf(gx, gy), id = ci + '_' + cj;
  for (const k of ['h:' + id, 'c:' + id, 'base']) { const t = tiles.get(k); if (t && t.state === 'ok') { const r = sample(t, gx, gy); if (r) return r; } }
  return null;
}
const API3 = {
  get META() { return META; }, get follow() { return follow; }, get here() { return here; }, get view() { return view; }, get CSET() { return CSET; }, get HSET() { return HSET; },
  getData, load, sampleSync, ll2g, g2ll, depthAt, describe, ramp, LUT, LAND, STRUCTURE, fmtDM,
  track: () => showTrack ? curShown() : [], wpts: () => wpts, photos: () => photos, openPhoto, toast,
  pause2d: on => { paused2d = on; if (!on) requestDraw(); },
};

if (NATIVE) {
  ['wakeRow', 'trkNoteWeb', 'bDl'].forEach(id => { $(id).hidden = true; }); ['bgRow', 'trkNoteApp'].forEach(id => { $(id).hidden = false; });
  $('bgrec').onchange = e => { localStorage.setItem('bgrec', e.target.checked ? '1' : '0'); startGPS(); toast(e.target.checked ? '画面を消しても記録します' : 'アプリを開いている間だけ記録します'); };
}

async function extrasInit() {
  [wpts, photos] = [(await kv.get('wpts').catch(() => null)) || [], (await kv.get('photos').catch(() => null)) || []];
  trk.pts = await loadTrack(trk.day);
  requestDraw();
}
