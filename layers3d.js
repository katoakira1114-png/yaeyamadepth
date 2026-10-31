// Extra 3D layers: satellite colour on land, seabed colour (≤10 m, estimated), buildings, harbour aerial photo.
// Data (data/v3/*) covers Ishigaki island only; everything degrades silently when a file is missing.
import * as THREE from './lib/three.module.min.js';

const GX0 = 67340, GY0 = 5940, TW = 2048, TH = 2197, ST = 20;        // texture origin in grid metres, 20 m per pixel
const PORT = {gx: 76405.97, gy: 33019.82, w: 4126.2, h: 3619.5};     // harbour photo (GSI) extent in grid metres
let land = null, ben = null, benV = null;
let phIdx = null, wetI = null, furn = null, est = null, brg = null, strc = null, treeImg = null, A = null, drape = null, tex = null, bot = null, sat = null, bld = null, portImg = null, ready = null;
const triCache = new Map(), wetCache = new Map();

async function img(name) {
  const bmp = await createImageBitmap(await A.getData('data/v3/' + name), {premultiplyAlpha: 'none', colorSpaceConversion: 'none'});
  const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
  const g = c.getContext('2d', {willReadFrequently: true}); g.drawImage(bmp, 0, 0);
  return {w: bmp.width, h: bmp.height, d: g.getImageData(0, 0, bmp.width, bmp.height).data, bmp};
}
export function init(api) {
  A = api;
  if (!ready) ready = (async () => {
    const [t, b, j, st] = await Promise.allSettled([img('tex.jpg'), img('bottom.webp'), A.getData('data/v3/bld.json').then(b => b.text()).then(JSON.parse), img('bottom_sat.webp')]);
    sat = st.value || null;
    try { const b = await createImageBitmap(await A.getData('data/v3/drape.webp'), {premultiplyAlpha: 'none'}); const c = document.createElement('canvas'); c.width = b.width; c.height = b.height; c.getContext('2d').drawImage(b, 0, 0); drape = c; } catch (e) { drape = null; }
    tex = t.value || null; bot = b.value || null; bld = j.value || null;
    try { ben = await img('benthic.webp'); } catch (e) { ben = null; }
    try { phIdx = JSON.parse(await (await A.getData('data/v3/photo/idx.json')).text()); } catch (e) { phIdx = null; }
    try { wetI = await img('wetland.webp'); } catch (e) { wetI = null; }
    try { furn = JSON.parse(await (await A.getData('data/v3/furn.json')).text()); } catch (e) { furn = null; }
    try { est = JSON.parse(await (await A.getData('data/v3/estuary.json')).text()); } catch (e) { est = null; }
    try { brg = JSON.parse(await (await A.getData('data/v3/bridges.json')).text()); } catch (e) { brg = null; }
    try { strc = JSON.parse(await (await A.getData('data/v3/structs.json')).text()); } catch (e) { strc = null; }
    try { treeImg = await img('trees.webp'); } catch (e) { treeImg = null; }
    try { benV = await loadBenVec(A); } catch (e) { benV = null; }
    try { land = JSON.parse(await (await A.getData('data/v3/land.json')).text()); } catch (e) { land = null; }
    try { portImg = await createImageBitmap(await A.getData('data/v3/port.webp'), {imageOrientation: 'flipY', premultiplyAlpha: 'none'}); } catch (e) { portImg = null; }
  })();
  return ready;
}
export const has = () => ({land: !!tex, bottom: !!bot, bld: !!bld, port: !!portImg, rivers: !!land, trees: !!treeImg});

function bil(I, gx, gy, out) {
  const fx = (gx - GX0) / ST - 0.5, fy = (gy - GY0) / ST - 0.5;
  if (fx < 0 || fy < 0 || fx >= I.w - 1 || fy >= I.h - 1) return false;
  const i = fx | 0, j = fy | 0, ax = fx - i, ay = fy - j, d = I.d, p = (j * I.w + i) * 4, q = p + I.w * 4;
  for (let k = 0; k < 4; k++) out[k] = (d[p + k] * (1 - ax) + d[p + 4 + k] * ax) * (1 - ay) + (d[q + k] * (1 - ax) + d[q + 4 + k] * ax) * ay;
  return true;
}
const tmp = [0, 0, 0, 0];
export function landColor(gx, gy) { return tex && bil(tex, gx, gy, tmp) ? [tmp[0], tmp[1], tmp[2]] : null; }
const BEN = {w: 5672, h: 4080};   // seabed-class raster covers the whole Yaeyama grid (20 m, origin 0,0)
function bilBen(gx, gy, out) {
  const I = ben, fx = gx / ST - 0.5, fy = gy / ST - 0.5;
  if (!I || fx < 0 || fy < 0 || fx >= I.w - 1 || fy >= I.h - 1) return false;
  const i = fx | 0, j = fy | 0, ax = fx - i, ay = fy - j, d = I.d, p = (j * I.w + i) * 4, q = p + I.w * 4;
  for (let k = 0; k < 4; k++) out[k] = (d[p + k] * (1 - ax) + d[p + 4 + k] * ax) * (1 - ay) + (d[q + k] * (1 - ax) + d[q + 4 + k] * ax) * ay;
  return true;
}
export function bottomColor(gx, gy, mode) {
  if (mode === 4) return null;
  if (mode === 3) return bilBen(gx, gy, tmp) && tmp[3] > 2 ? [tmp[0], tmp[1], tmp[2], tmp[3] / 255] : null;
  const I = mode === 2 ? sat : bot; return I && bil(I, gx, gy, tmp) && tmp[3] > 2 ? [tmp[0], tmp[1], tmp[2], tmp[3] / 255] : null; }

