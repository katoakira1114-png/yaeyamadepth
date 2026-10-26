'use strict';
// 八重山 水深マップ: 2D depth map + GPS depth readout, works offline after download.
// Grid frame: gx = UTM easting - x0 (m, east), gy = y0 - UTM northing (m, south). Zone 51N (EPSG:32651).

const $ = id => document.getElementById(id);
const DATA_CACHE = 'yaeyama-data-v1';
let META = null, STRUCT = [];

// ---------- optional encryption (build_encrypted.py): data files are AES-GCM blobs, key from a passphrase ----------
let ENC = null, KEY = null; // ENC = contents of data/key.json when the data is encrypted
const b64 = u => btoa(String.fromCharCode(...new Uint8Array(u))), unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const dataURL = p => ENC ? p + '.enc' : p;
async function deriveKey(pass) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({name: 'PBKDF2', salt: unb64(ENC.salt), iterations: ENC.iter, hash: 'SHA-256'}, base, {name: 'AES-GCM', length: 256}, true, ['decrypt']);
}
async function decrypt(buf, key) { const u = new Uint8Array(buf); return crypto.subtle.decrypt({name: 'AES-GCM', iv: u.slice(0, 12)}, key || KEY, u.slice(12)); }
async function getData(p, opt) {
  const res = await fetch(dataURL(p), opt);
  if (!res.ok) throw new Error(res.status);
  if (!ENC) return res.blob();
  return new Blob([await decrypt(await res.arrayBuffer())]);
}
async function unlock() {
  try { const k = localStorage.getItem('k'); if (k) { KEY = await crypto.subtle.importKey('raw', unb64(k), 'AES-GCM', true, ['decrypt']); await decrypt(unb64(ENC.check)); return; } } catch (e) { KEY = null; }
  $('lock').hidden = false;
  await new Promise(done => {
    $('bUnlock').onclick = async () => {
      $('lockmsg').textContent = '確認中…';
      try {
        // phone keyboards capitalise / use full-width letters, so normalise before deriving
        const key = await deriveKey($('pass').value.normalize('NFKC').trim().toLowerCase()); await decrypt(unb64(ENC.check), key);
        KEY = key; localStorage.setItem('k', b64(await crypto.subtle.exportKey('raw', key)));
        $('lock').hidden = true; done();
      } catch (e) { $('lockmsg').textContent = '合言葉が違います。'; }
    };
  });
}

// ---------- UTM (WGS84, zone 51) ----------
const UTM = (() => {
  const a = 6378137, f = 1 / 298.257223563, k0 = 0.9996, e2 = f * (2 - f), ep2 = e2 / (1 - e2), lon0 = 123 * Math.PI / 180;
  const e4 = e2 * e2, e6 = e4 * e2;
  const M = p => a * ((1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * p - (3 * e2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * Math.sin(2 * p)
    + (15 * e4 / 256 + 45 * e6 / 1024) * Math.sin(4 * p) - (35 * e6 / 3072) * Math.sin(6 * p));
  function fwd(lat, lon) {
    const p = lat * Math.PI / 180, l = lon * Math.PI / 180 - lon0, s = Math.sin(p), c = Math.cos(p), t = Math.tan(p);
    const N = a / Math.sqrt(1 - e2 * s * s), T = t * t, C = ep2 * c * c, A = c * l;
    const x = k0 * N * (A + (1 - T + C) * A ** 3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5 / 120) + 500000;
    const y = k0 * (M(p) + N * t * (A * A / 2 + (5 - T + 9 * C + 4 * C * C) * A ** 4 / 24 + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6 / 720));
    return [x, y];
  }
  function inv(x, y) {
    const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2)), m = y / k0, mu = m / (a * (1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256));
    const p1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) + (21 * e1 * e1 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
      + (151 * e1 ** 3 / 96) * Math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
    const s = Math.sin(p1), c = Math.cos(p1), t = Math.tan(p1), C1 = ep2 * c * c, T1 = t * t, N1 = a / Math.sqrt(1 - e2 * s * s);
    const R1 = a * (1 - e2) / Math.pow(1 - e2 * s * s, 1.5), D = (x - 500000) / (N1 * k0);
    const lat = p1 - (N1 * t / R1) * (D * D / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D ** 4 / 24
      + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D ** 6 / 720);
    const lon = lon0 + (D - (1 + 2 * T1 + C1) * D ** 3 / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D ** 5 / 120) / c;
    return [lat * 180 / Math.PI, lon * 180 / Math.PI];
  }
  return {fwd, inv};
})();
const ll2g = (lat, lon) => { const [x, y] = UTM.fwd(lat, lon); return [x - META.x0, META.y0 - y]; };
const g2ll = (gx, gy) => UTM.inv(gx + META.x0, META.y0 - gy);

