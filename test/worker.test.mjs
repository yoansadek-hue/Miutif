// Test de bout en bout, sans réseau : KV simulé, pages Apple, fichier du robot et service push simulés.
// Les notifications envoyées sont déchiffrées pour vérifier leur contenu.
// Lancer : node test/worker.test.mjs
import { createRequire } from "node:module";
import { createECDH, randomBytes } from "node:crypto";
import worker from "../src/worker.js";
import { b64url } from "../src/push.js";
import { searchArtists, recentReleases, discography, featOf, filterUpcoming, catalogReleases, artistCatalog } from "../public/music.js";

const ece = createRequire(import.meta.url)("http_ece");
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

// --- Téléphones simulés (clés pour déchiffrer leurs notifications)
const phones = {};
function phone(name) {
  const ecdh = createECDH("prime256v1"); ecdh.generateKeys();
  const auth = randomBytes(16);
  phones[`https://web.push.apple.com/${name}`] = { ecdh, auth };
  return { endpoint: `https://web.push.apple.com/${name}`, keys: { p256dh: b64url.encode(ecdh.getPublicKey()), auth: b64url.encode(auth) } };
}

// --- Réseau simulé
const NOW = Date.parse("2026-11-18T10:00:00Z"); // 11:00 à Paris
const day = (d) => new Date(NOW - d * 86400000).toISOString();
const pushes = [];
const dispatches = [];
let pushStatus = 201;
let robotFile = null;
let robotReads = 0;
let playlistArtists = [["111", "Artiste A"], ["222", "Artiste B"], ["444", "Artiste D & co"]];
let artistFetches = 0;
const link = (id, name) => ({ title: name, segue: { destination: { contentDescriptor: { kind: "artist", identifiers: { storeAdamID: id } } } } });

globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.startsWith("https://itunes.apple.com/search")) {
    return Response.json({ results: [{ artistId: 111, artistName: "Artiste A", primaryGenreName: "Rap" }] });
  }
  if (url.startsWith("https://itunes.apple.com/lookup")) {
    return Response.json({ results: [
      { wrapperType: "artist", artistId: 111 },
      { wrapperType: "collection", collectionId: 1, artistId: 111, artistName: "Artiste A", collectionName: "Neuf - Single", releaseDate: day(1), collectionViewUrl: "https://music.apple.com/fr/album/neuf/1?uo=4", artworkUrl100: "https://x/100x100bb.jpg" },
      { wrapperType: "collection", collectionId: 9, artistId: 111, artistName: "Artiste A", collectionName: "Neuf - Single", releaseDate: day(1.5), collectionViewUrl: "https://music.apple.com/fr/album/neuf/9" },
      { wrapperType: "collection", collectionId: 2, artistId: 111, artistName: "Artiste A", collectionName: "Vieux", releaseDate: day(40), collectionViewUrl: "https://music.apple.com/fr/album/vieux/2" },
      { wrapperType: "collection", collectionId: 3, artistId: 111, artistName: "Artiste A", collectionName: "Futur", releaseDate: day(-5), collectionViewUrl: "https://music.apple.com/fr/album/futur/3" },
      { wrapperType: "artist", artistId: 222 },
      { wrapperType: "collection", collectionId: 4, artistId: 222, artistName: "Artiste B", collectionName: "Album B", releaseDate: day(3), collectionViewUrl: "https://music.apple.com/fr/album/b/4" },
    ] });
  }
  if (url.startsWith("https://music.apple.com/") && url.includes("/playlist/")) {
    if (!url.includes("pl.ok")) return new Response("introuvable", { status: 404 });
    const data = { data: [{ sections: [{ items: playlistArtists.map(([id, n], i) => ({ title: `Titre ${i}`, artistName: `${n} & Artiste A`, contentDescriptor: { kind: "song", identifiers: { storeAdamID: `90${i}` }, url: `https://music.apple.com/fr/album/x/1?i=90${i}` }, artwork: { dictionary: { url: "https://is1-ssl.mzstatic.com/image/thumb/s.jpg/{w}x{h}bb.{f}" } }, subtitleLinks: [link(id, n), link("111", "Artiste A")] })) }] }] };
    const more = url.includes("pl.oklong") ? '{"nextIntent":{"$kind":"PlaylistPaginationIntent"}}' : "";
    return new Response(`${more}<meta property="og:title" content="Ma playlist &amp; moi sur Apple Music"><meta property="og:image" content="https://is1-ssl.mzstatic.com/image/thumb/Features/x/y.png/1200x630SC.DN01.jpg?l=fr-FR"><script type="application/json" id="serialized-server-data">${JSON.stringify(data)}</script>`);
  }
  if (url.startsWith("https://music.apple.com/") && url.includes("/artist/")) {
    artistFetches++;
    if (url.endsWith("/999")) return new Response("introuvable", { status: 404 });
    const data = { data: [{ data: { sections: [{ itemKind: "artistDetailHeader", items: [{ title: "Artiste A", bio: "Né à Paris.\nRappeur.", circleArtwork: { dictionary: { url: "https://is1-ssl.mzstatic.com/image/thumb/a/file.png/{w}x{h}{c}.{f}" } } }] }, { id: "artists_111.marker.SimilarArtists-CircleLockupSection", itemKind: "bubbleLockup", items: [
      { title: "Proche 1", contentDescriptor: { kind: "artist", identifiers: { storeAdamID: "701" } }, artwork: { dictionary: { url: "https://is1-ssl.mzstatic.com/image/thumb/p1.jpg/{w}x{h}bb.{f}" } } },
      { title: "Proche 2", contentDescriptor: { kind: "artist", identifiers: { storeAdamID: "702" } } },
    ] }] } }] };
    return new Response(`<script type="application/json" id="serialized-server-data">${JSON.stringify(data)}</script>`);
  }
  if (url.startsWith(DATA_URL)) {
    robotReads++;
    return robotFile ? Response.json(robotFile) : new Response("404", { status: 404 });
  }
  if (url.startsWith("https://api.github.com/")) {
    dispatches.push({ url, auth: init.headers.Authorization, body: init.body });
    return new Response(null, { status: 204 });
  }
  if (url.startsWith("https://web.push.apple.com/")) {
    const ph = phones[url];
    const payload = JSON.parse(ece.decrypt(Buffer.from(init.body), { version: "aes128gcm", privateKey: ph.ecdh, authSecret: ph.auth }).toString());
    pushes.push({ url, headers: init.headers, payload });
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
  const text = await res.text();
  return { status: res.status, headers: res.headers, data: text ? JSON.parse(text) : null };
};
const runCron = async (iso) => {
  const jobs = [];
  await worker.scheduled({ scheduledTime: Date.parse(iso) }, env, { waitUntil: (p) => jobs.push(p) });
  await Promise.all(jobs);
};
const user = (id) => JSON.parse(kv.get(`u:${id}`));
const notes = (id) => JSON.parse(kv.get(`n:${id}`) || "{}"); // historique des notifications (fiche à part)

// --- Catalogue (module partagé app / robot)
const found = await searchArtists("artiste");
check(found[0]?.id === "111" && found[0].genre === "Rap", "recherche d'artiste");
const rel = await recentReleases(["111", "222"]);
check(JSON.stringify(rel.map((x) => x.id)) === JSON.stringify(["1", "4"]), "sorties : récentes uniquement, sans futur ni > 30 jours, sans doublon de fiche");
check(rel[0].kind === "Single" && rel[0].title === "Neuf" && rel[0].artistId === "111", "sorties : « - Single » reconnu, artiste suivi noté");
check(featOf({ artist: "Future", featured: true }, "Drake") === "Drake", "feat : Drake sur un titre de Future → « feat. Drake »");
check(featOf({ artist: "SCH & SDM", featured: true }, "SDM") === null, "feat : SDM dans « SCH & SDM » est artiste principal, pas un feat");
check(featOf({ artist: "Artiste A", featured: false }, "Artiste A") === null, "feat : sa propre sortie n'est pas un feat");
const up = filterUpcoming([
  { id: "a", artist: "X", title: "Bientôt", date: day(-5) },
  { id: "b", artist: "X", title: "Demain", date: day(-1) },
  { id: "c", artist: "X", title: "Passé", date: day(2) },
  { id: "d", artist: "X", title: "Trop loin", date: day(-400) },
], { now: NOW });
check(JSON.stringify(up.map((r) => r.id)) === JSON.stringify(["b", "a"]), "à venir : seulement les sorties futures (≤ 6 mois), la plus proche d'abord");
const cat = await catalogReleases(["111", "222"]);
check(cat.recent.length === 2 && cat.upcoming.length === 1 && cat.upcoming[0].title === "Futur", "à venir : récupérées avec les mêmes requêtes que les sorties récentes");
check(rel[0].featured === false, "sorties : sortie de l'artiste lui-même marquée comme non-feat");

