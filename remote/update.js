// SC-Remote updates: each GitHub release carries "sc-remote-update.json", a small manifest (version, installer
// address, SHA-256) signed with the release key (RSA-SHA256). The app and the Windows service only trust a
// manifest whose signature matches the public key built into them, so a release can't be faked by anyone who
// doesn't hold the key (kept as a GitHub Actions secret).
'use strict';
const crypto = require('crypto');

const MANIFEST_NAME = 'sc-remote-update.json';

// 1.10.0 > 1.9.3
function cmpVersion(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0), pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d > 0 ? 1 : -1; }
  return 0;
}

// { manifest: "<JSON text>", sig: "<base64>" } → the manifest object, or an exception
function verifyManifest(doc, publicKeyPem) {
  if (!doc || typeof doc.manifest !== 'string' || typeof doc.sig !== 'string') throw new Error('not an update manifest');
  const ok = crypto.verify('sha256', Buffer.from(doc.manifest, 'utf8'), publicKeyPem, Buffer.from(doc.sig, 'base64'));
  if (!ok) throw new Error('the update manifest is not signed with the release key');
  const m = JSON.parse(doc.manifest);
  if (!m || typeof m.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(m.version) || typeof m.url !== 'string' || !/^[0-9a-f]{64}$/.test(m.sha256 || '')) throw new Error('incomplete update manifest');
  return m;
}

function signManifest(manifest, privateKeyPem) {
  // (plain ASCII, so the signed text reads the same however a downloader decodes it)
  const text = JSON.stringify(manifest).replace(/[\u007f-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  return { manifest: text, sig: crypto.sign('sha256', Buffer.from(text, 'utf8'), privateKeyPem).toString('base64') };
}

// The download for this system. The manifest's own url/sha256/size are the Windows installer (what the Windows
// service and SC-Remote 1.3–1.4 read); other systems are under "platforms" (from 1.5): { linux: {…}, darwin: {…} }.
// Only addresses inside this repository's releases count.
function platformAsset(m, platform, allowedPrefix) {
  const a = platform === 'win32' ? m : m.platforms && m.platforms[platform];
  if (!a || typeof a.url !== 'string' || !/^[0-9a-f]{64}$/.test(a.sha256 || '')) return null;
  if (allowedPrefix && !a.url.startsWith(allowedPrefix)) return null;
  return { url: a.url, sha256: a.sha256, size: Number(a.size) || 0, file: a.file || '' };
}

// The public key as the Windows service reads it (RSA modulus and exponent, base64)
function publicKeyParts(publicKeyPem) {
  const jwk = crypto.createPublicKey(publicKeyPem).export({ format: 'jwk' });
  const b64 = s => Buffer.from(s, 'base64url').toString('base64');
  return { n: b64(jwk.n), e: b64(jwk.e) };
}

module.exports = { MANIFEST_NAME, cmpVersion, verifyManifest, signManifest, publicKeyParts, platformAsset };
