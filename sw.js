// Офлайн-кэш тренажёра. Файл создаётся скриптом собрать.py — не правьте вручную.
const CACHE = 'trainer-20261128-131019';
const FONTS = 'trainer-fonts-v1'; // шрифты Google: один раз скачать — дальше работают без сети
const ASSETS = ["./", "index.html", "manifest.webmanifest", "icons/icon-180.png", "icons/icon-192.png", "icons/icon-512.png", "data/sets.json"];

self.addEventListener('install', e => {
  // cache: 'reload' — мимо кэша браузера, иначе GitHub Pages ещё 10 минут отдаёт старые файлы
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== FONTS).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// Сначала из памяти телефона — страница открывается сразу, даже при плохом интернете.
// Параллельно в фоне скачивается свежая версия: она покажется при следующем открытии.
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const origin = new URL(req.url).origin;
  if (origin === 'https://fonts.googleapis.com' || origin === 'https://fonts.gstatic.com') {
    e.respondWith(caches.open(FONTS).then(async cache => {
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
      return res;
    }));
    return;
  }
  if (origin !== location.origin) return;
  // Список файлов курсов маленький и меняется из админки: сначала сеть (3 с), без сети — из памяти.
  if (new URL(req.url).pathname.endsWith('/data/sets.json')) {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const res = await Promise.race([fetch(req.url, { cache: 'no-cache' }), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))]);
        if (res.ok) cache.put(req, res.clone());
        return res;
      } catch (err) {
        const hit = await cache.match(req, { ignoreSearch: true });
        if (hit) return hit;
        throw err;
      }
    })());
    return;
  }
  // Из памяти отдаётся только сам тренажёр. Другие страницы (admin.html) — всегда из сети: иначе вместо
  // админки открывался тренажёр, а потом вместо тренажёра — админка.
  const path = new URL(req.url).pathname;
  if (req.mode === 'navigate' && !(path.endsWith('/') || path.endsWith('/index.html'))) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const nav = req.mode === 'navigate';
    const hit = await cache.match(nav ? 'index.html' : req, { ignoreSearch: true });
    const fresh = fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }).then(res => {
      if (res && res.ok) return cache.put(nav ? 'index.html' : req, res.clone()).then(() => res);
      return res;
    });
    if (hit) {
      e.waitUntil(fresh.catch(() => {}));
      return hit;
    }
    return fresh;
  })());
});
