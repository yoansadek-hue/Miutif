// Miutif : suivre ses artistes et être prévenu de leurs sorties à 11 h.
import { searchArtists, playlistUrl, artistCatalog, featOf, catalogReleases } from "./music.js?v=13";

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
let upcoming = store.get("upcoming", []);               // sorties à venir (précommandes)
let seen = new Set(store.get("seen", []));              // sorties déjà ouvertes (sans pastille)
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
function confirmBox(title, text, ok = "Supprimer", avatarHtml = "", square = false) {
  return new Promise((resolve) => {
    const pp = $("#confirm-avatar"); // (absent d'une ancienne page : la confirmation marche quand même)
    if (pp) { pp.innerHTML = avatarHtml; pp.hidden = !avatarHtml; pp.classList.toggle("square", square); }
    $("#confirm-title").textContent = title;
    $("#confirm-text").textContent = text;
    $("#confirm-yes").textContent = ok;
    $("#confirm").hidden = false;
    const done = (v) => { $("#confirm").hidden = true; $("#confirm-yes").onclick = $("#confirm-no").onclick = null; resolve(v); };
    $("#confirm-yes").onclick = () => done(true);
    $("#confirm-no").onclick = () => done(false);
  });
}

/** Petit message d'erreur sous le champ du lien de playlist (vide = efface). */
function fieldError(inputSel, msg) {
  const el = $(inputSel === "#ob-url" ? "#ob-error" : "#pl-error");
  el.textContent = msg;
  el.hidden = !msg;
}

// ---------- Synchronisation ----------

let unexcluded = new Set(store.get("unexcluded", [])); // artistes supprimés puis suivis à nouveau (à signaler au serveur)
const sync = (extra = {}) => {
  const sent = [...unexcluded];
  return api("sync", { id: userId, artists, playlists, excluded: [...excluded], unexcluded: sent, tz, ...extra }).then((res) => {
    for (const id of sent) unexcluded.delete(id);
    store.set("unexcluded", [...unexcluded]);
    applyServer(res);
    return res;
  });
};

/** S'aligne sur la version fusionnée du serveur (artistes ajoutés ou supprimés ailleurs). */
function applyServer(res) {
  if (!res || !Array.isArray(res.artistList)) return;
  let changed = false;
  for (const id of res.excluded || []) if (!excluded.has(String(id)) && !unexcluded.has(String(id))) { excluded.add(String(id)); changed = true; }
  const kept = artists.filter((x) => !excluded.has(x.id));
  if (kept.length !== artists.length) { artists = kept; changed = true; }
  const known = new Set(artists.map((x) => x.id));
  for (const x of res.artistList) if (!known.has(x.id) && !excluded.has(x.id)) { artists.push({ id: x.id, name: x.name }); known.add(x.id); changed = true; }
  if (!changed) return;
  store.set("artists", artists);
  store.set("excluded", [...excluded]);
  renderArtists();
  loadReleasesSoon();
}
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
  updateIndex();
  updateSplit();
}

// ---------- Index A à Z de la liste des artistes (comme les Contacts) ----------

const AZ = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ", "#"];
let presentLetters = [];
const azEl = $("#az");
azEl.innerHTML = AZ.map((l) => `<span data-l="${l}">${l}</span>`).join("");

const azBubble = $("#az-bubble");
const azSpans = () => [...azEl.querySelectorAll("span")];

/** Visible seulement sur l'onglet Artistes, hors recherche, et quand la liste est assez longue. */
function updateIndex() {
  const show = current === "artists" && !$("#q").value.trim() && artists.length >= 15 && $("#sheet").hidden;
  azEl.hidden = !show;
  azSpans().forEach((el) => el.classList.toggle("dim", !presentLetters.includes(el.dataset.l)));
  if (show) markCurrentLetter();
}

/** Met en évidence une lettre de l'index. */
function setCurLetter(l) {
  azSpans().forEach((el) => el.classList.toggle("cur", el.dataset.l === l));
}

/** Pendant le défilement : la lettre de la section en haut de l'écran est mise en évidence. */
function markCurrentLetter() {
  if (azEl.classList.contains("active")) return;
  const scroller = $("#scroll-artists");
  const top = scroller.getBoundingClientRect().top + 12;
  let cur = presentLetters[0];
  for (const h of document.querySelectorAll("#artists .letter")) {
    if (h.getBoundingClientRect().top <= top) cur = h.dataset.letter; else break;
  }
  setCurLetter(cur);
}
let azRaf = 0, azHide = 0;
/** L'index se montre pendant qu'on fait défiler la liste, puis s'efface. */
function revealIndex() {
  if (azEl.hidden) return;
  azEl.classList.add("visible");
  clearTimeout(azHide);
  azHide = setTimeout(() => { if (!azEl.classList.contains("active")) azEl.classList.remove("visible"); }, 1400);
}
$("#scroll-artists").addEventListener("scroll", () => {
  if (azEl.hidden) return;
  revealIndex();
  if (azRaf) return;
  azRaf = requestAnimationFrame(() => { azRaf = 0; markCurrentLetter(); });
}, { passive: true });