const catA = await artistCatalog("111");
check(JSON.stringify(catA.own.map((r) => r.id)) === JSON.stringify(["1", "2"]) && JSON.stringify(catA.appearances.map((r) => r.id)) === JSON.stringify(["4"]),
  "fiche artiste : ses sorties d'un côté, ses apparitions chez les autres de l'autre");
const disco = await discography("111");
check(JSON.stringify(disco.map((r) => r.id)) === JSON.stringify(["1", "2"]), "discographie : ses sorties parues (sans doublon, sans le futur, sans les autres artistes), la plus récente d'abord");

// --- Fiches artistes
const fiche = await call("GET", "/api/artist/111");
check(fiche.data.name === "Artiste A" && fiche.data.bio.startsWith("Né à Paris") && fiche.data.image.endsWith("/400x400cc.jpg"), "fiche artiste : nom, biographie et photo carrée");
check(fiche.data.similar.length === 2 && fiche.data.similar[0].id === "701" && fiche.data.similar[0].image.endsWith("/200x200cc.jpg") && fiche.data.similar[1].image === null,
  "fiche artiste : artistes similaires (identifiant, nom, photo) pour les suggestions");
const ph = await call("GET", "/api/artist/111/photo");
check(ph.status === 302 && ph.headers.get("Location").includes("mzstatic") && artistFetches === 1, "photo : redirection vers l'image, fiche gardée en mémoire (1 seule lecture Apple)");
check((await call("GET", "/api/artist/999/photo")).status === 404, "photo absente : 404 (l'app affiche l'initiale)");

// --- Playlist
const pl = await call("POST", "/api/playlist", { url: "Écoute https://music.apple.com/fr/playlist/ma-playlist/pl.ok?ls=1" });
check(pl.status === 200 && pl.data.title === "Ma playlist & moi" && pl.data.artists.length === 3, "playlist : lien partagé lu, chaque artiste une seule fois");
check(pl.data.trackCount === 3 && pl.data.truncated === false && !("tracks" in pl.data), "playlist : nombre de titres lus, playlist complète");
check(pl.data.image === "https://is1-ssl.mzstatic.com/image/thumb/Features/x/y.png/300x300bb.jpg", "playlist : couverture carrée récupérée");
check((await call("POST", "/api/playlist", { url: "https://music.apple.com/fr/playlist/x/pl.oklong" })).data.truncated === true, "playlist de plus de 300 titres : signalée comme incomplète");
check((await call("POST", "/api/playlist", { url: "https://music.apple.com/fr/playlist/x/pl.absente" })).status === 404, "playlist : non partagée → message clair");
check((await call("POST", "/api/playlist", { url: "https://exemple.com/fr/playlist/x" })).status === 400, "playlist : autre site refusé");

// --- Utilisateurs
const cfg = await call("GET", "/api/config");
check(b64url.decode(cfg.data.vapidKey).length === 65, "config : clé VAPID créée au premier appel");