// ---- buildings ----
let facadeTex = null, roofPhotoTex = null;
function facade() {
  if (facadeTex) return facadeTex;
  const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d');
  g.fillStyle = '#f2f0ea'; g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#5a6b7c'; g.fillRect(22, 30, 84, 62);            // window
  g.fillStyle = '#9fb4c6'; g.fillRect(22, 30, 84, 20);            // sky reflection
  g.fillStyle = '#c9c5bb'; g.fillRect(0, 118, 128, 10);           // floor slab
  g.fillStyle = '#8a8a86'; g.fillRect(18, 92, 92, 5);             // sill
  facadeTex = new THREE.CanvasTexture(c); facadeTex.colorSpace = THREE.SRGBColorSpace; facadeTex.anisotropy = 4; facadeTex.wrapS = facadeTex.wrapT = THREE.RepeatWrapping;
  return facadeTex;
}
// Buildings: walls get a floors-and-windows texture (floor height 3.2 m from the stored height), roofs inside the harbour photo use that photo.
// places rebuilt from the user's own videos win over the map's buildings, trees and street furniture there (grid metres)
let EXCL = null;
export function setExclude(f) { EXCL = f; }
const excl = (gx, gy) => !!EXCL && EXCL(gx, gy);
export function buildings(cx, cy, R, ve) {
  if (!bld) return null;
  const bs = Math.max(1, ve * 0.6), W = {p: [], c: [], u: []}, RP = {p: [], c: [], u: []}, RF = {p: [], c: [], u: []};
  for (let n = 0; n < bld.length; n++) {
    const b = bld[n], gx = GX0 + b[0] / 10, gy = GY0 + b[1] / 10;
    if (Math.abs(gx - cx) > R || Math.abs(gy - cy) > R) continue;
    if (EXCL) { let hit = excl(gx, gy); for (let i = 0; !hit && i < b[2].length; i += 2) hit = excl(gx + b[2][i] / 10, gy + b[2][i + 1] / 10); if (hit) continue; }
    let T = triCache.get(n);
    if (!T) {
      const d = b[2], v = [new THREE.Vector2(b[0] / 10, b[1] / 10)];
      for (let i = 0; i < d.length; i += 2) v.push(new THREE.Vector2((b[0] + d[i]) / 10, (b[1] + d[i + 1]) / 10));
      T = {v, tri: THREE.ShapeUtils.triangulateShape(v, [])}; triCache.set(n, T);
    }
    // footprints standing on structure/sea cells are breakwaters, piers and quays: low plain slabs, no windows
    let wet = wetCache.get(n); if (wet === undefined) { const sm = A.sampleSync(gx + (b[2][0] || 0) / 20, gy + (b[2][1] || 0) / 20); wet = !!sm && sm.d !== A.LAND; wetCache.set(n, wet); }
    if (wet) continue;
    const base = b[4] / 10 * ve, y0 = base - 1, y1 = base + (wet ? Math.min(b[3], 20) : b[3]) / 10 * bs, rgb = wet ? 0xa8a49a : b[5], floors = Math.max(1, b[3] / 10 / 3.2);
    const WT = wet ? RP : W;
    const r = (rgb >> 16 & 255) / 255, g = (rgb >> 8 & 255) / 255, bl = (rgb & 255) / 255, k = 0.85;
    const ox = GX0 - cx, oy = GY0 - cy, v = T.v;
    for (let i = 0; i < v.length; i++) {
      const a = v[i], c = v[(i + 1) % v.length];
      const ax = a.x + ox, az = a.y + oy, cx2 = c.x + ox, cz = c.y + oy, u1 = Math.hypot(c.x - a.x, c.y - a.y) / 3.2;
      WT.p.push(ax, y0, az, cx2, y0, cz, cx2, y1, cz, ax, y0, az, cx2, y1, cz, ax, y1, az);
      if (!wet) W.u.push(0, 0, u1, 0, u1, floors, 0, 0, u1, floors, 0, floors);
      for (let q = 0; q < 6; q++) WT.c.push(0.55 + r * k * 0.45, 0.55 + g * k * 0.45, 0.55 + bl * k * 0.45);
    }
    const inPort = portImg && gx > PORT.gx && gx < PORT.gx + PORT.w && gy > PORT.gy && gy < PORT.gy + PORT.h;
    const D = inPort && !wet ? RF : RP;
    for (const t of T.tri) for (const q of t) {
      D.p.push(v[q].x + ox, y1, v[q].y + oy);
      if (D === RF) { D.c.push(1, 1, 1); D.u.push((v[q].x + GX0 - PORT.gx) / PORT.w, 1 - (v[q].y + GY0 - PORT.gy) / PORT.h); }
      else D.c.push(r, g, bl);
    }
  }
  const P = [...W.p, ...RP.p, ...RF.p];
  if (!P.length) return null;
  const nW = W.p.length / 3, nR = RP.p.length / 3, nF = RF.p.length / 3;
  const geo = new THREE.BufferGeometry(), uv = [...W.u, ...new Array(nR * 2).fill(0), ...RF.u];
  geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); geo.setAttribute('color', new THREE.Float32BufferAttribute([...W.c, ...RP.c, ...RF.c], 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); geo.computeVertexNormals();
  geo.addGroup(0, nW, 0); geo.addGroup(nW, nR, 1); geo.addGroup(nW + nR, nF, 2);
  if (portImg && !roofPhotoTex) { roofPhotoTex = new THREE.Texture(portImg); roofPhotoTex.colorSpace = THREE.SRGBColorSpace; roofPhotoTex.needsUpdate = true; roofPhotoTex.anisotropy = 4; }
  const mats = [new THREE.MeshLambertMaterial({map: facade(), vertexColors: true, side: THREE.DoubleSide}), new THREE.MeshLambertMaterial({vertexColors: true, side: THREE.DoubleSide}), new THREE.MeshLambertMaterial({map: roofPhotoTex || null, vertexColors: true, side: THREE.DoubleSide})];
  return new THREE.Mesh(geo, mats);
}

