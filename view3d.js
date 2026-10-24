// 3D view (loaded only when the 立体 button is pressed). Terrain around a centre point:
// 10 m samples within ±1.5 km, 40 m samples out to ±6 km. The boat marker floats at sea level (0 m)
// with a line down to the seabed; track, waypoints and photos are drawn on the sea surface.
import * as THREE from './lib/three.module.min.js';
import {OrbitControls} from './lib/OrbitControls.js';

const R_IN = 1500, ST_IN = 10, R_OUT = 6000, ST_OUT = 40;
let A = null, root, renderer, scene, cam, ctl, ray = new THREE.Raycaster();
let center = null, ve = 5, terrain = [], water, me, meLine, trackLine = null, marks = null, building = false, follow = true, needs = false;
const $ = id => document.getElementById(id);

export function open(api) {
  A = api;
  if (!root) setup();
  root.hidden = false; A.pause2d(true); onResize();
  // centre on the boat when the map is following it, otherwise on the middle of the map
  const h = A.here, M = A.META, inside = h && h.gx >= 0 && h.gy >= 0 && h.gx < M.nx * M.st && h.gy < M.ny * M.st;
  follow = !!(inside && A.follow);
  center = follow ? {gx: h.gx, gy: h.gy} : {gx: A.view.cx, gy: A.view.cy};
  cam.position.set(0, 700, 1500); ctl.target.set(0, -15 * ve, 0); ctl.update();
  rebuild();
}
function close() {
  root.hidden = true; clearTerrain(); A.pause2d(false);
}

function setup() {
  const css = document.createElement('style');
  css.textContent = `#v3{position:fixed;inset:0;z-index:5;background:#0a1640}#v3[hidden]{display:none}
#v3c{position:absolute;inset:0;width:100%;height:100%;touch-action:none;display:block}
#v3top{position:absolute;top:calc(var(--st) + 8px);left:calc(var(--sl) + 8px);right:calc(var(--sr) + 8px);padding:8px 12px;font-size:13px}
#v3top .big{font-size:26px;font-weight:700}
#v3ctl{position:absolute;left:calc(var(--sl) + 8px);right:calc(var(--sr) + 8px);bottom:calc(var(--sb) + 64px);padding:8px 10px;display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:13px}
#v3ctl button{padding:7px 11px;font-size:13px}
#v3ctl input[type=range]{flex:1;min-width:90px}
#v3busy{position:absolute;left:50%;top:45%;transform:translate(-50%,-50%);padding:10px 16px}
#v3busy[hidden]{display:none}
#warn{z-index:6}`;
  document.head.appendChild(css);
  root = document.createElement('div'); root.id = 'v3'; root.hidden = true;
  root.innerHTML = `<canvas id="v3c"></canvas>
<div id="v3top" class="card"><div><span style="color:var(--mute)">現在地の水深（推定）</span> <span class="big" id="v3d">—</span></div><div id="v3tap" style="color:var(--mute)">海底をタップすると、その地点の水深が出ます。現在地の印は海面（0m）に浮かんでいます。</div></div>
<div id="v3ctl" class="card">
  <button id="v3back">◀ 地図に戻る</button>
  <button id="v3here">現在地を中心に</button>
  <label><input type="checkbox" id="v3water" checked> 海面</label>
  <span>高さ×<b id="v3vev">5</b></span><input type="range" id="v3ve" min="1" max="10" step="0.5" value="5">
</div>
<div id="v3busy" class="card">地形を読み込み中…</div>`;
  document.body.appendChild(root);

  renderer = new THREE.WebGLRenderer({canvas: $('v3c'), antialias: true});
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  scene = new THREE.Scene(); scene.background = new THREE.Color(0x0a1640);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x2a3a55, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 1.3); sun.position.set(-1, 2, -0.7); scene.add(sun);
  cam = new THREE.PerspectiveCamera(50, 1, 5, 80000);
  ctl = new OrbitControls(cam, $('v3c'));
  ctl.enableDamping = true; ctl.maxPolarAngle = Math.PI * 0.49; ctl.minDistance = 60; ctl.maxDistance = 30000;
  ctl.addEventListener('change', req);

  water = new THREE.Mesh(new THREE.PlaneGeometry(2 * R_OUT, 2 * R_OUT), new THREE.MeshBasicMaterial({color: 0x3fa9ff, transparent: true, opacity: 0.1, depthWrite: false, side: THREE.DoubleSide}));
  water.rotation.x = -Math.PI / 2; water.renderOrder = 5; scene.add(water);

  me = new THREE.Group();
  const ball = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), new THREE.MeshBasicMaterial({color: 0x2f7cff}));
  const halo = new THREE.Mesh(new THREE.RingGeometry(1.3, 1.7, 32), new THREE.MeshBasicMaterial({color: 0xffffff, side: THREE.DoubleSide}));
  halo.rotation.x = -Math.PI / 2; me.add(ball, halo); me.userData.base = 1; scene.add(me);
  meLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial({color: 0xffffff}));
  scene.add(meLine);

  $('v3back').onclick = close;
  $('v3here').onclick = () => { const h = A.here; if (!h) { A.toast('現在地がまだわかりません'); return; } follow = true; moveCenter(h.gx, h.gy); };
  $('v3water').onchange = e => { water.visible = e.target.checked; req(); };
  $('v3ve').oninput = e => { ve = +e.target.value; $('v3vev').textContent = ve; applyVE(); };
  addEventListener('resize', onResize);
  addEventListener('fix', onFix);
  addEventListener('trackchange', () => { if (!root.hidden) { buildTrack(); req(); } });
  addEventListener('marks', () => { if (!root.hidden) { buildMarks(); req(); } });
  addEventListener('leave3d', () => { if (!root.hidden) close(); });
  let down = null;
  $('v3c').addEventListener('pointerdown', e => { down = [e.clientX, e.clientY, e.isPrimary]; });
  $('v3c').addEventListener('pointerup', e => { if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) < 6) onTap(e); down = null; });
}