const id = "abcdefghij0123456789";
check((await call("POST", "/api/sync", { id: "x", artists: [] })).status === 400, "sync : identifiant invalide refusé");
const sy = await call("POST", "/api/sync", {
  id, tz: "Europe/Paris", subscription: phone("paris"),
  artists: [{ id: "111", name: "Artiste A" }, { id: "222", name: "Artiste B" }, { id: "111", name: "doublon" }, { id: "abc", name: "faux" }],
  playlists: [{ url: "https://music.apple.com/fr/playlist/ma-playlist/pl.ok", title: "Ma playlist", count: 3, cover: "javascript:alert(1)" }, { url: "https://exemple.com/x", title: "faux" }],
  excluded: ["444"],
});
check(sy.data.subscribed && sy.data.artists === 2, "sync : abonnement gardé, doublons et faux identifiants ignorés");
const saved = (await call("GET", `/api/user?id=${id}`)).data;
// un appareil avec une liste périmée (sans les suppressions, avec l'artiste supprimé) ne doit rien effacer
const stale = await call("POST", "/api/sync", { id, artists: [{ id: "111", name: "Artiste A" }, { id: "444", name: "Supprimé" }], excluded: [] });
check(stale.data.artistList.length === 2 && !stale.data.artistList.some((x) => x.id === "444") && stale.data.excluded.includes("444"),
  "sync : une liste périmée n'efface ni les artistes ni les suppressions (fusion)");
// suivre à nouveau explicitement un artiste supprimé
const back = await call("POST", "/api/sync", { id, artists: [{ id: "444", name: "De retour" }], excluded: [], unexcluded: ["444"] });
check(back.data.artistList.some((x) => x.id === "444") && !back.data.excluded.includes("444"), "sync : un artiste suivi à nouveau sort des suppressions");
await call("POST", "/api/sync", { id, artists: [], excluded: ["444"] }); // on le resupprime pour la suite du scénario
check(saved.artists.length === 2 && saved.playlists.length === 1 && saved.excluded[0] === "444", "user : artistes, playlists valides et artistes retirés récupérables");
check(saved.playlists[0].cover === null, "sync : une couverture qui ne vient pas d'Apple est refusée");

const tokyo = "tokyo0123456789abcdef";
await call("POST", "/api/sync", { id: tokyo, tz: "Asia/Tokyo", artists: [{ id: "111", name: "A" }, { id: "333", name: "C" }], subscription: phone("tokyo") });
const art = await call("GET", "/api/artists");
check(JSON.stringify(art.data.countries.fr.sort()) === JSON.stringify(["111", "222", "333"]), "robot : liste de tous les artistes suivis, sans doublon");

// --- 10 h : relecture des playlists (un nouvel artiste est apparu dans la playlist)
playlistArtists = [...playlistArtists, ["555", "Artiste E"]];
check((await call("GET", "/api/status")).data.updated === null, "état du robot : inconnu tant qu'il n'a rien publié");
robotReads = 0; // la lecture ci-dessus ne compte pas pour le test suivant
await runCron("2026-11-18T09:00:00Z"); // 10:00 à Paris
const ids = user(id).artists.map((a) => a.id);
check(ids.includes("555") && !ids.includes("444"), "10 h : nouvel artiste de la playlist ajouté, artiste retiré à la main pas rajouté");
check(user(id).playlists[0].cover?.endsWith("/300x300bb.jpg") && user(id).playlists[0].title === "Ma playlist & moi", "10 h : couverture et titre de la playlist mis à jour");
const of = (name) => pushes.filter((x) => x.url.endsWith(`/${name}`)); // notifications reçues par un téléphone
check(of("paris").length === 0, "10 h à Paris : aucune notification (on attend 11 h)");

// Le robot publie son fichier (comme le ferait GitHub Actions à 10 h 50)
robotFile = { updated: new Date(NOW).toISOString(), byCountry: { fr: await recentReleases(["111", "222", "333"], { days: 14, dedupe: false }) } };

