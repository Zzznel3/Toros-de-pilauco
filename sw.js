// Service worker de la app instalada en el celular.
// Siempre pide primero a la red, así los cambios se ven al tiro. La copia guardada solo se usa
// cuando no hay señal, para abrir la página con lo último que se vio. Nunca guarda nada de los
// administradores (ingreso, historial, perfiles, cambios): solo la página y los datos públicos.
const CACHE = 'toros-v1';
const PRECARGA = [
  '/', '/base.css', '/runtime.js', '/manifest.webmanifest', '/img/escudo.png', '/api/estado',
  '/datos/arbitraje.json', '/datos/ligas.json', '/datos/inscripcion.json', '/datos/camisetas_pedidos.json', '/datos/camisetas_numeros.json',
  'https://cdnjs.cloudflare.com/ajax/libs/d3/7.8.5/d3.min.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(PRECARGA.map((u) => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((claves) => Promise.all(claves.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const EXTERNOS = ['cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];
const guardable = (url) => {
  if (url.origin === self.location.origin) return !url.pathname.startsWith('/api/') || url.pathname === '/api/estado';
  return EXTERNOS.includes(url.hostname);
};

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (!guardable(url)) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res && (res.ok || res.type === 'opaque')) {
        const copia = res.clone();
        e.waitUntil(caches.open(CACHE).then((c) => c.put(req, copia)).catch(() => {}));
      }
      return res;
    } catch (error) {
      const guardada = await caches.match(req);
      if (guardada) return guardada;
      if (req.mode === 'navigate') {
        const inicio = await caches.match('/');
        if (inicio) return inicio;
      }
      throw error;
    }
  })());
});
