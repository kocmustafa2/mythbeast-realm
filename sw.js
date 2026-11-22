/* Mythbeast Realm: görsel, ses ve font dosyalarını telefonda saklar.
   İlk açılışta bir kez indirilir, sonraki açılışlarda internetten değil telefondan gelir.
   Sayfanın kendisi (index.html) saklanmaz, böylece oyun güncellemeleri hemen gelir.
   Bir dosyanın içeriği değişince sayfadaki sürüm (sw.js?v=...) artırılır, eski depo silinir. */
const V = new URL(location.href).searchParams.get('v') || '1';
const CACHE = 'mr-assets-' + V;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k.startsWith('mr-assets-') && k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET' || r.headers.has('range')) return;
  const u = new URL(r.url);
  if (u.origin !== location.origin || !/\/(img|snd|font)\//.test(u.pathname)) return;
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    const hit = await c.match(r, { ignoreSearch: true });
    if (hit) return hit;
    const res = await fetch(r);
    if (res.ok && res.type === 'basic') c.put(r, res.clone()).catch(() => {});
    return res;
  })());
});
