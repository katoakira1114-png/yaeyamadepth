'use strict';
// 撮影した3D（写真のような3D＝Gaussian splat ＋ 閉じた立体 glb）を地図の長押しで開く。
// データは data/cap/index.json と data/cap/<id>/ の各ファイル（暗号化時は .enc、app.js の getData で復号）。
// シーン座標: x 東, y 北, z 上 (m)。UTM51N の E = x + origin[0], N = y + origin[1]。glb は y-up: glb (x, y, z) = scene (x, z, -y)。
const W3 = (() => {
let IDX = null, idxTried = false, PLAIN = false; // PLAIN: the 3D files are not encrypted (no .enc), even when the depth data is
async function loadIndex(){
  if (idxTried) return IDX; idxTried = true;
  try { IDX = JSON.parse(await (await getData('data/cap/index.json', {cache: 'no-cache'})).text()); } catch (e) { IDX = null; }
  if (!IDX && ENC) try { const r = await fetch('data/cap/index.json', {cache: 'no-cache'}); if (r.ok) { IDX = await r.json(); PLAIN = true; } } catch (e) { IDX = null; }
  if (IDX) { for (const s of IDX.scenes) s.g = s.cams.map(([x, y]) => [x + s.origin[0] - META.x0, META.y0 - (y + s.origin[1])]); requestDraw(); }
  return IDX;
}
// ---------- map: walked paths of each 3D scene, long-press to open ----------
function draw(){
  if (!IDX) return;
  const big = view.s * 20 >= 6 * dpr; // 20 m wide enough to see
  for (const s of IDX.scenes) {
    if (!s.g.length) continue;
    if (big) { ctx.strokeStyle = 'rgba(255,214,90,.9)'; ctx.lineWidth = 3 * dpr; ctx.beginPath(); s.g.forEach(([gx, gy], i) => { const [x, y] = g2s(gx, gy); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke(); }
    const [cx, cy] = g2s(s.g[0][0], s.g[0][1]), r = 9 * dpr;
    ctx.fillStyle = '#ffd65a'; ctx.strokeStyle = '#3a2a00'; ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath(); ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r, cy - r / 2); ctx.lineTo(cx + r, cy + r / 2); ctx.lineTo(cx, cy + r); ctx.lineTo(cx - r, cy + r / 2); ctx.lineTo(cx - r, cy - r / 2); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx - r, cy - r / 2); ctx.lineTo(cx, cy); ctx.lineTo(cx + r, cy - r / 2); ctx.moveTo(cx, cy); ctx.lineTo(cx, cy + r); ctx.stroke();
  }
}
// nearest walked point of any scene to a map point (grid frame), within maxM metres
function nearest(gx, gy, maxM){
  if (!IDX) return null; let best = null;
  for (const s of IDX.scenes) s.g.forEach(([x, y], i) => { const m = Math.hypot(x - gx, y - gy); if (m <= maxM && (!best || m < best.m)) best = {s, i, m}; });
  return best;
}
async function longPress(sx, sy){
  await loadIndex();
  const [gx, gy] = s2g(sx, sy), hit = nearest(gx, gy, Math.max(60, 30 * dpr / view.s));
  if (!hit) { toast(IDX ? 'この近くには撮影した3Dがありません（黄色い線の近くを長押し）' : '撮影した3Dのデータがまだありません'); return; }
  const s = hit.s, eye = s.cams[hit.i];
  // look from the nearest walked point toward the pressed point (or along the path when pressed on it)
  const px = gx + META.x0 - s.origin[0], py = (META.y0 - gy) - s.origin[1];
  let dx = px - eye[0], dy = py - eye[1];
  if (Math.hypot(dx, dy) < 2) { const j = Math.min(s.cams.length - 1, hit.i + 1), k = Math.max(0, j - 2); dx = s.cams[j][0] - s.cams[k][0]; dy = s.cams[j][1] - s.cams[k][1]; }
  const h = Math.hypot(dx, dy) || 1;
  openScene(s, {pos: eye, dir: [dx / h, dy / h]});
}
function toast(t){ let el = document.getElementById('w3toast'); if (!el) { el = document.createElement('div'); el.id = 'w3toast'; document.body.appendChild(el); }
  el.textContent = t; el.hidden = false; clearTimeout(el._t); el._t = setTimeout(() => { el.hidden = true; }, 3500); }

// ---------- viewer overlay ----------
let booted = false, running = false, cur = null, loadedN = 0, busy = false;
const $ = id => document.getElementById('w3' + id);
function makeDOM(){
  const o = document.createElement('div'); o.id = 'w3'; o.hidden = true;
  o.innerHTML = `<div id="w3stage"><canvas id="w3gl" aria-label="撮影した場所の3D"></canvas>
    <svg id="w3north" viewBox="0 0 44 44" aria-label="北の向き"><circle cx="22" cy="22" r="20" fill="rgba(10,22,64,.75)" stroke="rgba(255,255,255,.4)"/><g id="w3needle"><path d="M22 6 L27 24 L22 21 L17 24 Z" fill="#ffd65a"/><text x="22" y="38" text-anchor="middle" font-size="9" fill="#fff">N</text></g></svg>
    <div id="w3top"><b id="w3name"></b><span id="w3msg"></span><button id="w3x" type="button" aria-label="閉じる">✕</button></div>
    <div id="w3bar"><span id="w3layers"><button class="w3b" id="w3tMesh" type="button" aria-pressed="true">立体</button><button class="w3b" id="w3tSplat" type="button" aria-pressed="true">写真3D</button></span><button class="w3b" id="w3more" type="button" hidden>もっと細かく</button></div>
    <div id="w3hint">1本指で見回す・2本指で前後と移動</div></div>`;
  document.body.appendChild(o);
  const st = document.createElement('style');
  st.textContent = `#w3{position:fixed;inset:0;z-index:60;background:linear-gradient(#7fa6d6,#9abde5 50%,#c9dbee)}#w3[hidden],#w3 [hidden],#w3toast[hidden]{display:none!important}
#w3stage{position:absolute;inset:0}#w3gl{display:block;width:100%;height:100%;touch-action:none}
#w3top{position:absolute;left:0;right:0;top:0;padding:calc(env(safe-area-inset-top,0px) + 10px) 12px 10px;display:flex;gap:10px;align-items:center;background:rgba(10,22,64,.72);color:#fff;font-size:14px}
#w3top b{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}#w3msg{flex:1;font-size:12px;opacity:.85}
#w3x{font:inherit;font-size:20px;background:none;border:0;color:#fff;padding:4px 8px;min-width:44px;min-height:44px}
#w3bar{position:absolute;right:12px;bottom:calc(env(safe-area-inset-bottom,0px) + 14px);display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
#w3layers{display:flex;gap:6px}.w3b{font:inherit;font-size:13px;font-weight:700;background:rgba(10,22,64,.78);color:#fff;border:1px solid rgba(255,255,255,.35);border-radius:6px;padding:8px 12px;min-height:40px}
.w3b[aria-pressed="false"]{opacity:.5;text-decoration:line-through}
#w3north{position:absolute;left:12px;bottom:calc(env(safe-area-inset-bottom,0px) + 14px);width:44px;height:44px}
#w3hint{position:absolute;left:64px;bottom:calc(env(safe-area-inset-bottom,0px) + 24px);font-size:11px;color:#fff;text-shadow:0 1px 2px #000;opacity:.85}
#w3toast{position:fixed;left:16px;right:16px;bottom:calc(env(safe-area-inset-bottom,0px) + 90px);z-index:61;background:rgba(10,22,64,.9);color:#fff;padding:10px 14px;border-radius:8px;font-size:14px;text-align:center}`;
  document.head.appendChild(st);
}
let canvas, gl, worker;
function boot(){
  canvas = $('gl'); gl = canvas.getContext('webgl2', {antialias: false, premultipliedAlpha: true, depth: true});
  if (!gl) { $('msg').textContent = 'この端末は WebGL2 に対応していないため表示できません'; return; }
  initGL(); try { initMeshGL(); } catch (e) { mprog = null; }
  worker = makeWorker(); worker.onmessage = e => { const idx = e.data.idx; gl.bindBuffer(gl.ARRAY_BUFFER, idxBuf); gl.bufferData(gl.ARRAY_BUFFER, idx, gl.DYNAMIC_DRAW); drawCount = idx.length; sorting = false; };
  wireInput();
  $('x').onclick = closeScene;
  $('more').onclick = () => cur && loadMore(cur, loadedN + 4);
  for (const [id, k] of [['tMesh', 0], ['tSplat', 1]]) $(id).onclick = () => { if (k) showSplat = !showSplat; else showMesh = !showMesh; $(id).setAttribute('aria-pressed', String(k ? showSplat : showMesh)); };
}
const VS = `#version 300 es
precision highp float; precision highp int;
uniform highp usampler2D u_tex; uniform mat4 proj, view; uniform vec2 focal, viewport;
in vec2 position; in uint index;
out vec4 vColor; out vec2 vPos;
void main(){
  uvec4 cen = texelFetch(u_tex, ivec2((index & 0x3ffu) << 1, index >> 10), 0);
  vec4 cam = view * vec4(uintBitsToFloat(cen.xyz), 1.0);
  vec4 p2 = proj * cam;
  float clip = 1.2 * p2.w;
  if (p2.z < -clip || p2.x < -clip || p2.x > clip || p2.y < -clip || p2.y > clip) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  uvec4 cov = texelFetch(u_tex, ivec2(((index & 0x3ffu) << 1) | 1u, index >> 10), 0);
  vec2 u1 = unpackHalf2x16(cov.x), u2 = unpackHalf2x16(cov.y), u3 = unpackHalf2x16(cov.z);
  mat3 Vrk = mat3(u1.x, u1.y, u2.x, u1.y, u2.y, u3.x, u2.x, u3.x, u3.y);
  mat3 J = mat3(focal.x / cam.z, 0.0, -(focal.x * cam.x) / (cam.z * cam.z), 0.0, -focal.y / cam.z, (focal.y * cam.y) / (cam.z * cam.z), 0.0, 0.0, 0.0);
  mat3 T = transpose(mat3(view)) * J;
  mat3 c2 = transpose(T) * Vrk * T;
  float mid = (c2[0][0] + c2[1][1]) / 2.0;
  float rad = length(vec2((c2[0][0] - c2[1][1]) / 2.0, c2[0][1]));
  float l1 = mid + rad, l2 = mid - rad;
  if (l2 < 0.0) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  vec2 dv = normalize(vec2(c2[0][1], l1 - c2[0][0]));
  vec2 major = min(sqrt(2.0 * l1), 1024.0) * dv;
  vec2 minor = min(sqrt(2.0 * l2), 1024.0) * vec2(dv.y, -dv.x);
  vColor = clamp(p2.z / p2.w + 1.0, 0.0, 1.0) * vec4(cov.w & 0xffu, (cov.w >> 8) & 0xffu, (cov.w >> 16) & 0xffu, (cov.w >> 24) & 0xffu) / 255.0;
  vPos = position;
  vec2 c = p2.xy / p2.w;
  gl_Position = vec4(c + position.x * major / viewport + position.y * minor / viewport, p2.z / p2.w, 1.0);
}`;
const FS = `#version 300 es
precision highp float;
in vec4 vColor; in vec2 vPos; out vec4 o;
void main(){ float A = -dot(vPos, vPos); if (A < -4.0) discard; float B = exp(A) * vColor.a; o = vec4(B * vColor.rgb, B); }`;

let splatVao, prog, uProj, uView, uFocal, uVp, idxBuf, tex, drawCount = 0;
function initGL(){
  if (!gl) return false;
  const sh = (t, s) => { const x = gl.createShader(t); gl.shaderSource(x, s); gl.compileShader(x); if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x)); return x; };
  prog = gl.createProgram(); gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog); splatVao = gl.createVertexArray(); gl.bindVertexArray(splatVao);
  gl.disable(gl.DEPTH_TEST); gl.enable(gl.BLEND);
  gl.blendFuncSeparate(gl.ONE_MINUS_DST_ALPHA, gl.ONE, gl.ONE_MINUS_DST_ALPHA, gl.ONE);
  gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_ADD);
  uProj = gl.getUniformLocation(prog, 'proj'); uView = gl.getUniformLocation(prog, 'view'); uFocal = gl.getUniformLocation(prog, 'focal'); uVp = gl.getUniformLocation(prog, 'viewport');
  const quad = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, quad); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-2, -2, 2, -2, 2, 2, -2, 2]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, 'position'); gl.enableVertexAttribArray(aPos); gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
  tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
  for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE);
  for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
  gl.uniform1i(gl.getUniformLocation(prog, 'u_tex'), 0);
  idxBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, idxBuf);
  const aIdx = gl.getAttribLocation(prog, 'index'); gl.enableVertexAttribArray(aIdx); gl.vertexAttribIPointer(aIdx, 1, gl.UNSIGNED_INT, 0, 0); gl.vertexAttribDivisor(aIdx, 1);
  return true;
}

