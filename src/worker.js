// Serveur de Miutif (Cloudflare Worker).
// - sert l'appli (dossier public/)
// - garde pour chaque téléphone : ses artistes, ses playlists et son abonnement aux notifications (KV « DB »)
// - chaque heure, un réveil (cron) :
//     · à 10 h (heure locale) relit les playlists, pour que le robot GitHub voie les nouveaux artistes
//     · à 11 h envoie UNE notification récap des nouvelles sorties
// Apple bloque l'API iTunes depuis Cloudflare : les sorties sont récupérées par un robot GitHub
// (scripts/fetch-releases.mjs) qui les publie dans un fichier JSON (env.DATA_URL) lu ici.
// Les pages music.apple.com (playlists, fiches artistes), elles, restent lisibles d'ici.

import { generateVapidKeys, sendPush, b64url } from "./push.js";
import { filterRecent, playlistUrl, parsePlaylistPage, parseArtistPage, featOf } from "../public/music.js";

const NOTIFY_HOUR = 11;            // heure locale des notifications
const PLAYLIST_HOUR = 10;          // relecture des playlists avant le passage du robot
const NEW_DAYS = 7;                // une sortie est « nouvelle » pendant 7 jours
const ARTIST_TTL = 14 * 86400;     // fiche artiste gardée 14 jours
const MAX_PLAYLISTS = 30;

const APPLE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  "Accept-Language": "fr-FR,fr;q=0.9",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      return await api(request, url, env);
    } catch (e) {
      return json({ error: e.message || "Erreur" }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(hourlyRun(env, new Date(event.scheduledTime)));
  },
};

// ---------- API ----------

async function api(request, url, env) {
  const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
  const country = (body.country || url.searchParams.get("country") || request.cf?.country || "fr").toLowerCase().slice(0, 2);

  // Fiche artiste (photo + bio) et photo seule (pour la liste)
  const artist = request.method === "GET" && url.pathname.match(/^\/api\/artist\/(\d{1,15})(\/photo)?$/);
  if (artist) {
    const info = await artistInfo(env, artist[1], country);
    if (!artist[2]) return json(info, 200, "public, max-age=86400");
    if (!info.image) return new Response(null, { status: 404, headers: { "Cache-Control": "public, max-age=86400" } });
    return new Response(null, { status: 302, headers: { Location: info.image, "Cache-Control": "public, max-age=1209600" } });
  }

  switch (`${request.method} ${url.pathname}`) {
    case "GET /api/config":
      return json({
        vapidKey: (await vapid(env)).publicKey,
        appleMusic: hasMusicKit(env),
        hour: NOTIFY_HOUR,
        country,
      });

    case "GET /api/token":
      if (!hasMusicKit(env)) return json({ error: "Connexion Apple Music non configurée" }, 404);
      return json({ token: await developerToken(env) });

    // Import d'une playlist partagée : la page music.apple.com contient tous ses artistes
    case "POST /api/playlist": {
      const target = playlistUrl(body.url);
      if (!target) return json({ error: "Ce n'est pas un lien de playlist Apple Music" }, 400);
      const res = await fetch(target, { headers: APPLE_HEADERS });
      if (res.status === 404) return json({ error: "Playlist introuvable : vérifie qu'elle est bien partagée" }, 404);
      if (!res.ok) return json({ error: `Apple Music ne répond pas (${res.status})` }, 502);
      const parsed = parsePlaylistPage(await res.text());
      if (!parsed) return json({ error: "Impossible de lire cette playlist" }, 502);
      return json(parsed);
    }

    // Pour le robot : tous les artistes suivis (identifiants publics, sans lien avec les utilisateurs)
    case "GET /api/artists": {
      const countries = {};
      await forEachUser(env, async (_, user) => {
        const set = (countries[user.country || "fr"] ||= new Set());
        for (const a of user.artists || []) set.add(a.id);
      });
      return json({ countries: Object.fromEntries(Object.entries(countries).map(([c, s]) => [c, [...s]])) });
    }

    case "GET /api/user": {
      const id = cleanUserId(url.searchParams.get("id"));
      const user = id && (await env.DB.get(`u:${id}`, "json"));
      return json({
        artists: user?.artists || [],
        playlists: user?.playlists || [],
        excluded: user?.excluded || [],
        subscribed: !!user?.sub,
      });
    }

    case "POST /api/sync": {
      const id = cleanUserId(body.id);
      if (!id) return json({ error: "id invalide" }, 400);
      const user = (await env.DB.get(`u:${id}`, "json")) || { notified: {}, created: Date.now() };
      if (Array.isArray(body.artists)) user.artists = cleanArtists(body.artists);
      if (Array.isArray(body.playlists)) user.playlists = cleanPlaylists(body.playlists);
      if (Array.isArray(body.excluded)) user.excluded = cleanIdList(body.excluded);
      if (body.subscription === null) delete user.sub;
      else if (validSub(body.subscription)) user.sub = pickSub(body.subscription);
      if (typeof body.tz === "string" && body.tz.length < 64) user.tz = body.tz;
      user.country = country;
      await env.DB.put(`u:${id}`, JSON.stringify(user));
      return json({ ok: true, subscribed: !!user.sub, artists: user.artists?.length || 0 });
    }
  }
  return json({ error: "Introuvable" }, 404);
}

