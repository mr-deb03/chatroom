/* ChatRoom service worker — enables install + offline shell.
   Network-first for the app HTML (so updates apply immediately, no stale app),
   cache-first only for immutable assets and uploaded media. */
const CACHE = 'chatroom-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Never intercept realtime or API calls
  if (url.pathname.startsWith('/socket.io') || url.pathname.startsWith('/api')) return;

  const immutable = url.pathname.startsWith('/_next/static') ||
    url.pathname.startsWith('/media') || url.pathname.startsWith('/uploads') ||
    /\.(png|jpe?g|webp|gif|svg|ico|woff2?)$/.test(url.pathname);

  e.respondWith(immutable ? cacheFirst(req) : networkFirst(req));
});

async function cacheFirst(req) {
  const c = await caches.open(CACHE);
  const hit = await c.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok) c.put(req, res.clone());
    return res;
  } catch {
    return hit || Response.error();
  }
}

async function networkFirst(req) {
  const c = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) c.put(req, res.clone());
    return res;
  } catch {
    return (await c.match(req)) || (await c.match('/')) || Response.error();
  }
}
