const CACHE = 'popup-restaurant-v1';
// Pas de paden aan als je app in een submap staat op GitHub Pages
// bv. voor https://naam.github.io/popup-restaurant/ gebruik je:
// '/popup-restaurant/index.html'
const ASSETS = [
  './index.html',
  './manifest.json'
];

self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE).then(function(cache) {
      return cache.addAll(ASSETS);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE; })
            .map(function(k) { return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function(e) {
  // Firebase calls altijd via netwerk
  if (e.request.url.includes('firebaseio.com')) return;

  e.respondWith(
    caches.match(e.request).then(function(cached) {
      return cached || fetch(e.request).then(function(response) {
        // Sla HTML en manifest op in cache
        if (e.request.url.includes('.html') || e.request.url.includes('manifest')) {
          var clone = response.clone();
          caches.open(CACHE).then(function(cache) { cache.put(e.request, clone); });
        }
        return response;
      });
    }).catch(function() {
      // Offline fallback
      return caches.match('/index.html');
    })
  );
});
