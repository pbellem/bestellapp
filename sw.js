const CACHE = 'popup-restaurant-v2';
// Alleen de hoofdapp cachen (index.html + manifest)
// admin.html, tickets.html en station.html worden NOOIT gecached
// zodat updates altijd direct zichtbaar zijn
const ASSETS = [
  './index.html',
  './manifest.json'
];

const NEVER_CACHE = ['admin.html', 'tickets.html', 'station.html', 'help.html'];

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
  if (e.request.url.includes('firebaseio.com') || e.request.url.includes('firebasedatabase.app')) return;

  // Pagina's die nooit gecached mogen worden — altijd vers ophalen
  var shouldNeverCache = NEVER_CACHE.some(function(name) {
    return e.request.url.indexOf(name) !== -1;
  });
  if (shouldNeverCache) {
    e.respondWith(
      fetch(e.request, {cache: 'no-store'}).catch(function() {
        return caches.match(e.request);
      })
    );
    return;
  }

  // Voor index.html en manifest: network-first met fallback naar cache
  if (e.request.url.indexOf('index.html') !== -1 ||
      e.request.url.indexOf('manifest.json') !== -1 ||
      e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).then(function(response) {
        var clone = response.clone();
        caches.open(CACHE).then(function(cache) { cache.put(e.request, clone); });
        return response;
      }).catch(function() {
        return caches.match(e.request) || caches.match('./index.html');
      })
    );
    return;
  }

  // Standaard: cache-first
  e.respondWith(
    caches.match(e.request).then(function(cached) {
      return cached || fetch(e.request);
    })
  );
});
