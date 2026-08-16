const CACHE_NAME = 'nexus-shell-v2';
const APP_SHELL = [
  './',
  './index.html',
  './firebase-config.js',
  './scroll-fix.js',
  './manifest.webmanifest',
  './nexus-icon.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

async function responseWithScrollFix(response) {
  const type = response.headers.get('content-type') || '';
  if (!type.includes('text/html')) return response;

  const html = await response.text();
  if (html.includes('scroll-fix.js')) {
    return new Response(html, { status: response.status, statusText: response.statusText, headers: response.headers });
  }

  const injected = html.replace('</body>', '<script src="./scroll-fix.js"></script></body>');
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return new Response(injected, { status: response.status, statusText: response.statusText, headers });
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    try {
      const response = await fetch(event.request);
      const copy = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});

      if (event.request.mode === 'navigate' || url.pathname.endsWith('/index.html') || url.pathname === '/') {
        return responseWithScrollFix(response);
      }
      return response;
    } catch (_) {
      const cached = await caches.match(event.request) || await caches.match('./index.html');
      if (!cached) throw _;
      if (event.request.mode === 'navigate' || url.pathname.endsWith('/index.html') || url.pathname === '/') {
        return responseWithScrollFix(cached);
      }
      return cached;
    }
  })());
});
