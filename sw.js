const CACHE = 'impostor-v2';
const STATIC = [
  '/',
  '/index.html',
  '/app.js',
  '/auth.js',
  '/supabase-init.js',
  '/style.css',
  '/data.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/manifest.webmanifest',
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(STATIC)),
  );
});

self.addEventListener('activate', event => {
  self.clients.claim();
  // Remove old caches
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))),
    ),
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // API calls always go to the network — never serve from cache
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(request));
    return;
  }

  // For everything else: cache-first, fall back to network
  event.respondWith(
    caches.match(request).then(cached => cached || fetch(request)),
  );
});
