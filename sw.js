// Service Worker: app shell is precached; depth data lives in its own cache,
// filled by the page's download button (and by any tile fetched while online).
const SHELL = 'shell-v1';
const DATA = 'yaeyama-data-v1';
const SHELL_FILES = ['./', 'index.html', 'app.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];
const CORE_DATA = ['data/key.json', 'data/meta.json.enc', 'data/base.png.enc', 'data/struct.json.enc'];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    await (await caches.open(SHELL)).addAll(SHELL_FILES);
    await (await caches.open(DATA)).addAll(CORE_DATA);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== SHELL && k !== DATA) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const isData = new URL(req.url).pathname.includes('/data/');
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
