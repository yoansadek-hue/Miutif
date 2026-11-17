// Miutif : suivre ses artistes et être prévenu de leurs sorties à 11 h.
import { searchArtists, recentReleases, playlistUrl, discography } from "./music.js?v=5";

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
let playlists = store.get("playlists", []);
let excluded = new Set(store.get("excluded", [])); // artistes retirés à la main : les playlists ne les rajoutent pas
let releases = store.get("releases", []);
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

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const plural = (n, word) => `${n} ${word}${n > 1 ? "s" : ""}`;
const initial = (name) => esc((name || "?").trim().charAt(0).toUpperCase() || "?");
const photo = (id) => `/api/artist/${encodeURIComponent(id)}/photo`;
const ICON_X = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
const ICON_CHEV = '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';

function b64ToBytes(b64) {
  const s = atob(b64.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64.length + 3) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

/** Ouvre un lien music.apple.com dans l'app Musique (iPhone) ou dans le navigateur. */
function openInMusic(url) {
  if (!/^https:\/\/music\.apple\.com\//.test(url)) return;
  if (isIOS) location.href = url.replace(/^https:\/\//, "music://");
  else window.open(url, "_blank", "noopener");
}

/** Petite fenêtre de confirmation. Renvoie true si l'utilisateur confirme. */
function confirmBox(title, text, ok = "Supprimer") {
  return new Promise((resolve) => {
    $("#confirm-title").textContent = title;
    $("#confirm-text").textContent = text;
    $("#confirm-yes").textContent = ok;
    $("#confirm").hidden = false;
    const done = (v) => { $("#confirm").hidden = true; $("#confirm-yes").onclick = $("#confirm-no").onclick = null; resolve(v); };
    $("#confirm-yes").onclick = () => done(true);
    $("#confirm-no").onclick = () => done(false);
  });
}

// ---------- Synchronisation ----------

const sync = (extra = {}) => api("sync", { id: userId, artists, playlists, excluded: [...excluded], tz, ...extra });
const syncSoon = debounce(() => sync().catch(() => {}), 800);

function saveAll() {
  store.set("artists", artists);
  store.set("playlists", playlists);
  store.set("excluded", [...excluded]);
  syncSoon();
}

// ---------- Onglets ----------

const TABS = ["artists", "new", "settings"];
let current = null;
const scrollPos = {};

function showTab(tab) {
  if (!TABS.includes(tab)) tab = "new";
  const scroller = $("#scroller");
  if (current) scrollPos[current] = scroller.scrollTop;
  current = tab;
  for (const t of TABS) $(`#tab-${t}`).hidden = t !== tab;
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  $("#tabpill").style.transform = `translateX(${TABS.indexOf(tab) * 100}%)`;
  scroller.scrollTop = scrollPos[tab] || 0;
  $("#results").hidden = true;
}

// ---------- Artistes ----------

function renderArtists() {
  const n = artists.length;
  $("#artists-count").textContent = n ? `${plural(n, "artiste")} suivi${n > 1 ? "s" : ""}` : "Aucun artiste";
  $("#artists-empty").hidden = n > 0;
  $("#artists").innerHTML = [...artists]
    .sort((a, b) => a.name.localeCompare(b.name, "fr", { sensitivity: "base" }))
    .map((a) => `
      <li>
        <button class="main" data-open="${esc(a.id)}">
          <span class="avatar">${initial(a.name)}<img src="${photo(a.id)}" alt="" loading="lazy" decoding="async"></span>
          <span class="name">${esc(a.name)}</span>
        </button>
        <button class="x" data-remove="${esc(a.id)}" aria-label="Supprimer ${esc(a.name)}">${ICON_X}</button>
      </li>`).join("");
}

/** Ajoute des artistes. `manual` : choisi à la main (même s'il avait été retiré avant). */
function addArtists(list, { manual = false } = {}) {
  const known = new Set(artists.map((a) => a.id));
  const added = [];
  for (const a of list) {
    const id = String(a.id);
    if (!id || known.has(id)) continue;
    if (excluded.has(id)) { if (!manual) continue; excluded.delete(id); }
    known.add(id);
    added.push({ id, name: a.name });
  }
  if (added.length) {
    artists = [...artists, ...added];
    renderArtists();
    saveAll();
  }
  return added.length;
}

async function removeArtist(id) {
  const a = artists.find((x) => x.id === id);
  if (!a) return;
  if (!(await confirmBox("Supprimer cet artiste ?", `Voulez-vous vraiment supprimer ${a.name} ? Tu ne seras plus prévenu de ses sorties.`))) return;
  artists = artists.filter((x) => x.id !== id);
  excluded.add(id);
  releases = releases.filter((r) => r.artistId !== id);
  store.set("releases", releases);
  renderArtists();
  renderNews();
  saveAll();
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
  list.hidden = !$("#q").value.trim();
  list.innerHTML = lastResults.length
    ? lastResults.map((a) => `
      <li>
        <button class="main" data-open="${esc(a.id)}" data-name="${esc(a.name)}">
          <span class="avatar">${initial(a.name)}<img src="${photo(a.id)}" alt="" loading="lazy"></span>
          <span class="lines"><b>${esc(a.name)}</b><span>${esc(a.genre)}</span></span>
        </button>
        ${followed.has(a.id)
          ? '<button class="follow" disabled>Suivi</button>'
          : `<button class="follow" data-add="${esc(a.id)}">Suivre</button>`}
      </li>`).join("")
    : '<li><span class="empty" style="padding:16px">Aucun artiste trouvé</span></li>';
}

// ---------- Fiche artiste ----------

const shortDate = (iso) => new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" });
const discoRow = (r) => `
  <li>
    <button class="main" data-url="${esc(r.url)}">
      <img class="cover" src="${esc(r.artwork)}" alt="" loading="lazy">
      <span class="lines"><b>${esc(r.title)}</b><span>${esc(r.kind)}</span></span>
      <span class="date">${shortDate(r.date)}</span>
    </button>
  </li>`;

async function openArtist(id, fallbackName = "") {
  const name = artists.find((a) => a.id === id)?.name || fallbackName;
  $("#sheet-name").textContent = name;
  $("#sheet-avatar").innerHTML = `${initial(name)}<img src="${photo(id)}" alt="">`;
  $("#sheet-disco").innerHTML = '<p class="empty">Chargement de la discographie…</p>';
  $("#sheet-open").onclick = () => openInMusic(`https://music.apple.com/${config.country}/artist/${id}`);
  $("#sheet-scroller").scrollTop = 0;
  $("#sheet").hidden = false;

  let list = [];
  try { list = await discography(id, config.country); } catch {}
  if ($("#sheet").hidden) return;
  if (!list.length) { $("#sheet-disco").innerHTML = '<p class="empty">Discographie indisponible pour le moment.</p>'; return; }
  const albums = list.filter((r) => r.kind === "Album");
  const singles = list.filter((r) => r.kind !== "Album");
  const section = (title, items) => items.length
    ? `<h2 class="group-title">${title}</h2><ul class="list">${items.map(discoRow).join("")}</ul>` : "";
  $("#sheet-disco").innerHTML =
    section("Dernières sorties", list.slice(0, 5)) +
    section(`Albums · ${albums.length}`, albums) +
    section(`Singles et EP · ${singles.length}`, singles);
}

// ---------- Nouveautés ----------

function dayLabel(date) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(date); d.setHours(0, 0, 0, 0);
  const diff = Math.round((today - d) / 86400000);
  const full = d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
  if (diff === 0) return { big: "Aujourd'hui", small: full };
  if (diff === 1) return { big: "Hier", small: full };
  const cap = full.charAt(0).toUpperCase() + full.slice(1);
  return { big: cap, small: "" };
}

const releaseRow = (r) => `
  <li>
    <button class="main" data-url="${esc(r.url)}">
      <img class="cover" src="${esc(r.artwork)}" alt="" loading="lazy">
      <span class="lines"><b>${esc(r.title)}</b><span>${esc(r.artist)} · ${esc(r.kind)}</span></span>
      ${ICON_CHEV}
    </button>
  </li>`;

function renderNews(loading = false) {
  const box = $("#news");
  if (loading && !releases.length && artists.length) {
    box.innerHTML = `<ul class="list">${'<li class="skeleton"></li>'.repeat(4)}</ul>`;
    $("#news-empty").hidden = true;
    return;
  }
  $("#news-empty").hidden = releases.length > 0;
  if (!artists.length) $("#news-empty").textContent = "Ajoute des artistes (onglet Artistes) ou une playlist (Réglages).";
  else $("#news-empty").textContent = "Aucune sortie ces 30 derniers jours pour tes artistes.";

  const groups = new Map();
  for (const r of releases) {
    const key = new Date(r.date).toDateString();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  box.innerHTML = [...groups].map(([key, list]) => {
    const { big, small } = dayLabel(key);
    return `<section class="day">
      <div class="day-head"><h2>${big}</h2>${small ? `<p>${small}</p>` : ""}</div>
      <ul class="list">${list.map(releaseRow).join("")}</ul>
    </section>`;
  }).join("");
}

let loadingReleases = false;
async function loadReleases() {
  if (loadingReleases) return;
  if (!artists.length) { releases = []; renderNews(); return; }
  loadingReleases = true;
  renderNews(true);
  try {
    releases = await recentReleases(artists.map((a) => a.id), { country: config.country, days: 30 });
    store.set("releases", releases);
  } catch (e) {
    if (!releases.length) toast(e.message);
  } finally {
    loadingReleases = false;
  }
  renderNews();
}
const loadReleasesSoon = debounce(loadReleases, 900);

// ---------- Playlists ----------

function renderPlaylists() {
  const html = playlists.map((p) => `
    <div class="row pl">
      ${p.cover ? `<img class="pl-cover" src="${esc(p.cover)}" alt="">` : '<span class="pl-cover"></span>'}
      <span class="lines"><b>${esc(p.title)}</b><span>${plural(p.count || 0, "artiste")}</span></span>
      <button class="x" data-unfollow="${esc(p.url)}" aria-label="Retirer la playlist">${ICON_X}</button>
    </div>`).join("");
  $("#playlists").innerHTML = html;
  $("#ob-playlists").innerHTML = html;
  $("#ob-add").textContent = playlists.length ? "Ajouter une autre playlist" : "Coller le lien";
  $("#ob-start").disabled = !playlists.length && !artists.length;
}

async function importPlaylist(input) {
  const url = playlistUrl(input);
  if (!url) throw new Error("Colle un lien de playlist Apple Music");
  const res = await api("playlist", { url });
  const added = addArtists(res.artists);
  const entry = { url, title: res.title.replace(/ sur Apple Music$/, ""), count: res.artists.length, cover: res.image || null };
  playlists = [entry, ...playlists.filter((p) => p.url !== url)];
  renderPlaylists();
  saveAll();
  return { added, ...entry };
}

async function addPlaylistFromField(inputSel = "#pl-url", btnSel = "#pl-add") {
  const btn = $(btnSel);
  const label = btn.textContent;
  let value = $(inputSel).value.trim();
  if (!value) {
    try { value = await navigator.clipboard.readText(); } catch {}
  }
  if (!value) { $(inputSel).focus(); toast("Colle le lien dans le champ"); return; }
  btn.disabled = true;
  btn.textContent = "Ajout…";
  try {
    const r = await importPlaylist(value);
    $(inputSel).value = "";
    toast(r.added ? `${plural(r.added, "artiste")} ajouté${r.added > 1 ? "s" : ""}` : "Playlist ajoutée");
    loadReleasesSoon();
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
    renderPlaylists();
  }
}

/** À l'ouverture : les artistes ajoutés depuis dans tes playlists sont suivis automatiquement. */
async function refreshPlaylists() {
  let added = 0;
  for (const p of playlists) {
    try { added += (await importPlaylist(p.url)).added; } catch {}
  }
  if (added) toast(`${added} nouvel${added > 1 ? "s" : ""} artiste${added > 1 ? "s" : ""} depuis tes playlists`);
  return added;
}

// ---------- Notifications ----------

async function currentSubscription() {
  if (!pushSupported) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

async function renderNotifState() {
  $("#notif-time").textContent = `${String(config.hour).padStart(2, "0")}:00`;
  const sub = await currentSubscription();
  const on = !!sub && Notification.permission === "granted";
  $("#enable").hidden = on;
  renderOnboardNotif(on);
  $("#notif-state").textContent = on ? "Activées"
    : pushSupported && Notification.permission === "denied" ? "Refusées (Réglages iPhone)"
    : isIOS && !standalone ? "Depuis l'écran d'accueil"
    : "Désactivées";
  return sub;
}

async function enableNotifications() {
  if (!pushSupported) {
    toast(isIOS && !standalone ? "Ajoute d'abord Miutif à l'écran d'accueil" : "Ce navigateur ne gère pas les notifications");
    return;
  }
  const btn = $("#enable");
  btn.disabled = true;
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") { toast("Notifications refusées"); return; }
    if (!config.vapidKey) config = { ...config, ...(await api("config")) };
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription())
      || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(config.vapidKey) }));
    await sync({ subscription: sub.toJSON() });
    toast("Notifications activées");
  } catch (e) {
    toast(`Impossible d'activer : ${e.message}`);
  } finally {
    btn.disabled = false;
    renderNotifState();
  }
}

