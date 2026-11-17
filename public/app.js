// Miutif : suivre ses artistes et être prévenu de leurs sorties à 11 h.
import { searchArtists, recentReleases, playlistUrl, discography, featOf } from "./music.js?v=11";

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

/** Chaque onglet a sa propre zone de défilement : passer de l'un à l'autre ne change pas leur position. */
function showTab(tab) {
  if (!TABS.includes(tab)) tab = "new";
  const first = current === null;
  current = tab;
  for (const t of TABS) $(`#scroll-${t}`).classList.toggle("off", t !== tab);
  BTNS.forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  pillTo(BTNS.find((b) => b.dataset.tab === tab), !first);
}

/**
 * Appui sur un onglet de la barre. Une fiche artiste ouverte se ferme (on revient à la liste).
 * Appui sur l'onglet déjà ouvert : la page remonte tout en haut.
 */
function tapTab(tab) {
  const sheetOpen = !$("#sheet").hidden;
  if (sheetOpen) closeSheet();
  if (tab === current) {
    if (!sheetOpen) $(`#scroll-${tab}`).scrollTo({ top: 0, behavior: reduced() ? "auto" : "smooth" });
    return;
  }
  showTab(tab);
}

// ---------- Barre d'onglets : on peut y glisser le doigt (comme Quizly) ----------

const bar = $("#tabbar");
const pill = $("#tabpill");
const BTNS = [...bar.querySelectorAll(".tab")];
const P = { x: 0, anim: null };
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const place = (x, sx = 1, sy = 1) => { P.x = x; pill.style.transform = `translate3d(${x}px,0,0) scale(${sx},${sy})`; };

// petit « tic » quand la bulle change d'onglet : vibrate sur Android ;
// sur iPhone (iOS 18+), basculer un interrupteur caché fait vibrer le téléphone
const hapticSwitch = (() => {
  if ("vibrate" in navigator) return null;
  const input = document.createElement("input");
  input.type = "checkbox"; input.setAttribute("switch", ""); input.tabIndex = -1;
  if (!("switch" in input)) return null;
  const label = document.createElement("label");
  label.setAttribute("aria-hidden", "true"); label.append(input);
  label.style.cssText = "position:fixed;left:-99px;top:0;width:1px;height:1px;opacity:0;pointer-events:none";
  document.body.append(label);
  return label;
})();
function haptic() { if (navigator.vibrate) navigator.vibrate(8); else if (hapticSwitch) hapticSwitch.click(); }

/** Amène la bulle sous un onglet, avec un petit étirement pendant le trajet. */
function pillTo(btn, animate = true, from = P.x) {
  if (!btn) return;
  const x = btn.offsetLeft, w = btn.offsetWidth;
  pill.style.width = `${w}px`;
  if (P.anim) { P.anim.cancel(); P.anim = null; }
  if (animate && Math.abs(x - from) > 1 && !reduced()) {
    const d = Math.abs(x - from), k = Math.min(0.55, d / (w * 2.6));
    P.anim = pill.animate([
      { transform: `translate3d(${from}px,0,0) scale(1,1)` },
      { offset: 0.42, transform: `translate3d(${from + (x - from) * 0.58}px,0,0) scale(${1 + k},${1 - k * 0.32})` },
      { offset: 0.8, transform: `translate3d(${x + (x - from) * 0.02}px,0,0) scale(${1 - k * 0.08},${1 + k * 0.06})` },
      { transform: `translate3d(${x}px,0,0) scale(1,1)` },
    ], { duration: 380 + Math.min(180, d * 0.5), easing: "cubic-bezier(.22,.8,.3,1)" });
    P.anim.onfinish = () => { P.anim = null; };
  }
  place(x);
}

