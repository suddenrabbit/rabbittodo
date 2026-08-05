const CACHE = "rabbittodo-v76";
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

self.addEventListener("install", (event) => event.waitUntil(cacheLatestAssets()));
self.addEventListener("activate", (event) => event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()).then(() => announceVersion())));
self.addEventListener("message", (event) => {
  if (event.data?.type === "RABBITTODO_GET_VERSION") event.source?.postMessage({ type: "RABBITTODO_SW_VERSION", version: CACHE });
  if (event.data?.type === "RABBITTODO_APPLY_UPDATE") self.skipWaiting();
});
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const pathname = new URL(event.request.url).pathname;
  if (pathname.startsWith("/api/") || pathname.startsWith("/console/")) return;
  event.respondWith(caches.open(CACHE).then(async (cache) => {
    const cached = await cache.match(event.request);
    if (cached) return cached;
    try { return await fetch(event.request); }
    catch { return cache.match("/"); }
  }));
});

self.addEventListener("push", (event) => {
  let payload = { title: "RabbitToDo", body: "你有一条待办提醒" };
  try { if (event.data) payload = { ...payload, ...event.data.json() }; } catch {}
  event.waitUntil(self.registration.showNotification(payload.title, { body: payload.body, icon: "/rabbittodo-icon.png", badge: "/rabbittodo-icon.png" }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
    for (const client of clients) { if ("focus" in client) return client.focus(); }
    if (self.clients.openWindow) return self.clients.openWindow("/");
  }));
});