let azLastIndex = -1;
function azJump(clientY) {
  const r = azEl.getBoundingClientRect();
  const i = Math.max(0, Math.min(AZ.length - 1, Math.floor(((clientY - r.top) / r.height) * AZ.length)));
  if (i === azLastIndex) return;
  azLastIndex = i;
  haptic(); // petite vibration à chaque lettre franchie
  const letter = AZ[i];
  setCurLetter(letter);
  azBubble.textContent = letter;
  azBubble.style.top = `${Math.max(r.top + 32, Math.min(r.bottom - 32, clientY))}px`;
  azBubble.classList.add("show");
  // lettre sans artiste : on va à la suivante qui en a (ou la dernière)
  const target = AZ.slice(i).find((l) => presentLetters.includes(l)) || presentLetters[presentLetters.length - 1];
  const head = target && $(`#artists [data-letter="${target}"]`);
  const scroller = $("#scroll-artists");
  if (head) {
    const y = head.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 4;
    // si la liste est encore lancée, on coupe son élan : sinon iOS ignore le saut et l'index semble ne pas marcher
    scroller.style.overflowY = "hidden";
    scroller.scrollTop = y;
    requestAnimationFrame(() => { scroller.style.overflowY = ""; scroller.scrollTop = y; });
  }
}
azEl.addEventListener("pointerdown", (e) => {
  azLastIndex = -1;
  try { azEl.setPointerCapture(e.pointerId); } catch {}
  azEl.classList.add("active");
  azJump(e.clientY);
});
azEl.addEventListener("pointermove", (e) => { if (azEl.classList.contains("active")) azJump(e.clientY); });
for (const ev of ["pointerup", "pointercancel"]) {
  azEl.addEventListener(ev, () => {
    azEl.classList.remove("active");
    azBubble.classList.remove("show");
    markCurrentLetter();
    revealIndex(); // reste visible un instant puis s'efface
  });
}

// ---------- Défiler la liste pendant une recherche ferme le clavier ----------
(() => {
  const sc = $("#scroll-artists"), q = $("#q");
  let y0 = null;
  sc.addEventListener("touchstart", (e) => { y0 = document.activeElement === q ? e.touches[0].clientY : null; }, { passive: true });
  sc.addEventListener("touchmove", (e) => {
    if (y0 !== null && Math.abs(e.touches[0].clientY - y0) > 10) { q.blur(); y0 = null; }
  }, { passive: true });
})();

const resetPull = [];