// ---- harbour photo patch (land part only; the sea is transparent) ----
export function portPatch(cx, cy, R, ve, height) {
  if (!portImg) return null;
  if (Math.abs(PORT.gx + PORT.w / 2 - cx) > R + PORT.w / 2 || Math.abs(PORT.gy + PORT.h / 2 - cy) > R + PORT.h / 2) return null;
  const N = 12, nx = Math.round(PORT.w / N), nz = Math.round(PORT.h / N);
  const g = new THREE.PlaneGeometry(PORT.w, PORT.h, nx, nz); g.rotateX(-Math.PI / 2);
  const p = g.attributes.position;
  for (let k = 0; k < p.count; k++) {
    const gx = PORT.gx + p.getX(k) + PORT.w / 2, gy = PORT.gy + p.getZ(k) + PORT.h / 2;
    p.setXYZ(k, gx - cx, Math.max(height(gx - cx, gy - cy), 0) * ve + 0.5, gy - cy);
  }
  p.needsUpdate = true; g.computeVertexNormals();
  const t = new THREE.Texture(portImg); t.colorSpace = THREE.SRGBColorSpace; t.needsUpdate = true; t.anisotropy = 4;
  const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({map: t, alphaTest: 0.5, side: THREE.DoubleSide}));
  return m;
}

// ---- 実写テクスチャ（陸＋水深8m以浅の衛星写真）を地形メッシュにそのまま貼る ----
export const hasDrape = () => !!drape;
export function drapeUV(geo, cx, cy) {
  const p = geo.attributes.position, uv = new Float32Array(p.count * 2);
  for (let k = 0; k < p.count; k++) { uv[k * 2] = (cx + p.getX(k) - GX0) / (TW * ST); uv[k * 2 + 1] = 1 - (cy + p.getZ(k) - GY0) / (TH * ST); }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}
let drapeTex = null;
export function drapeMesh(geo) {
  if (!drape) return null;
  if (!drapeTex) { drapeTex = new THREE.CanvasTexture(drape); drapeTex.colorSpace = THREE.SRGBColorSpace; drapeTex.anisotropy = 4; drapeTex.wrapS = drapeTex.wrapT = THREE.ClampToEdgeWrapping; }
  const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({map: drapeTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2}));
  m.renderOrder = 1; return m;
}