// ---------- Premier lancement ----------

function renderOnboardNotif(on) {
  const b = $("#ob-notif");
  b.classList.toggle("done", on);
  b.disabled = on || (isIOS && !standalone);
  b.textContent = on ? "Notifications activées ✓"
    : isIOS && !standalone ? "Ajoute d'abord Miutif à l'écran d'accueil" : "Activer les notifications";
  $("#ob-notif-foot").textContent = isIOS && !standalone && !on
    ? "Dans Safari : Partager › Sur l'écran d'accueil, puis ouvre Miutif depuis son icône."
    : "Une seule notification par jour, à 11 h.";
}

/** Affiché tout de suite au lancement tant que l'app n'est pas prête (playlist + notifications). */
function maybeOnboard() {
  const granted = pushSupported && Notification.permission === "granted";
  if ((playlists.length && granted) || store.get("onboarded")) return;
  renderPlaylists();
  renderOnboardNotif(false);
  $("#onboard").hidden = false;
}

// ---------- Apple Music (facultatif, avec une clé MusicKit côté serveur) ----------

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
  try {
    const [{ token }] = await Promise.all([api("token"), loadMusicKit()]);
    await MusicKit.configure({ developerToken: token, app: { name: "Miutif", build: "2.0.0" } });
    const music = MusicKit.getInstance();
    await music.authorize();
    const found = [];
    for (let offset = 0; offset < 5000; offset += 100) {
      const { data } = await music.api.music("/v1/me/library/artists", { limit: 100, offset, include: "catalog" });
      for (const item of data.data || []) {
        const catalog = item.relationships?.catalog?.data?.[0];
        if (catalog) found.push({ id: catalog.id, name: item.attributes?.name || "" });
      }
      if (!data.next) break;
    }
    const n = addArtists(found);
    toast(n ? `${plural(n, "artiste")} ajouté${n > 1 ? "s" : ""}` : "Tous tes artistes sont déjà suivis");
    loadReleasesSoon();
  } catch (e) {
    toast(`Import impossible : ${e.message || e}`);
  }
}