check((await call("GET", "/api/status")).data.updated === robotFile.updated, "état du robot : date de sa dernière publication (Réglages)");
// un utilisateur dont aucun artiste n'a rien sorti
const calme = "calme0123456789abcdef";
await call("POST", "/api/sync", { id: calme, tz: "Europe/Paris", artists: [{ id: "999", name: "Silencieux" }], subscription: phone("calme") });
// --- 11 h : une seule notification récap
await runCron("2026-11-18T10:00:00Z");
check(!pushes.some((p) => p.url.endsWith("/calme")) && notes(calme).lastRun === "2026-11-18", "11 h : aucune sortie chez ses artistes → aucune notification");
check(of("paris").length === 1, "11 h : UNE seule notification pour 2 sorties");
const recap = of("paris")[0]?.payload;
check(recap?.title === "2 nouvelles sorties" && recap.body.includes("Artiste A — Neuf") && recap.body.includes("Artiste B — Album B"), "11 h : le récap liste les sorties");
check(recap?.url === "/?tab=new", "11 h : toucher le récap ouvre l'onglet Nouveautés");

await runCron("2026-11-18T10:00:00Z");
await runCron("2026-11-19T10:00:00Z");
check(of("paris").length === 1, "pas de doublon : ni le même jour, ni le lendemain");

await runCron("2026-11-19T02:00:00Z"); // 11:00 à Tokyo (suit 111 mais pas 222)
const tk = of("tokyo")[0];
check(of("tokyo").length === 1 && tk.payload.title === "Nouveau single de Artiste A" && tk.payload.url === "https://music.apple.com/fr/album/neuf/1",
  "1 seule sortie : la notif ouvre directement Apple Music, une seule fois (fuseau de Tokyo respecté)");

check((await call("POST", "/api/test", { id })).status === 404, "version finale : plus de notification de test");

robotFile = null;
kv.delete(`n:${id}`);
await runCron("2026-11-20T10:00:00Z");
check(of("paris").length === 1 && notes(id).lastRun === undefined, "fichier du robot absent : rien d'envoyé, on réessaiera");

pushStatus = 410;
robotFile = { byCountry: { fr: [{ ...rel[0], date: day(0.1) }] } };
await runCron("2026-11-20T10:00:00Z");
check(!user(id).sub, "abonnement mort (notifs coupées) : supprimé");

// --- lancement du robot par le réveil de Cloudflare (à :45)
const robotCron = async () => { const jobs = []; await worker.scheduled({ cron: "45 * * * *", scheduledTime: NOW }, env, { waitUntil: (p) => jobs.push(p) }); await Promise.all(jobs); };
await robotCron();
check(dispatches.length === 0, "robot : rien n'est lancé tant que le jeton GitHub n'est pas configuré");
env.GITHUB_TOKEN = "jeton-test";
const before = pushes.length;
await robotCron();
check(dispatches.length === 1 && dispatches[0].url.endsWith("/actions/workflows/sorties.yml/dispatches") && dispatches[0].auth === "Bearer jeton-test" && JSON.parse(dispatches[0].body).ref === "main",
  "robot : lancé à :45 par Cloudflare via l'API GitHub");
check(pushes.length === before, "robot : le réveil de :45 n'envoie aucune notification");
delete env.GITHUB_TOKEN;

// --- une sortie qui apparaît après le récap de 11 h est notifiée à l'heure suivante
pushStatus = 201; // le service de notification simulé refonctionne
const soir = "soir0123456789abcdefg";
await call("POST", "/api/sync", { id: soir, tz: "Europe/Paris", artists: [{ id: "111", name: "Artiste A" }], subscription: phone("soir") });
robotFile = { byCountry: { fr: [{ ...rel[0], id: "s1", title: "Matin", date: "2026-11-21T08:00:00Z" }] } };
await runCron("2026-11-21T10:00:00Z"); // 11 h
const soirPushes = () => pushes.filter((p) => p.url.endsWith("/soir"));
check(soirPushes().length === 1 && soirPushes()[0].payload.body.includes("Matin"), "11 h : récap avec la sortie du matin");
await runCron("2026-11-21T13:00:00Z"); // 14 h, rien de nouveau
check(soirPushes().length === 1, "14 h : rien de nouveau → aucune notification");
robotFile.byCountry.fr.push({ ...rel[0], id: "s2", title: "Surprise", date: "2026-11-21T08:00:00Z" });
await runCron("2026-11-21T15:00:00Z"); // 16 h : une sortie est apparue entre-temps
check(soirPushes().length === 2 && soirPushes()[1].payload.body.includes("Surprise") && !soirPushes()[1].payload.body.includes("Matin"),
  "16 h : la sortie apparue après 11 h est notifiée (seule)");
