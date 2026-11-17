// Catalogue Apple Music via l'API publique iTunes (gratuite, sans clé).
// Les identifiants d'artistes sont les mêmes que ceux d'Apple Music.
// Module partagé : utilisé par l'app (navigateur), le robot GitHub et le Worker.
// (Apple bloque les serveurs Cloudflare : le Worker n'appelle jamais Apple, il n'utilise que filterRecent.)

const ITUNES = "https://itunes.apple.com";

async function getJSON(url) {
  const res = await fetch(url); // pas d'en-tête perso : sinon le navigateur ferait une requête CORS préalable
  if (!res.ok) throw new Error(`Apple Music ne répond pas (${res.status})`);
  return res.json();
}

const chunks = (list, size) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

export async function searchArtists(term, country = "fr") {
  const url = `${ITUNES}/search?term=${encodeURIComponent(term)}&entity=musicArtist&country=${country}&limit=10`;
  const json = await getJSON(url);
  return (json.results || []).map((a) => ({
    id: String(a.artistId),
    name: a.artistName,
    genre: a.primaryGenreName || "",
  }));
}

const simplify = (s) => String(s || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * Nom de l'artiste suivi si cette sortie est un featuring pour lui (il n'en est pas l'artiste principal),
 * sinon null. « SCH & SDM » n'est pas un feat pour SDM : il fait partie des artistes principaux.
 */
export function featOf(release, followedName) {
  if (!followedName || release.featured === false) return null;
  return simplify(release.artist).includes(simplify(followedName)) ? null : followedName;
}

function toRelease(c, followedId) {
  const name = c.collectionName || "";
  const kind = / - Single$/.test(name) ? "Single" : / - EP$/.test(name) ? "EP" : "Album";
  return {
    id: String(c.collectionId),
    title: name.replace(/ - (Single|EP)$/, ""),
    artist: c.artistName,
    artistId: followedId, // l'artiste suivi qui a amené cette sortie
    featured: c.artistId != null && followedId != null && String(c.artistId) !== String(followedId), // il n'en est pas l'artiste principal
    kind,
    date: c.releaseDate, // ISO, ex. 2026-11-14T08:00:00Z
    url: c.collectionViewUrl.replace(/\?uo=\d+$/, ""),
    artwork: (c.artworkUrl100 || "").replace(/\/\d+x\d+bb\./, "/600x600bb."),
  };
}

/**
 * Garde les sorties déjà parues depuis moins de `days` jours, les plus récentes d'abord.
 * `dedupe` : Apple publie parfois la même sortie sous deux fiches, on n'en garde qu'une.
 */
export function filterRecent(releases, { days = 30, now = Date.now(), dedupe = true } = {}) {
  const seen = new Set();
  return releases
    .filter((r) => { const t = Date.parse(r.date); return t <= now && now - t <= days * 86400000; })
    .sort((a, b) => b.date.localeCompare(a.date))
    .filter((r) => {
      if (!dedupe) return true;
      const key = `${r.artist}|${r.title}`.toLowerCase();
      return !seen.has(key) && seen.add(key);
    });
}

/** Vérifie qu'un lien est bien une playlist Apple Music et renvoie l'adresse à lire. */
export function playlistUrl(input) {
  try {
    const u = new URL(String(input).trim().match(/https?:\/\/\S+/)?.[0] || "");
    if (u.protocol !== "https:" || !/^(embed\.)?music\.apple\.com$/.test(u.hostname)) return null;
    if (!/^\/[a-z]{2}\/playlist\//.test(u.pathname)) return null;
    return `https://music.apple.com${u.pathname}`;
  } catch {
    return null;
  }
}

/**
 * Artistes d'une page de playlist music.apple.com (données intégrées « serialized-server-data »).
 * Chaque titre liste ses artistes un par un (featurings compris), avec leur identifiant.
 */
export function parsePlaylistPage(html) {
  const m = html.match(/<script[^>]*id="serialized-server-data"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  const artists = new Map();
  const tracks = new Map();
  const walk = (node) => {
    if (Array.isArray(node)) { for (const x of node) walk(x); return; }
    if (!node || typeof node !== "object") return;
    const song = node.contentDescriptor?.kind === "song" && node.contentDescriptor.identifiers?.storeAdamID;
    if (song && node.title && !tracks.has(String(song))) {
      const art = node.artwork?.dictionary?.url;
      tracks.set(String(song), {
        id: String(song),
        title: node.title,
        artist: node.artistName || (node.subtitleLinks || []).map((l) => l.title).join(", "),
        url: node.contentDescriptor.url || null,
        artwork: art ? art.replace(/\{w\}x\{h\}(\{c\}|bb|cc)?\.\{f\}/, "200x200bb.jpg") : null,
      });
    }
    if (Array.isArray(node.subtitleLinks)) {
      for (const link of node.subtitleLinks) {
        const d = link?.segue?.destination?.contentDescriptor;
        const id = d?.kind === "artist" && d.identifiers?.storeAdamID;
        if (id && link.title && !artists.has(String(id))) artists.set(String(id), { id: String(id), name: link.title });
      }
    }
    for (const k in node) if (node[k] && typeof node[k] === "object") walk(node[k]);
  };
  walk(JSON.parse(m[1]));
  const title = (html.match(/<meta property="og:title" content="([^"]*)"/)?.[1] || "Playlist")
    .replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+sur\s+Apple\s+Music$/, "");
  return {
    title,
    image: coverFrom(html),
    artists: [...artists.values()],
    trackCount: tracks.size,
    // Apple ne met que les 300 premiers titres dans la page ; au-delà, elle indique une « page suivante »
    truncated: /PlaylistPaginationIntent/.test(html),
  };
}

/** Couverture carrée d'une page music.apple.com (à partir de son image de partage). */
function coverFrom(html) {
  const og = html.match(/<meta property="og:image" content="([^"]+)"/)?.[1];
  return og && /^https:\/\/is\d-ssl\.mzstatic\.com\//.test(og) ? og.replace(/\?.*$/, "").replace(/\/[^/]+$/, "/300x300bb.jpg") : null;
}

/**
 * Fiche d'un artiste depuis sa page music.apple.com : nom, photo (carrée) et biographie.
 * La photo vient de l'en-tête de la page (ou, à défaut, de l'image de partage og:image).
 */
export function parseArtistPage(html) {
  let header = null;
  const m = html.match(/<script[^>]*id="serialized-server-data"[^>]*>([\s\S]*?)<\/script>/);
  if (m) {
    try {
      const sections = JSON.parse(m[1])?.data?.[0]?.data?.sections || [];
      header = sections.find((s) => s.itemKind === "artistDetailHeader")?.items?.[0] || null;
    } catch {}
  }
  const template = header?.circleArtwork?.dictionary?.url || header?.artwork?.dictionary?.url;
  const og = html.match(/<meta property="og:image" content="([^"]+)"/)?.[1];
  const image = template
    ? template.replace("{w}x{h}{c}.{f}", "400x400cc.jpg")
    : og && /AMCArtistImages|\/Music\d*\//.test(og) ? og.replace(/\/[^/]+$/, "/400x400cc.jpg") : null;
  const name = header?.title || (html.match(/<meta property="og:title" content="([^"]*)"/)?.[1] || "").replace(/\s+sur\s+Apple\s+Music$/, "");
  return { name, image, bio: (header?.bio || "").trim() };
}

