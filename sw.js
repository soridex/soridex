// Soridex Service Worker — cache des images de cartes pour le mode hors ligne
cconst CACHE_VERSION = 'soridex-img-v2';
const IMAGE_HOSTS = [
  'images.pokemontcg.io',
  'cards.scryfall.io',
  'c1.scryfall.com',
  'c2.scryfall.com',
  'c3.scryfall.com',
  'cards.scryfall.com',
  'lorcast.io',
  'cards.lorcast.io',
  'lorcanito-images',
  'lorcana-api.com'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_VERSION && k.startsWith('soridex-img')).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

function isImageRequest(req) {
  try {
    const url = new URL(req.url);
    if (IMAGE_HOSTS.some(h => url.hostname.includes(h))) return true;
    // Fallback : Accept header demande une image
    const accept = req.headers.get('accept') || '';
    if (accept.includes('image/')) return true;
    // Extension
    if (/\.(png|jpg|jpeg|webp|gif|avif)(\?|$)/i.test(url.pathname)) return true;
  } catch (e) {}
  return false;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (!isImageRequest(req)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_VERSION);
    const cached = await cache.match(req);
    if (cached) {
      // Cache-first : on renvoie le cache, et on rafraîchit en arrière-plan si online
      if (navigator.onLine !== false) {
        fetch(req).then(resp => {
          if (resp && resp.ok) cache.put(req, resp.clone()).catch(()=>{});
        }).catch(()=>{});
      }
      return cached;
    }
    try {
      const resp = await fetch(req);
      if (resp && resp.ok) {
        cache.put(req, resp.clone()).catch(()=>{});
      }
      return resp;
    } catch (e) {
      // Offline et pas en cache → on renvoie une réponse vide propre plutôt qu'une erreur réseau
      return new Response('', { status: 504, statusText: 'Offline and not cached' });
    }
  })());
});