// ---------- Fiches artistes ----------

async function artistInfo(env, id, country) {
  const cached = await env.DB.get(`a:${id}`, "json");
  if (cached) return cached;
  const res = await fetch(`https://music.apple.com/${country}/artist/x/${id}`, { headers: APPLE_HEADERS });
  if (!res.ok && res.status !== 404) throw new Error(`Apple Music ne répond pas (${res.status})`);
  const info = { id, ...(res.ok ? parseArtistPage(await res.text()) : { name: "", image: null, bio: "" }) };
  await env.DB.put(`a:${id}`, JSON.stringify(info), { expirationTtl: ARTIST_TTL });
  return info;
}

// ---------- Réveil horaire ----------

async function forEachUser(env, fn) {
  let cursor;
  do {
    const page = await env.DB.list({ prefix: "u:", cursor });
    for (const { name } of page.keys) {
      const user = await env.DB.get(name, "json");
      if (user) await fn(name, user);
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
}

/** Sorties publiées par le robot GitHub : { updated, byCountry: { fr: [...] } } */
async function releaseData(env) {
  const res = await fetch(`${env.DATA_URL}?t=${Math.floor(Date.now() / 60000)}`);
  if (!res.ok) throw new Error(`Fichier des sorties introuvable (${res.status})`);
  return res.json();
}

function releasesFor(user, data, { days, now }) {
  const mine = new Set((user.artists || []).map((a) => a.id));
  const list = data.byCountry?.[user.country] || data.byCountry?.fr || [];
  return filterRecent(list.filter((r) => mine.has(r.artistId)), { days, now });
}

async function hourlyRun(env, now) {
  const keys = await vapid(env);
  let data = null;
  await forEachUser(env, async (key, user) => {
    try {
      const { hour, day } = localTime(now, user.tz || "Europe/Paris");
      if (hour === PLAYLIST_HOUR && user.playlists?.length && user.playlistDay !== day) {
        await refreshPlaylists(env, key, user, day);
      }
      if (hour === NOTIFY_HOUR && user.sub && user.artists?.length && user.lastRun !== day) {
        data ||= await releaseData(env); // lu une seule fois, et seulement s'il y a quelqu'un à notifier
        await notifyUser(env, key, user, data, keys, now, day);
      }
    } catch (e) {
      console.error(`Réveil raté pour ${key} :`, e.message);
    }
  });
}

/** Ajoute les artistes apparus dans les playlists (sauf ceux que l'utilisateur a retirés). */
async function refreshPlaylists(env, key, user, day) {
  const known = new Set((user.artists || []).map((a) => a.id));
  const excluded = new Set(user.excluded || []);
  for (const p of user.playlists) {
    try {
      const res = await fetch(p.url, { headers: APPLE_HEADERS });
      const parsed = res.ok && parsePlaylistPage(await res.text());
      if (!parsed) continue;
      p.count = parsed.artists.length;
      p.title = parsed.title;
      p.truncated = parsed.truncated;
      if (parsed.image) p.cover = parsed.image;
      for (const a of parsed.artists) {
        if (!known.has(a.id) && !excluded.has(a.id)) { known.add(a.id); user.artists.push(a); }
      }
    } catch {}
  }
  user.playlistDay = day;
  await env.DB.put(key, JSON.stringify(user));
}

async function notifyUser(env, key, user, data, keys, now, day) {
  const notified = user.notified || {};
  const fresh = releasesFor(user, data, { days: NEW_DAYS, now: now.getTime() }).filter((r) => !notified[r.id]);

  if (fresh.length) {
    const names = Object.fromEntries((user.artists || []).map((a) => [a.id, a.name]));
    const status = await sendPush(user.sub, recapPayload(fresh, day, names), keys);
    if (status === 404 || status === 410) delete user.sub; // notifications coupées sur le téléphone
  }

  for (const r of fresh) notified[r.id] = now.getTime();
  for (const [id, t] of Object.entries(notified)) if (now.getTime() - t > 60 * 86400000) delete notified[id];
  user.notified = notified;
  user.lastRun = day;
  await env.DB.put(key, JSON.stringify(user));
}

/** Une seule notification. 1 sortie : elle s'ouvre dans Apple Music. Plusieurs : l'onglet Nouveautés. */
function recapPayload(fresh, day, names = {}) {
  const feat = (r) => featOf(r, names[r.artistId]);
  if (fresh.length === 1) {
    const r = fresh[0];
    if (feat(r)) return { title: `${feat(r)} en featuring`, body: `${r.title} de ${r.artist} · touche pour écouter`, url: r.url, tag: `recap-${day}` };
    const what = r.kind === "Album" ? "Nouvel album" : r.kind === "EP" ? "Nouvel EP" : "Nouveau single";
    return { title: `${what} de ${r.artist}`, body: `${r.title} · touche pour écouter`, url: r.url, tag: `recap-${day}` };
  }
  const lines = fresh.slice(0, 4).map((r) => `${r.artist} — ${r.title}${feat(r) ? ` (feat. ${feat(r)})` : ""}`);
  if (fresh.length > 4) lines.push(`et ${fresh.length - 4} autre${fresh.length - 4 > 1 ? "s" : ""}`);
  return { title: `${fresh.length} nouvelles sorties`, body: lines.join("\n"), url: "/?tab=new", tag: `recap-${day}` };
}

function localTime(date, timeZone) {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
    }).formatToParts(date).map((p) => [p.type, p.value]));
    return { hour: Number(parts.hour), day: `${parts.year}-${parts.month}-${parts.day}` };
  } catch {
    return localTime(date, "Europe/Paris");
  }
}