/** Une nouvelle version de l'app est-elle en ligne ? (compare le numéro de version de app.js) */
async function newerVersion() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 800);
    const html = await fetch(`/?fresh=${Date.now()}`, { cache: "no-store", signal: ctrl.signal }).then((r) => r.text());
    clearTimeout(t);
    const online = html.match(/app\.js\?v=(\d+)/)?.[1];
    const mine = document.querySelector('script[src*="app.js"]')?.getAttribute("src").match(/v=(\d+)/)?.[1];
    return !!(online && mine && Number(online) > Number(mine)); // seulement plus récente (juste après une mise en ligne, un serveur peut encore servir l'ancienne)
  } catch {
    return false; // pas de réseau : on rafraîchit ce qu'on peut
  }
}
const pullResume = {};
// ---------- Tirer vers le bas : le rond se remplit, puis l'app se recharge entièrement ----------
// (seulement tout en haut d'une page, pour un geste vraiment vertical ; rien ne bouge avant 24 px)
(() => {
  const ptr = $("#ptr"), spokes = [...ptr.querySelectorAll("i")], DEAD = 24, NEED = 72;
  let st = null, busy = false;
  const set = (sc, d, p) => {
    sc.style.setProperty("--pull", `${d}px`);
    // centré dans l'espace ouvert au-dessus de la page (comme les apps iPhone)
    ptr.style.transform = `translateY(${Math.max(0, d / 2 - 14)}px)`;
    // les traits apparaissent un par un pendant qu'on tire
    spokes.forEach((el, i) => el.classList.toggle("on", p >= (i + 1) / spokes.length));
  };
  for (const t of TABS) {
    const sc = $(`#scroll-${t}`);
    sc.addEventListener("touchstart", (e) => {
      const t = e.touches[0];
      st = !busy && sc.scrollTop <= 0 && e.touches.length === 1 && t.touchType !== "stylus"
        ? { sc, x: t.clientX, y: t.clientY, on: false, dy: 0, ready: false } : null;
    }, { passive: true });
    sc.addEventListener("touchmove", (e) => {
      if (!st || st.sc !== sc) return;
      const dx = e.touches[0].clientX - st.x, dy = e.touches[0].clientY - st.y;
      if (!st.on) {
        if (dy < DEAD || Math.abs(dx) > dy || sc.scrollTop > 0) { if (dy < -4 || Math.abs(dx) > 12) st = null; return; }
        st.on = true;
        sc.classList.add("pulling");
        ptr.classList.add("dragging"); // le rond suit le doigt sans retard pendant qu'on tire
      }
      st.dy = dy - DEAD;
      const d = 110 * (1 - Math.exp(-st.dy / 110)); // le contenu suit le doigt, de plus en plus difficilement
      const p = Math.min(1, st.dy / NEED);
      set(sc, d, p);
      if (p >= 1 && !st.ready) { st.ready = true; haptic(); }
      if (p < 1) st.ready = false;
      if (e.cancelable) e.preventDefault();
    }, { passive: false });
    const end = () => {
      if (!st || st.sc !== sc) return;
      const s = st;
      st = null;
      sc.classList.remove("pulling");
      ptr.classList.remove("dragging"); // relâché : la page et le rond reviennent en douceur
      if (!s.on) return;
      if (s.dy < NEED) { set(sc, 0, 0); return; }
      busy = true;
      ptr.classList.add("spin");
      set(sc, 64, 1);
      haptic();
      refreshInPlace(sc);
    };
    sc.addEventListener("touchend", end, { passive: true });
    sc.addEventListener("touchcancel", end, { passive: true });
    resetPull.push(() => { if (!busy) { st = null; sc.classList.remove("pulling"); ptr.classList.remove("dragging"); set(sc, 0, 0); } });
  }
  /**
   * Rafraîchissement sur place (rapide) : playlists et sorties relues sans recharger la page.
   * Seule une nouvelle version de l'app déclenche un vrai rechargement (qui reprend en douceur, rond compris).
   */
  async function refreshInPlace(sc) {
    const t0 = performance.now();
    if (await newerVersion()) {
      try { sessionStorage.setItem("miutif.ptr", "1"); } catch {}
      if ("caches" in window) for (const k of await caches.keys()) await caches.delete(k);
      location.replace(`/?tab=${current}`);
      return;
    }
    const work = (async () => {
      const added = await refreshPlaylists();
      await loadReleases(true);
      if (added) await loadReleases(true);
      renderNotifState();
    })();
    await Promise.race([work, new Promise((r) => setTimeout(r, 1500))]); // jamais plus d'1,5 s de rond
    await new Promise((r) => setTimeout(r, Math.max(0, 350 - (performance.now() - t0)))); // le rond se voit un instant
    ptr.classList.remove("spin");
    set(sc, 0, 0);
    busy = false;
  }

  // après le rechargement : on reprend là où le geste s'était arrêté, puis on remonte en douceur
  pullResume.hold = (sc) => {
    ptr.classList.add("dragging", "spin");
    sc.classList.add("pulling");
    set(sc, 64, 1);
    requestAnimationFrame(() => requestAnimationFrame(() => { ptr.classList.remove("dragging"); sc.classList.remove("pulling"); }));
  };
  pullResume.release = (sc) => {
    ptr.classList.remove("spin");
    set(sc, 0, 0);
  };
  // la fin du geste peut arriver ailleurs (doigt sorti de la zone, stylet…) : la page ne reste jamais descendue
  addEventListener("touchend", () => { if (!st) resetPull.forEach((f) => f()); }, { passive: true });
  document.addEventListener("visibilitychange", () => resetPull.forEach((f) => f()));
})();

/**
 * Appui sur un onglet de la barre. Une fiche artiste ouverte se ferme (on revient à la liste).
 * Appui sur l'onglet déjà ouvert : la page remonte tout en haut.
 */
