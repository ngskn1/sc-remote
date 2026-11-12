// Shared by the remote host engine and the remote session window.
'use strict';
const REMOTE_PREFIX = 'rdesk-';          // remote-desktop peers live in their own namespace on the signaling server
const PBKDF2_ROUNDS = 150000;            // must match remote/host-main.js
const CHUNK = 256 * 1024;

function peerOptions() {
  const opts = {
    debug: +(new URLSearchParams(location.search).get('debug') || 1),
    config: { iceServers: [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
      { urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'], username: 'peerjs', credential: 'peerjsp' },
    ] },
  };
  // a lab can name its own connection server and relay (set by the page from the lab policy)
  const net = window.__net || {};
  if (net.server && net.server.host) {
    Object.assign(opts, { host: net.server.host, port: +net.server.port || (net.server.secure === false ? 80 : 443),
                          path: net.server.path || '/', secure: net.server.secure !== false, ...(net.server.key ? { key: net.server.key } : {}) });
  } else {
    const s = new URLSearchParams(location.search).get('server');
    if (s) { const [host, port] = s.split(':'); Object.assign(opts, { host, port: +port || 9000, path: '/', secure: false }); }
  }
  if (net.turn && net.turn.urls) {
    const urls = String(net.turn.urls).split(/[\s,]+/).filter(Boolean);
    opts.config.iceServers = [opts.config.iceServers[0], { urls, username: net.turn.username || '', credential: net.turn.credential || '' }];
  }
  return opts;
}

// The DTLS certificate fingerprints of a connection, [this side, other side]. Lab sign-ins sign them,
// which ties the sign-in to this exact encrypted connection.
function dtlsFingerprints(conn) {
  const pc = conn && conn.peerConnection;
  const fp = d => { const m = d && d.sdp && d.sdp.match(/a=fingerprint:(\S+) (\S+)/); return m ? m[1].toLowerCase() + ' ' + m[2].toUpperCase() : ''; };
  return [fp(pc && pc.localDescription), fp(pc && pc.remoteDescription)];
}

// Member side of a lab sign-in: check the PC's identity, then sign in with my key (and hand over a newer policy).
async function labSignIn(conn, hello, creds, purpose, extra = {}) {
  const R = window.remoteApp;
  const [mine, theirs] = dtlsFingerprints(conn);
  if (!mine || !theirs) return { ok: false, reason: 'Could not read the connection\'s security details.' };
  const check = await R.labCheckHost(creds.labId, creds.pc, hello, theirs, mine);
  if (!check.ok) return check;
  const a = await R.labSignAuth(creds.labId, creds.pc, hello.nonce, theirs, mine, purpose);
  const have = await R.labVersion(creds.labId);
  const msg = { t: 'auth', mode: 'lab', pub: a.pub, sig: a.sig, purpose, name: creds.me, have, ...extra };
  if (have > (hello.version || 0)) msg.policy = await R.labSignedPolicy(creds.labId);
  conn.send(msg);
  return { ok: true, fp: check.fp };
}

const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const unhex = h => new Uint8Array(h.match(/../g).map(x => parseInt(x, 16)));
const randomHex = n => hex(crypto.getRandomValues(new Uint8Array(n)));

// Client side of the password check: derive the same key the host stored, then sign the host's nonce.
// bound: also sign both ends' DTLS fingerprints ("nonce|host|client"), tying the check to this encrypted connection
async function signNonce(password, saltHex, nonceHex, bound = null) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unhex(saltHex), iterations: PBKDF2_ROUNDS }, base, 256);
  const key = await crypto.subtle.importKey('raw', bits, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const data = bound ? new TextEncoder().encode(`${nonceHex}|${bound.hostFp}|${bound.clientFp}`) : unhex(nonceHex);
  return hex(await crypto.subtle.sign('HMAC', key, data));
}

// Prefer a codec and ask Chrome to start at a sensible bitrate (it otherwise ramps up slowly).
function remoteSdp(sdp, codec, kbps) {
  const lines = sdp.split('\r\n');
  const m = lines.findIndex(l => l.startsWith('m=video'));
  if (m < 0) return sdp;
  let end = lines.findIndex((l, i) => i > m && l.startsWith('m=')); if (end < 0) end = lines.length;
  const pt2name = {};
  lines.slice(m, end).forEach(l => { const r = l.match(/^a=rtpmap:(\d+) ([\w-]+)\//); if (r) pt2name[r[1]] = r[2].toUpperCase(); });
  const parts = lines[m].split(' '); let pts = parts.slice(3);
  const want = pts.filter(p => pt2name[p] === codec);
  if (want.length) { pts = [...want, ...pts.filter(p => !want.includes(p))]; lines[m] = [...parts.slice(0, 3), ...pts].join(' '); }
  const start = Math.round(kbps * 0.6), min = Math.min(800, Math.round(kbps * 0.2));
  for (let i = m; i < end; i++) {
    const r = lines[i].match(/^a=fmtp:(\d+) (.*)$/);
    if (r && ['H264', 'VP8', 'VP9', 'AV1'].includes(pt2name[r[1]]) && !r[2].includes('x-google-')) lines[i] += `;x-google-start-bitrate=${start};x-google-min-bitrate=${min}`;
  }
  for (const [pt, name] of Object.entries(pt2name)) {
    if (name === 'VP8' && !lines.slice(m, end).some(l => l.startsWith(`a=fmtp:${pt} `))) {
      const at = lines.findIndex((l, i) => i > m && i < end && l.startsWith(`a=rtpmap:${pt} `));
      lines.splice(at + 1, 0, `a=fmtp:${pt} x-google-start-bitrate=${start};x-google-min-bitrate=${min}`); end++;
    }
  }
  return lines.join('\r\n');
}

const toBytes = d => d instanceof Uint8Array ? d : d instanceof ArrayBuffer ? new Uint8Array(d) : ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : new Uint8Array(0);

// Wait while a data channel has a lot queued, so file transfers never starve the input channel.
async function drain(conn, limit = 4 * 1024 * 1024) {
  const dc = conn.dataChannel;
  while (conn.open && dc && (dc.bufferedAmount > limit || (conn.bufferSize || 0) > 64)) await new Promise(r => setTimeout(r, 15));
}

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB']; let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return (n >= 100 ? n.toFixed(0) : n.toFixed(1)) + ' ' + u[i];
}