// ---------- colours (same ramp as the 3D viewer) ----------
const RAMP = [[0, [196, 238, 232]], [3, [120, 214, 214]], [8, [62, 170, 205]], [15, [40, 120, 190]], [30, [28, 76, 150]], [50, [18, 40, 100]], [64, [10, 22, 64]]];
function ramp(d) {
  for (let i = 1; i < RAMP.length; i++) if (d <= RAMP[i][0]) { const a = RAMP[i - 1], b = RAMP[i], t = (d - a[0]) / (b[0] - a[0]); return [0, 1, 2].map(k => a[1][k] + (b[1][k] - a[1][k]) * t); }
  return RAMP[RAMP.length - 1][1];
}
const LUT = new Uint8Array(641 * 3); // 0.1 m steps to 64 m
for (let i = 0; i <= 640; i++) { const c = ramp(i / 10); LUT[i * 3] = c[0]; LUT[i * 3 + 1] = c[1]; LUT[i * 3 + 2] = c[2]; }

// ---------- PNG decoding ----------
// Left half: R,G chart depth A (0.1 m, 65535 = land), B land height/2.5 (255 = harbour structure).
// Right half: R,G combined depth C (0.1 m), B satellite depth. The app uses C.
const LAND = -1, STRUCTURE = -2;
async function loadBitmap(blob) {
  try { return await createImageBitmap(blob, {premultiplyAlpha: 'none', colorSpaceConversion: 'none'}); }
  catch (e) {
    const url = URL.createObjectURL(blob), img = new Image();
    await new Promise((ok, ng) => { img.onload = ok; img.onerror = ng; img.src = url; });
    URL.revokeObjectURL(url); return img;
  }
}
async function decode(url) {
  const bmp = await loadBitmap(await getData(url));
  const W = bmp.width, h = bmp.height, w = W / 2, c = document.createElement('canvas');
  c.width = W; c.height = h;
  const g = c.getContext('2d', {willReadFrequently: true}); g.drawImage(bmp, 0, 0);
  const px = g.getImageData(0, 0, W, h).data, D = new Float32Array(w * h), E = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, p = (y * W + x) * 4, q = p + w * 4;
    if (px[p] * 256 + px[p + 1] === 65535) { const s = px[p + 2] === 255; D[i] = s ? STRUCTURE : LAND; E[i] = s ? 0 : px[p + 2]; }
    else D[i] = (px[q] * 256 + px[q + 1]) / 10;
  }
  return {w, h, D, E};
}

// render a decoded tile to a canvas: depth colours, contours, land, coastline
function paint(T, ivs) {
  const {w, h, D, E} = T, c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'), im = g.createImageData(w, h), o = im.data;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, d = D[i], k = i * 4;
    let r, gg, b;
    if (d === STRUCTURE) { r = 150; gg = 150; b = 150; }
    else if (d === LAND) { const t = Math.min(E[i] * 2.5 / 200, 1); r = 228 - 40 * t; gg = 216 - 46 * t; b = 180 - 50 * t; }
    else { const j = Math.min(Math.round(d * 10), 640) * 3; r = LUT[j]; gg = LUT[j + 1]; b = LUT[j + 2]; }
    // edges against right / lower neighbour
    let edge = 0;
    for (const n of [x + 1 < w ? i + 1 : -1, y + 1 < h ? i + w : -1]) {
      if (n < 0) continue;
      const e = D[n];
      if ((d < 0) !== (e < 0)) { if (d === LAND || e === LAND) edge = 9; continue; }
      if (d < 0) continue;
      for (let lv = 0; lv < ivs.length; lv++) {
        const [iv, max] = ivs[lv];
        if (Math.max(d, e) > max) continue;
        if (Math.floor(d / iv) !== Math.floor(e / iv)) { edge = Math.max(edge, 3 - lv); break; }
      }
    }
    if (edge === 9) { r = 95; gg = 85; b = 65; }
    else if (edge) {
      const deep = d > 25, f = [0, .14, .26, .42][edge];
      if (deep) { r += (255 - r) * f; gg += (255 - gg) * f; b += (255 - b) * f; } else { r *= 1 - f; gg *= 1 - f; b *= 1 - f; }
    }
    o[k] = r; o[k + 1] = gg; o[k + 2] = b; o[k + 3] = 255;
  }
  g.putImageData(im, 0, 0);
  return c;
}

