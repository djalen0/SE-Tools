// Minimal service worker: this app is a live shared-state tool (one
// global job on the server), not an offline-first document editor, so
// this SW exists only to satisfy "installable to home screen" PWA
// criteria (which require a registered SW + manifest.json), not to cache
// pages for offline use. It intentionally does not intercept fetches --
// every request should always go to the network to see the current job.
const CACHE_NAME = 'pinning-sheets-shell-v1';
const SHELL_ASSETS = [
  '/static/style.css',
  '/static/app.js',
  '/static/manifest.json'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(names =>
      Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n)))
    )
  );
  self.clients.claim();
});

// Network-first for everything -- if the network's up (the normal case),
// always use the live response so the shared job state / any code updates
// are seen immediately. Only fall back to the cached app shell (CSS/JS)
// if the network request outright fails (e.g. briefly offline), so the
// page can still render its chrome instead of a blank error page.
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