// ---------- Clés ----------

async function vapid(env) {
  let keys = await env.DB.get("vapid", "json");
  if (!keys) {
    keys = await generateVapidKeys(); // créées une seule fois, au premier lancement
    await env.DB.put("vapid", JSON.stringify(keys));
  }
  return keys;
}

const hasMusicKit = (env) => !!(env.MUSICKIT_TEAM_ID && env.MUSICKIT_KEY_ID && env.MUSICKIT_PRIVATE_KEY);

/** Jeton développeur Apple Music (facultatif : seulement pour importer la librairie). */
async function developerToken(env) {
  const pem = env.MUSICKIT_PRIVATE_KEY.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const enc = new TextEncoder();
  const now = Math.floor(Date.now() / 1000);
  const head = b64url.encode(enc.encode(JSON.stringify({ alg: "ES256", kid: env.MUSICKIT_KEY_ID })));
  const claims = b64url.encode(enc.encode(JSON.stringify({ iss: env.MUSICKIT_TEAM_ID, iat: now, exp: now + 7 * 86400 })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${head}.${claims}`));
  return `${head}.${claims}.${b64url.encode(sig)}`;
}

// ---------- Validation ----------

const cleanUserId = (v) => (typeof v === "string" && /^[a-z0-9]{16,40}$/.test(v) ? v : null);
const cleanIdList = (list) => [...new Set(list.map(String).filter((x) => /^\d{1,15}$/.test(x)))].slice(0, 5000);
const cleanArtists = (list) => {
  const seen = new Set();
  return list
    .filter((a) => a && /^\d{1,15}$/.test(String(a.id)) && !seen.has(String(a.id)) && seen.add(String(a.id)))
    .slice(0, 3000)
    .map((a) => ({ id: String(a.id), name: String(a.name || "").slice(0, 100) }));
};
const cleanPlaylists = (list) => {
  const seen = new Set();
  return list
    .map((p) => ({
      url: playlistUrl(p?.url),
      title: String(p?.title || "Playlist").slice(0, 120),
      count: Number(p?.count) || 0,
      truncated: p?.truncated === true,
      cover: /^https:\/\/is\d-ssl\.mzstatic\.com\/[^\s"']+$/.test(p?.cover || "") ? p.cover : null,
    }))
    .filter((p) => p.url && !seen.has(p.url) && seen.add(p.url))
    .slice(0, MAX_PLAYLISTS);
};
const validSub = (s) => s && typeof s.endpoint === "string" && s.endpoint.startsWith("https://")
  && s.keys && typeof s.keys.p256dh === "string" && typeof s.keys.auth === "string";
const pickSub = (s) => ({ endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } });

const json = (data, status = 200, cache = "no-store") => new Response(JSON.stringify(data), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": cache },
});
