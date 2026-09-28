// Cadence — safe service worker
// Never fails a navigation. Network-first for HTML, stale-while-revalidate for assets.

const CACHE = 'cadence-v3';
const PRECACHE = [
  '/',
  '/index.html',
  '/login.html',
  '/assets/style.css',
  '/assets/app.js',
  '/assets/data.js',
  '/images/home.png'
];

// ── Install: precache, never fail the install ─────────────────
self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then((c) =>
      Promise.all(
        PRECACHE.map((u) => c.add(u).catch(() => null))
      )
    )
  );
});

// ── Activate: clean old caches, take control ─────────────────
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

// ── Fetch: never return an empty respondWith ─────────────────
self.addEventListener('fetch', (e) => {
  const req = e.request;

  // Only handle GET
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Never intercept API calls
  if (url.pathname.startsWith('/api/')) return;

  // Never intercept cross-origin (Google Fonts, etc.)
  if (url.origin !== location.origin) return;

  const isHTML =
    req.mode === 'navigate' ||
    (req.headers.get('accept') || '').includes('text/html');

  if (isHTML) {
    // Network-first for pages
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() =>
          caches.match(req).then((hit) => hit || caches.match('/index.html'))
        )
        .then((res) => res || new Response('Offline', { status: 503 }))
    );
    return;
  }

  // Stale-while-revalidate for static assets: instant load, fresh next time
  e.respondWith(
    caches.open(CACHE).then((c) =>
      c.match(req).then((hit) => {
        const refresh = fetch(req)
          .then((res) => {
            if (res && res.ok) c.put(req, res.clone()).catch(() => {});
            return res;
          })
          .catch(() => null);
        return hit || refresh.then((res) => res || new Response('', { status: 504 }));
      })
    )
  );
});
