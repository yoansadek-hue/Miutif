// Service worker de Miutif : notifications + ouverture instantanée et hors connexion.
// L'app est servie tout de suite depuis la mémoire, puis mise à jour en arrière-plan.
// Si une nouvelle version arrive au lancement, l'app est prévenue et se recharge.
const SHELL = "miutif-shell-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

async function notifyUpdate() {
  for (const c of await self.clients.matchAll({ type: "window" })) c.postMessage({ type: "updated" });
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  // les données (API) et ce service worker passent toujours par le réseau
  if (req.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/") || url.pathname === "/sw.js" || url.searchParams.has("fresh")) return;
  const nav = req.mode === "navigate";
  const key = nav ? "/" : req; // toutes les ouvertures (/?tab=…) partagent la même page
  e.respondWith((async () => {
    const cache = await caches.open(SHELL);
    const cached = await cache.match(key);
    const network = fetch(req).then(async (res) => {
      if (res.ok && res.type === "basic") {
        if (nav && cached) {
          const [a, b] = await Promise.all([cached.clone().text(), res.clone().text()]);
          if (a !== b) notifyUpdate(); // nouvelle version de l'app
        }
        await cache.put(key, res.clone());
      }
      return res;
    }).catch(() => null);
    if (cached) { e.waitUntil(network); return cached; }
    return (await network) || new Response("Miutif est hors connexion.", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  })());
});

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "Miutif", {
    body: d.body || "",
    icon: "/icons/icon-192.png?v=2",
    badge: "/icons/icon-192.png?v=2",
    tag: d.tag || undefined,
    data: { url: d.url || "/" },
  }));
});

// L'appli ouverte confirme qu'elle a reçu le lien (sinon on l'ouvre à cette adresse).
const ask = (client, url) => new Promise((ok) => {
  const ch = new MessageChannel();
  const t = setTimeout(() => ok(false), 1500);
  ch.port1.onmessage = () => { clearTimeout(t); ok(true); };
  try { client.postMessage({ type: "open", url }, [ch.port2]); } catch { clearTimeout(t); ok(false); }
});

// Appui sur la notif : une sortie s'ouvre dans Apple Music ; le récap ouvre l'onglet Nouveautés.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || "/";
  const isMusic = /^https:\/\/music\.apple\.com\//.test(target);
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const client = all.find((c) => c.focused) || all[0];
    if (client) {
      try { await client.focus(); } catch {}
      if (await ask(client, target)) return;
    }
    return self.clients.openWindow(isMusic ? `/?open=${encodeURIComponent(target)}` : target);
  })());
});