// ---------- tiles ----------
// kinds: base (160 m samples), c (20 m chunks), h (10 m chunks)
const tiles = new Map(); // key -> {state, T, img, used, gx0, gy0, res, fail}
let CSET, HSET;
function tileInfo(key) {
  if (key === 'base') return {url: 'data/base.png', res: META.st * META.base.step, gx0: META.st * 0.5 - META.st * META.base.step / 2, gy0: META.st * 0.5 - META.st * META.base.step / 2, ivs: [[10, 60]]};
  const [k, ci, cj] = key.split(/[:_]/).map((v, i) => i ? +v : v), span = META.ch * META.st;
  if (k === 'c') return {url: `data/c/${ci}_${cj}.png`, res: META.st, gx0: ci * span, gy0: cj * span, ivs: [[50, 1e9], [10, 60], [5, 30]]};
  return {url: `data/h/${ci}_${cj}.png`, res: META.hr.res, gx0: ci * span, gy0: cj * span, ivs: [[50, 1e9], [10, 60], [5, 30], [1, 15]]};
}
let inflight = 0;
const queue = [];
function want(key, prio) {
  let t = tiles.get(key);
  if (!t) { t = {state: 'new', ...tileInfo(key)}; tiles.set(key, t); }
  t.used = performance.now();
  if (t.state === 'new' || (t.state === 'fail' && performance.now() - t.fail > 15000)) { t.state = 'queued'; queue.push([prio, key]); pump(); }
  return t;
}
function pump() {
  queue.sort((a, b) => a[0] - b[0]);
  while (inflight < 3 && queue.length) {
    const [, key] = queue.shift(), t = tiles.get(key);
    inflight++; t.state = 'loading';
    t.promise = decode(t.url).then(T => { t.T = T; t.img = paint(T, t.ivs); t.state = 'ok'; requestDraw(); refreshReadouts(); })
      .catch(() => { t.state = 'fail'; t.fail = performance.now(); })
      .finally(() => { inflight--; pump(); evict(); });
  }
}
function load(key) { const t = want(key, -1); return t.state === 'ok' ? Promise.resolve(t) : (t.promise || Promise.reject()).then(() => t); }
function evict() {
  const ok = [...tiles.entries()].filter(([k, t]) => t.state === 'ok' && k !== 'base');
  if (ok.length <= 70) return;
  ok.sort((a, b) => a[1].used - b[1].used);
  for (const [k] of ok.slice(0, ok.length - 70)) tiles.delete(k);
}
function chunkOf(gx, gy) { const span = META.ch * META.st; return [Math.floor(gx / span), Math.floor(gy / span)]; }

// depth at a grid point using the finest tile available; loads tiles if needed
async function depthAt(gx, gy) {
  if (gx < 0 || gy < 0 || gx >= META.nx * META.st || gy >= META.ny * META.st) return null;
  const [ci, cj] = chunkOf(gx, gy), id = ci + '_' + cj;
  for (const [k, ok] of [['h:' + id, HSET.has(id)], ['c:' + id, CSET.has(id)]]) {
    if (!ok) continue;
    try { const t = await load(k); return sample(t, gx, gy); } catch (e) { /* not cached / offline: fall through */ }
  }
  return null;
}
function sample(t, gx, gy) {
  const x = Math.floor((gx - t.gx0) / t.res), y = Math.floor((gy - t.gy0) / t.res), T = t.T;
  if (x < 0 || y < 0 || x >= T.w || y >= T.h) return null;
  const d = T.D[y * T.w + x];
  return {d, res: t.res, elev: T.E[y * T.w + x] * 2.5};
}

// ---------- view ----------
const cv = $('map'), ctx = cv.getContext('2d');
let dpr = 1, VW = 0, VH = 0;
const view = {cx: 0, cy: 0, s: 0.01}; // s = device px per metre
function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 3);
  VW = cv.width = Math.round(innerWidth * dpr); VH = cv.height = Math.round(innerHeight * dpr);
  requestDraw();
}
const g2s = (gx, gy) => [(gx - view.cx) * view.s + VW / 2, (gy - view.cy) * view.s + VH / 2];
const s2g = (sx, sy) => [(sx - VW / 2) / view.s + view.cx, (sy - VH / 2) / view.s + view.cy];
function clampView() {
  const W = META.nx * META.st, H = META.ny * META.st;
  view.s = Math.min(Math.max(view.s, Math.min(VW / W, VH / H) * 0.5), 1.5 * dpr * 4);
  view.cx = Math.min(Math.max(view.cx, -W * 0.2), W * 1.2); view.cy = Math.min(Math.max(view.cy, -H * 0.2), H * 1.2);
}
function fitAll() { const W = META.nx * META.st, H = META.ny * META.st; view.cx = W / 2; view.cy = H / 2; view.s = Math.min(VW / W, VH / H) * 0.95; }
let drawReq = false, paused2d = false; // paused while the 3D view is open
function requestDraw() { if (!drawReq) { drawReq = true; requestAnimationFrame(draw); } }

