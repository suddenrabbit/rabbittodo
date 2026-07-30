const CACHE = "rabbittodo-v28";
const ASSETS = ["/", "/index.html", "/style.css", "/style-overrides.css", "/app.js", "/manifest.webmanifest", "/rabbittodo-icon.png", "/rabbittodo-icon-dock-v4.png"];
self.addEventListener("install", (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())));
self.addEventListener("activate", (event) => event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener("fetch", (event) => {
  const pathname = new URL(event.request.url).pathname;
  if (pathname.startsWith("/api/") || pathname.startsWith("/console/")) return;
  event.respondWith(fetch(event.request).then((response) => {
    const copy = response.clone();
    caches.open(CACHE).then((cache) => cache.put(event.request, copy));
    return response;
  }).catch(() => caches.match(event.request)));
});
