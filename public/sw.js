const CACHE = "rabbittodo-v34";
const ASSETS = ["/", "/index.html", "/style.css", "/style-overrides.css", "/app.js", "/manifest.webmanifest", "/rabbittodo-icon.png", "/rabbittodo-icon-dock-v4.png"];

async function cacheLatestAssets() {
  const cache = await caches.open(CACHE);
  await Promise.all(ASSETS.map(async (url) => {
    const request = new Request(new URL(url, self.location.origin), { cache: "reload" });
    const response = await fetch(request);
    if (!response.ok) throw new Error(`无法缓存 ${url}`);
    await cache.put(url, response);
  }));
}

async function announceVersion() {
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  clients.forEach((client) => client.postMessage({ type: "RABBITTODO_SW_VERSION", version: CACHE }));
}

self.addEventListener("install", (event) => event.waitUntil(cacheLatestAssets().then(() => self.skipWaiting())));
self.addEventListener("activate", (event) => event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()).then(() => announceVersion())));
self.addEventListener("message", (event) => {
  if (event.data?.type === "RABBITTODO_GET_VERSION") event.source?.postMessage({ type: "RABBITTODO_SW_VERSION", version: CACHE });
});
self.addEventListener("fetch", (event) => {
  const pathname = new URL(event.request.url).pathname;
  if (pathname.startsWith("/api/") || pathname.startsWith("/console/")) return;
  event.respondWith(fetch(event.request).then((response) => {
    if (response.ok) {
      const copy = response.clone();
      caches.open(CACHE).then((cache) => cache.put(event.request, copy));
    }
    return response;
  }).catch(() => caches.match(event.request)));
});