await runCron("2026-11-21T16:00:00Z");
check(soirPushes().length === 2, "17 h : pas de doublon");
robotFile.byCountry.fr.push({ ...rel[0], id: "s3", title: "Nuit", date: "2026-11-22T00:00:00Z" });
await runCron("2026-11-22T03:00:00Z"); // 4 h du matin : on attend le récap de 11 h
check(soirPushes().length === 2, "la nuit : pas de notification, la sortie attend le récap de 11 h");

// --- heure du récap choisie et mode silencieux
const tot = "tot0123456789abcdefgh", calm2 = "calm20123456789abcdef";
await call("POST", "/api/sync", { id: tot, tz: "Europe/Paris", notifyHour: 8, artists: [{ id: "111", name: "A" }], subscription: phone("tot") });
await call("POST", "/api/sync", { id: calm2, tz: "Europe/Paris", quiet: true, artists: [{ id: "111", name: "A" }], subscription: phone("calm2") });
check((await call("GET", `/api/user?id=${tot}`)).data.notifyHour === 8 && (await call("GET", `/api/user?id=${calm2}`)).data.quiet === true, "réglages : heure du récap et mode silencieux enregistrés");
robotFile = { byCountry: { fr: [{ ...rel[0], id: "q1", title: "Aube", date: "2026-11-23T00:00:00Z" }] } };
await runCron("2026-11-23T06:00:00Z"); // 7 h
check(of("tot").length === 0, "récap à 8 h : rien à 7 h");
await runCron("2026-11-23T07:00:00Z"); // 8 h
check(of("tot").length === 1 && of("calm2").length === 0, "récap à 8 h : notifié à 8 h (le silencieux attend 11 h)");
await runCron("2026-11-23T10:00:00Z"); // 11 h
check(of("calm2").length === 1, "mode silencieux : le récap de 11 h arrive");
robotFile.byCountry.fr.push({ ...rel[0], id: "q2", title: "Après-midi", date: "2026-11-23T00:00:00Z" });
await runCron("2026-11-23T14:00:00Z"); // 15 h
check(of("tot").length === 2 && of("calm2").length === 1, "15 h : nouvelle sortie notifiée, sauf en mode silencieux");
await runCron("2026-11-24T10:00:00Z"); // lendemain 11 h
check(of("calm2").length === 2 && of("calm2")[1].payload.body.includes("Après-midi"), "mode silencieux : la sortie de l'après-midi arrive dans le récap du lendemain");

// --- l'app réécrit le compte juste après la notif : la notif n'est pas renvoyée l'heure suivante
const course = "course0123456789abcde";
await call("POST", "/api/sync", { id: course, tz: "Europe/Paris", artists: [{ id: "111", name: "A" }], subscription: phone("course") });
const vieux = kv.get(`u:${course}`); // copie du compte lue par l'app avant la notif
robotFile = { byCountry: { fr: [{ ...rel[0], id: "c1", title: "Course", date: "2026-11-25T00:00:00Z" }, { ...rel[0], id: "c2", title: "Course", date: "2026-11-25T00:00:00Z" }] } };
await runCron("2026-11-25T10:00:00Z"); // 11 h
kv.set(`u:${course}`, vieux); // l'app réécrit sa vieille copie
await call("POST", "/api/sync", { id: course, artists: [{ id: "111", name: "A" }] });
await runCron("2026-11-25T11:00:00Z"); // 12 h
check(of("course").length === 1, "12 h : pas la même notif qu'à 11 h, même si l'app a réécrit le compte entre-temps");
check(of("course")[0].payload.title.startsWith("Nouveau single"), "même sortie sous deux identifiants Apple : notifiée une seule fois");

check((await call("GET", "/api/token")).status === 404, "jeton Apple Music : absent tant que non configuré");

Date.now = realNow;
console.log(failed ? `\n${failed} échec(s)` : "\nTout est bon.");
process.exit(failed ? 1 : 0);
