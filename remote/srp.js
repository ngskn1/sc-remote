// Password sign-in for remote desktop: SRP-6a, a password-authenticated key exchange (PAKE).
//
// Why: with a plain challenge/response, whoever sits on the other end of a sign-in walks away with something
// to test password guesses against on their own computer. With SRP neither end learns anything of the kind:
// a stranger who connects to a PC, or an impostor that took a PC's ID, gets exactly one guess per connection,
// like typing a password at a login screen. Both ends prove that they know the password, and the proofs
// also cover the DTLS fingerprints of the connection, so they can't be relayed through someone in the middle.
//
// The parts (RFC 5054 conventions; group: its 3072-bit one, hash: SHA-256):
//   x  = the key derived from the password (PBKDF2, see host-main.js); the PC stores it, never the password
//   v  = g^x                      the verifier
//   PC:   b random,  B = k*v + g^b                            -> sent in its hello
//   app:  a random,  A = g^a,  u = H(A, B),  S = (B - k*g^x)^(a + u*x)
//         M1 = HMAC(H(S), "client" | A | B | context)         -> sent with A
//   PC:   S = (A * v^u)^b; checks M1;  M2 = HMAC(H(S), "host" | M1 | A | B | context)   -> sent back
//   app:  checks M2 before it sends anything else
// "context" names the connection: the PC's nonce and salt and both DTLS fingerprints.
'use strict';
const crypto = require('crypto');

const GROUP = {            // RFC 5054 appendix A (= RFC 3526 group 15), generator 5
  N: BigInt('0x' +
  'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DD' +
  'EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED' +
  'EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F' +
  '83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B' +
  'E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA0510' +
  '15728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7' +
  'ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864D87602733EC86A64521F2B18177B200C' +
  'BBE117577A615D6C770988C0BAD946E208E24FA074E5AB3143DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF'),
  g: 5n, bytes: 384, hash: 'sha256',
};

function modpow(base, exp, mod) {
  let r = 1n; base %= mod;
  while (exp > 0n) { if (exp & 1n) r = r * base % mod; base = base * base % mod; exp >>= 1n; }
  return r;
}
const pad = (n, G) => Buffer.from(n.toString(16).padStart(G.bytes * 2, '0'), 'hex');
const H = (G, ...bufs) => { const h = crypto.createHash(G.hash); for (const b of bufs) h.update(b); return h.digest(); };
const int = buf => BigInt('0x' + (buf.toString('hex') || '0'));
const kOf = G => int(H(G, pad(G.N, G), pad(G.g, G)));
const uOf = (G, A, B) => int(H(G, pad(A, G), pad(B, G)));
// a public value as it travels: hex, at most the group's size, and not a multiple of N
function parse(hexText, G) {
  if (typeof hexText !== 'string' || !/^[0-9a-f]+$/.test(hexText) || hexText.length > G.bytes * 2) return null;
  const n = BigInt('0x' + hexText);
  return n % G.N === 0n || n >= G.N ? null : n;
}
const hexOf = n => n.toString(16);
const randomExp = () => int(crypto.randomBytes(32));

// the math, with every input given (also what the tests run against the RFC's own numbers)
const verifier = (x, G = GROUP) => modpow(G.g, x, G.N);
const hostPublic = (v, b, G = GROUP) => (kOf(G) * v + modpow(G.g, b, G.N)) % G.N;
const clientPublic = (a, G = GROUP) => modpow(G.g, a, G.N);
function hostSecret(A, B, v, b, G = GROUP) {
  const u = uOf(G, A, B);
  return u === 0n ? null : modpow(A * modpow(v, u, G.N) % G.N, b, G.N);
}
function clientSecret(A, B, x, a, G = GROUP) {
  const u = uOf(G, A, B);
  if (u === 0n) return null;
  const base = ((B - kOf(G) * modpow(G.g, x, G.N)) % G.N + G.N) % G.N;
  return modpow(base, a + u * x, G.N);
}

const context = c => [c.nonce, c.salt, c.hostFp, c.clientFp].join('|');
const contextDigest = c => crypto.createHash('sha256').update(context(c)).digest('hex').slice(0, 12);
function proofs(S, A, B, c, G = GROUP) {
  const K = H(G, pad(S, G));
  const mac = text => crypto.createHmac('sha256', K).update(text).digest('hex');
  const m1 = mac(`SC-Remote sign-in 1, client|${hexOf(A)}|${hexOf(B)}|${context(c)}`);
  return { m1, m2: mac(`SC-Remote sign-in 1, host|${m1}|${hexOf(A)}|${hexOf(B)}|${context(c)}`) };
}

let cached = null;         // the verifier for the stored key (recomputed when the password changes)
function verifierOf(keyHex) {
  if (!cached || cached.key !== keyHex) cached = { key: keyHex, v: verifier(BigInt('0x' + keyHex)) };
  return cached.v;
}

// PC, when a connection opens: its half of the exchange. Keep "b" (secret) until the answer comes.
function hostStart(keyHex) {
  const b = randomExp();
  return { b, B: hexOf(hostPublic(verifierOf(keyHex), b)) };
}
// PC, on the app's answer: null = wrong password (or nonsense); otherwise the proof to send back
function hostFinish(keyHex, b, Bhex, Ahex, m1, c) {
  const A = parse(Ahex, GROUP), B = parse(Bhex, GROUP);
  if (!A || !B || typeof m1 !== 'string' || !/^[0-9a-f]{64}$/.test(m1)) return null;
  const S = hostSecret(A, B, verifierOf(keyHex), b);
  if (S == null) return null;
  const p = proofs(S, A, B, c);
  return crypto.timingSafeEqual(Buffer.from(p.m1, 'hex'), Buffer.from(m1, 'hex')) ? p.m2 : null;
}
// App: answer the PC's half. key: the 32-byte key derived from the typed password and the PC's salt.
// Returns what to send (A, m1) and what the PC must answer (m2); null if the PC's half is nonsense.
function clientAnswer(key, Bhex, c) {
  const B = parse(Bhex, GROUP);
  if (!B) return null;
  const a = randomExp(), A = clientPublic(a);
  const S = clientSecret(A, B, int(key), a);
  if (S == null) return null;
  const p = proofs(S, A, B, c);
  return { A: hexOf(A), m1: p.m1, m2: p.m2 };
}

module.exports = { GROUP, hostStart, hostFinish, clientAnswer, contextDigest,
                   math: { modpow, verifier, hostPublic, clientPublic, hostSecret, clientSecret, kOf, uOf, int, pad } };