function draw() {
  drawReq = false;
  if (!META || paused2d) return;
  clampView();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#0a1640'; ctx.fillRect(0, 0, VW, VH);
  const [gx0, gy0] = s2g(0, 0), [gx1, gy1] = s2g(VW, VH), span = META.ch * META.st;
  const blit = t => {
    if (t.state !== 'ok') return;
    const [x, y] = g2s(t.gx0, t.gy0), px = t.res * view.s;
    ctx.imageSmoothingEnabled = px < 3;
    ctx.drawImage(t.img, x, y, t.T.w * px, t.T.h * px);
  };
  blit(want('base', 0));
  const cvis = [], hvis = [];
  const useC = view.s * META.st >= 0.6, useH = view.s * META.hr.res >= 0.8;
  if (useC) {
    for (let cj = Math.max(0, Math.floor(gy0 / span)); cj <= Math.floor(gy1 / span); cj++)
      for (let ci = Math.max(0, Math.floor(gx0 / span)); ci <= Math.floor(gx1 / span); ci++) {
        const id = ci + '_' + cj, d = Math.hypot((ci + .5) * span - view.cx, (cj + .5) * span - view.cy);
        if (CSET.has(id)) cvis.push(want('c:' + id, d));
        if (useH && HSET.has(id)) hvis.push(want('h:' + id, d - 1e6));
      }
  }
  cvis.forEach(blit); hvis.forEach(blit);
  if (typeof drawBottom === 'function') drawBottom();
  if (typeof drawLand === 'function') drawLand();
  // harbour structures (OpenStreetMap)
  if (view.s * META.st >= 0.3) {
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const st of STRUCT) {
      ctx.strokeStyle = st.t === 'bridge' ? '#e59a4c' : '#8c8c8c';
      ctx.lineWidth = Math.max(2 * dpr, (st.t === 'bridge' ? 12 : 9) * view.s);
      ctx.beginPath();
      st.p.forEach(([x, z], i) => { const [sx, sy] = g2s(x * 1000, z * 1000); i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); });
      ctx.stroke();
    }
  }
  if (typeof drawOverlays === 'function') drawOverlays();
  // tapped point
  if (tapPt) { const [sx, sy] = g2s(tapPt[0], tapPt[1]); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 * dpr; ctx.beginPath(); ctx.moveTo(sx - 9 * dpr, sy); ctx.lineTo(sx + 9 * dpr, sy); ctx.moveTo(sx, sy - 9 * dpr); ctx.lineTo(sx, sy + 9 * dpr); ctx.stroke(); }
  // current position
  if (here) {
    const [sx, sy] = g2s(here.gx, here.gy), r = here.acc * view.s;
    if (r > 6 * dpr) { ctx.fillStyle = 'rgba(66,140,255,.18)'; ctx.strokeStyle = 'rgba(120,180,255,.7)'; ctx.lineWidth = dpr; ctx.beginPath(); ctx.arc(sx, sy, r, 0, 7); ctx.fill(); ctx.stroke(); }
    ctx.fillStyle = '#2f7cff'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 3 * dpr; ctx.beginPath(); ctx.arc(sx, sy, 8 * dpr, 0, 7); ctx.fill(); ctx.stroke();
  }
  drawScale();
  try { localStorage.setItem('view', JSON.stringify(view)); } catch (e) {}
}
function drawScale() {
  const mpp = 1 / (view.s / dpr), target = 100 * mpp, p = Math.pow(10, Math.floor(Math.log10(target)));
  const nice = [1, 2, 5, 10].map(k => k * p).filter(v => v <= target).pop() || p;
  const bar = $('scale').firstElementChild; bar.style.width = (nice / mpp) + 'px';
  $('scale').lastElementChild.textContent = nice >= 1000 ? (nice / 1000) + ' km' : nice + ' m';
}

// ---------- input: drag, pinch, wheel, tap ----------
const ptrs = new Map();
let gesture = null, follow = true;
cv.addEventListener('pointerdown', e => {
  cv.setPointerCapture(e.pointerId);
  ptrs.set(e.pointerId, [e.clientX * dpr, e.clientY * dpr]);
  gesture = {start: snapshot(), t: performance.now(), moved: false, n: ptrs.size, maxN: Math.max(ptrs.size, gesture ? gesture.maxN : 0)};
});
function snapshot() {
  const p = [...ptrs.values()], c = p.reduce((a, b) => [a[0] + b[0] / p.length, a[1] + b[1] / p.length], [0, 0]);
  const dist = p.length > 1 ? Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]) : 0;
  return {c, dist, g: s2g(c[0], c[1]), s: view.s, p0: p[0]};
}
cv.addEventListener('pointermove', e => {
  if (!ptrs.has(e.pointerId)) return;
  ptrs.set(e.pointerId, [e.clientX * dpr, e.clientY * dpr]);
  const now = snapshot(), st = gesture.start;
  if (Math.hypot(now.c[0] - st.c[0], now.c[1] - st.c[1]) > 6 * dpr || (st.dist && Math.abs(now.dist - st.dist) > 6 * dpr)) gesture.moved = true;
  if (!gesture.moved) return;
  if (follow) setFollow(false);
  if (now.dist && st.dist) view.s = st.s * now.dist / st.dist;
  view.cx = st.g[0] - (now.c[0] - VW / 2) / view.s; view.cy = st.g[1] - (now.c[1] - VH / 2) / view.s;
  requestDraw();
});
function endPtr(e) {
  if (!ptrs.has(e.pointerId)) return;
  ptrs.delete(e.pointerId);
  const wasTap = gesture && !gesture.moved && gesture.maxN === 1 && performance.now() - gesture.t < 500;
  if (wasTap) onTap(e.clientX * dpr, e.clientY * dpr);
  gesture = ptrs.size ? {start: snapshot(), t: performance.now(), moved: true, n: ptrs.size, maxN: gesture.maxN} : null;
}
cv.addEventListener('pointerup', endPtr); cv.addEventListener('pointercancel', endPtr);
cv.addEventListener('wheel', e => {
  e.preventDefault();
  const sx = e.clientX * dpr, sy = e.clientY * dpr, [gx, gy] = s2g(sx, sy);
  view.s *= Math.exp(-e.deltaY * 0.0015);
  clampView();
  view.cx = gx - (sx - VW / 2) / view.s; view.cy = gy - (sy - VH / 2) / view.s;
  requestDraw();
}, {passive: false});

