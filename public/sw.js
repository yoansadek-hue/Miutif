// Service worker de Miutif : uniquement les notifications (pas de cache, pour ne jamais bloquer une mise à jour).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

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
