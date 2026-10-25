// Extra 3D layers: satellite colour on land, seabed colour (≤10 m, estimated), buildings, harbour aerial photo.
// Data (data/v3/*) covers Ishigaki island only; everything degrades silently when a file is missing.
import * as THREE from './lib/three.module.min.js';

const GX0 = 67340, GY0 = 5940, TW = 2048, TH = 2197, ST = 20;        // texture origin in grid metres, 20 m per pixel
const PORT = {gx: 76405.97, gy: 33019.82, w: 4126.2, h: 3619.5};     // harbour photo (GSI) extent in grid metres
let A = null, drape = null, tex = null, bot = null, sat = null, bld = null, portImg = null, ready = null;
const triCache = new Map();

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
    try { portImg = await createImageBitmap(await A.getData('data/v3/port.webp'), {imageOrientation: 'flipY', premultiplyAlpha: 'none'}); } catch (e) { portImg = null; }
  })();
  return ready;
}
export const has = () => ({land: !!tex, bottom: !!bot, bld: !!bld, port: !!portImg});

function bil(I, gx, gy, out) {
  const fx = (gx - GX0) / ST - 0.5, fy = (gy - GY0) / ST - 0.5;
  if (fx < 0 || fy < 0 || fx >= I.w - 1 || fy >= I.h - 1) return false;
  const i = fx | 0, j = fy | 0, ax = fx - i, ay = fy - j, d = I.d, p = (j * I.w + i) * 4, q = p + I.w * 4;
  for (let k = 0; k < 4; k++) out[k] = (d[p + k] * (1 - ax) + d[p + 4 + k] * ax) * (1 - ay) + (d[q + k] * (1 - ax) + d[q + 4 + k] * ax) * ay;
  return true;
}
const tmp = [0, 0, 0, 0];
export function landColor(gx, gy) { return tex && bil(tex, gx, gy, tmp) ? [tmp[0], tmp[1], tmp[2]] : null; }
export function bottomColor(gx, gy, mode) { const I = mode === 2 ? sat : bot; return I && bil(I, gx, gy, tmp) && tmp[3] > 2 ? [tmp[0], tmp[1], tmp[2], tmp[3] / 255] : null; }

// ---- buildings ----
export function buildings(cx, cy, R, ve) {
  if (!bld) return null;
  const bs = Math.max(1, ve * 0.6), pos = [], col = [], C = new THREE.Color();
  for (let n = 0; n < bld.length; n++) {
    const b = bld[n], gx = GX0 + b[0] / 10, gy = GY0 + b[1] / 10;
    if (Math.abs(gx - cx) > R || Math.abs(gy - cy) > R) continue;
    let T = triCache.get(n);
    if (!T) {
      const d = b[2], v = [new THREE.Vector2(b[0] / 10, b[1] / 10)];
      for (let i = 0; i < d.length; i += 2) v.push(new THREE.Vector2((b[0] + d[i]) / 10, (b[1] + d[i + 1]) / 10));
      T = {v, tri: THREE.ShapeUtils.triangulateShape(v, [])}; triCache.set(n, T);
    }
    const base = b[4] / 10 * ve, y0 = base - 1, y1 = base + b[3] / 10 * bs, rgb = b[5];
    const r = (rgb >> 16 & 255) / 255, g = (rgb >> 8 & 255) / 255, bl = (rgb & 255) / 255, k = 0.78;
    const ox = GX0 - cx, oy = GY0 - cy, v = T.v;
    for (let i = 0; i < v.length; i++) {
      const a = v[i], c = v[(i + 1) % v.length];
      const ax = a.x + ox, az = a.y + oy, cx2 = c.x + ox, cz = c.y + oy;
      pos.push(ax, y0, az, cx2, y0, cz, cx2, y1, cz, ax, y0, az, cx2, y1, cz, ax, y1, az);
      for (let q = 0; q < 6; q++) col.push(r * k, g * k, bl * k);
    }
    for (const t of T.tri) for (const q of t) { pos.push(v[q].x + ox, y1, v[q].y + oy); col.push(r, g, bl); }
  }
  if (!pos.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); geo.computeVertexNormals();
  return new THREE.Mesh(geo, new THREE.MeshLambertMaterial({vertexColors: true, side: THREE.DoubleSide}));
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