// float -> half (from antimatter15/splat)
const _f = new Float32Array(1), _i = new Int32Array(_f.buffer);
function half(v){ _f[0] = v; const x = _i[0]; let b = (x >> 16) & 0x8000, m = (x >> 12) & 0x07ff; const e = (x >> 23) & 0xff;
  if (e < 103) return b; if (e > 142) { b |= 0x7c00; b |= ((e == 255) ? 0 : 1) && (x & 0x007fffff); return b; }
  if (e < 113) { m |= 0x0800; b |= (m >> (114 - e)) + ((m >> (113 - e)) & 1); return b; }
  b |= ((e - 112) << 10) | (m >> 1); b += m & 1; return b; }
const pack2 = (a, b) => (half(a) | (half(b) << 16)) >>> 0;

let data = new Uint8Array(0), count = 0, texRows = 0, texBuf = null, posArr = null;
function addChunk(u8){
  const n = (u8.length / 32) | 0, start = count, total = count + n;
  const merged = new Uint8Array(total * 32); merged.set(data.subarray(0, count * 32)); merged.set(u8.subarray(0, n * 32), count * 32); data = merged;
  const rows = Math.ceil(total / 1024);
  const nb = new Uint32Array(2048 * rows * 4); if (texBuf) nb.set(texBuf.subarray(0, Math.min(texBuf.length, nb.length))); texBuf = nb;
  const np = new Float32Array(total * 3); if (posArr) np.set(posArr); posArr = np;
  const tf = new Float32Array(texBuf.buffer), tb = new Uint8Array(texBuf.buffer), fb = new Float32Array(data.buffer);
  for (let i = start; i < total; i++) {
    const x = fb[8 * i], y = fb[8 * i + 1], z = fb[8 * i + 2];
    tf[8 * i] = x; tf[8 * i + 1] = y; tf[8 * i + 2] = z; posArr[3 * i] = x; posArr[3 * i + 1] = y; posArr[3 * i + 2] = z;
    tb[4 * (8 * i + 7)] = data[32 * i + 24]; tb[4 * (8 * i + 7) + 1] = data[32 * i + 25]; tb[4 * (8 * i + 7) + 2] = data[32 * i + 26]; tb[4 * (8 * i + 7) + 3] = data[32 * i + 27];
    const s = [fb[8 * i + 3], fb[8 * i + 4], fb[8 * i + 5]];
    let r = [(data[32 * i + 28] - 128) / 128, (data[32 * i + 29] - 128) / 128, (data[32 * i + 30] - 128) / 128, (data[32 * i + 31] - 128) / 128];
    const ql = Math.hypot(r[0], r[1], r[2], r[3]) || 1; r = r.map(v => v / ql);
    const M = [1 - 2 * (r[2] * r[2] + r[3] * r[3]), 2 * (r[1] * r[2] + r[0] * r[3]), 2 * (r[1] * r[3] - r[0] * r[2]),
               2 * (r[1] * r[2] - r[0] * r[3]), 1 - 2 * (r[1] * r[1] + r[3] * r[3]), 2 * (r[2] * r[3] + r[0] * r[1]),
               2 * (r[1] * r[3] + r[0] * r[2]), 2 * (r[2] * r[3] - r[0] * r[1]), 1 - 2 * (r[1] * r[1] + r[2] * r[2])].map((k, j) => k * s[(j / 3) | 0]);
    const sg = [M[0] * M[0] + M[3] * M[3] + M[6] * M[6], M[0] * M[1] + M[3] * M[4] + M[6] * M[7], M[0] * M[2] + M[3] * M[5] + M[6] * M[8],
                M[1] * M[1] + M[4] * M[4] + M[7] * M[7], M[1] * M[2] + M[4] * M[5] + M[7] * M[8], M[2] * M[2] + M[5] * M[5] + M[8] * M[8]];
    texBuf[8 * i + 4] = pack2(4 * sg[0], 4 * sg[1]); texBuf[8 * i + 5] = pack2(4 * sg[2], 4 * sg[3]); texBuf[8 * i + 6] = pack2(4 * sg[4], 4 * sg[5]);
  }
  count = total; texRows = rows;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32UI, 2048, rows, 0, gl.RGBA_INTEGER, gl.UNSIGNED_INT, texBuf);
  worker.postMessage({pos: posArr, n: count});
  dirty = true;
  
}

