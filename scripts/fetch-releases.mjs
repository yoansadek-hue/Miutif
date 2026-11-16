// Robot (GitHub Actions) : récupère chez Apple les sorties récentes de tous les artistes suivis
// et les écrit dans un fichier JSON que le serveur Miutif lit pour les notifs de 11 h.
// Lancer : node scripts/fetch-releases.mjs [fichier de sortie]
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { recentReleases } from "../public/music.js";

const API = process.env.MIUTIF_URL || "https://miutif.miutif.workers.dev";
const out = process.argv[2] || "out/releases.json";

async function withRetry(fn, tries = 4) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= tries) throw e;
      console.warn(`Essai ${i} raté (${e.message}), nouvel essai…`);
      await new Promise((r) => setTimeout(r, 5000 * i));
    }
  }
}

const res = await withRetry(async () => {
  const r = await fetch(`${API}/api/artists`);
  if (!r.ok) throw new Error(`Miutif ne répond pas (${r.status})`);
  return r.json();
});

const byCountry = {};
let total = 0;
for (const [country, ids] of Object.entries(res.countries || {})) {
  byCountry[country] = await withRetry(() => recentReleases(ids, { country, days: 14, dedupe: false }));
  total += byCountry[country].length;
  console.log(`${country} : ${ids.length} artistes → ${byCountry[country].length} sorties`);
}

await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, JSON.stringify({ updated: new Date().toISOString(), byCountry }));
console.log(`${total} sorties écrites dans ${out}`);
