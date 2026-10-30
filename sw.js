// Service Worker: app shell is precached; depth data lives in its own cache,
// filled by the page's download button (and by any tile fetched while online).
const SHELL = 'shell-v44';
const OTA = 'ota'; // files downloaded by the in-app update button; they win over the packaged ones
const DATA = 'yaeyama-data-v1';
const SHELL_FILES = ['./', 'index.html', 'native.js', 'app.js', 'extras.js', 'capture.js', 'walk3d.js', 'view3d.js', 'layers3d.js', 'lib/three.module.min.js', 'lib/OrbitControls.js',
  'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    await (await caches.open(SHELL)).addAll(SHELL_FILES.map(u => new Request(u, {cache: 'reload'})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== SHELL && k !== DATA && k !== OTA && k !== 'ota-stage') await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const u = new URL(req.url);
    if (!u.search.includes('b=1')) { // ?b=1 asks for the packaged copy (used to compare versions)
      const p = u.pathname.endsWith('/') ? u.pathname + 'index.html' : u.pathname;
      const o = await (await caches.open(OTA)).match(u.origin + p);
      if (o) return o;
    }
    const path = new URL(req.url).pathname, isData = path.includes('/data/');
    // key.json decides which data version is current: always ask the network first
    if (path.endsWith('/data/key.json')) {
      try { const r = await fetch(req, {cache: 'no-store'}); if (r.ok) { (await caches.open(DATA)).put(req, r.clone()); return r; } } catch (err) {}
      return (await caches.match(req, {ignoreSearch: true})) || Response.error();
    }
    const hit = await caches.match(req, {ignoreSearch: true});
    if (hit) {
      // app files: answer from cache, refresh in the background so the next launch gets updates
      if (!isData) e.waitUntil(fetch(req).then(async r => { if (r.ok) await (await caches.open(SHELL)).put(req, r); }).catch(() => {}));
      return hit;
    }
    try {
      const res = await fetch(req);
      if (res.ok && isData) (await caches.open(DATA)).put(req, res.clone());
      return res;
    } catch (err) {
      if (req.mode === 'navigate') return (await caches.match('index.html')) || Response.error();
      throw err;
    }
  })());
});