// depth sort in a worker (16-bit counting sort, near first)
const makeWorker = () => new Worker(URL.createObjectURL(new Blob([`
let pos = null, n = 0;
onmessage = e => {
  const d = e.data;
  if (d.pos) { pos = d.pos; n = d.n; return; }
  if (!pos) { postMessage({idx: new Uint32Array(0)}); return; }
  const f = d.f; let mn = Infinity, mx = -Infinity; const dep = new Float32Array(n);
  for (let i = 0; i < n; i++) { const z = f[0] * pos[3 * i] + f[1] * pos[3 * i + 1] + f[2] * pos[3 * i + 2]; dep[i] = z; if (z < mn) mn = z; if (z > mx) mx = z; }
  const B = 65536, inv = (B - 1) / ((mx - mn) || 1), keys = new Uint16Array(n), cnt = new Uint32Array(B);
  for (let i = 0; i < n; i++) { const k = ((dep[i] - mn) * inv) | 0; keys[i] = k; cnt[k]++; }
  const st = new Uint32Array(B); for (let k = 1; k < B; k++) st[k] = st[k - 1] + cnt[k - 1];
  const idx = new Uint32Array(n); for (let i = 0; i < n; i++) idx[st[keys[i]]++] = i;
  postMessage({idx}, [idx.buffer]);
};`], {type: 'text/javascript'})));
let sorting = false, dirty = true;

