// Catalogue Apple Music via l'API publique iTunes (gratuite, sans clé).
// Les identifiants d'artistes sont les mêmes que ceux d'Apple Music.

const ITUNES = "https://itunes.apple.com";

async function getJSON(url, cacheSeconds) {
  const res = await fetch(url, { cf: { cacheTtl: cacheSeconds, cacheEverything: true } });
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
  const json = await getJSON(url, 3600);
  return (json.results || []).map((a) => ({
    id: String(a.artistId),
    name: a.artistName,
    genre: a.primaryGenreName || "",
  }));
}

function toRelease(c, followedId) {
  const name = c.collectionName || "";
  const kind = / - Single$/.test(name) ? "Single" : / - EP$/.test(name) ? "EP" : "Album";
  return {
    id: String(c.collectionId),
    title: name.replace(/ - (Single|EP)$/, ""),
    artist: c.artistName,
    artistId: followedId,
    kind,
    date: c.releaseDate, // ISO, ex. 2026-11-14T08:00:00Z
    url: c.collectionViewUrl.replace(/\?uo=\d+$/, ""),
    artwork: (c.artworkUrl100 || "").replace(/\/\d+x\d+bb\./, "/600x600bb."),
  };
}

/** Sorties récentes (déjà sorties, moins de `days` jours) des artistes suivis. */
export async function recentReleases(artistIds, { country = "fr", days = 30, now = Date.now() } = {}) {
  const found = new Map();
  for (const ids of chunks([...new Set(artistIds)], 40)) {
    // sort=recent est indispensable (sinon Apple trie par popularité) mais approximatif :
    // on prend 15 sorties par artiste et on trie nous-mêmes.
    const url = `${ITUNES}/lookup?id=${ids.join(",")}&entity=album&sort=recent&limit=15&country=${country}`;
    const json = await getJSON(url, 1800);
    let current = null;
    for (const r of json.results || []) {
      if (r.wrapperType === "artist") { current = String(r.artistId); continue; }
      if (r.wrapperType !== "collection" || !r.collectionViewUrl || !r.releaseDate) continue;
      const t = Date.parse(r.releaseDate);
      if (t > now || now - t > days * 86400000) continue;
      const rel = toRelease(r, current);
      if (!found.has(rel.id)) found.set(rel.id, rel);
    }
  }
  // Apple publie parfois la même sortie sous deux fiches : on garde la plus récente.
  const seen = new Set();
  return [...found.values()]
    .sort((a, b) => b.date.localeCompare(a.date))
    .filter((r) => {
      const key = `${r.artist}|${r.title}`.toLowerCase();
      return !seen.has(key) && seen.add(key);
    });
}
