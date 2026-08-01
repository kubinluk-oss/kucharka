// Service worker: cachuje jen soubory aplikace (shell). Data žijí ve Firebase,
// takže požadavky mimo tento web necháváme být — aplikace potřebuje připojení.
const CACHE = 'kucharka-v87';
const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/firebase.js',
  './js/auth.js',
  './js/ui.js',
  './js/util.js',
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== 'GET') return;
  // network-first s revalidací (obchází heuristickou HTTP cache prohlížeče),
  // cache je záloha pro výpadky
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