// orbit camera, scene frame: x east, y north, z up
const cam = {t: [0, 0, 0], dist: 30, yaw: -Math.PI / 2, pitch: 0.6};
function camBasis(){
  const cp = Math.cos(cam.pitch), C = [cam.t[0] + cam.dist * cp * Math.cos(cam.yaw), cam.t[1] + cam.dist * cp * Math.sin(cam.yaw), cam.t[2] + cam.dist * Math.sin(cam.pitch)];
  let f = [cam.t[0] - C[0], cam.t[1] - C[1], cam.t[2] - C[2]]; const fl = Math.hypot(...f); f = f.map(v => v / fl);
  let r = [f[1], -f[0], 0]; const rl = Math.hypot(...r) || 1; r = r.map(v => v / rl);           // f × up
  const d = [f[1] * r[2] - f[2] * r[1], f[2] * r[0] - f[0] * r[2], f[0] * r[1] - f[1] * r[0]];   // f × r (down)
  return {C, f, r, d};
}
// ---------- closed solids / ground (glTF .glb, y-up: glb (x, y, z) = scene (x, z, -y)) ----------
const MVS = `#version 300 es
precision highp float;
uniform mat4 proj, view; in vec3 mpos; in vec4 mcol; in vec2 muv; out vec4 vC; out vec3 vW; out vec2 vUV;
void main(){ vC = mcol; vW = mpos; vUV = muv; gl_Position = proj * view * vec4(mpos, 1.0); }`;
const MFS = `#version 300 es
precision highp float;
uniform sampler2D tex; uniform float useTex; in vec4 vC; in vec3 vW; in vec2 vUV; out vec4 o;
void main(){ vec3 n = normalize(cross(dFdx(vW), dFdy(vW))); float l = 0.62 + 0.38 * abs(dot(n, normalize(vec3(0.35, 0.25, 0.9))));
  vec4 c = vC * mix(vec4(1.0), texture(tex, vUV), useTex); o = vec4(c.rgb * l, 1.0); }`;
