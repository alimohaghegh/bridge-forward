/* Cloudflare Worker: relay from Telegram Serverless to EitaaYar.
   Telegram's servers cannot connect to Eitaa, Cloudflare's can. Only
   requests signed by the bot (ECDSA P-256 over "<unix time>\n<path>",
   private key in the bot's config) are forwarded, only to
   https://eitaayar.ir/api/<token>/<method>, and nothing is stored or
   logged. The key below is the PUBLIC half: not a secret.
   /ping (no signature) only reports whether eitaayar.ir answers.
   Written without line comments or reliance on ASI, so it can be pasted
   as one line into the dashboard editor. */
const PUBLIC_KEY = { kty: "EC", crv: "P-256", x: "-O0cbo356NG05SNUSc5BSO2j1QkzzByS9iCV6912R6o", y: "5j57cIiwCSP7f5KEt_v1THLQkqQH_sju2Hg0HIpC1ds" };
const ORIGIN = "https://eitaayar.ir";
const MAX_SKEW_SECONDS = 300;
const PATH = /^\/api\/[A-Za-z0-9:_-]+\/[A-Za-z]+$/;

function reply(status, body) {
  return new Response(JSON.stringify(body), { status: status, headers: { "content-type": "application/json" } });
}

function fromB64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

let keyPromise = null;

async function verified(request, path) {
  const ts = Number(request.headers.get("x-relay-ts"));
  const sig = request.headers.get("x-relay-sig");
  if (!ts || !sig || Math.abs(Date.now() / 1000 - ts) > MAX_SKEW_SECONDS) return false;
  if (!keyPromise) keyPromise = crypto.subtle.importKey("jwk", PUBLIC_KEY, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  try {
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, await keyPromise, fromB64(sig), new TextEncoder().encode(ts + "\n" + path));
  } catch (e) {
    return false;
  }
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/ping") {
      const t = Date.now();
      try {
        const r = await fetch(ORIGIN + "/", { method: "GET" });
        return reply(200, { ok: true, eitaayar: r.status, ms: Date.now() - t });
      } catch (e) {
        return reply(200, { ok: false, error: String(e && e.message).slice(0, 120), ms: Date.now() - t });
      }
    }
    if (request.method !== "POST" || !PATH.test(url.pathname)) return reply(404, { ok: false, description: "not found" });
    if (!(await verified(request, url.pathname))) return reply(403, { ok: false, description: "relay: bad signature" });
    const headers = new Headers();
    const type = request.headers.get("content-type");
    if (type) headers.set("content-type", type);
    let r;
    try {
      r = await fetch(ORIGIN + url.pathname, { method: "POST", headers: headers, body: request.body });
    } catch (e) {
      return reply(502, { ok: false, description: "relay: eitaayar unreachable" });
    }
    return new Response(r.body, { status: r.status, headers: { "content-type": r.headers.get("content-type") || "application/json" } });
  }
};