// ---------- Événements ----------

document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
$("#enable").addEventListener("click", enableNotifications);
$("#am-import").addEventListener("click", importAppleMusic);
$("#pl-add").addEventListener("click", () => addPlaylistFromField());
$("#pl-url").addEventListener("keydown", (e) => { if (e.key === "Enter") addPlaylistFromField(); });
$("#ob-add").addEventListener("click", () => addPlaylistFromField("#ob-url", "#ob-add"));
$("#ob-url").addEventListener("keydown", (e) => { if (e.key === "Enter") addPlaylistFromField("#ob-url", "#ob-add"); });
$("#ob-notif").addEventListener("click", enableNotifications);
$("#ob-start").addEventListener("click", () => {
  store.set("onboarded", true);
  $("#onboard").hidden = true;
  showTab("new");
  loadReleases();
});
$("#q").addEventListener("input", (e) => search(e.target.value.trim()));
$("#sheet-close").addEventListener("click", () => { $("#sheet").hidden = true; });

$("#results").addEventListener("click", (e) => {
  const add = e.target.closest("[data-add]")?.dataset.add;
  if (add) {
    const a = lastResults.find((x) => x.id === add);
    if (a && addArtists([a], { manual: true })) { toast(`${a.name} ajouté`); loadReleasesSoon(); }
    renderResults();
    return;
  }
  const open = e.target.closest("[data-open]");
  if (open) openArtist(open.dataset.open, open.dataset.name);
});
$("#artists").addEventListener("click", (e) => {
  const rm = e.target.closest("[data-remove]")?.dataset.remove;
  if (rm) return removeArtist(rm);
  const open = e.target.closest("[data-open]")?.dataset.open;
  if (open) openArtist(open);
});
for (const sel of ["#news", "#sheet-disco"]) {
  $(sel).addEventListener("click", (e) => {
    const url = e.target.closest("[data-url]")?.dataset.url;
    if (url) openInMusic(url);
  });
}
async function onUnfollowClick(e) {
  const url = e.target.closest("[data-unfollow]")?.dataset.unfollow;
  if (!url) return;
  if (!(await confirmBox("Retirer cette playlist ?", "Ses artistes restent suivis, mais ses nouveaux artistes ne seront plus ajoutés.", "Retirer"))) return;
  playlists = playlists.filter((p) => p.url !== url);
  renderPlaylists();
  saveAll();
}
$("#playlists").addEventListener("click", onUnfollowClick);
$("#ob-playlists").addEventListener("click", onUnfollowClick);