function tapTab(tab) {
  const sheetOpen = !$("#sheet").hidden;
  if (sheetOpen) closeSheet();
  if (tab === current) {
    if (sheetOpen) return;
    // en pleine recherche : l'onglet Artistes efface la recherche et ramène à la liste
    const q = $("#q");
    if (tab === "artists" && q.value.trim()) {
      q.value = "";
      q.blur();
      updateSearchMode();
      $("#scroll-artists").scrollTop = 0;
      return;
    }
    $(`#scroll-${tab}`).scrollTo({ top: 0, behavior: reduced() ? "auto" : "smooth" });
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
// au lancement, la barre n'a pas encore sa taille finale : on recale la bulle dès qu'elle change
const replacePill = () => { if (!drag) pillTo(BTNS.find((b) => b.classList.contains("on")), false); };
if ("ResizeObserver" in window) new ResizeObserver(replacePill).observe(bar);
addEventListener("load", replacePill);
document.fonts?.ready.then(replacePill);

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
  presentLetters = letters;
  $("#artists").innerHTML = letters.map((l) => `
    <h2 class="letter" data-letter="${l}">${l}</h2>
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
    if (excluded.has(id)) { if (!manual) continue; excluded.delete(id); unexcluded.add(id); store.set("unexcluded", [...unexcluded]); }
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
  const pp = `${initial(a.name)}<img src="${photo(a.id)}" alt="">`;
  if (!(await confirmBox("Supprimer cet artiste ?", `Voulez-vous vraiment supprimer ${a.name} ? Tu ne seras plus prévenu de ses sorties.`, "Supprimer", pp))) return;
  await animateRemoval(document.querySelector(`#artists [data-remove="${CSS.escape(id)}"]`)?.closest("li"));
  unfollowArtist(id);
}

/** Suppression mise en évidence : la ligne devient rouge, glisse hors de la liste et se referme. */
async function animateRemoval(row) {
  if (!row || reduced()) return;
  row.style.maxHeight = `${row.offsetHeight}px`;
  row.classList.add("removing");
  haptic();
  requestAnimationFrame(() => requestAnimationFrame(() => row.classList.add("out")));
  await new Promise((r) => setTimeout(r, 560));
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
  updateIndex();
  $("#artists-empty").hidden = searching || artists.length > 0;
  if (!searching) { $("#results").hidden = true; lastResults = []; }
}

const search = debounce(async (q) => {
  if (!q) { updateSearchMode(); return; }
  try {
    lastResults = await searchArtists(q, config.country);
    renderResults();
  } catch {
    // erreur ignorée (plus de message en bas de l\'écran)
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
    if (artists.some((a) => a.id === id)) { unfollowArtist(id); }
    else if (addArtists([{ id, name: $("#sheet-name").textContent || name }], { manual: true })) loadReleasesSoon();
    paint();
    if (lastResults.length) renderResults();
  };
  paint();
  $("#sheet-similar").innerHTML = "";
  $("#sheet-scroller").scrollTop = 0;
  sheetArtist = id;
  document.querySelectorAll("#artists .main.sel").forEach((el) => el.classList.remove("sel"));
  document.querySelector(`#artists [data-open="${CSS.escape(id)}"]`)?.classList.add("sel");
  openSheet();

  const [cat, info] = await Promise.allSettled([artistCatalog(id, config.country), api(`artist/${id}`)]);
  if ($("#sheet").hidden || sheetArtist !== id) return;
  const { own = [], appearances = [] } = cat.status === "fulfilled" ? cat.value : {};
  const albums = own.filter((r) => r.kind === "Album");
  const singles = own.filter((r) => r.kind !== "Album");
  // chaque section défile sur le côté (comme Apple Music) : la page reste courte
  const tile = (r, sub) => `
    <button class="tile" data-url="${esc(r.url)}">
      <img src="${esc(r.artwork)}" alt="" loading="lazy" decoding="async">
      <b>${esc(r.title)}</b>
      <small>${esc(sub(r))}</small>
    </button>`;
  const year = (r) => new Date(r.date).getFullYear();
  const section = (title, items, sub) => items.length
    ? `<div class="sugg-head"><h2>${title}</h2><span class="count-sub">${items.length}</span></div>
       <div class="carousel tiles">${items.map((r) => tile(r, sub)).join("")}</div>` : "";
  $("#sheet-disco").innerHTML = own.length || appearances.length
    ? section("Dernières sorties", own.slice(0, 10), (r) => `${r.kind} · ${shortDate(r.date)}`) +
      section("Albums", albums, (r) => `${year(r)}`) +
      section("Singles et EP", singles, (r) => `${r.kind} · ${year(r)}`) +
      section("Apparitions", appearances, (r) => `chez ${r.artist}`)
    : '<p class="empty">Discographie indisponible pour le moment.</p>';
  similarList = info.status === "fulfilled" ? info.value.similar || [] : [];
  renderSimilar();
}

let sheetArtist = null;
let similarList = [];

/** Une apparition : le titre, et l'artiste principal chez qui il apparaît. */
const appearanceRow = (r) => `
  <li>
    <button class="main" data-url="${esc(r.url)}">
      <img class="cover" src="${esc(r.artwork)}" alt="" loading="lazy" decoding="async">
      <span class="lines"><b>${esc(r.title)}</b><span>chez ${esc(r.artist)}</span></span>
      <span class="date">${shortDate(r.date)}</span>
    </button>
  </li>`;

let dismissed = new Set(store.get("dismissed", [])); // suggestions écartées avec la croix

/** Carte d'artiste suggéré : photo, nom, « Similaire à … », bouton Suivre, croix pour l'écarter. */
const suggestCard = (s, because) => {
  const on = artists.some((a) => a.id === s.id);
  return `
  <div class="card" data-card="${esc(s.id)}">
    <button class="dismiss" data-dismiss="${esc(s.id)}" aria-label="Ne plus suggérer ${esc(s.name)}">${ICON_X}</button>
    <button class="open" data-open="${esc(s.id)}" data-name="${esc(s.name)}">
      <span class="avatar">${initial(s.name)}<img src="${esc(s.image || photo(s.id))}" alt="" loading="lazy"></span>
      <b>${esc(s.name)}</b>
      <small>Similaire à ${esc(because)}</small>
    </button>
    <button class="follow-btn${on ? " on" : ""}" data-toggle-follow="${esc(s.id)}" data-name="${esc(s.name)}">${on ? "Suivi" : "Suivre"}</button>
  </div>`;
};

function renderSimilar() {
  const list = similarList.filter((s) => !dismissed.has(s.id) && !artists.some((x) => x.id === s.id) && !excluded.has(s.id));
  $("#sheet-similar").innerHTML = list.length
    ? `<div class="sugg-head"><h2>Suggestions pour vous</h2></div>
       <div class="carousel">${list.map((s) => suggestCard(s, $("#sheet-name").textContent)).join("")}</div>`
    : "";
}

/** Écarte une suggestion (elle ne revient plus). */
function dismissSuggestion(id) {
  dismissed.add(id);
  store.set("dismissed", [...dismissed]);
  const card = document.querySelector(`#sheet-similar [data-card="${CSS.escape(id)}"]`);
  if (!card) return;
  card.classList.add("gone");
  setTimeout(() => { card.remove(); if (!document.querySelector("#sheet-similar .card")) $("#sheet-similar").innerHTML = ""; }, 200);
}

/** Suivre / ne plus suivre depuis une suggestion (le bouton change sur place, la liste ne bouge pas). */
function toggleFollow(id, name) {
  if (artists.some((a) => a.id === id)) unfollowArtist(id);
  else if (addArtists([{ id, name }], { manual: true })) loadReleasesSoon();
  haptic();
  const on = artists.some((x) => x.id === id);
  document.querySelectorAll(`#sheet-similar [data-toggle-follow="${CSS.escape(id)}"]`).forEach((b) => {
    b.textContent = on ? "Suivi" : "Suivre";
    b.classList.toggle("on", on);
  });
  if (sheetArtist === id) { // c'est l'artiste de la fiche ouverte : son bouton Suivre se met à jour aussi
    const on = artists.some((x) => x.id === id);
    $("#sheet-follow").textContent = on ? "Suivi ✓" : "Suivre";
    $("#sheet-follow").classList.toggle("on", on);
  }
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

const featFor = (r) => featOf(r, artists.find((a) => a.id === r.artistId)?.name);
const releaseRow = (r) => {
  const feat = featFor(r);
  return `
  <li>
    <button class="main" data-url="${esc(r.url)}" data-id="${esc(r.id)}">
      ${seen.has(r.id) ? "" : '<span class="udot" aria-label="Pas encore écouté"></span>'}
      <img class="cover" src="${esc(r.artwork)}" alt="" loading="lazy" decoding="async">
      <span class="lines">
        <b>${esc(r.title)}</b>
        <span>${esc(r.artist)} · ${esc(r.kind)}</span>
        ${feat ? `<span class="feat">feat. ${esc(feat)}</span>` : ""}
      </span>
      ${ICON_CHEV}
    </button>
  </li>`;
};

function countdown(iso) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(iso); d.setHours(0, 0, 0, 0);
  const days = Math.round((d - today) / 86400000);
  return days <= 0 ? "Aujourd'hui" : days === 1 ? "Demain" : `Dans ${days} jours`;
}

function renderUpcoming() {
  const list = upcoming;
  $("#upcoming").innerHTML = list.length ? `
    <section class="day upcoming">
      <div class="day-head"><h2>À venir</h2><p>${plural(list.length, "sortie")} annoncée${list.length > 1 ? "s" : ""}</p></div>
      <ul class="list">${list.map((r) => `
        <li>
          <button class="main" data-url="${esc(r.url)}">
            <img class="cover" src="${esc(r.artwork)}" alt="" loading="lazy" decoding="async">
            <span class="lines">
              <b>${esc(r.title)}</b>
              <span>${esc(r.artist)} · ${esc(r.kind)} · ${new Date(r.date).toLocaleDateString("fr-FR", { day: "numeric", month: "long" })}</span>
              ${featFor(r) ? `<span class="feat">feat. ${esc(featFor(r))}</span>` : ""}
            </span>
            <span class="countdown">${countdown(r.date)}</span>
          </button>
        </li>`).join("")}
      </ul>
    </section>` : "";
}

/** Pastille sur l'onglet Nouveautés : il reste des sorties de la semaine pas encore écoutées. */
function renderNewDot() {
  const week = Date.now() - 7 * 86400000;
  $("#new-dot").hidden = !releases.some((r) => !seen.has(r.id) && Date.parse(r.date) >= week);
  $("#mark-all").hidden = !releases.some((r) => !seen.has(r.id));
}

function markSeen(ids) {
  let changed = false;
  for (const id of ids) if (id && !seen.has(id)) { seen.add(id); changed = true; }
  if (!changed) return;
  // on ne garde que les sorties encore affichées (la liste ne grossit pas indéfiniment)
  const keep = new Set([...releases, ...upcoming].map((r) => r.id));
  seen = new Set([...seen].filter((id) => keep.has(id)));
  store.set("seen", [...seen]);
  renderNewDot();
}

let lastNewsHtml = null;
function renderNews(loading = false) {
  const box = $("#news");
  renderUpcoming();
  renderNewDot();
  if (loading && !releases.length && artists.length) {
    box.innerHTML = `<ul class="list">${'<li class="skeleton"></li>'.repeat(4)}</ul>`;
    lastNewsHtml = null; // le squelette sera toujours remplacé, même par une liste vide
    $("#news-empty").hidden = true;
    return;
  }
  const shown = releases;
  $("#news-empty").hidden = shown.length > 0;
  if (!artists.length) $("#news-empty").textContent = "Ajoute des artistes (onglet Artistes) ou une playlist (Réglages).";
  else $("#news-empty").textContent = "Aucune sortie ces 30 derniers jours pour tes artistes.";

  const groups = new Map();
  for (const r of shown) {
    const key = new Date(r.date).toDateString();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const html = [...groups].map(([key, list]) => {
    const { big, small } = dayLabel(key);
    return `<section class="day">
      <div class="day-head"><h2>${big}</h2>${small ? `<p>${small}</p>` : ""}</div>
      <ul class="list">${list.map(releaseRow).join("")}</ul>
    </section>`;
  }).join("");
  // rien de changé : on ne retouche pas la page (pas de clignotement ni d'images rechargées)
  if (html !== lastNewsHtml) { box.innerHTML = html; lastNewsHtml = html; }
}

let loadingReleases = null;
async function loadReleases(force = false) {
  if (loadingReleases) { if (!force) return; await loadingReleases; }
  loadingReleases = loadReleasesNow();
  try { await loadingReleases; } finally { loadingReleases = null; }
}
async function loadReleasesNow() {
  if (!artists.length) { releases = []; renderNews(); return; }
  if (!releases.length) renderNews(true); // l'écran de chargement seulement s'il n'y a encore rien à montrer
  try {
    ({ recent: releases, upcoming } = await catalogReleases(artists.map((a) => a.id), { country: config.country, days: 30 }));
    store.set("releases", releases);
    store.set("upcoming", upcoming);
  } catch {
    // pas de réseau : on garde la dernière liste affichée
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

async function importPlaylist(input, { refresh = false } = {}) {
  const url = playlistUrl(input);
  if (!url) throw new Error("Colle un lien de playlist Apple Music");
  const res = await api("playlist", { url });
  // relecture : si la playlist a été supprimée pendant ce temps, on n'y touche plus
  if (refresh && !playlists.some((p) => p.url === url)) return { added: 0, url };
  const added = addArtists(res.artists);
  const entry = { url, title: res.title.replace(/\s+sur\s+Apple\s+Music$/, ""), count: res.artists.length, cover: res.image || null, truncated: !!res.truncated };
  // une relecture met la playlist à jour à sa place ; un nouvel ajout la met en tête
  playlists = refresh ? playlists.map((p) => (p.url === url ? entry : p)) : [entry, ...playlists.filter((p) => p.url !== url)];
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
  fieldError(inputSel, "");
  if (!value) { $(inputSel).focus(); fieldError(inputSel, "Colle le lien de ta playlist dans le champ."); return; }
  btn.disabled = true;
  btn.textContent = "Ajout…";
  try {
    const r = await importPlaylist(value);
    $(inputSel).value = "";
    loadReleasesSoon();
  } catch (e) {
    fieldError(inputSel, e.message); // seule erreur gardée : sous le champ, pas en bas de l'écran
  } finally {
    btn.disabled = false;
    btn.textContent = label;
    renderPlaylists();
  }
}

/** À l'ouverture : les artistes ajoutés depuis dans tes playlists sont suivis automatiquement. */
async function refreshPlaylists() {
  let added = 0;
  for (const p of [...playlists]) {
    if (!playlists.some((x) => x.url === p.url)) continue; // supprimée entre-temps
    try { added += (await importPlaylist(p.url, { refresh: true })).added; } catch {}
  }
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
  } catch {
    // erreur ignorée (plus de message en bas de l\'écran)
  } finally {
    renderNotifState();
  }
}

async function enableNotifications() {
  if (!pushSupported) {
    renderNotifState();
    return;
  }
  const btn = $("#notif-switch");
  btn.disabled = true;
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return;
    if (!config.vapidKey) config = { ...config, ...(await api("config")) };
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription())
      || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(config.vapidKey) }));
    await sync({ subscription: sub.toJSON() });
  } catch {
    // erreur ignorée (plus de message en bas de l\'écran)
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
    addArtists(found);
    loadReleasesSoon();
  } catch {
    // erreur ignorée (plus de message en bas de l\'écran)
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
const splitMQ = matchMedia("(min-width: 1000px) and (orientation: landscape)");
const isSplit = () => document.body.classList.contains("split-on");
/** iPad en paysage, onglet Artistes : la liste reste à gauche et la fiche s'affiche à droite. */
function updateSplit() {
  const on = splitMQ.matches && current === "artists";
  document.body.classList.toggle("split-on", on);
  $("#split-empty").hidden = !(on && sheet.hidden);
}
splitMQ.addEventListener?.("change", updateSplit);
const shade = document.createElement("div");
shade.className = "shade";
document.body.append(shade);

function openSheet() {
  sheet.classList.remove("leaving");
  sheet.style.transform = "";
  shade.style.opacity = "";
  sheet.hidden = false;
  updateIndex();
  updateSplit();
}

function closeSheet(from = 0) {
  if (sheet.hidden) return;
  sheetArtist = null;
  document.querySelectorAll("#artists .main.sel").forEach((el) => el.classList.remove("sel"));
  if (isSplit()) { sheet.hidden = true; updateIndex(); updateSplit(); return; } // côte à côte : pas d'animation
  if (reduced()) { sheet.hidden = true; updateIndex(); return; }
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
    updateIndex();
    updateSplit();
  }, 300);
}