// ---------- readouts ----------
const fmtDM = (v, pos, neg) => { const s = v < 0 ? neg : pos, a = Math.abs(v), d = Math.floor(a); return `${s}${d}°${((a - d) * 60).toFixed(3)}'`; };
function describe(r) {
  if (!r) return {big: 'データなし', unit: ''};
  if (r.d === STRUCTURE) return {big: '堤防・桟橋', unit: ''};
  if (r.d === LAND) return {big: '陸', unit: ''};
  return {big: r.d.toFixed(1), unit: 'm'};
}
let tapPt = null, here = null;
async function onTap(sx, sy) {
  if (typeof tapHit === 'function' && tapHit(sx, sy)) return;
  const [gx, gy] = s2g(sx, sy); tapPt = [gx, gy]; requestDraw();
  showTap();
}
async function showTap() {
  if (!tapPt) return;
  const r = await depthAt(tapPt[0], tapPt[1]), ds = describe(r), [lat, lon] = g2ll(tapPt[0], tapPt[1]);
  let dist = '';
  if (here) { const m = Math.hypot(here.gx - tapPt[0], here.gy - tapPt[1]); dist = ` ・ 現在地から ${m >= 1000 ? (m / 1000).toFixed(2) + ' km' : Math.round(m) + ' m'}`; }
  $('tap').innerHTML = `<b>タップした地点:</b> ${ds.big}${ds.unit ? ' ' + ds.unit : ''}${r && r.d >= 0 ? `（${r.res}m格子）` : ''}<br>${fmtDM(lat, '北緯', '南緯')} ${fmtDM(lon, '東経', '西経')}${dist}<span class="x" id="tapx">✕</span>${typeof tapExtra === 'function' ? tapExtra(tapPt) : ''}`;
  $('tap').hidden = false;
  $('tap').style.top = $('top').getBoundingClientRect().bottom + 8 + 'px';
  if (typeof tapWire === 'function') tapWire();
  $('tapx').onclick = () => { tapPt = null; $('tap').hidden = true; requestDraw(); };
}
async function showHere() {
  if (!here) return;
  const r = await depthAt(here.gx, here.gy), ds = describe(r);
  $('depth').innerHTML = `${ds.big}${ds.unit ? ` <small>${ds.unit}</small>` : ''}`;
  $('depth').style.fontSize = ds.unit ? '' : '24px';
  const res = r && r.d >= 0 ? `${r.res}m格子` : '—';
  $('gps').innerHTML = `位置の精度 <b>±${Math.round(here.acc)} m</b> ・ データ <b>${res}</b><br>${fmtDM(here.lat, '北緯', '南緯')} ${fmtDM(here.lon, '東経', '西経')}`;
}
function refreshReadouts() { showHere(); if (tapPt && !$('tap').hidden) showTap(); }

// ---------- geolocation ----------
function setFollow(on) {
  follow = on; $('bLoc').classList.toggle('on', on);
  if (on && here) { view.cx = here.gx; view.cy = here.gy; if (view.s < 0.1 * dpr) view.s = 0.12 * dpr; requestDraw(); }
}
let firstFix = true;
function startGPS() {
  if (NATIVE) { NATIVE.startGPS(onPosition, onPosError).catch(() => onPosError({code: 2})); return; }
  if (!('geolocation' in navigator)) { $('gps').textContent = 'この端末では位置情報が使えません'; return; }
  navigator.geolocation.watchPosition(onPosition, onPosError, {enableHighAccuracy: true, maximumAge: 2000, timeout: 30000});
}
function onPosition(p) {
  const {latitude: lat, longitude: lon, accuracy: acc} = p.coords, [gx, gy] = ll2g(lat, lon);
  here = {lat, lon, acc, gx, gy, t: Date.now()};
  if (typeof onFix === 'function') onFix(p);
  window.dispatchEvent(new Event('fix'));
  if (follow) { view.cx = gx; view.cy = gy; if (firstFix && view.s < 0.1 * dpr) view.s = 0.12 * dpr; }
  firstFix = false;
  requestDraw(); showHere();
}
function onPosError(err) {
  const m = {1: '位置情報の利用が許可されていません。端末の設定で、このアプリ（またはブラウザ）に位置情報を許可してください。', 2: '位置を取得できません（屋内や電波の状況を確認してください）', 3: '位置の取得に時間がかかっています…'}[err.code] || '位置を取得できません';
  $('gps').textContent = m;
}

