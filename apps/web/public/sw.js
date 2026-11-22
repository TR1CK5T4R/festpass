// The scanner's service worker: lets /scan open with no network. Hand-written because it does one small
// job, and every line can be explained. It never touches API requests: those must fail honestly when
// offline, so the page can switch to offline mode. Change CACHE when this file's behaviour changes.
const CACHE = 'festpass-scan-v1';
const SHELL = ['/scan', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// The first visit loads the page before this worker is in control, so those files passed by unseen.
// The page sends their URLs here, or the first offline reload would have no JavaScript.
self.addEventListener('message', (event) => {
  if (event.data?.type !== 'CACHE_URLS') return;
  const urls = event.data.urls.filter(isStatic);
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(urls)));
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
  } else if (isStatic(url.href)) {
    event.respondWith(cacheFirst(request));
  }
});

// Next.js puts a content hash in these file names, so a cached copy can never be out of date.
function isStatic(href) {
  const { pathname } = new URL(href);
  return (
    pathname.startsWith('/_next/static/') ||
    pathname.startsWith('/icons/') ||
    pathname === '/manifest.webmanifest'
  );
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put('/scan', response.clone());
    return response;
  } catch {
    return (await cache.match('/scan')) ?? Response.error();
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}