let swipe = null;
sheet.addEventListener("touchstart", (e) => {
  if (e.touches.length !== 1 || sheet.classList.contains("leaving") || isSplit() || e.target.closest(".carousel")) return;
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
    unfollowArtist(off);
    return;
  }
  const add = e.target.closest("[data-add]")?.dataset.add;
  if (add) {
    const a = lastResults.find((x) => x.id === add);
    if (a && addArtists([a], { manual: true })) loadReleasesSoon();
    renderResults();
    return;
  }
  const open = e.target.closest("[data-open]");
  if (open) openArtist(open.dataset.open, open.dataset.name);
});
$("#sheet-similar").addEventListener("click", (e) => {
  const f = e.target.closest("[data-toggle-follow]");
  if (f) return toggleFollow(f.dataset.toggleFollow, f.dataset.name);
  const x = e.target.closest("[data-dismiss]");
  if (x) return dismissSuggestion(x.dataset.dismiss);
  const open = e.target.closest("[data-open]");
  if (open) openArtist(open.dataset.open, open.dataset.name);
});
$("#artists").addEventListener("click", (e) => {
  const rm = e.target.closest("[data-remove]")?.dataset.remove;
  if (rm) return removeArtist(rm);
  const open = e.target.closest("[data-open]")?.dataset.open;
  if (open) openArtist(open);
});
for (const sel of ["#news", "#upcoming", "#sheet-disco"]) {
  $(sel).addEventListener("click", (e) => {
    const row = e.target.closest("[data-url]");
    if (!row) return;
    if (row.dataset.id) { markSeen([row.dataset.id]); row.querySelector(".udot")?.remove(); lastNewsHtml = null; }
    openInMusic(row.dataset.url);
  });
}
$("#mark-all").addEventListener("click", () => {
  markSeen([...releases, ...upcoming].map((r) => r.id));
  lastNewsHtml = null;
  renderNews();
});