export async function loadBenVec(api) {
  const blob = await api.getData('data/v3/benthic_vec.json.gz');
  const txt = await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).text();
  return JSON.parse(txt).map(([c, rings]) => {
    const R = rings.map(o => { const a = new Float32Array(o.length); let x = o[0], y = o[1]; a[0] = x; a[1] = y; for (let i = 2; i < o.length; i += 2) { x += o[i]; y += o[i + 1]; a[i] = x; a[i + 1] = y; } return a; });
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; const o = R[0];
    for (let i = 0; i < o.length; i += 2) { if (o[i] < x0) x0 = o[i]; if (o[i] > x1) x1 = o[i]; if (o[i + 1] < y0) y0 = o[i + 1]; if (o[i + 1] > y1) y1 = o[i + 1]; }
    return {c, R, bb: [x0, y0, x1, y1]};
  });
}
export const BEN_RGB = ['rgb(255,95,60)', 'rgb(110,95,90)', 'rgb(248,232,150)', 'rgb(190,150,105)', 'rgb(40,165,75)', 'rgb(130,205,130)'];
export function paintBenVec(g, polys, x0, y0, x1, y1, tx, ty, sc) {   // grid-metre window -> canvas pixels
  for (const p of polys) {
    const b = p.bb; if (b[2] < x0 || b[0] > x1 || b[3] < y0 || b[1] > y1) continue;
    g.beginPath();
    for (const r of p.R) { for (let i = 0; i < r.length; i += 2) { const X = (r[i] - tx) * sc, Y = (r[i + 1] - ty) * sc; i ? g.lineTo(X, Y) : g.moveTo(X, Y); } g.closePath(); }
    g.fillStyle = BEN_RGB[p.c]; g.fill('evenodd');
  }
}
let benTex = null, benKey = '';
// seabed classes (Allen Coral Atlas) as the topmost layer: a transparent copy of the terrain above the satellite drape
export function benthicOverlay(src, cx, cy) {
  if (!ben && !benV) return null;
  const E = 4000, N = 3072;
  if (benV) {
    const key = cx + ',' + cy;
    if (key !== benKey) {
      const c = document.createElement('canvas'); c.width = c.height = N; const g = c.getContext('2d');
      paintBenVec(g, benV, cx - E, cy - E, cx + E, cy + E, cx - E, cy - E, N / (2 * E));
      if (benTex) benTex.dispose();
      benTex = new THREE.CanvasTexture(c); benTex.colorSpace = THREE.SRGBColorSpace; benTex.anisotropy = 4; benTex.wrapS = benTex.wrapT = THREE.ClampToEdgeWrapping; benKey = key;
    }
  }
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', src.attributes.position); if (src.attributes.normal) geo.setAttribute('normal', src.attributes.normal); geo.setIndex(src.index);
  const p = src.attributes.position, uv = new Float32Array(p.count * 2);
  for (let k = 0; k < p.count; k++) {
    if (benV) { uv[k * 2] = (p.getX(k) + E) / (2 * E); uv[k * 2 + 1] = 1 - (p.getZ(k) + E) / (2 * E); }
    else { uv[k * 2] = (cx + p.getX(k)) / (ben.w * ST); uv[k * 2 + 1] = 1 - (cy + p.getZ(k)) / (ben.h * ST); }
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (!benV && !benTex) { const c = document.createElement('canvas'); c.width = ben.w; c.height = ben.h; c.getContext('2d').drawImage(ben.bmp, 0, 0); benTex = new THREE.CanvasTexture(c); benTex.colorSpace = THREE.SRGBColorSpace; benTex.anisotropy = 4; benTex.wrapS = benTex.wrapT = THREE.ClampToEdgeWrapping; benTex.magFilter = THREE.NearestFilter; }
  const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({map: benTex, transparent: true, alphaTest: benV ? 0.05 : 0.5, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4}));
  m.renderOrder = 2; return m;
}

// ---- rivers, water bodies, roads (OpenStreetMap, via the handoff land-001 job) ----
const dec = o => { const p = []; let x = o[0], y = o[1]; p.push(x, y); for (let i = 2; i < o.length; i += 2) { x += o[i]; y += o[i + 1]; p.push(x, y); } return p; };
const ROAD_COL = [[0.95, 0.75, 0.3], [0.95, 0.85, 0.5], [0.92, 0.92, 0.88], [0.85, 0.85, 0.85], [0.7, 0.7, 0.7]];
export function landLines(cx, cy, R, ve, height) {
  if (!land) return null;
  const pos = [], col = [];
  const add = (pts, c, closed, lift) => {
    const n = pts.length / 2;
    for (let i = 0; i < n - 1 + (closed ? 1 : 0); i++) {
      const j = (i + 1) % n, ax = pts[2 * i] - cx, az = pts[2 * i + 1] - cy, bx = pts[2 * j] - cx, bz = pts[2 * j + 1] - cy;
      if (Math.abs(ax) > R || Math.abs(az) > R) continue;
      pos.push(ax, Math.max(height(ax, az), 0) * ve + lift, az, bx, Math.max(height(bx, bz), 0) * ve + lift, bz);
      col.push(c[0], c[1], c[2], c[0], c[1], c[2]);
    }
  };
  for (const o of land.water) add(dec(o), [0.2, 0.55, 1], true, 8);
  for (const [k, o] of land.roads) add(dec(o), ROAD_COL[k] || ROAD_COL[4], false, 6);
  if (!pos.length) return null;
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return new THREE.LineSegments(g, new THREE.LineBasicMaterial({vertexColors: true}));
}

