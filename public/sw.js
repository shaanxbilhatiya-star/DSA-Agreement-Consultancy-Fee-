// v2 — network-first for all HTML, cache-only for CDN libs
const CACHE_NAME = 'ruralift-scan-v2';
const CDN_ASSETS = [
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(CDN_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const url = event.request.url;

  // Always hit network for HTML pages — never serve stale HTML
  if (
    url.includes('/scan') ||
    url.endsWith('/') ||
    url.endsWith('.html') ||
    url.includes('/api/')
  ) {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' }).catch(() =>
        caches.match(event.request)
      )
    );
    return;
  }

  // Cache-first only for CDN JS (doesn't change)
  if (url.includes('cdnjs.cloudflare.com')) {
    event.respondWith(
      caches.match(event.request).then(cached => cached || fetch(event.request))
    );
    return;
  }

  // Everything else: network-first
  event.respondWith(
    fetch(event.request, { cache: 'no-store' }).catch(() =>
      caches.match(event.request)
    )
  );
});