function onResize() {
  if (!root || root.hidden) return;
  renderer.setSize(innerWidth, innerHeight, false); cam.aspect = innerWidth / innerHeight; cam.updateProjectionMatrix(); req();
}
function req() { if (!needs) { needs = true; requestAnimationFrame(frame); } }
function frame() {
  needs = false;
  if (root.hidden) return;
  const moving = ctl.update();
  // keep markers a constant size on screen
  const k = d => d * 0.011;
  me.scale.setScalar(k(cam.position.distanceTo(me.position)));
  if (marks) for (const m of marks.children) if (m.userData.sized) m.scale.setScalar(k(cam.position.distanceTo(m.position)));
  renderer.render(scene, cam);
  if (moving) req();
}

// ---------- terrain ----------
function clearTerrain() {
  for (const m of terrain) { scene.remove(m); m.geometry.dispose(); m.material.dispose(); }
  terrain = [];
}
async function ensureTiles() {
  const M = A.META, span = M.ch * M.st, jobs = [A.load('base')];
  const box = (R, set, pre) => {
    for (let cj = Math.floor((center.gy - R) / span); cj <= Math.floor((center.gy + R) / span); cj++)
      for (let ci = Math.floor((center.gx - R) / span); ci <= Math.floor((center.gx + R) / span); ci++)
        if (set.has(ci + '_' + cj)) jobs.push(A.load(pre + ci + '_' + cj));
  };
  box(R_OUT, A.CSET, 'c:'); box(R_IN, A.HSET, 'h:');
  await Promise.allSettled(jobs);
}
function grid(R, step, hole) {
  const n = Math.round(2 * R / step) + 1, N = n * n;
  const raw = new Float32Array(N), pos = new Float32Array(N * 3), col = new Float32Array(N * 3), LUT = A.LUT;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const k = j * n + i, x = -R + i * step, z = -R + j * step, s = A.sampleSync(center.gx + x, center.gy + z);
    let y, r, g, b;
    if (!s) { y = -250; r = g = b = 30; }
    else if (s.d === A.STRUCTURE) { y = 3; r = g = b = 160; }
    else if (s.d === A.LAND) { y = s.elev; const t = Math.min(s.elev / 200, 1); r = 228 - 40 * t; g = 216 - 46 * t; b = 180 - 50 * t; }
    else { y = -s.d; const q = Math.min(Math.round(s.d * 10), 640) * 3; r = LUT[q]; g = LUT[q + 1]; b = LUT[q + 2]; }
    raw[k] = y; pos[k * 3] = x; pos[k * 3 + 1] = y * ve; pos[k * 3 + 2] = z;
    col[k * 3] = r / 255; col[k * 3 + 1] = g / 255; col[k * 3 + 2] = b / 255;
  }
  const idx = [];
  for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
    if (hole) { const x0 = -R + i * step, z0 = -R + j * step; if (x0 >= -hole && x0 + step <= hole && z0 >= -hole && z0 + step <= hole) continue; }
    const a = j * n + i, b2 = a + 1, c = a + n, d = c + 1; idx.push(a, c, b2, b2, c, d);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(idx); geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({vertexColors: true}));
  mesh.userData.raw = raw; return mesh;
}
async function rebuild() {
  if (building) return; building = true; $('v3busy').hidden = false;
  try {
    await ensureTiles();
    clearTerrain();
    terrain.push(grid(R_IN, ST_IN, 0), grid(R_OUT, ST_OUT, R_IN - ST_OUT));
    terrain.forEach(m => scene.add(m));
    buildTrack(); buildMarks(); updateMe();
  } finally { building = false; $('v3busy').hidden = true; req(); }
}
function moveCenter(gx, gy) {
  // keep the camera's angle and distance, aim at the new centre
  const off = cam.position.clone().sub(ctl.target);
  center = {gx, gy}; ctl.target.set(0, ctl.target.y, 0); cam.position.copy(ctl.target).add(off); ctl.update();
  rebuild();
}
function applyVE() {
  for (const m of terrain) { const p = m.geometry.attributes.position.array, raw = m.userData.raw; for (let i = 0; i < raw.length; i++) p[i * 3 + 1] = raw[i] * ve; m.geometry.attributes.position.needsUpdate = true; m.geometry.computeVertexNormals(); }
  buildMarks(); updateMe(); req();
}
const local = (lat, lon) => { const [gx, gy] = A.ll2g(lat, lon); return [gx - center.gx, gy - center.gy]; };
const seabed = (x, z) => { const s = A.sampleSync(center.gx + x, center.gy + z); return !s ? 0 : s.d >= 0 ? -s.d : s.d === A.LAND ? s.elev : 3; };

