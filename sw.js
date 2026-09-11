/* sw.js — installs once, then serves everything from cache forever.
   It does not check for a newer version of itself or the app on later opens.
   To ship an update, bump CACHE_NAME and the user must reinstall (remove + re-add to Home Screen). */
const CACHE_NAME = 'ledger-cache-v25';

const PRECACHE_URLS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './db.js',
  './parse.js',
  './categorize.js',
  './charts.js',
  './manifest.json',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',

  // PDF text extraction
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',

  // On-device OCR for scanned statements — pinned so it never re-fetches
  'https://cdn.jsdelivr.net/npm/tesseract.js@5.0.5/dist/tesseract.min.js',
  'https://cdn.jsdelivr.net/npm/tesseract.js@5.0.5/dist/worker.min.js',
  'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.0.0/tesseract-core.wasm.js',
  'https://tessdata.projectnaptha.com/4.0.0/eng.traineddata.gz',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Cache each URL individually so one failed CDN fetch (e.g. offline install) doesn't block the rest.
      await Promise.all(PRECACHE_URLS.map(async (url) => {
        try {
          const req = new Request(url, { mode: url.startsWith('http') ? 'cors' : 'same-origin' });
          const res = await fetch(req);
          if (res && (res.ok || res.type === 'opaque')) await cache.put(url, res);
        } catch (e) { /* ignore individual failures; app still installs */ }
      }));
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(
      names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))
    )).then(() => self.clients.claim())
  );
});

// Cache-first, and never re-validate against the network for anything already cached.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      // Not precached (shouldn't normally happen) — try the network once, and cache it if it works.
      return fetch(event.request).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(event.request, copy));
        }
        return res;
      }).catch(() => cached);
    })
  );
});
