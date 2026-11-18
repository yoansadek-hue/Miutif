// Service worker de Miutif : notifications + ouverture hors connexion.
// La page vient toujours du réseau quand il y en a (au plus 2,5 s d'attente), sinon de la mémoire :
// page et code restent ainsi toujours de la même version. Les fichiers versionnés (?v=…) sont gardés en mémoire.
const SHELL = "miutif-shell-v2";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));


self.addEventListener("activate", (e) => {
  // l'ancienne mémoire (qui pouvait mélanger deux versions) est effacée
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  // les données (API) et ce service worker passent toujours par le réseau
  if (req.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/") || url.pathname === "/sw.js" || url.searchParams.has("fresh")) return;
  const nav = req.mode === "navigate";
  e.respondWith((async () => {
    const cache = await caches.open(SHELL);
    if (nav) {
      // la page : réseau d'abord (à jour), mémoire si pas de réseau ou réseau trop lent
      const network = fetch(req).then((res) => { if (res.ok) cache.put("/", res.clone()); return res; });
      const timeout = new Promise((r) => setTimeout(r, 2500, null));
      const res = await Promise.race([network.catch(() => null), timeout]);
      if (res) return res;
      const cached = await cache.match("/");
      if (cached) return cached;
      return (await network.catch(() => null)) || new Response("Miutif est hors connexion.", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    // fichiers de l'app : la mémoire d'abord (chaque version a sa propre adresse ?v=…), sinon le réseau
    const cached = await cache.match(req);
    if (cached) return cached;
    try {
      const res = await fetch(req);
      if (res.ok && res.type === "basic") cache.put(req, res.clone());
      return res;
    } catch {
      return new Response("", { status: 504 });
    }
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