let drag = null;
/** Onglet le plus proche du doigt (calculé directement, sans attendre la prochaine image). */
function tabUnder(cx) {
  const w = pill.offsetWidth, g = drag.geo;
  const mid = Math.max(g[0].x, Math.min(g[g.length - 1].x, cx - drag.left - w / 2)) + w / 2;
  return g.reduce((a, b) => (Math.abs(mid - (b.x + b.w / 2)) < Math.abs(mid - (a.x + a.w / 2)) ? b : a)).t;
}
function dragLoop() { // la bulle suit le doigt et s'étire selon la vitesse
  if (!drag) return;
  if (drag.moved) {
    const w = pill.offsetWidth, g = drag.geo, lo = g[0].x, hi = g[g.length - 1].x;
    const raw = drag.cx - drag.left - w / 2;
    // au-delà du premier ou du dernier onglet : la bulle résiste et la barre s'étire de ce côté
    const out = raw < lo ? raw - lo : raw > hi ? raw - hi : 0;
    const x = out ? (out < 0 ? lo : hi) + Math.max(-14, Math.min(14, out * 0.12)) : raw;
    if (!!out !== drag.edge) { drag.edge = !!out; if (out) haptic(); }
    if (out) {
      bar.style.transformOrigin = out < 0 ? "right center" : "left center";
      bar.style.scale = `${1 + Math.min(0.045, (Math.abs(out) / bar.offsetWidth) * 0.2)} 1`;
    } else bar.style.scale = "";
    drag.v *= 0.82;
    const k = Math.min(0.4, Math.abs(drag.v) * 0.09);
    place(x, 1 + k, 1 - k * 0.3);
    const mid = x + w / 2;
    const over = g.reduce((a, b) => (Math.abs(mid - (b.x + b.w / 2)) < Math.abs(mid - (a.x + a.w / 2)) ? b : a)).t;
    if (over !== drag.over) { drag.over.classList.remove("over"); over.classList.add("over"); drag.over = over; haptic(); }
  }
  requestAnimationFrame(dragLoop);
}

bar.addEventListener("pointerdown", (e) => {
  const t = e.target.closest(".tab");
  if (!t || (e.pointerType === "mouse" && e.button !== 0)) return;
  drag = {
    id: e.pointerId, x0: e.clientX, cx: e.clientX, t: performance.now(), v: 0, moved: false, edge: false,
    left: bar.getBoundingClientRect().left, tab: t, over: t,
    geo: BTNS.map((b) => ({ t: b, x: b.offsetLeft, w: b.offsetWidth })),
  };
  try { bar.setPointerCapture(e.pointerId); } catch {}
  bar.classList.add("press");
  pillTo(t);
  requestAnimationFrame(dragLoop);
});
bar.addEventListener("pointermove", (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  if (!drag.moved && Math.abs(e.clientX - drag.x0) < 5) return;
  if (!drag.moved) { drag.moved = true; bar.classList.add("drag"); if (P.anim) { P.anim.cancel(); P.anim = null; } }
  const now = performance.now(), dt = Math.max(1, now - drag.t);
  drag.v = drag.v * 0.4 + ((e.clientX - drag.cx) / dt) * 0.6;
  drag.cx = e.clientX; drag.t = now;
});
function dragEnd(e, cancel) {
  if (!drag || e.pointerId !== drag.id) return;
  const d = drag;
  const t = cancel ? null : d.moved ? tabUnder(e.clientX || d.cx) : d.tab;
  drag = null;
  bar.classList.remove("press", "drag");
  BTNS.forEach((b) => b.classList.remove("over"));
  bar.style.scale = ""; // la barre reprend sa taille avec un rebond
  if (t) {
    if (!d.moved && !t.classList.contains("on")) haptic();
    tapTab(t.dataset.tab); // la bulle part de là où le doigt l'a laissée
    if (t.dataset.tab === current) pillTo(t, true);
  } else {
    pillTo(BTNS.find((b) => b.classList.contains("on")), true);
  }
}
bar.addEventListener("pointerup", (e) => dragEnd(e));
bar.addEventListener("pointercancel", (e) => dragEnd(e, true));
addEventListener("resize", () => pillTo(BTNS.find((b) => b.classList.contains("on")), false));

// ---------- Artistes ----------