// ---------- download for offline use ----------
function dataFiles() {
  if (!META) return [];
  return [...(ENC ? ['data/key.json'] : []), ...['data/meta.json', 'data/base.png', 'data/struct.json',
    ...['tex.jpg', 'bottom.webp', 'bottom_sat.webp', 'port.webp', 'drape.webp', 'bld.json', 'land.json', 'benthic.webp', 'benthic_vec.json.gz','trees.webp','bridges.json','structs.json','estuary.json','furn.json','wetland.webp', 'photo/idx.json', 'photo/lo_9_0.webp', 'photo/lo_10_0.webp', 'photo/lo_11_0.webp', 'photo/lo_9_1.webp', 'photo/lo_10_1.webp', 'photo/lo_11_1.webp', 'photo/lo_9_2.webp', 'photo/lo_10_2.webp', 'photo/lo_7_3.webp', 'photo/lo_8_3.webp', 'photo/lo_9_3.webp', 'photo/lo_10_3.webp', 'photo/lo_2_4.webp', 'photo/lo_3_4.webp', 'photo/lo_6_4.webp', 'photo/lo_7_4.webp', 'photo/lo_8_4.webp', 'photo/lo_9_4.webp', 'photo/lo_2_5.webp', 'photo/lo_3_5.webp', 'photo/lo_4_5.webp', 'photo/lo_5_5.webp', 'photo/lo_6_5.webp', 'photo/lo_7_5.webp', 'photo/lo_8_5.webp', 'photo/lo_9_5.webp', 'photo/lo_0_6.webp', 'photo/lo_1_6.webp', 'photo/lo_2_6.webp', 'photo/lo_3_6.webp', 'photo/lo_4_6.webp', 'photo/lo_5_6.webp', 'photo/lo_6_6.webp', 'photo/lo_7_6.webp', 'photo/lo_8_6.webp', 'photo/lo_0_7.webp', 'photo/lo_1_7.webp', 'photo/lo_2_7.webp', 'photo/lo_3_7.webp', 'photo/lo_7_7.webp', 'photo/lo_8_7.webp', 'photo/lo_1_8.webp', 'photo/lo_2_8.webp', 'photo/lo_3_8.webp', 'photo/lo_7_8.webp', 'photo/lo_8_8.webp', 'photo/lo_2_9.webp', 'photo/lo_3_9.webp', 'photo/lo_7_9.webp', 'photo/lo_8_9.webp', 'photo/lo_0_10.webp', 'photo/lo_1_10.webp', 'photo/lo_2_10.webp', 'photo/lo_3_10.webp', 'photo/lo_4_10.webp', 'photo/lo_5_10.webp', 'photo/lo_6_10.webp', 'photo/lo_7_10.webp', 'photo/lo_8_10.webp', 'photo/lo_0_11.webp', 'photo/lo_1_11.webp', 'photo/lo_2_11.webp', 'photo/lo_3_11.webp', 'photo/lo_4_11.webp', 'photo/lo_5_11.webp', 'photo/lo_6_11.webp', 'photo/lo_7_11.webp', 'photo/lo_8_11.webp', 'photo/lo_0_12.webp', 'photo/lo_1_12.webp', 'photo/lo_2_12.webp', 'photo/lo_3_12.webp', 'photo/lo_3_13.webp', 'photo/lo_3_14.webp', 'photo/hi_25_29.webp', 'photo/hi_26_29.webp', 'photo/hi_27_29.webp', 'photo/hi_28_29.webp', 'photo/hi_29_29.webp', 'photo/hi_25_30.webp', 'photo/hi_26_30.webp', 'photo/hi_27_30.webp', 'photo/hi_28_30.webp', 'photo/hi_29_30.webp', 'photo/hi_25_31.webp', 'photo/hi_26_31.webp', 'photo/hi_27_31.webp', 'photo/hi_28_31.webp', 'photo/hi_29_31.webp', 'photo/hi_25_32.webp', 'photo/hi_26_32.webp', 'photo/hi_27_32.webp', 'photo/hi_28_32.webp', 'photo/hi_29_32.webp', 'photo/hi_12_20.webp', 'photo/hi_13_20.webp', 'photo/hi_14_20.webp', 'photo/hi_12_21.webp', 'photo/hi_13_21.webp', 'photo/hi_14_21.webp', 'photo/hi_12_22.webp', 'photo/hi_13_22.webp', 'photo/hi_14_22.webp', 'photo/hi_12_23.webp', 'photo/hi_13_23.webp', 'photo/hi_14_23.webp', 'photo/hi_12_29.webp', 'photo/hi_13_29.webp', 'photo/hi_14_29.webp', 'photo/hi_12_30.webp', 'photo/hi_13_30.webp', 'photo/hi_14_30.webp', 'photo/hi_12_31.webp', 'photo/hi_13_31.webp', 'photo/hi_14_31.webp', 'photo/hi_12_32.webp', 'photo/hi_13_32.webp', 'photo/hi_14_32.webp', 'photo/hi_12_38.webp', 'photo/hi_13_38.webp', 'photo/hi_14_38.webp', 'photo/hi_15_38.webp', 'photo/hi_16_38.webp', 'photo/hi_17_38.webp', 'photo/hi_12_39.webp', 'photo/hi_13_39.webp', 'photo/hi_14_39.webp', 'photo/hi_15_39.webp', 'photo/hi_16_39.webp', 'photo/hi_17_39.webp', 'photo/hi_12_40.webp', 'photo/hi_13_40.webp', 'photo/hi_14_40.webp', 'photo/hi_15_40.webp', 'photo/hi_16_40.webp', 'photo/hi_17_40.webp', 'photo/hi_12_41.webp', 'photo/hi_13_41.webp', 'photo/hi_14_41.webp', 'photo/hi_15_41.webp', 'photo/hi_16_41.webp', 'photo/hi_17_41.webp', 'photo/hi_12_42.webp', 'photo/hi_13_42.webp', 'photo/hi_14_42.webp', 'photo/hi_15_42.webp', 'photo/hi_16_42.webp', 'photo/hi_17_42.webp', 'photo/hi_28_34.webp', 'photo/hi_29_34.webp', 'photo/hi_27_35.webp', 'photo/hi_28_35.webp', 'photo/hi_29_35.webp', 'photo/hi_27_36.webp', 'photo/hi_28_36.webp', 'photo/hi_29_36.webp', 'photo/hi_27_37.webp', 'photo/hi_28_37.webp', 'photo/hi_29_37.webp', 'photo/hi_27_38.webp', 'photo/hi_28_38.webp', 'photo/hi_29_38.webp'].map(f => 'data/v3/' + f),
    ...META.chunks.map(([i, j]) => `data/c/${i}_${j}.png`), ...META.hr.chunks.map(([i, j]) => `data/h/${i}_${j}.png`)].map(dataURL)];
}
const fmtMB = b => (b / 1048576).toFixed(1) + ' MB';
async function cacheStatus() {
  if (NATIVE) return {ok: true, have: dataFiles().length, total: dataFiles().length}; // the app ships with the data
  if (!('caches' in window)) return {ok: false, have: 0, total: dataFiles().length};
  const cache = await caches.open(DATA_CACHE), keys = new Set((await cache.keys()).map(r => new URL(r.url).pathname));
  const files = dataFiles(), have = files.filter(f => keys.has(new URL(f, location.href).pathname)).length;
  return {ok: true, have, total: files.length};
}
function savedInfo() { try { return JSON.parse(localStorage.getItem('dl') || 'null'); } catch (e) { return null; } }
async function updateDlSheet() {
  const s = await cacheStatus(), info = savedInfo();
  if (!s.ok) { $('dlstat').textContent = 'このブラウザでは保存できません（HTTPSで開いているか確認してください）。'; $('bDlGo').disabled = true; return s; }
  if (s.have === s.total && info) $('dlstat').innerHTML = `保存済み: <b>${fmtMB(info.bytes)}</b>（${new Date(info.date).toLocaleString('ja-JP')}）。圏外でも使えます。`;
  else if (s.have === s.total) $('dlstat').innerHTML = `保存済み（${s.total}ファイル）。圏外でも使えます。`;
  else $('dlstat').innerHTML = `未保存: ${s.total - s.have} / ${s.total} ファイルが残っています。`;
  $('bDlGo').textContent = s.have === s.total ? '最新に更新' : 'ダウンロード';
  return s;
}
let downloading = false;
async function download(force) {
  if (downloading) return; downloading = true;
  const cache = await caches.open(DATA_CACHE), files = dataFiles(), prog = $('dlprog');
  prog.hidden = false; prog.max = files.length; prog.value = 0; $('dlmsg').textContent = '';
  let done = 0, failed = 0, bytes = 0;
  const work = files.slice();
  async function worker() {
    while (work.length) {
      const f = work.shift();
      try {
        let res = force ? null : await cache.match(f);
        if (!res) {
          const net = await fetch(f, {cache: 'no-store'});
          if (!net.ok) throw new Error(net.status);
          await cache.put(f, net.clone()); res = net;
        }
        bytes += (await res.blob()).size;
      } catch (e) { failed++; }
      done++; prog.value = done;
      $('dlmsg').textContent = `${done} / ${files.length} ファイル（${fmtMB(bytes)}）`;
    }
  }
  await Promise.all([1, 2, 3, 4, 5, 6].map(worker));
  downloading = false;
  if (failed) $('dlmsg').textContent = `${failed} ファイルを保存できませんでした。電波の良い所で、もう一度押してください。`;
  else {
    bytes = 0;
    for (const f of files) { const r = await cache.match(f); if (r) bytes += (await r.blob()).size; }
    localStorage.setItem('dl', JSON.stringify({date: new Date().toISOString(), bytes}));
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    $('dlmsg').textContent = '完了しました。圏外でも使えます。';
  }
  await updateDlSheet(); checkBanner();
}
async function deleteData() {
  if (!confirm('保存した水深データを消しますか？（地図の全体図は残ります）')) return;
  const cache = await caches.open(DATA_CACHE);
  for (const f of dataFiles().slice(ENC ? 4 : 3)) await cache.delete(f);
  localStorage.removeItem('dl');
  for (const k of [...tiles.keys()]) if (k !== 'base') tiles.delete(k);
  $('dlprog').hidden = true; $('dlmsg').textContent = '消しました。';
  await updateDlSheet(); checkBanner(); requestDraw();
}
async function checkBanner() {
  const s = await cacheStatus(), info = savedInfo(), b = $('banner');
  if (!s.ok || s.have === s.total || sessionStorage.getItem('bannerLater')) { b.hidden = true; return; }
  b.innerHTML = (info
    ? '<b>保存データが消えています。</b>しばらく使わないと、端末が自動で消すことがあります。電波のある所で、もう一度ダウンロードしてください。'
    : '<b>圏外で使うには、</b>電波のある所で先にデータをダウンロードしてください（約23MB）。')
    + '<br><button id="bBanDl">ダウンロード</button> <button id="bBanLater" style="background:transparent">あとで</button>';
  b.hidden = false;
  $('bBanDl').onclick = () => { b.hidden = true; openDl(true); };
  $('bBanLater').onclick = () => { sessionStorage.setItem('bannerLater', '1'); b.hidden = true; };
}
async function openDl(start) { $('dl').hidden = false; await updateDlSheet(); if (start) download(false); }

