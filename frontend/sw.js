const CACHE_NAME = "josocio-cache-v1";
const ASSETS_TO_CACHE = [
  "/",
  "/index.html",
  "/style.css",
  "/app.js",
  "/manifest.json",
  "https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css",
  "https://cdn.socket.io/4.7.2/socket.io.min.js"
];

// Installation du Service Worker et mise en cache des fichiers importants
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log("Mise en cache des ressources PWA terminée.");
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
});

// Interception des requêtes pour servir le cache si on est hors-ligne
self.addEventListener("fetch", (event) => {
  // On ne met en cache que les requêtes GET (on ignore les POST de l'API)
  if (event.request.method !== "GET") return;

  event.respondWith(
    caches.match(event.request).then((response) => {
      // Retourne la version en cache si elle existe, sinon fait la requête réseau
      return response || fetch(event.request);
    })
  );
});