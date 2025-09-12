const CACHE_NAME = 'm4wd-frame-v1';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './favicon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.map((k) => k !== CACHE_NAME ? caches.delete(k) : null))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  // Only handle same-origin GET
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  event.respondWith(
    caches.match(req).then((res) => res || fetch(req).then((net) => {
      // Cache new app shell assets
      if (APP_SHELL.includes(url.pathname) || APP_SHELL.includes('.' + url.pathname)) {
        const copy = net.clone();
        caches.open(CACHE_NAME).then((c) => c.put(req, copy));
      }
      return net;
    }))
  );
});