/** Dates de sortie de titres (identifiants Apple Music), par paquets de 150 : { id: "2017-06-30T12:00:00Z" } */
export async function trackDates(ids, country = "fr") {
  const dates = {};
  for (const chunk of chunks([...new Set(ids)], 150)) {
    const json = await getJSON(`${ITUNES}/lookup?id=${chunk.join(",")}&country=${country}`);
    for (const r of json.results || []) if (r.trackId && r.releaseDate) dates[String(r.trackId)] = r.releaseDate;
  }
  return dates;
}

/** Discographie complète d'un artiste (ses propres sorties, sans ses apparitions), la plus récente d'abord. */
export async function discography(artistId, country = "fr") {
  const id = String(artistId);
  const json = await getJSON(`${ITUNES}/lookup?id=${id}&entity=album&sort=recent&limit=200&country=${country}`);
  const seen = new Set();
  return (json.results || [])
    .filter((c) => c.wrapperType === "collection" && String(c.artistId) === id && c.collectionViewUrl && c.releaseDate)
    .map((c) => toRelease(c, id))
    .filter((r) => Date.parse(r.date) <= Date.now())
    .sort((a, b) => b.date.localeCompare(a.date))
    .filter((r) => { const k = r.title.toLowerCase(); return !seen.has(k) && seen.add(k); });
}

/** Sorties récentes des artistes donnés (une entrée par artiste suivi et par sortie si dedupe=false). */
export async function recentReleases(artistIds, { country = "fr", days = 30, now = Date.now(), dedupe = true } = {}) {
  const found = new Map();
  for (const ids of chunks([...new Set(artistIds)], 40)) {
    // sort=recent est indispensable (sinon Apple trie par popularité) mais approximatif :
    // on prend 15 sorties par artiste et on trie nous-mêmes.
    const url = `${ITUNES}/lookup?id=${ids.join(",")}&entity=album&sort=recent&limit=15&country=${country}`;
    const json = await getJSON(url);
    let current = null;
    for (const r of json.results || []) {
      if (r.wrapperType === "artist") { current = String(r.artistId); continue; }
      if (r.wrapperType !== "collection" || !r.collectionViewUrl || !r.releaseDate) continue;
      const rel = toRelease(r, current);
      found.set(`${rel.id}|${current}`, rel);
    }
  }
  return filterRecent([...found.values()], { days, now, dedupe });
}
