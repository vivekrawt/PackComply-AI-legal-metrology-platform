// PWA service worker: app-shell caching only (MOB-01, partial offline support).
// API responses and evidence content are intentionally NOT cached here —
// enforcement data must not persist unencrypted in the SW cache. Full offline
// drafts (encrypted IndexedDB) are a documented later phase.
const SHELL = 'packcomply-shell-v1';
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(['/', '/manifest.webmanifest', '/icon.svg'])));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request).then((r) => r || caches.match('/'))),
  );
});