let mprog = null, muProj, muView, muTex, white; const meshes = []; let showMesh = true, showSplat = true;
function initMeshGL(){
  const sh = (t, src) => { const x = gl.createShader(t); gl.shaderSource(x, src); gl.compileShader(x); if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x)); return x; };
  mprog = gl.createProgram(); gl.attachShader(mprog, sh(gl.VERTEX_SHADER, MVS)); gl.attachShader(mprog, sh(gl.FRAGMENT_SHADER, MFS));
  gl.bindAttribLocation(mprog, 0, 'mpos'); gl.bindAttribLocation(mprog, 1, 'mcol'); gl.bindAttribLocation(mprog, 2, 'muv'); gl.linkProgram(mprog);
  if (!gl.getProgramParameter(mprog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(mprog));
  muProj = gl.getUniformLocation(mprog, 'proj'); muView = gl.getUniformLocation(mprog, 'view'); muTex = gl.getUniformLocation(mprog, 'useTex');
  white = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, white); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
}
function parseGLB(buf){
  const dv = new DataView(buf); if (dv.getUint32(0, true) !== 0x46546C67) throw new Error('glb ではありません');
  let off = 12, json = null, bin = null;
  while (off + 8 <= buf.byteLength) { const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true), body = buf.slice(off + 8, off + 8 + len);
    if (type === 0x4E4F534A) json = JSON.parse(new TextDecoder().decode(body)); else if (type === 0x004E4942) bin = body; off += 8 + len; }
  return {json, bin};
}
const CT = {5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array};
const NC = {SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4};
function acc(g, i){
  const a = g.json.accessors[i], bv = g.json.bufferViews[a.bufferView], C = CT[a.componentType], n = NC[a.type];
  const start = (bv.byteOffset || 0) + (a.byteOffset || 0), es = C.BYTES_PER_ELEMENT * n, st = bv.byteStride || es;
  let arr; if (st === es) arr = new C(g.bin.slice(start, start + a.count * es));
  else { const u = new Uint8Array(a.count * es); for (let k = 0; k < a.count; k++) u.set(new Uint8Array(g.bin, start + k * st, es), k * es); arr = new C(u.buffer); }
  if (a.componentType !== 5126 && a.normalized) { const m = {5121: 255, 5123: 65535, 5120: 127, 5122: 32767}[a.componentType]; arr = Float32Array.from(arr, v => v / m); }
  return {arr, n};
}
function mmul(a, b){ const o = new Array(16).fill(0); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]; return o; }
function nodeMat(nd){
  if (nd.matrix) return nd.matrix.slice();
  const [x, y, z, w] = nd.rotation || [0, 0, 0, 1], [sx, sy, sz] = nd.scale || [1, 1, 1], [tx, ty, tz] = nd.translation || [0, 0, 0];
  return [(1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
          2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
          2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0, tx, ty, tz, 1];
}
async function addGLB(u8){
  const g = parseGLB(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength)), J = g.json, texCache = {};
  async function texFor(mi){
    const m = J.materials && J.materials[mi], t = m && m.pbrMetallicRoughness && m.pbrMetallicRoughness.baseColorTexture; if (!t) return null;
    if (texCache[t.index]) return texCache[t.index];
    const img = J.images[J.textures[t.index].source], bv = J.bufferViews[img.bufferView];
    const bmp = await createImageBitmap(new Blob([new Uint8Array(g.bin, bv.byteOffset || 0, bv.byteLength)], {type: img.mimeType || 'image/png'}));
    const tx = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tx); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
    gl.generateMipmap(gl.TEXTURE_2D); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    return texCache[t.index] = tx;
  }
  const visit = async (ni, parent) => {
    const nd = J.nodes[ni], M = mmul(parent, nodeMat(nd));
    if (nd.mesh != null) for (const pr of J.meshes[nd.mesh].primitives) {
      if (pr.mode != null && pr.mode !== 4) continue;
      const P = acc(g, pr.attributes.POSITION).arr, nv = P.length / 3, pos = new Float32Array(nv * 3);
      for (let i = 0; i < nv; i++) { const x = P[3 * i], y = P[3 * i + 1], z = P[3 * i + 2];
        const gx = M[0] * x + M[4] * y + M[8] * z + M[12], gy = M[1] * x + M[5] * y + M[9] * z + M[13], gz = M[2] * x + M[6] * y + M[10] * z + M[14];
        pos[3 * i] = gx; pos[3 * i + 1] = -gz; pos[3 * i + 2] = gy; }
      const mat = J.materials && J.materials[pr.material], f = (mat && mat.pbrMetallicRoughness && mat.pbrMetallicRoughness.baseColorFactor) || [1, 1, 1, 1];
      const col = new Float32Array(nv * 4);
      if (pr.attributes.COLOR_0 != null) { const {arr, n} = acc(g, pr.attributes.COLOR_0); for (let i = 0; i < nv; i++) for (let k = 0; k < 4; k++) col[4 * i + k] = (k < n ? arr[n * i + k] : 1) * f[k]; }
      else for (let i = 0; i < nv; i++) col.set(f, 4 * i);
      const uv = pr.attributes.TEXCOORD_0 != null ? acc(g, pr.attributes.TEXCOORD_0).arr : null, tex = uv ? await texFor(pr.material) : null;
      const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
      const put = (loc, data, n) => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, n, gl.FLOAT, false, 0, 0); };
      put(0, pos, 3); put(1, col, 4); if (uv) put(2, uv instanceof Float32Array ? uv : Float32Array.from(uv), 2); else gl.vertexAttrib2f(2, 0, 0);
      let cnt = nv, itype = null;
      if (pr.indices != null) { const ia = acc(g, pr.indices).arr, ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
        const i32 = ia instanceof Uint32Array ? ia : Uint32Array.from(ia); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, i32, gl.STATIC_DRAW); cnt = i32.length; itype = gl.UNSIGNED_INT; }
      gl.bindVertexArray(null);
      meshes.push({vao, cnt, itype, tex});
    }
    for (const c of nd.children || []) await visit(c, M);
  };
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], sc = J.scenes ? J.scenes[J.scene || 0].nodes : J.nodes.map((_, i) => i);
  for (const ni of sc) await visit(ni, I);
  dirty = true;
}
function drawMeshes(proj, view){
  gl.useProgram(mprog); gl.uniformMatrix4fv(muProj, false, proj); gl.uniformMatrix4fv(muView, false, view);
  for (const m of meshes) { gl.bindVertexArray(m.vao); gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, m.tex || white);
    gl.uniform1i(gl.getUniformLocation(mprog, 'tex'), 1); gl.uniform1f(muTex, m.tex ? 1 : 0);
    if (m.itype) gl.drawElements(gl.TRIANGLES, m.cnt, m.itype, 0); else gl.drawArrays(gl.TRIANGLES, 0, m.cnt); }
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
}

