// Test de bout en bout, sans réseau : KV simulé, API Apple, fichier du robot et service push simulés.
// Lancer : node test/worker.test.mjs
import { createECDH, randomBytes } from "node:crypto";
import worker from "../src/worker.js";
import { b64url } from "../src/push.js";
import { searchArtists, recentReleases } from "../public/music.js";

let failed = 0;
const check = (ok, label) => { console.log(`${ok ? "OK  " : "FAIL"} ${label}`); if (!ok) failed++; };

// --- KV simulé
const kv = new Map();
const DB = {
  async get(k, type) { const v = kv.get(k); return v == null ? null : type === "json" ? JSON.parse(v) : v; },
  async put(k, v) { kv.set(k, v); },
  async list({ prefix }) { return { keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; },
};
const DATA_URL = "https://raw.githubusercontent.com/test/Miutif/data/releases.json";
const env = { DB, DATA_URL, ASSETS: { fetch: async () => new Response("asset") } };

// --- Réseau simulé
const NOW = Date.parse("2026-11-18T10:00:00Z"); // 11:00 à Paris
const day = (d) => new Date(NOW - d * 86400000).toISOString();
const pushes = [];
let pushStatus = 201;
let robotFile = null;
let robotReads = 0;
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.startsWith("https://itunes.apple.com/search")) {
    return Response.json({ results: [{ artistId: 111, artistName: "Artiste A", primaryGenreName: "Rap" }] });
  }
  if (url.startsWith("https://itunes.apple.com/lookup")) {
    return Response.json({ results: [
      { wrapperType: "artist", artistId: 111 },
      { wrapperType: "collection", collectionId: 1, artistName: "Artiste A", collectionName: "Neuf - Single", releaseDate: day(1), collectionViewUrl: "https://music.apple.com/fr/album/neuf/1?uo=4", artworkUrl100: "https://x/100x100bb.jpg" },
      { wrapperType: "collection", collectionId: 9, artistName: "Artiste A", collectionName: "Neuf - Single", releaseDate: day(1.5), collectionViewUrl: "https://music.apple.com/fr/album/neuf/9" },
      { wrapperType: "collection", collectionId: 2, artistName: "Artiste A", collectionName: "Vieux", releaseDate: day(40), collectionViewUrl: "https://music.apple.com/fr/album/vieux/2" },
      { wrapperType: "collection", collectionId: 3, artistName: "Artiste A", collectionName: "Futur", releaseDate: day(-5), collectionViewUrl: "https://music.apple.com/fr/album/futur/3" },
      { wrapperType: "artist", artistId: 222 },
      { wrapperType: "collection", collectionId: 4, artistName: "Artiste B", collectionName: "Album B", releaseDate: day(3), collectionViewUrl: "https://music.apple.com/fr/album/b/4" },
    ] });
  }
  if (url.startsWith(DATA_URL)) {
    robotReads++;
    return robotFile ? Response.json(robotFile) : new Response("404", { status: 404 });
  }
  if (url.startsWith("https://web.push.apple.com/")) {
    pushes.push({ url, headers: init.headers });
    return new Response(null, { status: pushStatus });
  }
  throw new Error(`fetch inattendu : ${url}`);
};
const realNow = Date.now;
Date.now = () => NOW;

const call = async (method, path, body) => {
  const res = await worker.fetch(new Request(`https://miutif.test${path}`, {
    method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
  }), env);
  return { status: res.status, data: await res.json() };
};
const runCron = async (iso) => {
  const jobs = [];
  await worker.scheduled({ scheduledTime: Date.parse(iso) }, env, { waitUntil: (p) => jobs.push(p) });
  await Promise.all(jobs);
};

// --- Catalogue (module partagé app / robot)
const found = await searchArtists("artiste");
check(found[0]?.id === "111" && found[0].genre === "Rap", "recherche d'artiste");
const rel = await recentReleases(["111", "222"]);
check(JSON.stringify(rel.map((x) => x.id)) === JSON.stringify(["1", "4"]), "sorties : récentes uniquement, sans futur ni > 30 jours, sans doublon de fiche");
check(rel[0].kind === "Single" && rel[0].title === "Neuf" && rel[0].artistId === "111", "sorties : « - Single » reconnu, artiste suivi noté");
check(rel[0].url === "https://music.apple.com/fr/album/neuf/1" && rel[0].artwork.includes("600x600"), "sorties : lien Apple Music propre + pochette grand format");