function renderArtists() {
  const n = artists.length;
  $("#artists-count").textContent = n ? `${plural(n, "artiste")} suivi${n > 1 ? "s" : ""}` : "Aucun artiste";
  $("#artists-empty").hidden = n > 0;
  updateSearchMode();
  // groupés par lettre, comme les Contacts de l'iPhone (chiffres et symboles dans « # », à la fin)
  const letterOf = (name) => {
    const c = (name || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().charAt(0).toUpperCase();
    return /[A-Z]/.test(c) ? c : "#";
  };
  const groups = new Map();
  for (const a of [...artists].sort((x, y) => x.name.localeCompare(y.name, "fr", { sensitivity: "base" }))) {
    const l = letterOf(a.name);
    if (!groups.has(l)) groups.set(l, []);
    groups.get(l).push(a);
  }
  const letters = [...groups.keys()].sort((x, y) => (x === "#") - (y === "#") || x.localeCompare(y));
  $("#artists").innerHTML = letters.map((l) => `
    <h2 class="letter">${l}</h2>
    <ul class="list">${groups.get(l).map((a) => `
      <li>
        <button class="main" data-open="${esc(a.id)}">
          <span class="avatar">${initial(a.name)}<img src="${photo(a.id)}" alt="" loading="lazy" decoding="async"></span>
          <span class="name">${esc(a.name)}</span>
        </button>
        <button class="x" data-remove="${esc(a.id)}" aria-label="Supprimer ${esc(a.name)}">${ICON_X}</button>
      </li>`).join("")}
    </ul>`).join("");
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
  unfollowArtist(id);
}

/** Ne plus suivre un artiste (il n'est plus rajouté par une playlist). */
function unfollowArtist(id) {
  if (!artists.some((x) => x.id === id)) return;
  artists = artists.filter((x) => x.id !== id);
  excluded.add(id);
  releases = releases.filter((r) => r.artistId !== id);
  store.set("releases", releases);
  renderArtists();
  renderNews();
  if (lastResults.length) renderResults();
  saveAll();
}

// Recherche
let lastResults = [];
/** Pendant une recherche, on n'affiche que les résultats (la liste de ses artistes est masquée). */
function updateSearchMode() {
  const searching = !!$("#q").value.trim();
  $("#artists").hidden = searching;
  $("#artists-empty").hidden = searching || artists.length > 0;
  if (!searching) { $("#results").hidden = true; lastResults = []; }
}

const search = debounce(async (q) => {
  if (!q) { updateSearchMode(); return; }
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
          ? `<button class="follow on" data-unfollow-artist="${esc(a.id)}" aria-label="Ne plus suivre ${esc(a.name)}">Suivi</button>`
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
  const followBtn = $("#sheet-follow");
  const paint = () => {
    const on = artists.some((a) => a.id === id);
    followBtn.textContent = on ? "Suivi ✓" : "Suivre";
    followBtn.classList.toggle("on", on);
  };
  followBtn.onclick = () => {
    if (artists.some((a) => a.id === id)) { unfollowArtist(id); toast(`Tu ne suis plus ${name}`); }
    else if (addArtists([{ id, name: $("#sheet-name").textContent || name }], { manual: true })) { toast(`${name} ajouté`); loadReleasesSoon(); }
    paint();
    if (lastResults.length) renderResults();
  };
  paint();
  $("#sheet-scroller").scrollTop = 0;
  openSheet();

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

const releaseRow = (r) => {
  const feat = featOf(r, artists.find((a) => a.id === r.artistId)?.name);
  return `
  <li>
    <button class="main" data-url="${esc(r.url)}">
      <img class="cover" src="${esc(r.artwork)}" alt="" loading="lazy">
      <span class="lines">
        <b>${esc(r.title)}</b>
        <span>${esc(r.artist)} · ${esc(r.kind)}</span>
        ${feat ? `<span class="feat">feat. ${esc(feat)}</span>` : ""}
      </span>
      ${ICON_CHEV}
    </button>
  </li>`;
};

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
      <span class="lines"><b>${esc(p.title)}</b><span>${plural(p.count || 0, "artiste")}${p.truncated ? " · 300 premiers titres seulement" : ""}</span></span>
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
  const entry = { url, title: res.title.replace(/\s+sur\s+Apple\s+Music$/, ""), count: res.artists.length, cover: res.image || null, truncated: !!res.truncated };
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
    toast(r.truncated
      ? `${plural(r.added, "artiste")} ajouté${r.added > 1 ? "s" : ""} (seulement les 300 premiers titres de la playlist)`
      : r.added ? `${plural(r.added, "artiste")} ajouté${r.added > 1 ? "s" : ""}` : "Playlist ajoutée");
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
  const denied = pushSupported && Notification.permission === "denied";
  const sw = $("#notif-switch");
  sw.checked = on;
  sw.disabled = !pushSupported || denied;
  renderOnboardNotif(on);
  $("#notif-foot").textContent = denied
    ? "Notifications bloquées : réactive-les dans Réglages › Notifications › Miutif sur ton iPhone."
    : !pushSupported && isIOS && !standalone
      ? "Pour les notifications, ajoute Miutif à l'écran d'accueil (Safari › Partager › Sur l'écran d'accueil)."
      : "Une seule notification par jour avec toutes les nouvelles sorties de tes artistes.";
  return sub;
}

/** Interrupteur coupé : ce téléphone ne reçoit plus rien (le serveur oublie son abonnement). */
async function disableNotifications() {
  try {
    const sub = await currentSubscription();
    if (sub) await sub.unsubscribe();
    await sync({ subscription: null });
    toast("Notifications désactivées");
  } catch (e) {
    toast(`Impossible de désactiver : ${e.message}`);
  } finally {
    renderNotifState();
  }
}

async function enableNotifications() {
  if (!pushSupported) {
    toast(isIOS && !standalone ? "Ajoute d'abord Miutif à l'écran d'accueil" : "Ce navigateur ne gère pas les notifications");
    renderNotifState();
    return;
  }
  const btn = $("#notif-switch");
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

BTNS.forEach((b) => b.addEventListener("click", (e) => { if (e.detail === 0) tapTab(b.dataset.tab); }));
$("#notif-switch").addEventListener("change", (e) => (e.target.checked ? enableNotifications() : disableNotifications()));
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
$("#q").addEventListener("input", (e) => { updateSearchMode(); search(e.target.value.trim()); });
$("#sheet-close").addEventListener("click", () => closeSheet());

// ---------- Fiche : on la quitte en glissant le doigt vers la droite (comme sur iPhone) ----------

const sheet = $("#sheet");
const shade = document.createElement("div");
shade.className = "shade";
document.body.append(shade);

function openSheet() {
  sheet.classList.remove("leaving");
  sheet.style.transform = "";
  shade.style.opacity = "";
  sheet.hidden = false;
}

function closeSheet(from = 0) {
  if (sheet.hidden) return;
  if (reduced()) { sheet.hidden = true; return; }
  sheet.classList.add("leaving");
  sheet.style.transform = `translateX(${from}px)`;
  shade.style.transition = "opacity 0.28s";
  requestAnimationFrame(() => {
    sheet.style.transform = "translateX(100%)";
    shade.style.opacity = "0";
  });
  setTimeout(() => {
    sheet.hidden = true;
    sheet.classList.remove("leaving");
    sheet.style.transform = "";
    shade.style.transition = "";
  }, 300);
}

let swipe = null;
sheet.addEventListener("touchstart", (e) => {
  if (e.touches.length !== 1 || sheet.classList.contains("leaving")) return;
  const t = e.touches[0];
  swipe = { x0: t.clientX, y0: t.clientY, dx: 0, t0: performance.now(), dir: null };
}, { passive: true });
sheet.addEventListener("touchmove", (e) => {
  if (!swipe) return;
  const t = e.touches[0];
  const dx = t.clientX - swipe.x0, dy = t.clientY - swipe.y0;
  if (!swipe.dir) {
    if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
    swipe.dir = Math.abs(dx) > Math.abs(dy) && dx > 0 ? "x" : "y"; // vers la droite : on quitte ; sinon on fait défiler
  }
  if (swipe.dir !== "x") return;
  e.preventDefault();
  swipe.dx = Math.max(0, dx);
  sheet.style.transform = `translateX(${swipe.dx}px)`;
  shade.style.opacity = String(0.35 * (1 - swipe.dx / innerWidth));
}, { passive: false });
function swipeEnd() {
  if (!swipe) return;
  const s = swipe;
  swipe = null;
  if (s.dir !== "x") return;
  const speed = s.dx / Math.max(1, performance.now() - s.t0);
  if (s.dx > innerWidth * 0.33 || speed > 0.6) { closeSheet(s.dx); haptic(); return; }
  sheet.classList.add("leaving"); // retour en place
  sheet.style.transform = "translateX(0)";
  shade.style.opacity = "0";
  setTimeout(() => sheet.classList.remove("leaving"), 300);
}
sheet.addEventListener("touchend", swipeEnd);
sheet.addEventListener("touchcancel", swipeEnd);

$("#results").addEventListener("click", (e) => {
  const off = e.target.closest("[data-unfollow-artist]")?.dataset.unfollowArtist;
  if (off) {
    const a = artists.find((x) => x.id === off);
    unfollowArtist(off);
    if (a) toast(`Tu ne suis plus ${a.name}`);
    return;
  }
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
    if (tab) { closeSheet(); showTab(tab); loadReleases(); }
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
