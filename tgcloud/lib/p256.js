// ECDSA P-256 / SHA-256 signing in plain JavaScript (BigInt), for the Eitaa
// relay. The platform's WebCrypto imports only "raw" keys, so it can't load
// an EC private key; SHA-256 and random numbers still come from WebCrypto.
// Signatures are r||s (32 bytes each), the format WebCrypto verifies.

const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const GX = 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n;
const GY = 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n;

const mod = (a, m) => ((a % m) + m) % m;

function inv(a, m) {
  let [r0, r1] = [mod(a, m), m];
  let [s0, s1] = [1n, 0n];
  while (r1 !== 0n) {
    const q = r0 / r1;
    [r0, r1] = [r1, r0 - q * r1];
    [s0, s1] = [s1, s0 - q * s1];
  }
  return mod(s0, m);
}

// Jacobian coordinates [X, Y, Z]; Z = 0 is the point at infinity.
function double([x, y, z]) {
  if (z === 0n || y === 0n) return [0n, 1n, 0n];
  const yy = mod(y * y, P);
  const s = mod(4n * x * yy, P);
  const zz = mod(z * z, P);
  const m = mod(3n * (x - zz) * (x + zz), P); // a = -3
  const x3 = mod(m * m - 2n * s, P);
  const y3 = mod(m * (s - x3) - 8n * yy * yy, P);
  const z3 = mod(2n * y * z, P);
  return [x3, y3, z3];
}

function add(p1, p2) {
  if (p1[2] === 0n) return p2;
  if (p2[2] === 0n) return p1;
  const [x1, y1, z1] = p1;
  const [x2, y2, z2] = p2;
  const z1z1 = mod(z1 * z1, P);
  const z2z2 = mod(z2 * z2, P);
  const u1 = mod(x1 * z2z2, P);
  const u2 = mod(x2 * z1z1, P);
  const s1 = mod(y1 * z2 * z2z2, P);
  const s2 = mod(y2 * z1 * z1z1, P);
  if (u1 === u2) return s1 === s2 ? double(p1) : [0n, 1n, 0n];
  const h = mod(u2 - u1, P);
  const r = mod(s2 - s1, P);
  const hh = mod(h * h, P);
  const hhh = mod(h * hh, P);
  const v = mod(u1 * hh, P);
  const x3 = mod(r * r - hhh - 2n * v, P);
  const y3 = mod(r * (v - x3) - s1 * hhh, P);
  const z3 = mod(h * z1 * z2, P);
  return [x3, y3, z3];
}

function multiplyG(k) {
  let result = [0n, 1n, 0n];
  let point = [GX, GY, 1n];
  while (k > 0n) {
    if (k & 1n) result = add(result, point);
    point = double(point);
    k >>= 1n;
  }
  return result;
}

function toBig(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}

function toBytes32(n) {
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

// The 32-byte private scalar inside a PKCS#8 EC key (ECPrivateKey:
// version 1, then OCTET STRING of 32 bytes), or null.
export function privateScalarFromPkcs8(der) {
  for (let i = 0; i + 37 <= der.length; i++) {
    if (der[i] === 0x02 && der[i + 1] === 0x01 && der[i + 2] === 0x01 && der[i + 3] === 0x04 && der[i + 4] === 0x20) {
      const d = toBig(der.subarray(i + 5, i + 37));
      return d > 0n && d < N ? d : null;
    }
  }
  return null;
}

// Signs `message` (bytes) with private scalar `d`. Returns 64 bytes (r||s).
export async function signP256(d, message) {
  const c = globalThis.crypto;
  const e = mod(toBig(new Uint8Array(await c.subtle.digest('SHA-256', message))), N);
  for (;;) {
    const kb = new Uint8Array(32);
    c.getRandomValues(kb);
    const k = toBig(kb);
    if (k === 0n || k >= N) continue;
    const [x, , z] = multiplyG(k);
    if (z === 0n) continue;
    const zi = inv(z, P);
    const r = mod(x * zi * zi, P) % N;
    if (r === 0n) continue;
    const s = mod(inv(k, N) * (e + r * d), N);
    if (s === 0n) continue;
    const out = new Uint8Array(64);
    out.set(toBytes32(r), 0);
    out.set(toBytes32(s), 32);
    return out;
  }
}