// --- Serveur
const cfg = await call("GET", "/api/config");
check(cfg.status === 200 && b64url.decode(cfg.data.vapidKey).length === 65, "config : clé VAPID créée au premier appel");
check((await call("GET", "/api/config")).data.vapidKey === cfg.data.vapidKey, "config : la clé reste la même ensuite");

const browser = createECDH("prime256v1"); browser.generateKeys();
const sub = { endpoint: "https://web.push.apple.com/abc", keys: { p256dh: b64url.encode(browser.getPublicKey()), auth: b64url.encode(randomBytes(16)) } };
const id = "abcdefghij0123456789";
check((await call("POST", "/api/sync", { id: "x", artists: [] })).status === 400, "sync : identifiant invalide refusé");
const sy = await call("POST", "/api/sync", { id, tz: "Europe/Paris", artists: [{ id: "111", name: "Artiste A" }, { id: "222", name: "Artiste B" }, { id: "111", name: "doublon" }, { id: "abc", name: "faux" }], subscription: sub });
check(sy.data.subscribed && sy.data.artists === 2, "sync : abonnement gardé, doublons et faux identifiants ignorés");
check((await call("GET", `/api/user?id=${id}`)).data.artists.length === 2, "user : artistes récupérables après réinstallation");

const tokyo = "tokyo0123456789abcdef";
await call("POST", "/api/sync", { id: tokyo, tz: "Asia/Tokyo", artists: [{ id: "111", name: "A" }, { id: "333", name: "C" }], subscription: { ...sub, endpoint: "https://web.push.apple.com/tokyo" } });
const art = await call("GET", "/api/artists");
check(JSON.stringify(art.data.countries.fr.sort()) === JSON.stringify(["111", "222", "333"]), "robot : liste de tous les artistes suivis, sans doublon");

// Le robot publie son fichier (comme le ferait GitHub Actions)
robotFile = { updated: new Date(NOW).toISOString(), byCountry: { fr: await recentReleases(art.data.countries.fr, { days: 14, dedupe: false }) } };

await runCron("2026-11-18T09:00:00Z"); // 10:00 à Paris
check(pushes.length === 0 && robotReads === 0, "cron 10 h : rien n'est envoyé, fichier pas lu");

await runCron("2026-11-18T10:00:00Z"); // 11:00 à Paris
check(pushes.length === 2, "cron 11 h : une notif par nouvelle sortie (2)");
check(pushes[0]?.headers["Content-Encoding"] === "aes128gcm" && pushes[0]?.headers.Authorization.startsWith("vapid t="), "cron 11 h : notif chiffrée et signée");

await runCron("2026-11-18T10:00:00Z");
check(pushes.length === 2, "cron 11 h relancé le même jour : pas de doublon");

await runCron("2026-11-19T10:00:00Z");
check(pushes.length === 2, "lendemain 11 h : déjà notifiées, rien de nouveau");

await runCron("2026-11-19T02:00:00Z"); // 11:00 à Tokyo (suit 111 mais pas 222)
check(pushes.filter((p) => p.url.endsWith("/tokyo")).length === 1 && pushes.length === 3, "fuseau horaire + seulement SES artistes (Tokyo : 1 notif)");

const t = await call("POST", "/api/test", { id });
check(t.data.ok && pushes.length === 4, "bouton test : notif envoyée tout de suite");
check((await call("POST", "/api/test", { id })).status === 429, "bouton test : pas de rafale");

robotFile = null;
kv.set(`u:${id}`, JSON.stringify({ ...JSON.parse(kv.get(`u:${id}`)), notified: {}, lastRun: null }));
await runCron("2026-11-20T10:00:00Z");
check(pushes.length === 4 && JSON.parse(kv.get(`u:${id}`)).lastRun === null, "fichier du robot absent : rien d'envoyé, on réessaiera");

pushStatus = 410;
robotFile = { byCountry: { fr: [{ ...rel[0], date: day(0.1) }] } };
await runCron("2026-11-20T10:00:00Z");
check(!JSON.parse(kv.get(`u:${id}`)).sub, "abonnement mort (notifs coupées) : supprimé");

check((await call("GET", "/api/token")).status === 404, "jeton Apple Music : absent tant que non configuré");

Date.now = realNow;
console.log(failed ? `\n${failed} échec(s)` : "\nTout est bon.");
process.exit(failed ? 1 : 0);