function frame(){
  if (!running) return;
  const W = canvas.width, H = canvas.height;
  gl.viewport(0, 0, W, H); gl.clearColor(0, 0, 0, 0); gl.clearDepth(1); gl.depthMask(true); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  const {C, f, r, d} = camBasis();
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const view = [r[0], d[0], f[0], 0, r[1], d[1], f[1], 0, r[2], d[2], f[2], 0, -dot(r, C), -dot(d, C), -dot(f, C), 1];
  const fy = H / 2 / Math.tan(0.5 * 60 * Math.PI / 180), fx = fy, zn = 0.1, zf = 1000;
  const proj = [2 * fx / W, 0, 0, 0, 0, -2 * fy / H, 0, 0, 0, 0, zf / (zf - zn), 1, 0, 0, -(zf * zn) / (zf - zn), 0];
  // solids first into depth only, then splats front-to-back (hidden ones culled by depth), then solid colour underneath
  const solids = showMesh && meshes.length && mprog;
  if (solids) { gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS); gl.depthMask(true); gl.colorMask(false, false, false, false); drawMeshes(proj, view); gl.colorMask(true, true, true, true); }
  gl.depthMask(false);
  if (showSplat && drawCount) {
    gl.useProgram(prog); gl.bindVertexArray(splatVao);
    gl.uniformMatrix4fv(uProj, false, proj); gl.uniformMatrix4fv(uView, false, view);
    gl.uniform2fv(uFocal, [fx, fy]); gl.uniform2fv(uVp, [W, H]);
    gl.drawArraysInstanced(gl.TRIANGLE_FAN, 0, 4, drawCount);
  }
  if (solids) { gl.depthFunc(gl.LEQUAL); drawMeshes(proj, view); }
  gl.disable(gl.DEPTH_TEST); gl.bindVertexArray(null);
  if (dirty && !sorting && count) { sorting = true; dirty = false; worker.postMessage({f}); }
  $('needle').setAttribute('transform', `rotate(${(-cam.yaw - Math.PI / 2 + (cam.dist < 1 ? Math.PI : 0)) * 180 / Math.PI} 22 22)`);
  requestAnimationFrame(frame);
}
function resize(){ if (!running) return; const dp = Math.min(devicePixelRatio || 1, 1.5); canvas.width = Math.max(1, innerWidth * dp | 0); canvas.height = Math.max(1, innerHeight * dp | 0); dirty = true; }
addEventListener('resize', resize);