// Photo absente : on garde l'initiale
document.addEventListener("error", (e) => {
  if (e.target.tagName === "IMG" && e.target.closest(".avatar")) e.target.remove();
}, true);

// Pas de zoom ni de geste inutile
for (const ev of ["gesturestart", "gesturechange", "dblclick"]) document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });

// Le service worker transmet le lien d'une notification touchée
navigator.serviceWorker?.addEventListener("message", (e) => {
  if (e.data?.type !== "open") return;
  e.ports[0]?.postMessage("ok");
  route(e.data.url);
});

/** Lien venant d'une notification : Apple Music, ou un onglet de Miutif (?tab=new). */
function route(link) {
  if (/^https:\/\/music\.apple\.com\//.test(link)) return openInMusic(link);
  try {
    const tab = new URL(link, location.origin).searchParams.get("tab");
    if (tab) { $("#sheet").hidden = true; showTab(tab); loadReleases(); }
  } catch {}
}

// ---------- Démarrage ----------

async function start() {
  const params = new URLSearchParams(location.search);
  if (params.has("open") || params.has("tab")) history.replaceState(null, "", "/");
  showTab(params.get("tab") || "new");
  if (params.get("open")) openInMusic(params.get("open"));

  $("#install").hidden = !(isIOS && !standalone);
  renderArtists();
  renderPlaylists();
  renderNews(); // tout de suite, depuis la dernière visite : pas d'écran de chargement
  maybeOnboard();

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

  try {
    config = { ...config, ...(await api("config")) };
    store.set("country", config.country);
    $("#am-group").hidden = !config.appleMusic;
  } catch {}

  // Ce que le serveur a (playlists relues chaque matin, téléphone réinstallé…)
  try {
    const saved = await api(`user?id=${userId}`);
    for (const id of saved.excluded || []) excluded.add(String(id));
    const knownUrls = new Set(playlists.map((p) => p.url));
    playlists = [...playlists, ...(saved.playlists || []).filter((p) => !knownUrls.has(p.url))];
    const before = artists.length;
    addArtists(saved.artists || []);
    renderPlaylists();
    if (artists.length !== before || saved.playlists?.length) saveAll();
  } catch {}

  const sub = await renderNotifState();
  if (sub && Notification.permission === "granted") sync({ subscription: sub.toJSON() }).catch(() => {});

  loadReleases();
  if (await refreshPlaylists()) loadReleasesSoon();
}

start();