// River ribbons: OSM gives centrelines only, so the width is assumed per waterway type (river 12 m, stream 4 m, drains 2.5 m).
export function riverMesh(cx, cy, R, ve, height) {
  if (!land) return null;
  const pos = [], idx = [];
  for (const [w, o, ws] of land.rivers) {
    const p = dec(o), n = p.length / 2; if (n < 2) continue;
    if (Math.abs(p[0] - cx) > R * 1.5 && Math.abs(p[2 * n - 2] - cx) > R * 1.5) continue;
    const base = pos.length / 3; let ok = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.max(i - 1, 0), b = Math.min(i + 1, n - 1);
      let dx = p[2 * b] - p[2 * a], dz = p[2 * b + 1] - p[2 * a + 1]; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      const x = p[2 * i] - cx, z = p[2 * i + 1] - cy, h = Math.max(height(x, z), 0) * ve + 3, hw = (ws ? ws[i] : w) / 2;
      pos.push(x - dz * hw, h, z + dx * hw, x + dz * hw, h, z - dx * hw);
      if (Math.abs(x) < R && Math.abs(z) < R) ok++;
      if (i) { const q = base + 2 * (i - 1); idx.push(q, q + 1, q + 2, q + 1, q + 3, q + 2); }
    }
    if (!ok) { pos.length = base * 3; idx.length = idx.length - 6 * (n - 1); }
  }
  // ponds and riverbanks: flat fill at their lowest bank height
  for (const o of land.water) {
    const p = dec(o), n = p.length / 2; if (n < 3) continue;
    const v = [], hs = []; let ok = false;
    for (let i = 0; i < n; i++) { const x = p[2 * i] - cx, z = p[2 * i + 1] - cy; v.push(new THREE.Vector2(x, z)); hs.push(Math.max(height(x, z), 0)); if (Math.abs(x) < R && Math.abs(z) < R) ok = true; }
    if (!ok) continue;
    const h = Math.min(...hs) * ve + 3, tri = THREE.ShapeUtils.triangulateShape(v, []), base = pos.length / 3;
    for (const q of v) pos.push(q.x, h, q.y);
    for (const t of tri) idx.push(base + t[0], base + t[1], base + t[2]);
  }
  if (!idx.length) return null;
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
  return new THREE.Mesh(g, new THREE.MeshBasicMaterial({color: 0x2f7fe8, side: THREE.DoubleSide, transparent: true, opacity: 0.88}));
}

// ---- trees: one cone per 10 m canopy cell (ESA WorldCover tree class x ETH/Meta canopy height); coarser far away ----
export function trees(cx, cy, R, ve, height) {
  if (!treeImg) return null;
  const bs = Math.max(1, ve * 0.6), W = treeImg.w, H = treeImg.h, d = treeImg.d, P = [];
  const i0 = Math.max(0, Math.floor((cx - R - GX0) / 10)), i1 = Math.min(W - 1, Math.ceil((cx + R - GX0) / 10));
  const j0 = Math.max(0, Math.floor((cy - R - GY0) / 10)), j1 = Math.min(H - 1, Math.ceil((cy + R - GY0) / 10));
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const v = d[(j * W + i) * 4]; if (!v || excl(GX0 + (i + 0.5) * 10, GY0 + (j + 0.5) * 10)) continue;
    const x = GX0 + (i + 0.5) * 10 - cx, z = GY0 + (j + 0.5) * 10 - cy, dist = Math.hypot(x, z);
    if (dist > R) continue;
    const s = dist < 800 ? 1 : dist < 1600 ? 2 : 4;
    if (i % s || j % s) continue;
    const hs = ((i * 73856093) ^ (j * 19349663)) >>> 0;
    P.push(x + ((hs & 255) / 255 - 0.5) * 6 * s, z + ((hs >> 8 & 255) / 255 - 0.5) * 6 * s, v / 4 * 0.7, s, hs);
  }
  for (let k = P.length / 5 - 1; k >= 0; k--) if (height(P[k * 5], P[k * 5 + 1]) < 0) P.splice(k * 5, 5);   // no trees on cells the grid treats as water (estuary pools, channels)
  const n = P.length / 5; if (!n) return null;
  const g = new THREE.ConeGeometry(1, 1, 5); g.translate(0, 0.5, 0);
  const m = new THREE.InstancedMesh(g, new THREE.MeshLambertMaterial({color: 0xffffff}), n), M = new THREE.Matrix4(), q = new THREE.Quaternion(), c = new THREE.Color();
  for (let k = 0; k < n; k++) {
    const x = P[k * 5], z = P[k * 5 + 1], h = P[k * 5 + 2], s = P[k * 5 + 3], hs = P[k * 5 + 4];
    const gy = Math.max(height(x, z), 0) * ve, r = Math.min(5, Math.max(1.8, h * 0.28)) * Math.sqrt(s * bs);
    M.compose(new THREE.Vector3(x, gy, z), q, new THREE.Vector3(r, h * bs, r)); m.setMatrixAt(k, M);
    c.setHSL(0.27 + ((hs >> 16 & 255) / 255 - 0.5) * 0.06, 0.45, 0.2 + ((hs >> 4 & 255) / 255) * 0.08 + Math.min(h, 20) / 20 * 0.04); m.setColorAt(k, c);
  }
  m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true;
  return m;
}

