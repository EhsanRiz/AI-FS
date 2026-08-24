/* FS Field Monitoring — service worker.
   App-shell cache-first so the app opens with no signal in the field.
   Bump VERSION whenever app.js / styles.css / index.html change. */
var VERSION = 'fsm-v18';
var PRECACHE = [
  './',
  './index.html',
  './styles.css?v=9',
  './app.js?v=18',
  './data/sites.js?v=1',
  './assets/logo-4dcs.png?v=1',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './assets/vendor/leaflet/leaflet.css',
  './assets/vendor/leaflet/leaflet.js'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(VERSION).then(function (c) { return c.addAll(PRECACHE); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== VERSION) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var url = e.request.url;
  if (e.request.method !== 'GET') return;                 // API calls: network only
  if (url.indexOf('supabase.co') !== -1) return;          // never cache data
  if (url.indexOf('tile.openstreetmap.org') !== -1) return; // map tiles: live only

  e.respondWith(
    caches.match(e.request, { ignoreSearch: false }).then(function (hit) {
      if (hit) return hit;
      return fetch(e.request).then(function (res) {
        // runtime-cache same-origin assets and fonts so revisits work offline
        if (res.ok && (url.indexOf(self.location.origin) === 0 ||
                       url.indexOf('fonts.g') !== -1 || url.indexOf('unpkg.com') !== -1)) {
          var copy = res.clone();
          caches.open(VERSION).then(function (c) { c.put(e.request, copy); });
        }
        return res;
      }).catch(function () {
        // offline navigation fallback to the cached shell
        if (e.request.mode === 'navigate') return caches.match('./index.html');
        throw new Error('offline');
      });
    })
  );
});