// ---------- UI wiring ----------
$('bLoc').onclick = () => { if (!here) { $('gps').textContent = '位置を取得しています…'; } setFollow(true); };
$('bDl').onclick = () => openDl(false);
$('bDlGo').onclick = () => download($('bDlGo').textContent === '最新に更新');
$('bDlDel').onclick = deleteData;
$('bDlClose').onclick = () => { $('dl').hidden = true; };
$('bInfo').onclick = $('warn').onclick = () => { $('info').hidden = false; };
$('bOk').onclick = () => { $('info').hidden = true; localStorage.setItem('ack', '1'); };
(function legend() { const g = $('lg').getContext('2d'); for (let x = 0; x < 150; x++) { const c = ramp(x / 150 * 50); g.fillStyle = `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`; g.fillRect(x, 0, 1, 10); } })();
addEventListener('resize', resize);

// ---------- start ----------
(async function init() {
  if ('serviceWorker' in navigator) {
    // when an updated worker takes over, reload once so the page runs the new code
    const hadSW = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadSW && !sessionStorage.getItem('swReload')) { sessionStorage.setItem('swReload', '1'); location.reload(); } });
    navigator.serviceWorker.register('sw.js').catch(e => { window.__swErr = String(e && e.message || e); });
  }
  if (!localStorage.getItem('ack')) $('info').hidden = false;
  resize();
  try {
    const kr = await fetch('data/key.json').catch(() => null);
    if (kr && kr.ok) {
      ENC = await kr.json();
      // data re-encrypted with a new salt: everything saved under the old key is useless
      const old = localStorage.getItem('salt');
      if (old && old !== ENC.salt) {
        ['k', 'dl'].forEach(k => localStorage.removeItem(k));
        if ('caches' in window) await caches.delete(DATA_CACHE);
      }
      localStorage.setItem('salt', ENC.salt);
    }
    for (;;) {
      if (ENC) await unlock();
      try { META = JSON.parse(await (await getData('data/meta.json')).text()); break; }
      catch (e) {
        if (!ENC || e.name !== 'OperationError') throw e;
        // key and data do not match (stale saved key or stale cached file): start over
        localStorage.removeItem('k'); KEY = null;
        if ('caches' in window) await caches.delete(DATA_CACHE);
        $('lockmsg').textContent = 'もう一度、合言葉を入れてください。';
      }
    }
    CSET = new Set(META.chunks.map(([i, j]) => i + '_' + j)); HSET = new Set(META.hr.chunks.map(([i, j]) => i + '_' + j));
  } catch (e) { $('gps').textContent = 'データを読み込めません。電波のある所で一度開いてください。'; return; }
  getData('data/struct.json').then(b => b.text()).then(t => JSON.parse(t)).then(s => { STRUCT = s; requestDraw(); }).catch(() => {});
  fitAll();
  try { const v = JSON.parse(localStorage.getItem('view') || 'null'); if (v && v.s) Object.assign(view, v); } catch (e) {}
  requestDraw();
  startGPS(); setFollow(true);
  checkBanner();
  if (typeof extrasInit === 'function') extrasInit();
  window.__app = {depthAt, ll2g, g2ll, view, tiles, cacheStatus}; // for testing
})();
