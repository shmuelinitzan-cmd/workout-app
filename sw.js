// Bump CACHE_VERSION on every deploy so phones pick up the new files.
var CACHE_VERSION = 'v20';
var CACHE = 'workout-app-' + CACHE_VERSION;
var FILES = [
  './',
  './index.html',
  './manifest.webmanifest',
  './apple-touch-icon.png',
  './icon-192.png',
  './icon-512.png',
  './timerend.mp3'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return c.addAll(FILES.map(function (f) { return new Request(f, { cache: 'reload' }); }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      // Only old app-file caches; 'workout-meta' (notification text written by the page) must survive.
      return Promise.all(keys.filter(function (k) { return k.indexOf('workout-app-') === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

// Rest-end notification. The push carries no payload; the text was stored by the page when the rest started.
// iOS requires a visible notification for every push, so always show one.
self.addEventListener('push', function (e) {
  e.waitUntil(
    caches.open('workout-meta')
      .then(function (c) { return c.match('./push-meta.json'); })
      .then(function (r) { return r ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (m) {
        m = m || {};
        return self.registration.showNotification(m.title || 'המנוחה נגמרה', {
          body: m.body || 'הגיע הזמן לסט הבא',
          icon: './icon-192.png',
          badge: './icon-192.png',
          tag: 'rest-end',
          lang: 'he',
          dir: 'rtl'
        });
      })
  );
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        if ('focus' in list[i]) return list[i].focus();
      }
      return self.clients.openWindow('./');
    })
  );
});

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(function (hit) {
      return hit || fetch(e.request).catch(function () {
        if (e.request.mode === 'navigate') return caches.match('./index.html');
      });
    })
  );
});
