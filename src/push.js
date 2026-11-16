// Web Push sans dépendance : clés VAPID (RFC 8292) + chiffrement aes128gcm (RFC 8291).
// Tout passe par WebCrypto, disponible dans Cloudflare Workers comme dans Node.

const enc = new TextEncoder();

export const b64url = {
  encode(bytes) {
    let s = "";
    for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  decode(str) {
    const s = atob(str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  },
};

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

/** Nouvelle paire de clés VAPID : { publicKey, privateKey } en base64url (format web-push). */
export async function generateVapidKeys() {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return { publicKey: b64url.encode(raw), privateKey: jwk.d };
}

async function vapidHeader(endpoint, vapid, subject) {
  const pub = b64url.decode(vapid.publicKey);
  const key = await crypto.subtle.importKey("jwk", {
    kty: "EC", crv: "P-256", d: vapid.privateKey,
    x: b64url.encode(pub.slice(1, 33)), y: b64url.encode(pub.slice(33, 65)), ext: true,
  }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);

  const header = b64url.encode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url.encode(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject,
  })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${b64url.encode(sig)}, k=${vapid.publicKey}`;
}

/** Chiffre le message pour un abonnement (un seul enregistrement aes128gcm). */
export async function encryptPayload(subscription, text) {
  const uaPublic = b64url.decode(subscription.keys.p256dh);
  const authSecret = b64url.decode(subscription.keys.auth);

  const local = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, local.privateKey, 256));

  const ikm = await hkdf(authSecret, shared, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const plain = concat(enc.encode(text), new Uint8Array([2])); // 0x02 = dernier enregistrement
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, plain));

  const head = new Uint8Array(21 + asPublic.length);
  head.set(salt, 0);
  new DataView(head.buffer).setUint32(16, 4096);
  head[20] = asPublic.length;
  head.set(asPublic, 21);
  return concat(head, cipher);
}

/**
 * Envoie une notification. Renvoie le code HTTP du service push
 * (201 = ok ; 404/410 = abonnement mort, à supprimer).
 */
export async function sendPush(subscription, payload, vapid, subject = "mailto:notifications@miutif.app") {
  const body = await encryptPayload(subscription, JSON.stringify(payload));
  const res = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidHeader(subscription.endpoint, vapid, subject),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "86400",
      Urgency: "high",
    },
    body,
  });
  return res.status;
}
