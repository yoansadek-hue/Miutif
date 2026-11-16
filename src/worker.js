// Serveur de Miutif (Cloudflare Worker).
// - sert l'appli (dossier public/)
// - garde pour chaque téléphone : ses artistes + son abonnement aux notifications (KV « DB »)
// - chaque heure, un réveil (cron) envoie les notifs aux téléphones pour qui il est 11 h

import { generateVapidKeys, sendPush, b64url } from "./push.js";
import { searchArtists, recentReleases } from "./music.js";

const NOTIFY_HOUR = 11;   // heure locale des notifications
const NEW_DAYS = 7;       // une sortie est « nouvelle » pendant 7 jours
const MAX_SINGLE = 6;     // au-delà, une notif résumé pour le reste

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
    ctx.waitUntil(dailyRun(env, new Date(event.scheduledTime)));
  },
};

// ---------- API ----------

async function api(request, url, env) {
  const route = `${request.method} ${url.pathname}`;
  const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
  const country = (body.country || url.searchParams.get("country") || request.cf?.country || "fr").toLowerCase().slice(0, 2);

  switch (route) {
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

    case "GET /api/search": {
      const q = (url.searchParams.get("q") || "").trim().slice(0, 80);
      return json({ artists: q ? await searchArtists(q, country) : [] });
    }

    case "POST /api/releases": {
      const ids = cleanIds(body.ids);
      return json({ releases: ids.length ? await recentReleases(ids, { country, days: 30 }) : [] });
    }

    case "GET /api/user": {
      const id = cleanUserId(url.searchParams.get("id"));
      const user = id && (await env.DB.get(`u:${id}`, "json"));
      return json({ artists: user?.artists || [], subscribed: !!user?.sub });
    }

    case "POST /api/sync": {
      const id = cleanUserId(body.id);
      if (!id) return json({ error: "id invalide" }, 400);
      const user = (await env.DB.get(`u:${id}`, "json")) || { notified: {}, created: Date.now() };
      if (Array.isArray(body.artists)) user.artists = cleanArtists(body.artists);
      if (body.subscription === null) delete user.sub;
      else if (validSub(body.subscription)) user.sub = pickSub(body.subscription);
      if (typeof body.tz === "string" && body.tz.length < 64) user.tz = body.tz;
      user.country = country;
      await env.DB.put(`u:${id}`, JSON.stringify(user));
      return json({ ok: true, subscribed: !!user.sub, artists: user.artists?.length || 0 });
    }

    case "POST /api/test": {
      const id = cleanUserId(body.id);
      const user = id && (await env.DB.get(`u:${id}`, "json"));
      if (!user?.sub) return json({ error: "Notifications pas encore activées sur ce téléphone" }, 400);
      if (Date.now() - (user.lastTest || 0) < 15000) return json({ error: "Patiente quelques secondes" }, 429);
      user.lastTest = Date.now();
      await env.DB.put(`u:${id}`, JSON.stringify(user));

      const ids = (user.artists || []).map((a) => a.id);
      const [latest] = ids.length ? await recentReleases(ids, { country: user.country, days: 365 }) : [];
      const payload = latest
        ? { ...releasePayload(latest), title: `Test · ${releasePayload(latest).title}` }
        : { title: "Miutif", body: "Les notifications marchent ! Rendez-vous à 11 h.", url: "/" };
      const status = await sendPush(user.sub, payload, await vapid(env));
      return json({ ok: status < 300, status });
    }
  }
  return json({ error: "Introuvable" }, 404);
}

// ---------- Envoi quotidien de 11 h ----------

async function dailyRun(env, now) {
  const keys = await vapid(env);
  let cursor;
  do {
    const page = await env.DB.list({ prefix: "u:", cursor });
    for (const { name } of page.keys) {
      try {
        await notifyUser(env, name, keys, now);
      } catch (e) {
        console.error(`Envoi raté pour ${name} :`, e.message);
      }
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
}

async function notifyUser(env, key, keys, now) {
  const user = await env.DB.get(key, "json");
  if (!user?.sub || !user.artists?.length) return;

  const { hour, day } = localTime(now, user.tz || "Europe/Paris");
  if (hour !== NOTIFY_HOUR || user.lastRun === day) return;

  const releases = await recentReleases(user.artists.map((a) => a.id), {
    country: user.country, days: NEW_DAYS, now: now.getTime(),
  });
  const notified = user.notified || {};
  const fresh = releases.filter((r) => !notified[r.id]);

  const payloads = fresh.slice(0, MAX_SINGLE).map(releasePayload);
  if (fresh.length > MAX_SINGLE) {
    const rest = fresh.slice(MAX_SINGLE);
    payloads.push({
      title: `+ ${rest.length} autre${rest.length > 1 ? "s" : ""} sortie${rest.length > 1 ? "s" : ""}`,
      body: rest.map((r) => r.artist).slice(0, 5).join(", "),
      url: "/",
      tag: `summary-${day}`,
    });
  }

  for (const payload of payloads) {
    const status = await sendPush(user.sub, payload, keys);
    if (status === 404 || status === 410) { delete user.sub; break; } // notifications coupées sur le téléphone
  }

  for (const r of fresh) notified[r.id] = now.getTime();
  for (const [id, t] of Object.entries(notified)) if (now.getTime() - t > 60 * 86400000) delete notified[id];
  user.notified = notified;
  user.lastRun = day;
  await env.DB.put(key, JSON.stringify(user));
}

function releasePayload(r) {
  const what = r.kind === "Album" ? "Nouvel album" : r.kind === "EP" ? "Nouvel EP" : "Nouveau single";
  return {
    title: `${what} de ${r.artist}`,
    body: `« ${r.title} » est dispo sur Apple Music. Touche pour écouter.`,
    url: r.url,
    tag: `release-${r.id}`,
  };
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
const cleanIds = (v) => (Array.isArray(v) ? v.map(String).filter((x) => /^\d{1,15}$/.test(x)).slice(0, 2000) : []);
const cleanArtists = (list) => {
  const seen = new Set();
  return list
    .filter((a) => a && /^\d{1,15}$/.test(String(a.id)) && !seen.has(String(a.id)) && seen.add(String(a.id)))
    .slice(0, 2000)
    .map((a) => ({ id: String(a.id), name: String(a.name || "").slice(0, 100) }));
};
const validSub = (s) => s && typeof s.endpoint === "string" && s.endpoint.startsWith("https://")
  && s.keys && typeof s.keys.p256dh === "string" && typeof s.keys.auth === "string";
const pickSub = (s) => ({ endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } });

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
});
