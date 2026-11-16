// Miutif : suivre ses artistes et être prévenu de leurs sorties à 11 h.
import { searchArtists, recentReleases } from "./music.js?v=2";

const $ = (s) => document.querySelector(s);
const store = {
  get(k, fallback) { try { const v = JSON.parse(localStorage.getItem(`miutif.${k}`)); return v ?? fallback; } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(`miutif.${k}`, JSON.stringify(v)); } catch {} },
};

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

let userId = store.get("id");
if (!userId) {
  userId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => (b % 36).toString(36)).join("");
  store.set("id", userId);
}
let artists = store.get("artists", []);
let config = { hour: 11, appleMusic: false, vapidKey: null, country: store.get("country", "fr") };

// ---------- Utilitaires ----------

async function api(path, body) {
  const res = await fetch(`/api/${path}`, body
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    : undefined);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
  return data;
}

let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

function b64ToBytes(b64) {
  const s = atob(b64.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64.length + 3) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

/** Ouvre une sortie dans l'app Musique (iPhone) ou sur music.apple.com. */
function openInMusic(url) {
  if (!/^https:\/\/music\.apple\.com\//.test(url)) return;
  if (isIOS) location.href = url.replace(/^https:\/\//, "music://");
  else window.open(url, "_blank", "noopener");
}

// ---------- Synchronisation avec le serveur ----------

const sync = (extra = {}) => api("sync", { id: userId, artists, tz, ...extra });

// ---------- Notifications ----------

function renderNextTime() {
  const now = new Date();
  const label = now.getHours() < config.hour ? "Aujourd'hui" : "Demain";
  $("#next").textContent = `${label} · ${String(config.hour).padStart(2, "0")}:00`;
}

async function currentSubscription() {
  if (!pushSupported) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

async function renderNotifState() {
  const sub = await currentSubscription();
  const on = !!sub && Notification.permission === "granted";
  $("#enable").hidden = on;
  $("#test").hidden = !on;
  $("#notif-state").textContent = on
    ? "Notifications activées sur ce téléphone ✓"
    : pushSupported && Notification.permission === "denied"
      ? "Notifications refusées : réactive-les dans Réglages › Notifications › Miutif"
      : "Notifications désactivées";
  return sub;
}

async function enableNotifications() {
  if (!pushSupported) {
    if (isIOS && !standalone) {
      $("#install").hidden = false;
      $("#install").scrollIntoView({ behavior: "smooth" });
      toast("Ajoute d'abord Miutif à l'écran d'accueil");
    } else {
      toast("Ce navigateur ne gère pas les notifications");
    }
    return;
  }
  const btn = $("#enable");
  btn.disabled = true;
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") { toast("Notifications refusées"); return; }
    if (!config.vapidKey) config = await api("config");
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription())
      || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(config.vapidKey) }));
    await sync({ subscription: sub.toJSON() });
    toast("C'est bon ! Rendez-vous à 11 h 🎵");
  } catch (e) {
    toast(`Impossible d'activer : ${e.message}`);
  } finally {
    btn.disabled = false;
    renderNotifState();
  }
}

async function sendTest() {
  const btn = $("#test");
  btn.disabled = true;
  try {
    await api("test", { id: userId });
    toast("Notification envoyée !");
  } catch (e) {
    toast(e.message);
  } finally {
    setTimeout(() => { btn.disabled = false; }, 3000);
  }
}

// ---------- Artistes ----------

function renderArtists() {
  $("#count").textContent = artists.length;
  $("#artists-empty").hidden = artists.length > 0;
  $("#artists").innerHTML = [...artists]
    .sort((a, b) => a.name.localeCompare(b.name, "fr"))
    .map((a) => `<span class="chip"><span>${esc(a.name)}</span><button data-remove="${esc(a.id)}" aria-label="Ne plus suivre ${esc(a.name)}">×</button></span>`)
    .join("");
}

const saveArtists = debounce(async () => {
  store.set("artists", artists);
  try { await sync(); } catch {}
  loadReleases();
}, 600);

function addArtists(list) {
  const known = new Set(artists.map((a) => a.id));
  const added = list.filter((a) => a.id && !known.has(a.id) && known.add(a.id));
  if (!added.length) return 0;
  artists = [...artists, ...added.map((a) => ({ id: String(a.id), name: a.name }))];
  renderArtists();
  saveArtists();
  return added.length;
}

function removeArtist(id) {
  artists = artists.filter((a) => a.id !== id);
  renderArtists();
  saveArtists();
}

// Recherche
let lastResults = [];
const search = debounce(async (q) => {
  if (!q) { $("#results").hidden = true; return; }
  try {
    lastResults = await searchArtists(q, config.country);
    renderResults();
  } catch (e) {
    toast(e.message);
  }
}, 300);

function renderResults() {
  const followed = new Set(artists.map((a) => a.id));
  const list = $("#results");
  list.hidden = !lastResults.length && !$("#q").value.trim();
  list.innerHTML = lastResults.length
    ? lastResults.map((a) => `
      <li>
        <span class="avatar">${esc(a.name.charAt(0).toUpperCase())}</span>
        <span class="who"><span class="name">${esc(a.name)}</span><br><span class="genre">${esc(a.genre)}</span></span>
        ${followed.has(a.id)
          ? `<button class="add done" disabled>Suivi ✓</button>`
          : `<button class="add" data-add="${esc(a.id)}">Suivre</button>`}
      </li>`).join("")
    : `<li class="empty">Aucun artiste trouvé</li>`;
}