// ---- bridges: OSM bridge=yes centrelines (235) as grey decks with side beams; deck height runs between the two end heights ----
export function bridges(cx, cy, R, ve, height) {
  if (!brg) return null;
  const pos = [], idx = [], thick = 1.2 * Math.min(ve, 3);
  for (const [w10, o] of brg) {
    const n = o.length / 2, p = [];
    for (let i = 0; i < n; i++) p.push(GX0 + o[2 * i] / 10 - cx, GY0 + o[2 * i + 1] / 10 - cy);
    if (!p.some((v, i) => i % 2 === 0 && Math.abs(v) < R && Math.abs(p[i + 1]) < R)) continue;
    const e0 = Math.max(height(p[0], p[1]), 0) * ve, e1 = Math.max(height(p[2 * n - 2], p[2 * n - 1]), 0) * ve, hw = w10 / 20;
    let len = 0; const cum = [0];
    for (let i = 1; i < n; i++) { len += Math.hypot(p[2 * i] - p[2 * i - 2], p[2 * i + 1] - p[2 * i - 1]); cum.push(len); }
    const base = pos.length / 3;
    for (let i = 0; i < n; i++) {
      const a = Math.max(i - 1, 0), b = Math.min(i + 1, n - 1);
      let dx = p[2 * b] - p[2 * a], dz = p[2 * b + 1] - p[2 * a + 1]; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      const y = Math.max(e0 + (e1 - e0) * (len ? cum[i] / len : 0), 2 * Math.min(ve, 3)) + 1.5, x = p[2 * i], z = p[2 * i + 1];
      const lx = x - dz * hw, lz = z + dx * hw, rx = x + dz * hw, rz = z - dx * hw;
      pos.push(lx, y, lz, rx, y, rz, lx, y - thick, lz, rx, y - thick, rz);
      if (i) { const q = base + 4 * (i - 1), r = q + 4;
        idx.push(q, q + 1, r, q + 1, r + 1, r, q + 2, r + 2, q + 3, q + 3, r + 2, r + 3, q, r, q + 2, r, r + 2, q + 2, q + 1, q + 3, r + 1, r + 1, q + 3, r + 3); }
    }
  }
  if (!idx.length) return null;
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  return new THREE.Mesh(g, new THREE.MeshLambertMaterial({color: 0xb9b6ac, side: THREE.DoubleSide}));
}

// ---- breakwaters, piers and quays (OpenSeaMap/OSM): plain concrete bodies standing on the natural seabed ----
export function structures(cx, cy, R, ve) {
  if (!strc) return null;
  const pos = [], idx = [], top = 2.2 * ve, bot = -6 * ve;
  for (const [kind, w10, o] of strc) {
    const n = o.length / 2, p = [];
    for (let i = 0; i < n; i++) p.push(GX0 + o[2 * i] / 10 - cx, GY0 + o[2 * i + 1] / 10 - cy);
    if (!p.some((v, i) => i % 2 === 0 && Math.abs(v) < R && Math.abs(p[i + 1]) < R)) continue;
    const base = pos.length / 3;
    if (kind === 0) {
      const hw = w10 / 20;
      for (let i = 0; i < n; i++) {
        const a = Math.max(i - 1, 0), b = Math.min(i + 1, n - 1);
        let dx = p[2 * b] - p[2 * a], dz = p[2 * b + 1] - p[2 * a + 1]; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
        const x = p[2 * i], z = p[2 * i + 1], lx = x - dz * hw, lz = z + dx * hw, rx = x + dz * hw, rz = z - dx * hw;
        pos.push(lx, top, lz, rx, top, rz, lx, bot, lz, rx, bot, rz);
        if (i) { const q = base + 4 * (i - 1), r = q + 4;
          idx.push(q, q + 1, r, q + 1, r + 1, r, q + 2, r + 2, q + 3, q + 3, r + 2, r + 3, q, r, q + 2, r, r + 2, q + 2, q + 1, q + 3, r + 1, r + 1, q + 3, r + 3); }
      }
    } else {
      let v = []; for (let i = 0; i < n; i++) v.push(new THREE.Vector2(p[2 * i], p[2 * i + 1]));
      const v0 = v.slice(); if (v.length > 1 && v[0].equals(v[v.length - 1])) v.pop();
      if (v.length < 3) continue;
      const tri = THREE.ShapeUtils.triangulateShape(v.slice(), []); v = v0.length === v.length ? v0 : v;
      const nn = v.length;
      for (let i = 0; i < nn; i++) pos.push(v[i].x, top, v[i].y, v[i].x, bot, v[i].y);
      for (const t of tri) idx.push(base + 2 * t[0], base + 2 * t[1], base + 2 * t[2]);
      for (let i = 0; i < nn; i++) { const j = (i + 1) % nn, a = base + 2 * i, b = base + 2 * j; idx.push(a, a + 1, b, b, a + 1, b + 1); }
    }
  }
  if (!idx.length) return null;
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  return new THREE.Mesh(g, new THREE.MeshLambertMaterial({color: 0xb4b0a6, side: THREE.DoubleSide}));
}

