// Service Worker — Libro de Caja PCGE
// Sube CACHE_VERSION cada vez que cambies los archivos para forzar la actualización.
const CACHE_VERSION = 'v11';
const CACHE_NAME = `libro-caja-pcge-${CACHE_VERSION}`;

const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './data.json',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png'
];

self.addEventListener('install', (event) => {
  // OJO: a propósito NO se llama self.skipWaiting() aquí. Si ya hay una versión
  // anterior controlando la página, esta nueva versión se queda "esperando" hasta que
  // el usuario confirme desde el aviso "Nueva versión disponible" (ver app.js). Así
  // nunca se reemplaza la app que el usuario está usando sin que él lo sepa.
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .catch((err) => console.error('[SW] Error precacheando:', err))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith('libro-caja-pcge-') && k !== CACHE_NAME)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// La página le pide a esta versión "en espera" que se active ahora (botón Actualizar del aviso).
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Cache-first para el shell de la app; si falla la red y no hay cache, respuesta de respaldo simple.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((response) => {
          if (response && response.status === 200 && response.type === 'basic') {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
          }
          return response;
        })
        .catch(() => {
          if (event.request.mode === 'navigate') {
            return caches.match('./index.html');
          }
          return new Response('', { status: 408, statusText: 'Sin conexión' });
        });
    })
  );
});
