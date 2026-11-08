/* Service worker тренажёра: офлайн-кэш оболочки приложения.
 *
 * ВАЖНО: после изменения index.html / vendor / manifest поднимите версию
 * CACHE (pt-v1 → pt-v2 …) — иначе установленное приложение продолжит
 * отдавать старые файлы из кэша.
 */
'use strict';

var CACHE = 'pt-v14';
var ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './vendor/vexflow.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE)
      .then(function (cache) { return cache.addAll(ASSETS); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(
          keys.filter(function (k) { return k !== CACHE; })
            .map(function (k) { return caches.delete(k); })
        );
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then(function (cached) {
      if (cached) return cached; // cache-first: офлайн-запуск мгновенный
      return fetch(event.request).then(function (response) {
        if (response.ok && new URL(event.request.url).origin === self.location.origin) {
          var copy = response.clone();
          caches.open(CACHE).then(function (cache) { cache.put(event.request, copy); });
        }
        return response;
      }).catch(function () {
        // офлайн и мимо кэша: навигацию спасём заглавной страницей
        if (event.request.mode === 'navigate') return caches.match('./index.html');
        return new Response('Офлайн', { status: 504, statusText: 'Offline' });
      });
    })
  );
});