// cells near breakwaters/piers: the smoothed DEM piles up spikes there, so the terrain is flattened and the explicit body stands on it
let nearSet = null;
export function nearStructure(gx, gy) {
  if (!strc) return false;
  if (!nearSet) {
    nearSet = new Set(); const Rr = 4;
    const stamp = (x, y) => { for (let i = -Rr; i <= Rr; i++) for (let j = -Rr; j <= Rr; j++) if (i * i + j * j <= Rr * Rr) nearSet.add((Math.round(x / 4) + i) + ',' + (Math.round(y / 4) + j)); };
    for (const [, , o, m] of strc) {
      if (!m) continue;
      const n = o.length / 2;
      for (let i = 0; i < n; i++) { const x = GX0 + o[2 * i] / 10, y = GY0 + o[2 * i + 1] / 10, j = (i + 1) % n, x2 = GX0 + o[2 * j] / 10, y2 = GY0 + o[2 * j + 1] / 10, k = Math.max(1, Math.ceil(Math.hypot(x2 - x, y2 - y) / 4)); for (let q = 0; q <= k; q++) stamp(x + (x2 - x) * q / k, y + (y2 - y) * q / k); }
    }
  }
  return nearSet.has(Math.round(gx / 4) + ',' + Math.round(gy / 4));
}

// ---- turbid estuary water (Sentinel-2 MNDWI) that the land mask treats as land: flat fill just above the ground ----
export function estuary(cx, cy, R, ve, height) {
  if (!est) return null;
  const pos = [], idx = [];
  for (const o of est) {
    const v = [], hs = []; let ok = false;
    for (let i = 0; i < o.length; i += 2) { const x = GX0 + o[i] / 10 - cx, z = GY0 + o[i + 1] / 10 - cy; v.push(new THREE.Vector2(x, z)); hs.push(Math.min(Math.max(height(x, z), 0), 1.5)); if (Math.abs(x) < R && Math.abs(z) < R) ok = true; }
    if (!ok || v.length < 3) continue;
    const base = pos.length / 3, tri = THREE.ShapeUtils.triangulateShape(v, []);
    v.forEach((q, i) => pos.push(q.x, hs[i] * ve + 0.8, q.y));
    for (const t of tri) idx.push(base + t[0], base + t[1], base + t[2]);
  }
  if (!idx.length) return null;
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
  return new THREE.Mesh(g, new THREE.MeshBasicMaterial({color: 0x4d96a6, side: THREE.DoubleSide, transparent: true, opacity: 0.85}));
}

// ---- street furniture: [type, x, y] in decimetres from the texture origin. 0 signal, 1 utility pole, 2 bus stop ----
const FURN = [{h: 6, r: 0.18, c: 0x555a5e}, {h: 9, r: 0.22, c: 0x8a8378}, {h: 2.6, r: 0.08, c: 0x2a8f5a}];
export function furniture(cx, cy, R, ve, height) {
  if (!furn) return null;
  const grp = new THREE.Group(), bs = Math.max(1, ve * 0.6);
  for (let k = 0; k < FURN.length; k++) {
    const pts = furn.filter(o => o[0] === k && Math.abs(GX0 + o[1] / 10 - cx) < R && Math.abs(GY0 + o[2] / 10 - cy) < R && !excl(GX0 + o[1] / 10, GY0 + o[2] / 10)); if (!pts.length) continue;
    const F = FURN[k], g = new THREE.CylinderGeometry(F.r, F.r, 1, 6); g.translate(0, 0.5, 0);
    const m = new THREE.InstancedMesh(g, new THREE.MeshLambertMaterial({color: F.c}), pts.length), M = new THREE.Matrix4(), q = new THREE.Quaternion();
    pts.forEach((o, i) => { const x = GX0 + o[1] / 10 - cx, z = GY0 + o[2] / 10 - cy; M.compose(new THREE.Vector3(x, Math.max(height(x, z), 0) * ve, z), q, new THREE.Vector3(Math.max(1, bs / 2), F.h * bs, Math.max(1, bs / 2))); m.setMatrixAt(i, M); });
    m.instanceMatrix.needsUpdate = true; grp.add(m);
  }
  return grp.children.length ? grp : null;
}