// ---------- Glisser à gauche / à droite pour changer d'onglet (la bulle de la barre suit) ----------
// Fluide même quand on va vite : une seule mise à jour par image, vitesse mesurée en fin de geste,
// durée de l'animation adaptée à la vitesse, et un nouveau geste termine aussitôt l'animation en cours.
(() => {
  const vp = $(".viewport");
  let g = null, anim = null;
  const els = () => TABS.map((t) => $(`#scroll-${t}`));
  const finishAnim = () => { if (!anim) return; const a = anim; anim = null; clearTimeout(a.timer); a.done(); };
  const paint = () => {
    if (!g) return;
    g.raf = 0;
    els().forEach((el, i) => { if (Math.abs(i - g.idx) <= 1) el.style.transform = `translate3d(${(i - g.idx) * g.w + g.dx}px,0,0)`; });
    const p = -g.dx / g.w, next = BTNS[g.idx + Math.sign(p)], from = BTNS[g.idx].offsetLeft;
    place(next ? from + (next.offsetLeft - from) * Math.min(1, Math.abs(p)) : from - g.dx * 0.05);
  };
  vp.addEventListener("touchstart", (e) => {
    finishAnim();
    if (e.touches.length !== 1 || !sheet.hidden || azEl.classList.contains("active") || isSplit()) { g = null; return; }
    const t = e.touches[0];
    g = { x0: t.clientX, y0: t.clientY, dx: 0, dir: null, idx: TABS.indexOf(current), w: vp.clientWidth, s: [[performance.now(), t.clientX]], raf: 0 };
  }, { passive: true });
  vp.addEventListener("touchmove", (e) => {
    if (!g) return;
    const t = e.touches[0], dx = t.clientX - g.x0, dy = t.clientY - g.y0;
    if (!g.dir) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      g.dir = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      if (g.dir === "x") {
        $("#q").blur();
        els().forEach((el, i) => { if (Math.abs(i - g.idx) <= 1) el.classList.add("moving"); if (Math.abs(i - g.idx) === 1) el.classList.add("peek"); });
      }
    }
    if (g.dir !== "x") return;
    if (e.cancelable) e.preventDefault();
    let d = dx;
    if ((g.idx === 0 && d > 0) || (g.idx === TABS.length - 1 && d < 0)) d *= 0.25; // pas d'onglet de ce côté : ça résiste
    g.dx = d;
    g.s.push([performance.now(), t.clientX]);
    if (g.s.length > 6) g.s.shift();
    if (!g.raf) g.raf = requestAnimationFrame(paint);
  }, { passive: false });
  const end = () => {
    if (!g) return;
    const s = g;
    g = null;
    if (s.raf) cancelAnimationFrame(s.raf);
    if (s.dir !== "x") return;
    const [t0, x0] = s.s[0], [t1, x1] = s.s[s.s.length - 1];
    const v = (x1 - x0) / Math.max(1, t1 - t0); // vitesse en fin de geste (px/ms)
    let to = s.idx;
    if (Math.abs(s.dx) > s.w * 0.35 || (Math.abs(v) > 0.3 && Math.sign(v) === Math.sign(s.dx))) {
      to = Math.max(0, Math.min(TABS.length - 1, s.idx - Math.sign(s.dx)));
    }
    const dist = Math.abs((s.idx - to) * s.w - s.dx);
    const dur = Math.round(Math.max(140, Math.min(320, dist / Math.max(Math.abs(v), 1.1))));
    const list = els();
    list.forEach((el, i) => {
      if (Math.abs(i - s.idx) > 1) return;
      el.style.transition = `transform ${dur}ms cubic-bezier(0.25, 0.8, 0.25, 1)`;
      el.style.transform = `translate3d(${(i - to) * s.w}px,0,0)`;
    });
    pillTo(BTNS[to], true);
    if (to !== s.idx) haptic();
    anim = {
      timer: setTimeout(finishAnim, dur + 30),
      done: () => {
        list.forEach((el) => { el.style.transition = ""; el.style.transform = ""; el.classList.remove("peek", "moving"); });
        showTab(TABS[to]);
      },
    };
  };
  vp.addEventListener("touchend", end, { passive: true });
  vp.addEventListener("touchcancel", end, { passive: true });
})();
async function onUnfollowClick(e) {
  const btn = e.target.closest("[data-unfollow]");
  const url = btn?.dataset.unfollow;
  if (!url) return;
  const p = playlists.find((x) => x.url === url);
  const cover = p?.cover ? `<img src="${esc(p.cover)}" alt="">` : "♪";
  if (!(await confirmBox("Supprimer cette playlist ?", `Voulez-vous vraiment supprimer ${p?.title || "cette playlist"} ? Ses artistes restent suivis, mais ses nouveaux artistes ne seront plus ajoutés.`, "Supprimer", cover, true))) return;
  await animateRemoval(btn.closest(".row"));
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
// l'utilisateur a-t-il déjà commencé à utiliser l'app ? (sinon, une mise à jour peut recharger sans gêner)
let userTouched = false;
addEventListener("pointerdown", () => { userTouched = true; }, { once: true, capture: true });

navigator.serviceWorker?.addEventListener("message", (e) => {
  // nouvelle version de l'app trouvée au lancement : on recharge tout de suite, avant que l'utilisateur ne commence
  if (e.data?.type === "updated") {
    if (performance.now() < 6000 && !userTouched) location.reload();
    return;
  }
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

// ---------- Écran de chargement ----------
function hideSplash() {
  const s = document.getElementById("splash");
  if (!s) return;
  requestAnimationFrame(() => s.classList.add("out"));
  setTimeout(() => s.remove(), 450);
}

// ---------- Démarrage ----------

async function start() {
  const params = new URLSearchParams(location.search);
  if (params.has("open") || params.has("tab")) history.replaceState(null, "", "/");
  showTab(params.get("tab") || "new");
  let resumed = false;
  try { resumed = sessionStorage.getItem("miutif.ptr") === "1"; sessionStorage.removeItem("miutif.ptr"); } catch {}
  const resumedAt = performance.now();
  if (resumed) pullResume.hold($(`#scroll-${current}`));
  if (params.get("open")) openInMusic(params.get("open"));

  $("#install").hidden = !(isIOS && !standalone);
  renderArtists();
  renderPlaylists();
  renderNews(); // tout de suite, depuis la dernière visite : pas d'écran de chargement
  maybeOnboard();
  hideSplash(); // l'app est affichée : l'écran de chargement s'efface en fondu

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

  // les sorties sont cherchées tout de suite (avec le pays déjà connu), en même temps que le reste
  const ready = loadReleases();
  if (resumed) {
    // le rond tourne un court instant (les dernières sorties sont déjà affichées), puis tout remonte
    Promise.race([ready, new Promise((r) => setTimeout(r, 700))]).then(() =>
      setTimeout(() => pullResume.release($(`#scroll-${current}`)), Math.max(0, 300 - (performance.now() - resumedAt))));
  }

  try {
    config = { ...config, ...(await api("config")) };
    store.set("country", config.country);
    $("#am-group").hidden = !config.appleMusic;
  } catch {}

  // Ce que le serveur a (playlists relues chaque matin, téléphone réinstallé…)
  try {
    const saved = await api(`user?id=${userId}`);
    for (const id of saved.excluded || []) excluded.add(String(id));
    // un artiste supprimé ailleurs (autre appareil, compte transféré) est retiré ici aussi
    const kept = artists.filter((x) => !excluded.has(x.id));
    if (kept.length !== artists.length) { artists = kept; store.set("artists", artists); renderArtists(); }
    const knownUrls = new Set(playlists.map((p) => p.url));
    playlists = [...playlists, ...(saved.playlists || []).filter((p) => !knownUrls.has(p.url))];
    const before = artists.length;
    addArtists(saved.artists || []);
    renderPlaylists();
    if (artists.length !== before || saved.playlists?.length) saveAll();
    if (artists.length !== before) loadReleasesSoon(); // nouveaux artistes venus du serveur
  } catch {}

  const sub = await renderNotifState();
  if (sub && Notification.permission === "granted") sync({ subscription: sub.toJSON() }).catch(() => {});

  if (await refreshPlaylists()) loadReleasesSoon();
}

start();
