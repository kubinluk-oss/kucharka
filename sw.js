// Service worker: cachuje jen soubory aplikace (shell). Data žijí ve Firebase,
// takže požadavky mimo tento web necháváme být — aplikace potřebuje připojení.
const CACHE = 'kucharka-v99';
/* Fotky receptů a profilovek. Záměrně VLASTNÍ cache s vlastní verzí: přežije
   aktualizace appky, takže se po každé změně kódu nestahují znovu. Firebase u nich
   posílá `cache-control: private, max-age=0`, takže by je prohlížeč sám nikdy
   neuložil a při každém návratu na stránku by je stahoval znovu. */
const IMG_CACHE = 'kucharka-img-v1';
const IMG_HOST = 'firebasestorage.googleapis.com';
const IMG_MAX = 100;          // strop, ať cache neroste donekonečna
const IMG_STALE = 86400000;  // po dni se uložená fotka na pozadí obnoví (pojistka)
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
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE && k !== IMG_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Nejstarší fotky nad limit zahodí (klíče chodí v pořadí vložení).
async function trimImgCache(cache) {
  const keys = await cache.keys();
  if (keys.length <= IMG_MAX) return;
  await Promise.all(keys.slice(0, keys.length - IMG_MAX).map(k => cache.delete(k)));
}

// Appka se umí zeptat, jakou verzi právě obsluhuje — zobrazuje ji v Nastavení,
// ať je po nasazení hned vidět, jestli běží ta nová (viz „Kuchařka · verze …").
self.addEventListener('message', e => {
  if (e.data === 'version') e.source?.postMessage({ version: CACHE });
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  /* Fotky: nejdřív z uložené kopie (okamžitě), stáhnout jen když ji ještě nemáme.
     Zamrznout na staré fotce nehrozí: při výměně dostane soubor nový přístupový
     token, takže má jinou adresu, kterou si klienti načtou z receptu — a ta v
     uložených kopiích není. Navíc pojistka: kopii starší než den obnovíme na
     pozadí (zobrazí se hned ta uložená, čerstvá naskočí při příštím otevření). */
  if (url.hostname === IMG_HOST) {
    e.respondWith((async () => {
      const cache = await caches.open(IMG_CACHE);
      const hit = await cache.match(e.request);
      if (hit) {
        const d = hit.headers.get('date');
        const stara = !d || (Date.now() - Date.parse(d)) > IMG_STALE;
        if (stara) e.waitUntil((async () => {
          try {
            const fresh = await fetch(e.request);
            if (fresh.ok) await cache.put(e.request, fresh);
          } catch { /* offline — necháme uloženou kopii */ }
        })());
        return hit;
      }
      const res = await fetch(e.request);
      if (res.ok) { await cache.put(e.request, res.clone()); trimImgCache(cache); }
      return res;
    })());
    return;
  }

  if (url.origin !== location.origin) return;
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