// ---- tidal wetland layer: mangrove + herbaceous wetland (ESA WorldCover) and the zone whose water signal differs between high and low tide (Sentinel-2 MNDWI) ----
let wetTex = null;
export function wetOverlay(src) {
  if (!wetI) return null;
  if (!wetTex) { const c = document.createElement('canvas'); c.width = wetI.w; c.height = wetI.h; c.getContext('2d').drawImage(wetI.bmp, 0, 0); wetTex = new THREE.CanvasTexture(c); wetTex.colorSpace = THREE.SRGBColorSpace; wetTex.anisotropy = 4; wetTex.wrapS = wetTex.wrapT = THREE.ClampToEdgeWrapping; wetTex.magFilter = THREE.NearestFilter; }
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', src.attributes.position); if (src.attributes.normal) geo.setAttribute('normal', src.attributes.normal); geo.setIndex(src.index);
  const p = src.attributes.position, uv = new Float32Array(p.count * 2), cx = src.userData.cx ?? 0, cy = src.userData.cy ?? 0;
  for (let k = 0; k < p.count; k++) { uv[k * 2] = (cx + p.getX(k) - GX0) / (wetI.w * 10); uv[k * 2 + 1] = 1 - (cy + p.getZ(k) - GY0) / (wetI.h * 10); }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({map: wetTex, transparent: true, alphaTest: 0.05, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6}));
  m.renderOrder = 3; return m;
}

// ---- aerial photo (GSI seamless photo, re-projected to the app grid offline): 2.5 m/px island-wide + 0.7 m/px in town/airport/Kabira/Shiraho/Nagura, only where the satellite drape already has alpha ----
const PH = {lo: {res: 2.5, n: 1024, E: 3840, N: 3072, z: 1.1, off: -2.5}, hi: {res: 0.7, n: 1024, E: 1075, N: 3072, z: 1.2, off: -3}};
const phBmp = new Map(), phTex = {};
async function phTile(kind, i, j) {
  const k = kind + '_' + i + '_' + j;
  if (!phBmp.has(k)) phBmp.set(k, A.getData('data/v3/photo/' + k + '.webp').then(b => createImageBitmap(b, {premultiplyAlpha: 'none'})).catch(() => null));
  return phBmp.get(k);
}
function phCanvas(kind, cx, cy) {
  const P = PH[kind], key = kind + cx + ',' + cy;
  if (phTex[kind] && phTex[kind].key === key) return phTex[kind].tex;
  if (phTex[kind]) phTex[kind].tex.dispose();
  const c = document.createElement('canvas'); c.width = c.height = P.N; const g = c.getContext('2d');
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4; tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  phTex[kind] = {key, tex};
  const span = P.n * P.res, x0 = cx - P.E, y0 = cy - P.E;   // window origin in grid metres; canvas px = metres / res
  for (const [i, j] of phIdx[kind]) {
    const tx = GX0 + i * span, ty = GY0 + j * span;
    if (tx > x0 + 2 * P.E || tx + span < x0 || ty > y0 + 2 * P.E || ty + span < y0) continue;
    phTile(kind, i, j).then(b => { if (!b || phTex[kind].key !== key) return; g.drawImage(b, (tx - x0) / P.res, (ty - y0) / P.res, P.n, P.n); tex.needsUpdate = true; });
  }
  return tex;
}
export function photoOverlays(src, cx, cy) {
  if (!phIdx) return [];
  const out = [];
  for (const kind of ['lo', 'hi']) {
    const P = PH[kind], tex = phCanvas(kind, cx, cy);
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', src.attributes.position); if (src.attributes.normal) geo.setAttribute('normal', src.attributes.normal); geo.setIndex(src.index);
    const p = src.attributes.position, uv = new Float32Array(p.count * 2);
    for (let k = 0; k < p.count; k++) { uv[k * 2] = (p.getX(k) + P.E) / (2 * P.E); uv[k * 2 + 1] = 1 - (p.getZ(k) + P.E) / (2 * P.E); }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({map: tex, transparent: true, alphaTest: 0.5, depthWrite: false, polygonOffset: true, polygonOffsetFactor: P.off, polygonOffsetUnits: P.off}));
    m.renderOrder = P.z; out.push(m);
  }
  return out;
}
