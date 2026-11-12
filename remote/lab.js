// Lab edition security: personal keys, the signed lab policy, lab PC identities and the audit log.
//
//  - Every member's app has its own Ed25519 key pair. The private half never leaves that PC (encrypted with the
//    system keychain where available). Members give their *public* "access key" to a lab admin.
//  - The lab policy lists the members (name, public key, role), the lab PCs and the lab settings. It is signed by
//    an admin and versioned; a PC or app only accepts a newer version signed by an admin of the version it has.
//    So nobody can grant themselves access, and removing someone can't be undone by an old copy.
//  - Every lab PC has its own key pair. Members' apps remember it on first connection and refuse a PC whose key
//    changes (protects against someone impersonating a lab PC).
//  - Sign-in signatures include both ends' DTLS certificate fingerprints, so they're bound to the encrypted
//    connection itself: a man in the middle (e.g. a hostile connection server) can't relay them.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROTO = 'SSR1';
const b64u = buf => Buffer.from(buf).toString('base64url');
const unb64u = s => Buffer.from(String(s), 'base64url');

/* ---------------- keys ---------------- */
function newKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' });
  return { pub: jwk.x, priv: jwk.d };          // both base64url, 32 bytes each
}
const pubKeyObj = pub => crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: pub }, format: 'jwk' });
const privKeyObj = (pub, priv) => crypto.createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', x: pub, d: priv }, format: 'jwk' });
const validPub = k => typeof k === 'string' && /^[A-Za-z0-9_-]{43}$/.test(k) && unb64u(k).length === 32;
function sign(kp, text) { return b64u(crypto.sign(null, Buffer.from(text), privKeyObj(kp.pub, kp.priv))); }
function verify(pub, text, sig) {
  try { return validPub(pub) && crypto.verify(null, Buffer.from(text), pubKeyObj(pub), unb64u(sig)); } catch { return false; }
}
// short, readable fingerprint to compare keys by eye or over the phone, e.g. "K7QF-2XMA-PL9D"
function fingerprint(pub) {
  const h = crypto.createHash('sha256').update(unb64u(pub)).digest();
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 12; i++) s += A[h[i] % 32];
  return s.match(/.{4}/g).join('-');
}
// what members copy and send to the admin
const ACCESS_PREFIX = 'SSK1-';
function parseAccessKey(text) {
  const m = String(text || '').trim().match(/SSK1-([A-Za-z0-9_-]{43})/);
  if (!m || !validPub(m[1])) throw new Error('That is not a ScreenShare access key (it starts with SSK1-)');
  return m[1];
}

const slug = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'pc';
const peerIdFor = (labId, pcName) => `rlab-${labId}-${slug(pcName)}`;

/* ---------------- policy ---------------- */
// signed policy = { body: "<json text>", by: "<admin public key>", sig: "<signature of body>" }
function readPolicy(sp) {
  if (!sp || typeof sp.body !== 'string' || !validPub(sp.by) || !verify(sp.by, sp.body, sp.sig)) throw new Error('the lab file is damaged or its signature is invalid');
  const p = JSON.parse(sp.body);
  if (p.type !== 'screenshare-lab' || !/^[a-z0-9]{6,16}$/.test(p.labId) || !Number.isInteger(p.version) || !Array.isArray(p.members))
    throw new Error('not a ScreenShare lab policy');
  for (const m of p.members) if (!validPub(m.key) || !['admin', 'member'].includes(m.role)) throw new Error('bad member entry');
  if (!p.members.some(m => m.role === 'admin')) throw new Error('a lab needs at least one admin');
  return p;
}
const isAdmin = (p, key) => p.members.some(m => m.key === key && m.role === 'admin');
// May `next` replace `current`? Same lab, newer, signed by an admin of the current version.
function checkUpdate(current, next) {
  const cur = current ? readPolicy(current) : null;
  const nxt = readPolicy(next);
  if (!cur) return nxt;
  if (nxt.labId !== cur.labId) throw new Error('that update is for a different lab');
  if (nxt.version <= cur.version) throw new Error(`not newer (version ${nxt.version}, have ${cur.version})`);
  if (!isAdmin(cur, next.by)) throw new Error('signed by someone who is not an admin of this lab');
  return nxt;
}
function makePolicy(fields, kp) {
  const body = JSON.stringify({ type: 'screenshare-lab', ...fields, issued: new Date().toISOString() });
  return { body, by: kp.pub, sig: sign(kp, body) };
}
const DEFAULT_SETTINGS = { banner: true, localEnd: true, consent: 'never', clipboard: true, files: true, server: null, turn: null };
const settingsOf = p => ({ ...DEFAULT_SETTINGS, ...(p && p.settings || {}) });

