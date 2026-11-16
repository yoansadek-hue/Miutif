// Vérifie src/push.js contre la bibliothèque de référence http_ece (utilisée par web-push).
// Lancer : node test/push.test.mjs <dossier node_modules contenant http_ece>
import { createRequire } from "node:module";
import { createECDH, randomBytes, createPublicKey, verify } from "node:crypto";
import path from "node:path";
import { encryptPayload, generateVapidKeys, b64url, sendPush } from "../src/push.js";

const require = createRequire(path.resolve(process.argv[2] || "node_modules", "x.js"));
const ece = require("http_ece");

let failed = 0;
const check = (ok, label) => { console.log(`${ok ? "OK  " : "FAIL"} ${label}`); if (!ok) failed++; };

// 1. Le navigateur (simulé) crée son abonnement
const browser = createECDH("prime256v1");
browser.generateKeys();
const auth = randomBytes(16);
const sub = {
  endpoint: "https://web.push.apple.com/QGv-test",
  keys: { p256dh: b64url.encode(browser.getPublicKey()), auth: b64url.encode(auth) },
};

// 2. Chiffrement par notre code, déchiffrement par http_ece
const message = JSON.stringify({ title: "Nouveau single de Aya Nakamura", body: "« Test » est sorti 🎵", url: "https://music.apple.com/fr/album/x/1" });
const cipher = await encryptPayload(sub, message);
const plain = ece.decrypt(Buffer.from(cipher), { version: "aes128gcm", privateKey: browser, authSecret: auth });
check(plain.toString("utf8") === message, "le message chiffré est relu à l'identique par http_ece");

// 3. Clés VAPID + signature JWT vérifiable
const vapid = await generateVapidKeys();
check(b64url.decode(vapid.publicKey).length === 65 && b64url.decode(vapid.privateKey).length === 32, "clés VAPID au bon format");

let captured;
globalThis.fetch = async (url, init) => { captured = { url, init }; return new Response(null, { status: 201 }); };
const status = await sendPush(sub, { title: "t" }, vapid);
check(status === 201, "sendPush renvoie le code du service push");
const authz = captured.init.headers.Authorization;
const [, jwt, k] = authz.match(/^vapid t=([^,]+), k=(.+)$/) || [];
check(k === vapid.publicKey, "l'en-tête contient la clé publique");
const [h, c, s] = jwt.split(".");
const claims = JSON.parse(Buffer.from(b64url.decode(c)).toString());
check(claims.aud === "https://web.push.apple.com" && claims.exp > Date.now() / 1000, "le JWT vise le bon service et n'est pas expiré");
const pub = b64url.decode(vapid.publicKey);
const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64url.encode(pub.slice(1, 33)), y: b64url.encode(pub.slice(33)) }, format: "jwk" });
const sigOk = verify("sha256", Buffer.from(`${h}.${c}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(b64url.decode(s)));
check(sigOk, "la signature ES256 du JWT est valide");
check(captured.init.headers["Content-Encoding"] === "aes128gcm", "en-tête Content-Encoding correct");

console.log(failed ? `\n${failed} échec(s)` : "\nTout est bon.");
process.exit(failed ? 1 : 0);