// Import de la librairie Apple Music (seulement si le serveur a une clé MusicKit)
function loadMusicKit() {
  if (window.MusicKit) return Promise.resolve();
  return new Promise((resolve, reject) => {
    document.addEventListener("musickitloaded", resolve, { once: true });
    const s = document.createElement("script");
    s.src = "https://js-cdn.music.apple.com/musickit/v3/musickit.js";
    s.onerror = () => reject(new Error("MusicKit indisponible"));
    document.head.appendChild(s);
  });
}

async function importAppleMusic() {
  const btn = $("#am-import");
  btn.disabled = true;
  try {
    const [{ token }] = await Promise.all([api("token"), loadMusicKit()]);
    await MusicKit.configure({ developerToken: token, app: { name: "Miutif", build: "1.0.0" } });
    const music = MusicKit.getInstance();
    await music.authorize();

    const found = [];
    for (let offset = 0; offset < 5000; offset += 100) {
      const { data } = await music.api.music("/v1/me/library/artists", { limit: 100, offset, include: "catalog" });
      for (const item of data.data || []) {
        const catalog = item.relationships?.catalog?.data?.[0];
        if (catalog) found.push({ id: catalog.id, name: item.attributes?.name || catalog.attributes?.name || "" });
      }
      if (!data.next) break;
    }
    const n = addArtists(found);
    toast(n ? `${n} artiste${n > 1 ? "s" : ""} ajouté${n > 1 ? "s" : ""} depuis Apple Music` : "Tous tes artistes sont déjà suivis");
  } catch (e) {
    toast(`Import impossible : ${e.message || e}`);
  } finally {
    btn.disabled = false;
  }
}

// ---------- Sorties ----------

function relativeDay(iso) {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86400000);
  if (days <= 0) return "Aujourd'hui";
  if (days === 1) return "Hier";
  if (days < 7) return `Il y a ${days} jours`;
  return new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "long" });
}

let releases = store.get("releases", []);

function renderReleases(loading = false) {
  const list = $("#releases");
  if (loading && !releases.length) {
    list.innerHTML = '<li class="skeleton"></li><li class="skeleton"></li><li class="skeleton"></li>';
    $("#releases-empty").hidden = true;
    return;
  }
  $("#releases-empty").hidden = releases.length > 0 || !artists.length;
  list.innerHTML = releases.map((r) => {
    const isNew = Date.now() - Date.parse(r.date) < 7 * 86400000;
    return `<li><button class="release" data-url="${esc(r.url)}">
      ${r.artwork ? `<img src="${esc(r.artwork)}" alt="" loading="lazy">` : '<span class="ph"></span>'}
      <span class="info">
        <span class="meta">${isNew ? '<span class="badge">NOUVEAU</span>' : ""}<span class="tag">${esc(r.kind)}</span></span>
        <span class="title">${esc(r.title)}</span>
        <span class="artist">${esc(r.artist)}</span>
        <span class="meta">${relativeDay(r.date)}</span>
      </span>
      <svg class="go" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 16 16 8M9 8h7v7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button></li>`;
  }).join("");
}

async function loadReleases() {
  if (!artists.length) { releases = []; renderReleases(); return; }
  renderReleases(true);
  try {
    releases = await recentReleases(artists.map((a) => a.id), { country: config.country, days: 30 });
    store.set("releases", releases);
  } catch (e) {
    toast(e.message);
  }
  renderReleases();
}

// ---------- Événements ----------

$("#enable").addEventListener("click", enableNotifications);
$("#test").addEventListener("click", sendTest);
$("#am-import").addEventListener("click", importAppleMusic);
$("#reload").addEventListener("click", loadReleases);
$("#q").addEventListener("input", (e) => search(e.target.value.trim()));
$("#results").addEventListener("click", (e) => {
  const id = e.target.closest("[data-add]")?.dataset.add;
  const artist = id && lastResults.find((a) => a.id === id);
  if (!artist) return;
  addArtists([artist]);
  toast(`${artist.name} ajouté`);
  renderResults();
});
$("#artists").addEventListener("click", (e) => {
  const id = e.target.closest("[data-remove]")?.dataset.remove;
  if (id) removeArtist(id);
});
$("#releases").addEventListener("click", (e) => {
  const url = e.target.closest("[data-url]")?.dataset.url;
  if (url) openInMusic(url);
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".search, .results")) $("#results").hidden = true;
});
$("#q").addEventListener("focus", () => { if (lastResults.length && $("#q").value.trim()) $("#results").hidden = false; });

// Le service worker transmet le lien d'une notification touchée
navigator.serviceWorker?.addEventListener("message", (e) => {
  if (e.data?.type !== "open") return;
  e.ports[0]?.postMessage("ok");
  openInMusic(e.data.url);
});

// ---------- Démarrage ----------

async function start() {
  const params = new URLSearchParams(location.search);
  const toOpen = params.get("open");
  if (toOpen) {
    history.replaceState(null, "", "/");
    openInMusic(toOpen);
  }

  $("#install").hidden = !(isIOS && !standalone);
  renderNextTime();
  renderArtists();
  renderReleases();

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

  try {
    config = await api("config");
    store.set("country", config.country);
    renderNextTime();
    $("#am-import").hidden = !config.appleMusic;
  } catch {}

  // Téléphone réinstallé : on récupère les artistes gardés sur le serveur
  if (!artists.length) {
    try {
      const saved = await api(`user?id=${userId}`);
      if (saved.artists?.length) { artists = saved.artists; store.set("artists", artists); renderArtists(); }
    } catch {}
  }

  const sub = await renderNotifState();
  // L'adresse d'abonnement peut changer : on la renvoie à chaque ouverture
  if (sub && Notification.permission === "granted") sync({ subscription: sub.toJSON() }).catch(() => {});

  loadReleases();
}

start();