// channel binding: the signed text includes both DTLS fingerprints and the purpose
const helloText = (labId, pc, nonce, hostFp, clientFp) => [PROTO, 'hello', labId, slug(pc), nonce, hostFp, clientFp].join('|');
const authText = (labId, pc, nonce, hostFp, clientFp, purpose) => [PROTO, 'auth', labId, slug(pc), nonce, hostFp, clientFp, purpose].join('|');

/* ---------------- storage helpers ---------------- */
function readJson(f, dflt) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } }
function writeJson(f, obj, secret = false) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), secret ? { mode: 0o600 } : undefined);
  fs.renameSync(tmp, f);
}

/* =====================================================================
   Host side (a lab PC): its identity, its copy of the policy, checks, audit log
   ===================================================================== */
function labHost({ dataDir, log = () => {} }) {
  const file = path.join(dataDir, 'lab-host.json');
  const importFile = path.join(dataDir, 'lab-setup.json');      // dropped here by the installer
  const auditFile = path.join(dataDir, 'audit.log');
  let state = readJson(file, {});
  const pcName = () => process.env.SCREENSHARE_PC_NAME || os.hostname();

  if (!state.key) { state.key = newKeyPair(); writeJson(file, state, true); log('lab: created this PC\'s identity key'); }

  function save() { writeJson(file, state, true); }
  // the installer leaves a setup file; take it on start (the installer only runs with admin rights)
  function importPending() {
    if (!fs.existsSync(importFile)) return;
    try {
      const setup = readJson(importFile, null);
      const sp = setup && setup.policy;
      const p = readPolicy(sp);
      const cur = state.policy ? readPolicy(state.policy) : null;
      if (!cur || cur.labId !== p.labId || p.version >= cur.version) {
        state.policy = sp; save();
        log(`lab: joined "${p.lab}" (policy version ${p.version}) from the setup file`);
        audit('setup', { lab: p.lab, version: p.version });
      }
    } catch (e) { log('lab: setup file rejected: ' + e.message); }
    try { fs.rmSync(importFile, { force: true }); } catch {}
  }
  importPending();

  const policy = () => (state.policy ? readPolicy(state.policy) : null);
  function adopt(sp, from) {
    const p = checkUpdate(state.policy, sp);
    state.policy = sp; save();
    log(`lab: policy updated to version ${p.version} (delivered by ${from})`);
    audit('policy', { version: p.version, by: fingerprint(sp.by), deliveredBy: from });
    return p;
  }
  function audit(event, detail = {}) {
    try {
      if (fs.existsSync(auditFile) && fs.statSync(auditFile).size > 2 * 1024 * 1024) fs.renameSync(auditFile, auditFile + '.old');
      fs.appendFileSync(auditFile, JSON.stringify({ t: new Date().toISOString(), pc: pcName(), event, ...detail }) + '\n');
    } catch {}
  }
  function auditTail(n = 300) {
    try { return fs.readFileSync(auditFile, 'utf8').trim().split('\n').slice(-n).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
    catch { return []; }
  }
  return {
    ready: () => !!state.policy,
    pcName,
    hostPub: () => state.key.pub,
    config() {
      const p = policy();
      return p ? { labId: p.labId, lab: p.lab, version: p.version, pc: pcName(), peerId: peerIdFor(p.labId, pcName()),
                   hostKey: state.key.pub, settings: settingsOf(p) } : null;
    },
    signHello(nonce, hostFp, clientFp) {
      const p = policy();
      return sign(state.key, helloText(p.labId, pcName(), nonce, hostFp, clientFp));
    },
    // sign-in check for someone who wants to connect; may first adopt a newer policy they brought along
    verifyMember({ pub, sig, nonce, hostFp, clientFp, purpose, policy: offered, name }) {
      let note = '';
      if (offered) { try { adopt(offered, name || fingerprint(pub)); note = 'policy updated'; } catch (e) { note = e.message; } }
      const p = policy();
      if (!p) return { ok: false, reason: 'This PC has not been set up for a lab yet' };
      const m = p.members.find(x => x.key === pub);
      if (!m) { audit('denied', { key: fingerprint(pub || ''), name, reason: 'not a member' }); return { ok: false, reason: `You are not a member of "${p.lab}" (or your access was removed).` }; }
      if (!verify(pub, authText(p.labId, pcName(), nonce, hostFp, clientFp, purpose), sig)) {
        audit('denied', { member: m.name, reason: 'bad signature' });
        return { ok: false, reason: 'Sign-in check failed (the connection may have been tampered with).' };
      }
      return { ok: true, member: { name: m.name, role: m.role, fp: fingerprint(pub) }, version: p.version, note };
    },
    signedPolicy: () => state.policy,
    version: () => (policy() ? policy().version : 0),
    importPending,
    // is the person with this key fingerprint still a member (and with which role)? used after a policy change
    memberByFp: fp => { const p = policy(); const m = p && p.members.find(x => fingerprint(x.key) === fp); return m ? { name: m.name, role: m.role, fp } : null; },
    settings: () => settingsOf(policy()),
    audit, auditTail,
  };
}

/* =====================================================================
   Client side (a member's app): my key, the labs I belong to, pinned PC identities, admin tools
   ===================================================================== */
function labClient({ userDir, safeStorage, log = () => {} }) {
  const file = path.join(userDir, 'lab-client.json');
  let state = readJson(file, { labs: {} });
  const enc = s => safeStorage && safeStorage.isEncryptionAvailable() ? 'enc:' + safeStorage.encryptString(s).toString('base64') : 'raw:' + s;
  const dec = s => s.startsWith('enc:') ? safeStorage.decryptString(Buffer.from(s.slice(4), 'base64')) : s.slice(4);
  if (!state.me) {
    const kp = newKeyPair();
    state.me = { name: os.userInfo().username, pub: kp.pub, priv: enc(kp.priv) };
    writeJson(file, state, true);
    log('lab: created my personal access key');
  }
  const save = () => writeJson(file, state, true);
  const myKey = () => ({ pub: state.me.pub, priv: dec(state.me.priv) });

  function labView(labId) {
    const l = state.labs[labId]; if (!l) return null;
    const p = readPolicy(l.policy);
    const me = p.members.find(m => m.key === state.me.pub);
    return { labId, lab: p.lab, version: p.version, issued: p.issued, pcs: p.pcs || [], settings: settingsOf(p),
             myRole: me ? me.role : null, signedBy: fingerprint(l.policy.by),
             members: p.members.map(m => ({ name: m.name, role: m.role, key: m.key, fp: fingerprint(m.key), me: m.key === state.me.pub })),
             publish: l.publish || {}, prevNet: l.prevNet || null,
             saved: l.saved || [], recent: l.recent || [] };
  }
  function store(sp, { genesis = false } = {}) {
    const p = readPolicy(sp);
    const cur = state.labs[p.labId];
    if (cur) checkUpdate(cur.policy, sp);
    else if (!genesis) throw new Error('unknown lab');
    state.labs[p.labId] = { ...(cur || { pins: {} }), policy: sp };
    save();
    return p;
  }
  return {
    me: () => ({ name: state.me.name, accessKey: ACCESS_PREFIX + state.me.pub, fp: fingerprint(state.me.pub) }),
    setName(n) { state.me.name = String(n || '').trim().slice(0, 40) || state.me.name; save(); return this.me(); },
    labs: () => Object.keys(state.labs).map(labView),
    lab: labView,
    // a setup file from an admin (or exported by me)
    importSetup(text) {
      const setup = typeof text === 'string' ? JSON.parse(text) : text;
      if (!setup || setup.type !== 'screenshare-lab-setup' || !setup.policy) throw new Error('not a ScreenShare lab setup file');
      const p = readPolicy(setup.policy);
      const cur = state.labs[p.labId];
      if (cur) {
        const have = readPolicy(cur.policy);
        if (p.version > have.version) checkUpdate(cur.policy, setup.policy);
        else return labView(p.labId);              // already have this or newer
      }
      store(setup.policy, { genesis: true });
      return labView(p.labId);
    },
    exportSetup(labId) {
      const l = state.labs[labId]; if (!l) throw new Error('unknown lab');
      return JSON.stringify({ type: 'screenshare-lab-setup', note: 'Give this file to the ScreenShare Remote installer on lab PCs, and to members to import.', policy: l.policy }, null, 2);
    },
    signedPolicy: labId => (state.labs[labId] ? state.labs[labId].policy : null),
    version: labId => (state.labs[labId] ? readPolicy(state.labs[labId].policy).version : 0),
    // a newer policy received from a lab PC
    offer(labId, sp) {
      try { const p = store(sp); log(`lab: received policy version ${p.version}`); return true; }
      catch (e) { return false; }
    },
    forget(labId) { delete state.labs[labId]; save(); },
    // connection details for a lab PC
    target(labId, pc) {
      const v = labView(labId); if (!v) throw new Error('unknown lab');
      return { mode: 'lab', labId, lab: v.lab, pc, peerId: peerIdFor(labId, pc), name: pc, settings: v.settings };
    },
    signAuth(labId, pc, nonce, hostFp, clientFp, purpose) { return { pub: state.me.pub, sig: sign(myKey(), authText(labId, pc, nonce, hostFp, clientFp, purpose)) }; },
    // check a lab PC's hello and its identity (remembered on first use)
    checkHost(labId, pc, hello, hostFp, clientFp) {
      if (!verify(hello.hostKey, helloText(labId, pc, hello.nonce, hostFp, clientFp), hello.sig)) return { ok: false, reason: 'The PC\'s answer failed the security check (possible tampering).' };
      const l = state.labs[labId];
      const k = slug(pc);
      const pinned = l.pins[k];
      if (pinned && pinned !== hello.hostKey) return { ok: false, changed: true, reason: `The identity of ${pc} changed (was ${fingerprint(pinned)}, now ${fingerprint(hello.hostKey)}). If it was reinstalled, you can trust the new identity.` };
      if (!pinned) { l.pins[k] = hello.hostKey; save(); }
      return { ok: true, fp: fingerprint(hello.hostKey) };
    },
    trustHost(labId, pc, hostKey) { state.labs[labId].pins[slug(pc)] = hostKey; save(); },
    /* ---- admin tools ---- */
    createLab(name) {
      const kp = myKey();
      const labId = crypto.randomBytes(6).toString('hex').slice(0, 10);
      const sp = makePolicy({ lab: String(name).trim().slice(0, 60) || 'Lab', labId, version: 1,
        members: [{ name: state.me.name, key: kp.pub, role: 'admin' }], pcs: [], settings: { ...DEFAULT_SETTINGS } }, kp);
      store(sp, { genesis: true });
      return labView(labId);
    },
    // apply changes and sign the next version (only admins can produce a valid one)
    update(labId, changes) {
      const l = state.labs[labId]; if (!l) throw new Error('unknown lab');
      const p = readPolicy(l.policy);
      if (!isAdmin(p, state.me.pub)) throw new Error('only lab admins can change the lab');
      const next = { lab: p.lab, labId, version: p.version + 1, members: p.members, pcs: p.pcs || [], settings: settingsOf(p) };
      if (changes.lab) next.lab = String(changes.lab).trim().slice(0, 60);
      if (changes.addMember) {
        const key = parseAccessKey(changes.addMember.key);
        if (next.members.some(m => m.key === key)) throw new Error('that key is already a member');
        next.members = [...next.members, { name: String(changes.addMember.name || '').trim().slice(0, 40) || fingerprint(key), key, role: changes.addMember.role === 'admin' ? 'admin' : 'member' }];
      }
      if (changes.removeMember) next.members = next.members.filter(m => m.key !== changes.removeMember);
      if (changes.setRole) next.members = next.members.map(m => m.key === changes.setRole.key ? { ...m, role: changes.setRole.role === 'admin' ? 'admin' : 'member' } : m);
      if (changes.pcs) next.pcs = [...new Set(changes.pcs.map(s => String(s).trim()).filter(Boolean))].slice(0, 500);
      if (changes.settings) next.settings = { ...next.settings, ...changes.settings };
      if (!next.members.some(m => m.role === 'admin')) throw new Error('the lab must keep at least one admin');
      const sp = makePolicy(next, myKey());
      const old = settingsOf(p);
      store(sp);
      const l2 = state.labs[labId];                      // store() replaced the entry
      // a new connection server: PCs that don't have this version yet are still on the old one
      if (JSON.stringify([old.server, old.turn]) !== JSON.stringify([next.settings.server, next.settings.turn])) l2.prevNet = { server: old.server, turn: old.turn };
      l2.publish = {};                                  // every PC needs the new version
      save();
      return labView(labId);
    },
    setPublished(labId, pc, version) { const l = state.labs[labId]; if (!l) return; l.publish = { ...(l.publish || {}), [slug(pc)]: version }; save(); },
    // my own shortcuts to PCs that aren't in the lab's list, and the PCs I connected to lately (this computer only)
    savePc(labId, pc, on) {
      const l = state.labs[labId]; pc = String(pc || '').trim().slice(0, 60);
      if (!l || !pc) return labView(labId);
      const rest = (l.saved || []).filter(x => slug(x) !== slug(pc));
      l.saved = on ? [...rest, pc] : rest;
      save(); return labView(labId);
    },
    remember(labId, pc) {
      const l = state.labs[labId]; pc = String(pc || '').trim().slice(0, 60);
      if (!l || !pc) return;
      l.recent = [{ pc, at: new Date().toISOString() }, ...(l.recent || []).filter(x => slug(x.pc) !== slug(pc))].slice(0, 10);
      save();
    },
  };
}

module.exports = { labHost, labClient, fingerprint, parseAccessKey, peerIdFor, slug, readPolicy, checkUpdate, makePolicy, newKeyPair, sign, verify, helloText, authText };