const ptrs = new Map(); let pinch0 = null, pan, zoom;
function wireInput(){
// touch: close to the eye (dist < 1 m) drags look around like a street photo; zoomed out it orbits
canvas.addEventListener('pointerdown', e => { canvas.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, {x: e.clientX, y: e.clientY, b: e.button, s: e.shiftKey}); pinch0 = null; });
canvas.addEventListener('pointerup', e => { ptrs.delete(e.pointerId); pinch0 = null; });
canvas.addEventListener('pointercancel', e => { ptrs.delete(e.pointerId); pinch0 = null; });
pan = function(dx, dy){ const {f, r} = camBasis(); const h = Math.hypot(f[0], f[1]) || 1, s = Math.max(cam.dist, 4) * 0.0018;
  cam.t[0] += -r[0] * dx * s + (f[0] / h) * dy * s; cam.t[1] += -r[1] * dx * s + (f[1] / h) * dy * s; }
zoom = function(k){ // k > 1 zooms out
  const nd = cam.dist * k;
  if (nd < 0.15) { const {f} = camBasis(), h = Math.hypot(f[0], f[1]) || 1, step = (1 - k) * 6; cam.t[0] += f[0] / h * step; cam.t[1] += f[1] / h * step; cam.dist = 0.15; }
  else cam.dist = Math.min(80, nd);
}
canvas.addEventListener('pointermove', e => {
  const p = ptrs.get(e.pointerId); if (!p) return;
  const dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY;
  if (ptrs.size === 1) {
    if (p.b === 2 || p.s) pan(dx, dy);
    else if (cam.dist < 1) { cam.yaw += dx * 0.005; cam.pitch = Math.min(1.3, Math.max(-1.3, cam.pitch - dy * 0.005)); }
    else { cam.yaw -= dx * 0.006; cam.pitch = Math.min(1.5, Math.max(-0.15, cam.pitch + dy * 0.006)); }
  } else if (ptrs.size === 2) {
    const [a, b] = [...ptrs.values()], dist = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    if (pinch0) { zoom(pinch0.d / dist); pan(mx - pinch0.x, my - pinch0.y); }
    pinch0 = {d: dist, x: mx, y: my};
  }
  dirty = true;
});
canvas.addEventListener('wheel', e => { e.preventDefault(); zoom(Math.exp(e.deltaY * 0.001)); dirty = true; }, {passive: false});
canvas.addEventListener('contextmenu', e => e.preventDefault());

}
async function fetchFile(s, name){
  const p = `data/cap/${s.id}/${s.ver ? s.ver + '/' : ''}${name}`; // ver: a rebuilt scene goes to a new folder so cached old files are not reused
  if (!PLAIN) return new Uint8Array(await (await getData(p)).arrayBuffer());
  const r = await fetch(p); if (!r.ok) throw new Error(r.status); return new Uint8Array(await r.arrayBuffer());
}
async function loadMore(s, upto){
  if (busy) return; busy = true; $('more').hidden = true;
  try {
    if (!loadedN && !meshes.length) for (const [i, m] of (s.solids || []).entries()) { $('msg').textContent = `立体を読み込み中… ${i + 1}/${s.solids.length}`; try { await addGLB(await fetchFile(s, m)); } catch (e) { console.warn(e); } }
    while (loadedN < Math.min(upto, s.chunks.length) && cur === s) {
      $('msg').textContent = `読み込み中… ${loadedN + 1}/${Math.min(upto, s.chunks.length)}`;
      addChunk(await fetchFile(s, s.chunks[loadedN])); loadedN++;
    }
    $('msg').textContent = s.date || '';
  } catch (e) { $('msg').textContent = navigator.onLine ? '読み込めませんでした（' + e.message + '）' : '圏外のため読み込めません（一度開いた場所は圏外でも見られます）'; }
  busy = false; $('more').hidden = !(cur === s && loadedN < s.chunks.length);
}
function reset(){ data = new Uint8Array(0); count = 0; texBuf = null; posArr = null; loadedN = 0; drawCount = 0; meshes.length = 0; worker.postMessage({pos: new Float32Array(0), n: 0}); }
function openScene(s, at){
  if (!booted) { makeDOM(); boot(); booted = true; }
  if (cur !== s) { reset(); cur = s; }
  $('name').textContent = s.name; $('msg').textContent = '';
  if (at) { const z = (at.pos[2] != null ? at.pos[2] : 1.5), e = 0.15; cam.t = [at.pos[0] + at.dir[0] * e, at.pos[1] + at.dir[1] * e, z]; cam.dist = e; cam.yaw = Math.atan2(-at.dir[1], -at.dir[0]); cam.pitch = 0; }
  $('').hidden = false; paused2d = true; running = true; resize(); requestAnimationFrame(frame);
  loadMore(s, s.firstLoad || 4);
}
function closeScene(){ running = false; $('').hidden = true; paused2d = false; requestDraw(); }

return {loadIndex, draw, longPress, open: openScene, close: closeScene};
})();
