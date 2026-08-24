// Service Worker mínimo, escrito à mão (sem next-pwa/workbox) — só pra dar
// instalabilidade ao PWA. Cacheia SÓ o app-shell estático (JS/CSS hasheados,
// ícones, manifest); NUNCA cacheia /api/* nem nada de outra origem, porque a
// autenticação deste app é 100% localStorage (sem cookies, ver lib/api.ts) —
// deixar essa regra implícita numa lib seria mais difícil de auditar.
//
// Bump o número da versão sempre que mudar a estratégia de cache aqui —
// isso invalida o cache antigo no próximo `activate`.
const CACHE_NAME = 'af-crm-shell-v1';
const PRECACHE_URLS = ['/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Nunca intercepta chamada de API nem qualquer coisa de outra origem
  // (a API roda num domínio separado no Railway) — passa direto pro
  // navegador tratar normalmente, sem entrar no cache do SW.
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api')) {
    return;
  }

  // Navegação de documento (abrir/recarregar uma rota) — network-first com
  // fallback pro cache, pra nunca arriscar servir HTML velho quando há
  // conexão de verdade.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          return res;
        })
        .catch(() => caches.match(request).then((cached) => cached || caches.match('/dashboard')))
    );
    return;
  }

  // JS/CSS do Next com hash no nome — imutável por definição, seguro
  // cachear agressivo (o hash muda a cada build).
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(
      caches.match(request).then((cached) => cached || fetch(request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        return res;
      }))
    );
    return;
  }

  // Demais estáticos (ícones, manifest) — stale-while-revalidate.
  event.respondWith(
    caches.match(request).then((cached) => {
      const fetchPromise = fetch(request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        return res;
      }).catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