// ---------- boat, track, marks ----------
async function updateMe() {
  const h = A.here;
  me.visible = meLine.visible = !!h;
  if (!h) { $('v3d').textContent = '—'; return; }
  const x = h.gx - center.gx, z = h.gy - center.gy, yb = seabed(x, z) * ve;
  me.position.set(x, 0, z);
  meLine.geometry.setFromPoints([new THREE.Vector3(x, 0, z), new THREE.Vector3(x, Math.min(yb, 0), z)]);
  const r = await A.depthAt(h.gx, h.gy), ds = A.describe(r);
  $('v3d').textContent = ds.big + (ds.unit ? ' ' + ds.unit : '');
  req();
}
function onFix() {
  if (!root || root.hidden || !center) return;
  updateMe();
  const h = A.here;
  if (follow && h && !building && Math.hypot(h.gx - center.gx, h.gy - center.gy) > R_IN * 0.6) moveCenter(h.gx, h.gy);
}
function buildTrack() {
  if (trackLine) { scene.remove(trackLine); trackLine.geometry.dispose(); trackLine = null; }
  const pts = A.track(); if (pts.length < 2) return;
  const P = [], C = [];
  pts.forEach((p, i) => { const [x, z] = local(p[1], p[2]), f = i / (pts.length - 1); P.push(x, 2, z); C.push(1, (230 - 170 * f) / 255, (90 - 60 * f) / 255); });
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
  trackLine = new THREE.Line(g, new THREE.LineBasicMaterial({vertexColors: true})); trackLine.renderOrder = 6; scene.add(trackLine);
}
function buildMarks() {
  if (marks) { scene.remove(marks); marks.traverse(o => { if (o.geometry) o.geometry.dispose(); }); }
  marks = new THREE.Group(); scene.add(marks);
  const pin = new THREE.ConeGeometry(0.7, 2, 12); pin.rotateX(Math.PI); pin.translate(0, 1, 0);
  const box = new THREE.BoxGeometry(1.8, 1.3, 1.8); box.translate(0, 0.65, 0);
  const add = (lat, lon, geo, color, data) => {
    const [x, z] = local(lat, lon);
    if (Math.abs(x) > R_OUT || Math.abs(z) > R_OUT) return;
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({color})); m.position.set(x, 0, z); m.userData = {sized: true, ...data}; marks.add(m);
    const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(x, 0, z), new THREE.Vector3(x, Math.min(seabed(x, z) * ve, 0), z)]), new THREE.LineBasicMaterial({color, transparent: true, opacity: 0.7}));
    marks.add(l);
  };
  for (const w of A.wpts()) add(w.lat, w.lon, pin, 0xff4fa3, {wp: w});
  for (const p of A.photos()) add(p.lat, p.lon, box, 0xa259ff, {photo: p});
}

// ---------- tap: markers first, then the seabed ----------
async function onTap(e) {
  const r = $('v3c').getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1), cam);
  const hitM = marks ? ray.intersectObjects(marks.children.filter(m => m.userData.sized)) : [];
  if (hitM.length) {
    const u = hitM[0].object.userData;
    if (u.photo) { A.openPhoto(u.photo.id); return; }
    if (u.wp) { const w = u.wp; $('v3tap').innerHTML = `<b style="color:#ff8cc6">${esc(w.name)}</b>${w.d != null ? ' ・ ' + w.d + ' m' : ''}${w.note ? `<div class="memo">${esc(w.note)}</div>` : ''}`; return; }
  }
  const hit = ray.intersectObjects(terrain);
  if (!hit.length) return;
  const p = hit[0].point, gx = p.x + center.gx, gy = p.z + center.gy, res = await A.depthAt(gx, gy), ds = A.describe(res), [lat, lon] = A.g2ll(gx, gy);
  $('v3tap').innerHTML = `<b>タップした地点:</b> ${ds.big}${ds.unit ? ' ' + ds.unit : ''} ・ ${A.fmtDM(lat, '北緯', '南緯')} ${A.fmtDM(lon, '東経', '西経')}`;
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]);
