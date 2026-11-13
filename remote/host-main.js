// Remote desktop: everything that runs in Electron's main process.
//  - the host: a hidden "engine" window that keeps this PC reachable (ID + password), plus input injection,
//    tray icon, start-with-the-computer and keep-awake
//  - shared services for the engine and the client windows: clipboard sync and file access
//  - the manager window (settings + connect) and one window per remote session
const { app, BrowserWindow, ipcMain, screen, desktopCapturer, clipboard, nativeImage, Tray, Menu,
        powerSaveBlocker, shell, safeStorage, dialog } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Injector } = require('./injector');
const clipFiles = require('./clipfiles');

const PBKDF2_ROUNDS = 150000;          // (both ends of a sign-in derive the key here)

module.exports = function setupRemote({ readAppSettings, writeAppSettings, appDir, serverQuery, openMainWindow, log = console.log, lab = {},
                                         product = 'ScreenShare', feedbackUrl = null, defaultLang = 'en', trayApp = false, update = null,
                                         minPassword = 6 }) {
  // a Mac only connects to other PCs (being controlled would need screen-recording and accessibility
  // permissions granted by hand, and a signed app); SC-Remote on Linux hosts while someone is signed in
  const canHost = ((process.env.SCREENSHARE_TEST && process.env.SCREENSHARE_TEST_PLATFORM) || process.platform) !== 'darwin';
  const labHost = lab.host || null;       // this PC is a lab PC (lab edition agent)
  const labClient = lab.client || null;   // lab edition: my key, my labs, admin tools
  // The agent: started by the Windows service as the system account, before anyone signs in (lab edition, or the
  // remote edition with an ID and password). It covers the sign-in screen, and keeps members inside the user's files.
  const AGENT = !!(labHost || lab.agent);
  // agent options (remote edition: set in the service's settings dialog; lab edition: the lab's rules)
  const hostOptions = () => (labHost ? labHost.settings() : lab.options ? lab.options() : { banner: false, consent: 'never', localEnd: true });
  const audit = (event, detail) => { if (labHost) labHost.audit(event, detail); else if (lab.audit) lab.audit(event, detail); };
  const preload = path.join(appDir, 'remote-preload.js');
  const page = name => path.join(appDir, 'app', name);
  const q = () => ({ ...serverQuery(), ...(process.env.SCREENSHARE_DEBUG ? { debug: '3' } : {}) });
  const injector = new Injector(log);

  let engine = null;                   // hidden BrowserWindow running the host side
  let manager = null;
  let tray = null;
  let awakeId = null;
  let status = { state: 'off' };
  let sessionActive = false;
  let sessionSeq = 0, currentSid = 0;  // which sign-in the engine's current session belongs to
  let failures = 0, lockedUntil = 0, lockouts = 0;
  let capture = { source: null, rect: null };
  let session = null;                  // { name, role, fp, peer, started } while someone is in control
  let banner = null;
  let inputDesktop = 'Default';        // Windows: 'Default' = a user's desktop; else the login/lock/UAC screen
  let screenHelper = null;             // lab agent on Windows: captures the login/lock/UAC screen, which the normal capture can't
  const sessionCreds = new Map();      // webContents id -> { id, password, name }

  /* ---------------- settings ---------------- */
  const cfg = () => readAppSettings().remote || {};
  const saveCfg = patch => writeAppSettings({ remote: { ...cfg(), ...patch } }).remote;
  function ensureId() {
    let { id } = cfg();
    if (!/^\d{9}$/.test(id || '')) {
      id = String(crypto.randomInt(1, 10)) + String(crypto.randomInt(0, 1e8)).padStart(8, '0');
      saveCfg({ id });
    }
    return id;
  }
  const hasPassword = () => !!(cfg().salt && cfg().key);

  function publicState() {
    const c = cfg();
    return {
      id: ensureId(), enabled: !!c.enabled, hasPassword: hasPassword(), autostart: getAutostart(),
      keepAwake: c.keepAwake !== false, platform: process.platform, status, minPassword,
      wayland: process.platform === 'linux' && /wayland/i.test(process.env.XDG_SESSION_TYPE || ''),
    };
  }

  /* ---------------- password check (the key never leaves this process) ---------------- */
  function setPassword(pw) {
    if (typeof pw !== 'string' || pw.length < minPassword) throw new Error(`Use at least ${minPassword} characters`);
    const salt = crypto.randomBytes(16).toString('hex');
    const key = crypto.pbkdf2Sync(pw, Buffer.from(salt, 'hex'), PBKDF2_ROUNDS, 32, 'sha256').toString('hex');
    saveCfg({ salt, key });
    restartEngine('The password of that PC was changed');   // drop any session made with the old password
  }

  // bind: the two ends' DTLS fingerprints. The client then signs "nonce|host|client", which ties the password
  // check to this exact encrypted connection (a relay in the middle can't reuse it). The agent requires it.
  // cnonce: the client's own random number. With it, a right password is answered with a proof that this PC
  // knows the password too ("host|cnonce|nonce|host|client"), so the client can tell this PC from an impostor
  // that took its ID on the connection server while it was off.
  // The sign-in is SRP (see srp.js): this PC's half goes out in its hello, and the app's answer comes back
  // with its proof. Each connection gets its own half and one try.
  const srp = require('./srp');
  const pakes = new Map();          // id → { b, B, key, at }: this PC's half, until the app answers
  function pakeStart() {
    const { key } = cfg();
    if (!key || !/^[0-9a-f]{64}$/.test(key)) return null;
    const now = Date.now();
    for (const [id, p] of pakes) if (now - p.at > 60000) pakes.delete(id);
    if (pakes.size >= 32) pakes.delete(pakes.keys().next().value);
    const id = crypto.randomBytes(8).toString('hex');
    const { b, B } = srp.hostStart(key);
    pakes.set(id, { b, B, key, at: now });
    return { id, B };
  }
  function verify(nonceHex, macHex, bind, cnonceHex, pake) {
    if (Date.now() < lockedUntil) return { ok: false, code: 'locked', reason: `Too many wrong passwords. Try again in ${Math.ceil((lockedUntil - Date.now()) / 1000)} s.` };
    const { key, salt } = cfg();
    if (!key || !/^[0-9a-f]{64}$/.test(nonceHex)) return { ok: false, code: 'bad', reason: 'Bad request' };
    if (!bind || !bind.hostFp || !bind.clientFp) return { ok: false, code: 'old', reason: 'This PC needs a newer ScreenShare app to connect to it (ScreenShare 2.3 or SC-Remote).' };
    let ok, proof = null;
    if (pake) {
      const st = pakes.get(pake.id);
      pakes.delete(pake.id);
      if (!st || st.key !== key) return { ok: false, code: 'bad', reason: 'Bad request' };     // (or the password changed meanwhile)
      proof = srp.hostFinish(key, st.b, st.B, pake.A, pake.m1, { nonce: nonceHex, salt, hostFp: bind.hostFp, clientFp: bind.clientFp });
      ok = !!proof;
    } else {
      // apps from before the SRP sign-in (ScreenShare 2.3/2.4, SC-Remote up to 1.3.1): a signed nonce
      if (!/^[0-9a-f]{64}$/.test(macHex || '')) return { ok: false, code: 'bad', reason: 'Bad request' };
      const k = Buffer.from(key, 'hex');
      const tail = `${nonceHex}|${bind.hostFp}|${bind.clientFp}`;
      ok = crypto.timingSafeEqual(crypto.createHmac('sha256', k).update(tail).digest(), Buffer.from(macHex, 'hex'));
      if (ok && /^[0-9a-f]{64}$/.test(cnonceHex || '')) proof = crypto.createHmac('sha256', k).update(`host|${cnonceHex}|${tail}`).digest('hex');
    }
    if (!ok) {
      failures++;
      // 5 wrong passwords: locked for 1 min, then 2, 4… up to 30 min (reset by a right one)
      if (failures >= 5) { lockedUntil = Date.now() + Math.min(30, 2 ** lockouts) * 60000; lockouts++; failures = 0; }
      return { ok: false, code: 'wrong', reason: 'Wrong password' };
    }
    failures = 0; lockouts = 0;
    return { ok: true, proof };
  }

  /* ---------------- connection history (who connected to this PC, and who tried) ---------------- */
  // Kept next to this PC's status (readable by its users; only the host process writes it). Names are what the
  // other computer calls itself, so they aren't proof of who it was; the address is the one the connection used.
  // Refused attempts need no password, so strangers can produce any number of them: they get their own share
  // of the list and can't push the real sessions out of it.
  const HISTORY_SESSIONS = 200, HISTORY_REFUSED = 100;
  function trimHistory(list) {
    const keep = new Set([...list.filter(x => x.kind === 'session').slice(-HISTORY_SESSIONS), ...list.filter(x => x.kind !== 'session').slice(-HISTORY_REFUSED)]);
    return list.filter(x => keep.has(x));
  }
  let histLoaded = false, liveEntry = null;
  const readHistory = () => { try { const a = JSON.parse(fs.readFileSync(lab.historyFile, 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; } };
  function writeHistory(list) {
    if (!lab.historyFile) return;
    try {
      const tmp = lab.historyFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(trimHistory(list)));
      fs.renameSync(tmp, lab.historyFile);
    } catch (e) { log('history: ' + e.message); }
    if (manager && !manager.isDestroyed()) manager.webContents.send('remote:history-changed');
  }
  function loadHistory() {
    let list = readHistory();
    if (!histLoaded) {                    // sessions left open by a crash or power cut: their end isn't known
      histLoaded = true;
      if (list.some(x => x.live)) { list = list.map(x => (x.live ? { ...x, live: false } : x)); writeHistory(list); }
    }
    return list;
  }
  const cleanAddr = a => (typeof a === 'string' && /^[0-9a-fA-F:.]{3,45}$/.test(a) ? a : '');
  function historyAdd(kind, name, from = {}, reason = '') {
    if (!lab.historyFile) return;
    const list = loadHistory(), now = new Date().toISOString();
    const addr = cleanAddr(from.addr), relay = !!from.relay;
    if (kind !== 'session') {             // refused attempts: one line per source and reason, with a count
      const last = list[list.length - 1];
      if (last && last.kind === kind && last.reason === reason && last.name === name && last.addr === addr && Date.now() - Date.parse(last.last || last.t) < 15 * 60e3) {
        last.n = (last.n || 1) + 1; last.last = now;
      } else list.push({ t: now, kind, reason, name, addr, relay, n: 1 });
      return writeHistory(list);
    }
    liveEntry = { t: now, kind, name, addr, relay, live: true };
    list.push(liveEntry);
    writeHistory(list);
  }
  function historyEnd() {
    if (!liveEntry) return;
    const start = liveEntry.t; liveEntry = null;
    const list = loadHistory();
    const e = list.find(x => x.kind === 'session' && x.t === start);
    if (e) { e.live = false; e.end = new Date().toISOString(); writeHistory(list); }
  }
  ipcMain.handle('remote:history', () => (lab.historyFile ? trimHistory(readHistory()).reverse() : null));

  /* ---------------- engine (host) ---------------- */
  const hostEnabled = () => (labHost ? labHost.ready() : !!cfg().enabled && hasPassword());
  function startEngine() {
    if (engine || !hostEnabled()) return;
    engine = new BrowserWindow({
      show: false, width: 400, height: 300, title: 'ScreenShare remote host',
      webPreferences: { preload, contextIsolation: true, sandbox: true, backgroundThrottling: false, devTools: !AGENT },
    });
    engine.loadFile(page('remote-host.html'), { query: q() });
    engine.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    engine.on('closed', () => { engine = null; endSession(); setStatus({ state: 'off' }); });
    // a 24/7 host must survive its page crashing: start it again
    engine.webContents.on('render-process-gone', (_e, d) => {
      log('remote host page stopped: ' + d.reason);
      endSession();
      setTimeout(() => { if (hostEnabled()) restartEngine(); }, 2000);
    });
    if ((AGENT || cfg().keepAwake !== false) && awakeId === null) awakeId = powerSaveBlocker.start('prevent-app-suspension');
    updateTray();
  }
  function stopEngine(reason = 'Remote access was turned off on that PC') {
    if (engine) {
      // tell a connected controller why, so it doesn't keep retrying
      const e = engine; engine = null;
      try { if (!e.webContents.isCrashed()) e.webContents.send('remote:kick', reason); } catch {}
      setTimeout(() => { if (!e.isDestroyed()) e.destroy(); }, 400);
    }
    endSession();
    if (awakeId !== null) { powerSaveBlocker.stop(awakeId); awakeId = null; }
    setStatus({ state: 'off' });
  }
  function restartEngine(reason) { stopEngine(reason); setTimeout(startEngine, 500); }
  const isEngine = wc => !!(engine && wc && wc.id === engine.webContents.id);

  function endSession() {
    if (sessionActive) injector.releaseAll();
    sessionActive = false;
    if (session) audit('disconnect', { member: session.name, fp: session.fp, peer: session.peer, minutes: Math.round((Date.now() - session.started) / 6000) / 10 });
    historyEnd();
    session = null;
    closeBanner();
    updateScreenHelper();
  }

  function setStatus(s) {
    status = s;
    if (AGENT && lab.statusFile) {
      const c = labHost ? labHost.config() : null;
      const who = labHost ? { pc: labHost.pcName(), lab: c && c.lab, labId: c && c.labId, version: c && c.version }
                          : { pc: os.hostname(), id: cfg().id || null, enabled: hostEnabled() };
      try { fs.writeFileSync(lab.statusFile, JSON.stringify({ ...s, ...who, pid: process.pid, updated: new Date().toISOString() })); } catch {}
    }
    updateTray();
    if (manager && !manager.isDestroyed()) manager.webContents.send('remote:state', publicState());
  }

  /* ---------------- displays & capture source ---------------- */
  async function listDisplays() {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
    const displays = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay();
    const physical = d => process.platform === 'win32'
      ? screen.dipToScreenRect(null, d.bounds)
      : { x: Math.round(d.bounds.x * d.scaleFactor), y: Math.round(d.bounds.y * d.scaleFactor),
          width: Math.round(d.bounds.width * d.scaleFactor), height: Math.round(d.bounds.height * d.scaleFactor) };
    const union = rects => {
      const x = Math.min(...rects.map(r => r.x)), y = Math.min(...rects.map(r => r.y));
      return { x, y, width: Math.max(...rects.map(r => r.x + r.width)) - x, height: Math.max(...rects.map(r => r.y + r.height)) - y };
    };
    const byX = [...displays].sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y);
    return sources.map((s, i) => {
      // match the capture source to a display: by id when the OS reports it, else by position, else "all screens"
      let d = displays.find(d => String(d.id) === String(s.display_id));
      if (!d && sources.length === displays.length) d = byX[i];
      const rect = d ? physical(d) : union(displays.map(physical));
      return { i, sourceId: s.id, source: s, rect,
               label: d ? `${sources.length > 1 ? `Screen ${i + 1}` : 'Screen'} (${rect.width}×${rect.height})${d.id === primary.id ? ' – main' : ''}`
                        : `All screens (${rect.width}×${rect.height})`,
               primary: d ? d.id === primary.id : true };
    });
  }

  /* ---------------- drop files at a point on this screen ---------------- */
  // Start a real file drag from a tiny window, then let the input helper carry it to the drop point and release.
  // The native drag blocks this process until it ends, so the rest of the gesture is queued in the helper first.
  let dragging = false;
  const DRAG_ICON = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==');
  async function dropFiles(paths, nx, ny) {
    paths = (paths || []).map(String).filter(p => fs.existsSync(p));
    if (!paths.length || !capture.rect || dragging) return { ok: false, reason: 'nothing to drop' };
    if (!(await injector.start())) return { ok: false, reason: injector.error || 'input helper unavailable' };
    const r = capture.rect;
    const dx = r.x + Math.min(Math.floor(nx * r.width), r.width - 1), dy = r.y + Math.min(Math.floor(ny * r.height), r.height - 1);
    // start a little away from the drop point, so the drag-source window isn't the drop target
    const off = 90;
    const sx = dx + off < r.x + r.width - 40 ? dx + off : dx - off, sy = dy + off < r.y + r.height - 40 ? dy + off : dy - off;
    const dip = process.platform === 'win32' ? screen.screenToDipPoint({ x: sx, y: sy })
      : (() => { const d = screen.getDisplayNearestPoint({ x: sx, y: sy }); return { x: sx / d.scaleFactor, y: sy / d.scaleFactor }; })();
    dragging = true;
    const src = new BrowserWindow({
      x: Math.round(dip.x) - 32, y: Math.round(dip.y) - 32, width: 64, height: 64, frame: false, resizable: false, movable: false,
      alwaysOnTop: true, skipTaskbar: true, focusable: false, show: false, backgroundColor: '#5b8cff',
      webPreferences: { preload, contextIsolation: true, sandbox: true },
    });
    try {
      src.setAlwaysOnTop(true, 'screen-saver');
      await src.loadURL('data:text/html,' + encodeURIComponent(`<body style="margin:0;background:#5b8cff;color:#fff;font:600 12px system-ui;user-select:none">
        <div id=d draggable=true style="width:64px;height:64px;display:flex;align-items:center;justify-content:center;text-align:center">${paths.length} file${paths.length > 1 ? 's' : ''}</div>
        <script>document.getElementById('d').addEventListener('dragstart', e => { e.preventDefault(); window.remoteApp.dragStart(); });</script></body>`));
      src.showInactive();
      await new Promise(r => setTimeout(r, 250));
      const started = await new Promise(resolve => {
        const go = injector.dragTo(sx, sy, dx, dy, () => src.webContents.startDrag({ files: paths, icon: DRAG_ICON }));
        const onStart = ev => { if (ev.sender === src.webContents) { ipcMain.removeListener('remote:drag-start', onStart); clearTimeout(t); go(); resolve(true); } };
        const t = setTimeout(() => { ipcMain.removeListener('remote:drag-start', onStart); resolve(false); }, 2500);
        ipcMain.on('remote:drag-start', onStart);
      });
      if (!started) { injector.send('B 1 0'); return { ok: false, reason: 'could not start the drag on that PC' }; }
      await new Promise(r => setTimeout(r, 300));
      return { ok: true };
    } finally {
      dragging = false;
      if (!src.isDestroyed()) src.destroy();
    }
  }

  /* ---------------- lab: on-screen banner and consent prompt ---------------- */
  let promptState = null;               // what the banner/prompt pages show
  function topCenter(w, h) {
    const wa = screen.getPrimaryDisplay().workArea;
    return { x: Math.round(wa.x + (wa.width - w) / 2), y: wa.y + 8, width: w, height: h };
  }
  function openBanner(name) {
    closeBanner();
    const st = hostOptions();
    if (!st.banner) return;
    promptState = { kind: 'banner', name, lab: labHost ? labHost.config().lab : '', canEnd: st.localEnd !== false, lang: agentLang(), product };
    banner = new BrowserWindow({ ...topCenter(460, 44), frame: false, resizable: false, movable: true, alwaysOnTop: true, skipTaskbar: true,
      focusable: false, show: false, backgroundColor: '#1a1d24', webPreferences: { preload, contextIsolation: true, sandbox: true, devTools: false } });
    banner.setAlwaysOnTop(true, 'screen-saver');
    banner.loadFile(page('lab-prompt.html'));
    banner.once('ready-to-show', () => banner && banner.showInactive());
    banner.on('closed', () => { banner = null; });
  }
  function closeBanner() { if (banner && !banner.isDestroyed()) banner.destroy(); banner = null; }
  // ask the person at the PC (only when someone is at a desktop; at the login screen there is nobody to ask)
  function askConsent(name) {
    const st = hostOptions();
    if (st.consent !== 'ask' || inputDesktop !== 'Default') return Promise.resolve(true);
    return new Promise(resolve => {
      promptState = { kind: 'consent', name, lab: labHost ? labHost.config().lab : '', seconds: 30, lang: agentLang(), product };
      const w = new BrowserWindow({ ...topCenter(480, 150), frame: false, resizable: false, alwaysOnTop: true, skipTaskbar: true,
        show: false, backgroundColor: '#1a1d24', webPreferences: { preload, contextIsolation: true, sandbox: true, devTools: false } });
      w.setAlwaysOnTop(true, 'screen-saver');
      let done = false;
      const finish = ok => { if (done) return; done = true; ipcMain.removeListener('lab:prompt-answer', onAnswer); clearTimeout(t); if (!w.isDestroyed()) w.destroy(); resolve(ok); };
      const onAnswer = (e, a) => { if (e.sender === w.webContents) finish(a === 'allow'); };
      ipcMain.on('lab:prompt-answer', onAnswer);
      const t = setTimeout(() => finish(false), 31000);
      w.on('closed', () => finish(false));
      w.loadFile(page('lab-prompt.html'));
      w.once('ready-to-show', () => w.show());
    });
  }
  ipcMain.handle('lab:prompt-info', () => promptState);
  ipcMain.on('lab:prompt-answer', (e, a) => {
    if (a === 'end' && banner && e.sender === banner.webContents && engine) {
      audit('ended-locally', { member: session && session.name });
      engine.webContents.send('remote:kick', 'The person at that PC ended the session');
    }
  });

  /* ---------------- lab agent on Windows: login screen, lock screen, UAC prompts ---------------- */
  // Those appear on the secure ("Winlogon") desktop. The helper follows whichever desktop has the input,
  // reports switches, and while one is up a second helper captures it (the normal capture only sees the user's desktop).
  const helperExe = () => process.env.SCREENSHARE_HELPER || (lab.helper && fs.existsSync(lab.helper) ? lab.helper : null);
  injector.helperPath = () => (AGENT && process.platform === 'win32' ? helperExe() : null);
  function spawnHelper(mode) {
    const exe = helperExe();
    if (!exe) return null;
    const { spawn } = require('child_process');
    // a .js helper (tests) runs on Electron's own Node
    const [cmd, args, env] = exe.endsWith('.js') ? [process.execPath, [exe, mode], { ...process.env, ELECTRON_RUN_AS_NODE: '1' }] : [exe, [mode], process.env];
    const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env });
    p.on('error', e => log(`helper (${mode}): ${e.message}`));
    p.stderr.on('data', d => log(`helper (${mode}): ${String(d).trim()}`));
    return p;
  }
  function onDesktop(name) {
    if (!name || name === inputDesktop) return;
    inputDesktop = name;
    log('input desktop: ' + name);
    if (session) audit('desktop', { name, member: session.name });
    if (engine) engine.webContents.send('remote:desktop', name);
    updateScreenHelper();
  }
  function startDesktopWatch() {
    if (process.env.SCREENSHARE_TEST_DESKTOP) {          // tests: a file holds the desktop name
      const f = process.env.SCREENSHARE_TEST_DESKTOP;
      setInterval(() => { try { onDesktop(fs.readFileSync(f, 'utf8').trim()); } catch {} }, 300).unref();
      return;
    }
    // Windows: the input helper reports desktop switches; keep it running all the time
    injector.onDesktop = onDesktop;
    injector.start();
  }
  function updateScreenHelper() {
    const want = !!(AGENT && sessionActive && inputDesktop !== 'Default' && capture.rect && engine);
    if (want && !screenHelper) startScreenHelper();
    else if (!want && screenHelper) stopScreenHelper();
  }
  function startScreenHelper() {
    const p = spawnHelper('capture');
    if (!p) { if (engine) engine.webContents.send('remote:input-error', 'the login screen cannot be shown (helper missing)'); return; }
    screenHelper = p;
    const r = capture.rect, scale = Math.min(1, 1600 / r.width);
    p.stdin.write(`C ${r.x} ${r.y} ${r.width} ${r.height} 8 70 ${Math.round(r.width * scale)}\n`);
    // frames: 4-byte little-endian length, then a JPEG
    let buf = Buffer.alloc(0);
    p.stdout.on('data', d => {
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      while (buf.length >= 4) {
        const n = buf.readUInt32LE(0);
        if (n > 20 * 1024 * 1024) { log('helper (capture): bad frame'); stopScreenHelper(); return; }
        if (buf.length < 4 + n) break;
        const jpeg = buf.subarray(4, 4 + n); buf = buf.subarray(4 + n);
        if (engine && screenHelper === p) engine.webContents.send('remote:frame', new Uint8Array(jpeg));
      }
    });
    p.on('exit', () => { if (screenHelper === p) { screenHelper = null; setTimeout(updateScreenHelper, 1000); } });
    log('secure-desktop capture started');
  }
  function stopScreenHelper() {
    const p = screenHelper; screenHelper = null;
    if (!p) return;
    try { p.stdin.end(); } catch {}
    setTimeout(() => { try { p.kill(); } catch {} }, 1000).unref();
    log('secure-desktop capture stopped');
  }

  /* ---------------- language, feedback link ---------------- */
  const userLang = () => { const l = process.env.SCREENSHARE_LANG || readAppSettings().lang; return l === 'pt' || l === 'en' ? l : defaultLang; };
  const agentLang = () => { const l = process.env.SCREENSHARE_LANG || hostOptions().lang; return l === 'pt' || l === 'en' ? l : defaultLang; };
  ipcMain.handle('app:info', () => ({
    product, version: app.getVersion(), lang: AGENT ? agentLang() : userLang(),
    feedback: !!feedbackUrl, chooseLang: trayApp, canHost, platform: process.platform,
  }));
  ipcMain.handle('app:set-lang', (_e, l) => {
    if (l !== 'pt' && l !== 'en') return userLang();
    writeAppSettings({ lang: l });
    lastTrayKey = '';
    refreshAppTray();
    return l;
  });
  // only this one fixed address (the group's form), in the normal browser
  ipcMain.handle('app:open-feedback', () => { if (feedbackUrl && /^https:\/\//.test(feedbackUrl)) shell.openExternal(feedbackUrl); });

  /* ---------------- SC-Remote: tray icon (the app keeps running there) ---------------- */
  const TR = {
    pt: { 'Open {0}': 'Abrir o {0}', 'Quit': 'Sair', 'Copy ID': 'Copiar ID', 'Online, waiting for connections': 'Online, aguardando conexões',
          'Being controlled from {0}': 'Sendo controlado a partir de {0}', 'another PC': 'outro PC', 'Starting…': 'Iniciando…',
          'Problem: {0}': 'Problema: {0}', 'Remote access to this PC is off': 'Acesso remoto a este PC desligado',
          'Report a problem or send feedback': 'Relatar um problema ou enviar sugestões',
          'Update to version {0}…': 'Atualizar para a versão {0}…',
          'Version {0} is available. Open {1} to update.': 'A versão {0} está disponível. Abra o {1} para atualizar.' },
  };
  const tr = (s, ...a) => { const r = (userLang() === 'pt' && TR.pt[s]) || s; return r.replace(/\{(\d)\}/g, (_, i) => a[i] != null ? a[i] : ''); };
  let appTray = null, lastTrayKey = '';
  function appTrayState() {
    if (serviceMode()) {                              // Windows: the service runs this PC's remote access
      let st = null;
      try { st = JSON.parse(fs.readFileSync(lab.statusFile, 'utf8')); } catch {}
      if (st && st.pid && st.state !== 'off') { try { process.kill(st.pid, 0); } catch (e) { if (e.code !== 'EPERM') st = { ...st, state: 'off' }; } }
      return st && st.enabled !== false ? st : { ...(st || {}), state: 'off' };
    }
    const c = cfg();                                  // elsewhere: this app is the host
    return c.enabled ? { ...status, id: c.id } : { state: 'off', id: c.id };
  }
  function refreshAppTray() {
    if (!appTray) return;
    const st = appTrayState();
    const id = st.id ? String(st.id).replace(/(\d{3})(?=\d)/g, '$1 ') : '';
    const line = st.state === 'connected' ? tr('Being controlled from {0}', st.peer || tr('another PC'))
      : st.state === 'online' ? tr('Online, waiting for connections') : st.state === 'starting' ? tr('Starting…')
      : st.state === 'error' ? tr('Problem: {0}', st.message || 'offline') : tr('Remote access to this PC is off');
    const key = [id, line, userLang(), upd.state, upd.version].join('|');
    if (key === lastTrayKey) return;                  // (rebuilding the menu while it's open would close it)
    lastTrayKey = key;
    appTray.setToolTip(`${product}${id ? ' – ID ' + id : ''}\n${line}`);
    const items = [
      { label: id ? `ID ${id}` : product, enabled: false },
      { label: line, enabled: false },
      ...(upd.state === 'available' ? [{ type: 'separator' }, { label: tr('Update to version {0}…', upd.version), click: () => openManager() }] : []),
      { type: 'separator' },
      ...(st.id ? [{ label: tr('Copy ID'), click: () => clipboard.writeText(String(st.id)) }] : []),
      { label: tr('Open {0}', product), click: () => openManager() },
      ...(feedbackUrl ? [{ label: tr('Report a problem or send feedback'), click: () => shell.openExternal(feedbackUrl) }] : []),
      { type: 'separator' },
      { label: tr('Quit'), click: () => { stopEngine(); app.quit(); } },
    ];
    appTray.setContextMenu(Menu.buildFromTemplate(items));
    if (process.env.SCREENSHARE_TEST) global.__appTray = { tooltip: `${product}${id ? ' – ID ' + id : ''}\n${line}`, items };   // (tests)
  }
  function startAppTray() {
    if (appTray || !trayApp) return;
    if (!canHost) { startUpdateChecks(); return; }      // Mac: no tray (nothing to show: it isn't controlled)
    const icon = nativeImage.createFromPath(page('icon-tray.png'));
    appTray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
    appTray.on('click', () => openManager());
    appTray.on('double-click', () => openManager());
    appTray.on('balloon-click', () => openManager());
    refreshAppTray();
    setInterval(refreshAppTray, 4000).unref();
    startUpdateChecks();
  }

  /* ---------------- SC-Remote: updates ---------------- */
  // At startup (and twice a day while it sits in the tray) the app looks for a newer release on GitHub. It trusts
  // only a manifest signed with the release key. "Restart and update" asks the service, which checks everything
  // again (signature, version, SHA-256 of the download) and runs the installer; the installer closes this app,
  // and the new version's service opens it again.
  // Per system: Windows asks the service (above); SC-Remote's Linux AppImage downloads the new AppImage,
  // checks it against the signed manifest and replaces itself; a Mac (and anything else) opens the download page.
  const U = require('./update');
  let upd = { state: 'idle', current: app.getVersion() };   // idle | available | installing | failed | updated
  const appImage = () => {
    const f = process.platform === 'linux' && process.env.APPIMAGE;
    if (!f) return null;
    try { fs.accessSync(path.dirname(f), fs.constants.W_OK); fs.accessSync(f, fs.constants.W_OK); return f; } catch { return null; }
  };
  // (the service exists only where the Windows installer put it; it installs the Windows installer)
  const updateMethod = () => (serviceMode() ? 'service' : appImage() ? 'appimage' : 'download');
  let balloonFor = '', watchTimer = null;
  function setUpd(patch) {
    upd = { ...upd, ...patch };
    if (manager && !manager.isDestroyed()) manager.webContents.send('update:changed', upd);
    refreshAppTray();
    if (upd.state === 'available' && balloonFor !== upd.version && appTray && process.platform === 'win32') {
      balloonFor = upd.version;
      try { appTray.displayBalloon({ iconType: 'info', title: product, content: tr('Version {0} is available. Open {1} to update.', upd.version, product) }); } catch {}
    }
  }
  const readUpdateState = () => { try { return JSON.parse(fs.readFileSync(update.stateFile, 'utf8')); } catch { return null; } };
  async function checkForUpdate() {
    if (!update || upd.state === 'installing') return true;
    const { net } = require('electron');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 30000);
    try {
      const r = await net.fetch(update.manifestUrl, { cache: 'no-store', signal: ctl.signal });
      if (r.status === 404) { log('update check: no release published yet'); return true; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const m = U.verifyManifest(await r.json(), update.publicKey);
      if (m.product && m.product !== product) throw new Error('the manifest is for ' + m.product);
      const asset = U.platformAsset(m, serviceMode() ? 'win32' : process.platform, update.allowedPrefix);
      if (U.cmpVersion(m.version, app.getVersion()) > 0 && !asset) log(`update ${m.version}: nothing published for ${process.platform}`);
      if (U.cmpVersion(m.version, app.getVersion()) > 0 && asset) {
        if (upd.state === 'failed' && upd.version === m.version) return true;           // (keeps "Try again")
        if (upd.state !== 'available' || upd.version !== m.version) {
          log('update available: ' + m.version);
          setUpd({ state: 'available', version: m.version, notes: m.notes || '', error: '', asset, method: updateMethod(), opened: false });
        }
      } else if (upd.state === 'available') setUpd({ state: 'idle', version: '' });
      return true;
    } catch (e) {
      log('update check failed: ' + (e.name === 'AbortError' ? 'timed out' : e.message));
      return false;
    } finally { clearTimeout(timer); }
  }
  function startUpdateChecks() {
    if (!update) return;
    if (update.justUpdated) {                         // opened by the service after an update: how did it go?
      const s = readUpdateState();
      if (s && Date.now() - Date.parse(s.at) < 30 * 60e3) {
        if (s.state === 'done') setUpd({ state: 'updated' });
        else if (s.state === 'failed') setUpd({ state: 'failed', version: s.version || '', error: s.error || '' });
      }
    }
    let misses = 0;                                   // (offline right after sign-in: try again soon)
    const run = async () => {
      const ok = await checkForUpdate();
      misses = ok ? 0 : misses + 1;
      setTimeout(run, ok ? 12 * 3600e3 : [60e3, 5 * 60e3, 30 * 60e3][Math.min(misses, 3) - 1]).unref();
    };
    setTimeout(run, process.env.SCREENSHARE_TEST ? 300 : 3000).unref();
  }
  // Linux AppImage: download next to it, check, swap the file (the running copy keeps its old one open) and restart
  async function installAppImage() {
    const target = appImage(), a = upd.asset;
    const tmp = path.join(path.dirname(target), '.' + path.basename(target) + '.update');
    log('update to ' + upd.version + ': downloading ' + a.url);
    setUpd({ state: 'installing', step: 'downloading', error: '' });
    let error = 'could not download the update';
    try {
      const { net } = require('electron');
      const r = await net.fetch(a.url, { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const hash = crypto.createHash('sha256');
      const out = fs.createWriteStream(tmp, { mode: 0o700 });
      const finished = new Promise((res, rej) => { out.on('finish', res); out.on('error', rej); });
      for await (const chunk of r.body) { hash.update(chunk); if (!out.write(chunk)) await new Promise(res => out.once('drain', res)); }
      out.end(); await finished;
      if (hash.digest('hex') !== a.sha256 || (a.size && fs.statSync(tmp).size !== a.size)) { error = 'the downloaded update is damaged'; throw new Error(error); }
      error = 'could not replace the program file';
      setUpd({ step: 'installing' });
      fs.chmodSync(tmp, 0o755);
      fs.renameSync(tmp, target);
      try { fs.mkdirSync(path.dirname(update.stateFile), { recursive: true }); fs.writeFileSync(update.stateFile, JSON.stringify({ state: 'done', version: upd.version, at: new Date().toISOString() })); } catch {}
      log('updated the AppImage to ' + upd.version + ': restarting');
      app.relaunch({ execPath: target, args: ['--updated'] });
      setTimeout(() => app.exit(0), 300);
    } catch (e) {
      log('update failed: ' + e.message);
      try { fs.unlinkSync(tmp); } catch {}
      setUpd({ state: 'failed', error });
    }
  }
  function installUpdate() {
    if (!update || !['available', 'failed'].includes(upd.state) || !upd.version) return upd;
    const method = updateMethod();
    if (method === 'appimage' && upd.asset) { installAppImage(); return { ...upd, state: 'installing', step: 'downloading' }; }
    if (method === 'download') {                      // Mac, or no service / no writable AppImage: the download page
      if (update.page) shell.openExternal(update.page);
      setUpd({ method, opened: true });
      return upd;
    }
    const since = Date.now();
    log('update to ' + upd.version + ' requested');
    setUpd({ state: 'installing', step: 'requested', error: '' });
    require('child_process').execFile(lab.serviceExe, ['update-request'], { windowsHide: true, timeout: 20000 }, err => {
      if (err) {
        log('update request: ' + (err.code != null ? 'exit code ' + err.code : err.message));
        return setUpd({ state: 'failed', error: err.code === 2 ? 'the remote access service is not running' : 'could not reach the remote access service' });
      }
      // the service reports in update-state.json (the installer then closes this app)
      clearInterval(watchTimer);
      watchTimer = setInterval(() => {
        const s = readUpdateState();
        const fresh = s && Date.parse(s.at) >= since - 2000;
        const stop = patch => { clearInterval(watchTimer); setUpd(patch); };
        if (fresh && s.state === 'failed') stop({ state: 'failed', error: s.error || '' });
        else if (fresh && (s.state === 'downloading' || s.state === 'installing')) { if (upd.step !== s.state) setUpd({ step: s.state }); }
        else if (!fresh && Date.now() - since > 30000) stop({ state: 'failed', error: 'the remote access service did not respond' });
        if (Date.now() - since > 15 * 60e3 && upd.state === 'installing') stop({ state: 'failed', error: 'the update is taking too long' });
      }, 1000);
    });
    return upd;
  }
  ipcMain.handle('update:get', () => upd);
  ipcMain.handle('update:install', () => installUpdate());

  /* ---------------- tray ---------------- */
  function updateTray() {
    if (AGENT) return;                   // the agent runs as the system account: no tray (the app shows its state)
    if (trayApp) { refreshAppTray(); return; }   // SC-Remote has its own tray (below)
    const c = cfg();
    if (!c.enabled) { if (tray) { tray.destroy(); tray = null; } return; }
    if (!tray) {
      const icon = nativeImage.createFromPath(page('icon-tray.png'));
      tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
      tray.on('click', () => openManager());
    }
    const id = ensureId().replace(/(\d{3})(?=\d)/g, '$1 ');
    const line = status.state === 'connected' ? `Being controlled from ${status.peer || 'another PC'}`
      : status.state === 'online' ? 'Waiting for connections' : status.state === 'starting' ? 'Connecting…'
      : status.state === 'error' ? `Problem: ${status.message || 'offline'}` : 'Off';
    tray.setToolTip(`ScreenShare remote access – ID ${id}\n${line}`);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: `ID ${id}`, enabled: false },
      { label: line, enabled: false },
      { type: 'separator' },
      { label: 'Copy ID', click: () => clipboard.writeText(ensureId()) },
      ...(status.state === 'connected' ? [{ label: 'Disconnect the controller', click: () => engine && engine.webContents.send('remote:kick', 'Disconnected by the person at that PC') }] : []),
      { label: 'Remote desktop settings…', click: () => openManager() },
      { label: 'Open ScreenShare', click: () => openMainWindow() },
      { type: 'separator' },
      { label: 'Turn off remote access', click: () => setEnabled(false) },
      { label: 'Quit', click: () => { stopEngine(); app.quit(); } },
    ]));
  }

  function setEnabled(on) {
    if (on && !hasPassword()) throw new Error('Set a password first');
    saveCfg({ enabled: !!on });
    if (on) startEngine(); else stopEngine();
    updateTray();
    setStatus(status);
    return publicState();
  }

  /* ---------------- start with the computer ---------------- */
  const autostartFile = () => path.join(os.homedir(), '.config', 'autostart', 'screenshare-remote.desktop');
  function launchCommand() {
    const outer = process.env.APPIMAGE || process.env.PORTABLE_EXECUTABLE_FILE;
    if (outer) return { exe: outer, args: ['--background'] };
    return app.isPackaged ? { exe: process.execPath, args: ['--background'] } : { exe: process.execPath, args: [app.getAppPath(), '--background'] };
  }
  function getAutostart() {
    if (process.platform === 'linux') return fs.existsSync(autostartFile());
    if (process.platform === 'win32') { const { exe, args } = launchCommand(); return app.getLoginItemSettings({ path: exe, args }).openAtLogin; }
    return false;
  }
  function setAutostart(on) {
    const { exe, args } = launchCommand();
    if (process.platform === 'linux') {
      const f = autostartFile();
      if (!on) { fs.rmSync(f, { force: true }); return getAutostart(); }
      const q = s => /[\s"'\\$`]/.test(s) ? `"${s.replace(/(["\\$`])/g, '\\$1')}"` : s;
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, [
        '[Desktop Entry]', 'Type=Application', 'Name=ScreenShare remote access',
        'Comment=Lets you control this PC from your other computers',
        `Exec=${[exe, ...args].map(q).join(' ')}`,
        'Terminal=false', 'X-GNOME-Autostart-enabled=true', 'X-GNOME-Autostart-Delay=5', 'NoDisplay=false', '',
      ].join('\n'));
    } else if (process.platform === 'win32') {
      app.setLoginItemSettings({ openAtLogin: !!on, path: exe, args, name: 'ScreenShare remote access' });
    }
    return getAutostart();
  }

  /* ---------------- clipboard sync (engine and session windows) ---------------- */
  // Electron 44's clipboard is asynchronous (read()/write() with ClipboardItems, like the web API).
  const { ClipboardItem } = require('electron');
  const clipWatchers = new Set();
  let clipTimer = null, clipBusy = false, clipTick = 0;
  let lastClip = { text: null, image: null, files: '' };
  const sha1 = buf => crypto.createHash('sha1').update(buf).digest('hex');
  let lastLogged = '';
  const logOnce = m => { if (m !== lastLogged) { lastLogged = m; log(m); } };
  async function readClipboard(withImage) {
    const text = await clipboard.readText().catch(() => '');
    let png = null;
    if (withImage && await clipboard.has('image/png').catch(() => false)) {
      try {
        const items = await clipboard.read();
        const it = items.find(i => i.types.includes('image/png'));
        if (it) png = Buffer.from(await (await it.getType('image/png')).arrayBuffer());
      } catch {}
    }
    const files = await clipFiles.readFiles().catch(e => { logOnce('reading copied files: ' + e.message); return null; });
    return { text, png, files: files || [] };
  }
  async function pollClipboard() {
    if (clipBusy) return;
    clipBusy = true;
    try {
      const withImage = clipTick++ % 3 === 0;            // images are costlier to read: every 1.5 s
      const { text, png, files } = await readClipboard(withImage);
      // files copied in a file manager: send the list (the other side then fetches the files themselves)
      const sig = files.join('\n');
      if (sig !== lastClip.files) {
        lastClip.files = sig;
        if (files.length) { lastClip.text = text; clipOffered = files; broadcastClip({ kind: 'files', paths: files }); return; }
      }
      if (files.length) return;                     // the text then is just the paths: don't send it as text
      if (png) {
        const hash = sha1(png);
        if (hash !== lastClip.image) {
          lastClip = { text, image: hash };
          if (png.length <= 20 * 1024 * 1024) broadcastClip({ kind: 'image', data: new Uint8Array(png) });
          return;
        }
      }
      if (text && text !== lastClip.text && text.length <= 4 * 1024 * 1024) {
        lastClip.text = text;
        broadcastClip({ kind: 'text', data: text });
      }
    } catch (e) { log('clipboard: ' + e.message); }
    finally { clipBusy = false; }
  }
  function broadcastClip(payload) { for (const wc of clipWatchers) if (!wc.isDestroyed()) wc.send('clip:changed', payload); }
  async function watchClipboard(wc, on) {
    if (on) {
      if (!clipWatchers.has(wc)) { clipWatchers.add(wc); wc.once('destroyed', () => watchClipboard(wc, false)); }
      const { text, png, files } = await readClipboard(true);    // only send what changes from now on
      lastClip = { text, image: png ? sha1(png) : null, files: files.join('\n') };
    } else clipWatchers.delete(wc);
    if (clipWatchers.size && !clipTimer) clipTimer = setInterval(pollClipboard, 500);
    if (!clipWatchers.size && clipTimer) { clearInterval(clipTimer); clipTimer = null; }
  }
  async function setClipboard(payload) {
    if (payload.kind === 'text' && typeof payload.data === 'string') {
      lastClip.text = payload.data;
      await clipboard.writeText(payload.data);
    } else if (payload.kind === 'image' && payload.data) {
      const png = Buffer.from(payload.data);
      lastClip.image = sha1(png);
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
      // the OS may re-encode the PNG: remember what it now holds so it isn't sent back
      const now = await readClipboard(true);
      lastClip = { text: now.text, image: now.png ? sha1(now.png) : lastClip.image, files: lastClip.files };
    } else if (payload.kind === 'files' && Array.isArray(payload.paths)) {
      const paths = payload.paths.map(String).filter(p => fs.existsSync(p));
      if (!paths.length) return;
      lastClip.files = paths.join('\n');
      await clipFiles.writeFiles(paths);
      const now = await readClipboard(false);
      lastClip = { ...lastClip, text: now.text, files: now.files.length ? now.files.join('\n') : lastClip.files };
    }
  }

  /* ---------------- files ---------------- */
  // Staging: files arriving through the clipboard or a drop wait here until pasted/dropped (cleaned after a day).
  // The lab agent runs as the system account: use the folders of whoever is signed in at the PC (if anyone).
  const userDirs = () => {
    const u = lab.userContext ? lab.userContext() : null;
    if (u) return u;
    return { home: os.homedir(), temp: os.tmpdir(), downloads: app.getPath('downloads') };
  };
  const stageRoot = () => path.join(userDirs().temp, 'ScreenShare-transfers');
  try {
    for (const d of fs.readdirSync(stageRoot())) {
      const p = path.join(stageRoot(), d);
      if (Date.now() - fs.statSync(p).mtimeMs > 24 * 3600 * 1000) fs.rmSync(p, { recursive: true, force: true });
    }
  } catch {}
  function newStage() {
    const p = path.join(stageRoot(), new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex'));
    fs.mkdirSync(p, { recursive: true });
    return p;
  }
  // rel uses '/' and must stay inside base (no "..", no absolute paths)
  function safeJoin(base, rel) {
    const parts = String(rel).split(/[\\/]+/).filter(x => x && x !== '.');
    if (!parts.length || parts.some(x => x === '..')) throw new Error('bad path');
    return path.join(base, ...parts.map(x => x.replace(/[:*?"<>|\x00-\x1f]/g, '_')));
  }
  async function walk(paths, limit = 50000) {
    const items = []; let total = 0;
    async function add(abs, rel) {
      const st = await fs.promises.lstat(abs);
      if (st.isSymbolicLink()) return;                  // don't follow links out of what was copied
      if (items.length >= limit) throw new Error('too many files');
      if (st.isDirectory()) {
        items.push({ path: abs, rel, dir: true, size: 0 });
        for (const n of await fs.promises.readdir(abs)) await add(path.join(abs, n), rel + '/' + n);
      } else if (st.isFile()) { items.push({ path: abs, rel, dir: false, size: st.size }); total += st.size; }
    }
    for (const p of paths) await add(p, path.basename(p));
    return { items, total, roots: paths.map(p => path.basename(p)) };
  }
  function uniqueNames(base, names) {
    const used = new Set();
    return names.map(n => {
      const ext = path.extname(n), stem = n.slice(0, n.length - ext.length);
      let name = n;
      for (let i = 2; fs.existsSync(path.join(base, name)) || used.has(name); i++) name = `${stem} (${i})${ext}`;
      used.add(name);
      return name;
    });
  }
  const handles = new Map();
  let nextHandle = 1;
  function uniquePath(dir, name) {
    name = path.basename(String(name)).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_') || 'file';
    let p = path.join(dir, name);
    const ext = path.extname(name), base = name.slice(0, name.length - ext.length);
    for (let n = 2; fs.existsSync(p); n++) p = path.join(dir, `${base} (${n})${ext}`);
    return p;
  }
  /* ---------------- lab agent: file access stays inside the signed-in user's folders ---------------- */
  // The agent runs as the system account, which may read and change anything on the PC. Members only get the
  // profile folder of whoever is signed in, the files that person copied, and the transfer folders.
  let clipOffered = [];
  const realOr = p => { try { return fs.realpathSync.native(p); } catch { return null; } };
  // the real location of p (links and junctions resolved), also when the last parts don't exist yet
  function realish(p) {
    const rest = [];
    for (let cur = p; ; ) {
      const r = realOr(cur);
      if (r) return path.join(r, ...rest);
      const up = path.dirname(cur);
      if (up === cur) return null;
      rest.unshift(path.basename(cur)); cur = up;
    }
  }
  const within = (p, root) => { const rel = path.relative(root, p); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
  function allowedPath(p, write) {
    const real = realish(path.resolve(p));
    if (!real) return false;
    const roots = [userDirs().home, stageRoot()].map(realOr).filter(Boolean);
    if (!write) roots.push(...clipOffered.map(realOr).filter(Boolean));
    return roots.some(r => within(real, r));
  }
  function guard(e, p, write = false) {
    p = String(p);
    if (AGENT && isEngine(e.sender) && !allowedPath(p, write)) throw new Error('On this PC, files can only be used in the signed-in user\'s folder');
    return p;
  }

  async function listDir(dir, restricted = false) {
    dir = path.resolve(dir || userDirs().home);
    const names = await fs.promises.readdir(dir);
    const entries = [];
    for (const name of names) {
      if (name.startsWith('.') && process.platform !== 'win32') continue;     // hidden files
      try {
        const st = await fs.promises.stat(path.join(dir, name));
        entries.push({ name, dir: st.isDirectory(), size: st.size, mtime: st.mtimeMs });
      } catch {}
    }
    entries.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    let parent = path.dirname(dir);
    if (restricted && !allowedPath(parent, false)) parent = null;
    const roots = restricted ? [userDirs().home] : process.platform === 'win32'
      ? 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(l => l + ':\\').filter(r => { try { fs.accessSync(r); return true; } catch { return false; } })
      : ['/'];
    return { path: dir, parent: parent !== dir ? parent : null, sep: path.sep, home: userDirs().home, roots, entries };
  }

  /* ---------------- windows ---------------- */
  function openManager() {
    if (manager && !manager.isDestroyed()) { manager.show(); manager.focus(); return; }
    manager = new BrowserWindow({
      width: 900, height: 720, minWidth: 560, minHeight: 480, backgroundColor: '#111318', autoHideMenuBar: true,
      title: labClient ? 'ScreenShare Remote' : trayApp ? product : 'ScreenShare – Remote desktop', webPreferences: { preload, contextIsolation: true, sandbox: true },
    });
    manager.loadFile(page(labClient ? 'lab.html' : 'remote.html'), { query: serverQuery() });
    manager.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    manager.on('closed', () => { manager = null; });
  }

  function openSession(creds) {
    const { id, name } = creds;
    const w = new BrowserWindow({
      width: 1440, height: 900, minWidth: 640, minHeight: 400, backgroundColor: '#000000', autoHideMenuBar: true,
      title: `${name || id} – ${trayApp ? product : 'ScreenShare remote'}`,
      webPreferences: { preload, contextIsolation: true, sandbox: true, backgroundThrottling: false },
    });
    w.setMenu(null);                    // no menu shortcuts (Ctrl+W, Ctrl+R…): every key goes to the remote PC
    w.scSession = true;                 // (Mac: main.js swaps the menu bar for one without shortcuts)
    w.on('page-title-updated', e => e.preventDefault());   // keep "PC name – SC-Remote" (not the page's own title)
    const wcId = w.webContents.id;      // (read now: the window is gone by the time "destroyed" fires on exit)
    sessionCreds.set(wcId, creds);
    w.webContents.on('destroyed', () => sessionCreds.delete(wcId));
    w.loadFile(page('remote-session.html'), { query: q() });
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    // closing: let the page say goodbye to the other PC first (otherwise it notices only after a few seconds)
    let closing = false;
    w.on('close', e => {
      if (closing || w.webContents.isDestroyed() || w.webContents.isCrashed()) return;
      closing = true; e.preventDefault();
      w.webContents.send('session:closing');                       // the page closes itself after that
      setTimeout(() => { if (!w.isDestroyed()) w.close(); }, 1500); // (or we do, if it doesn't)
    });
    // Quit (tray menu, Cmd+Q) while connected: holding the window open above cancels that quit, so once the
    // window has said goodbye and closed, quit again
    w.on('closed', () => { if (quitting) setImmediate(() => app.quit()); });
    return true;
  }

  let quitting = false;
  app.on('before-quit', () => { quitting = true; });

  /* ---------------- saved computers (client side) ---------------- */
  const enc = s => safeStorage.isEncryptionAvailable() ? 'enc:' + safeStorage.encryptString(s).toString('base64') : 'b64:' + Buffer.from(s).toString('base64');
  const dec = s => { try { return s.startsWith('enc:') ? safeStorage.decryptString(Buffer.from(s.slice(4), 'base64')) : Buffer.from(s.slice(4), 'base64').toString(); } catch { return ''; } };
  const saved = () => (readAppSettings().remoteSaved || []);
  const publicSaved = () => saved().map(s => ({ id: s.id, name: s.name, hasPassword: !!s.pw }));

  /* ---------------- IPC ---------------- */
  const h = (ch, fn) => ipcMain.handle(ch, async (e, ...a) => fn(e, ...a));
  h('remote:state', () => publicState());
  h('remote:set-enabled', (_e, on) => setEnabled(on));
  h('remote:set-password', (_e, pw) => { setPassword(pw); return publicState(); });
  h('remote:set-autostart', (_e, on) => { setAutostart(on); return publicState(); });
  h('remote:set-keep-awake', (_e, on) => {
    saveCfg({ keepAwake: !!on });
    if (on && engine && awakeId === null) awakeId = powerSaveBlocker.start('prevent-app-suspension');
    if (!on && awakeId !== null) { powerSaveBlocker.stop(awakeId); awakeId = null; }
    return publicState();
  });
  h('remote:new-id', () => { saveCfg({ id: '' }); ensureId(); if (engine) restartEngine('That PC got a new ID'); return publicState(); });
  h('remote:open-manager', () => openManager());

  /* ---------------- remote edition on Windows: this PC's remote access is run by the service ---------------- */
  const serviceMode = () => !!(lab.serviceExe && fs.existsSync(lab.serviceExe));
  h('remote:service-info', () => {
    if (!serviceMode()) return null;
    let st = null;
    try { st = JSON.parse(fs.readFileSync(lab.statusFile, 'utf8')); } catch {}
    // an agent that is gone (EPERM: it's there, but runs as the system account)
    if (st && st.pid && st.state !== 'off') { try { process.kill(st.pid, 0); } catch (e) { if (e.code !== 'EPERM') st = { ...st, state: 'off' }; } }
    return { status: st, pc: os.hostname() };
  });
  // the service's settings dialog (ID, password, options) needs an administrator: Windows asks (UAC)
  h('remote:service-configure', () => new Promise((resolve, reject) => {
    if (!serviceMode()) return reject(new Error('The remote access service is not installed'));
    const { execFile } = require('child_process');
    const done = err => {
      if (!err) return resolve(true);
      log('service settings: ' + String(err.message || err).trim());
      reject(new Error(/cancel/i.test(String(err.message) + String(err.stderr || '')) ? 'Cancelled' : 'Could not open the settings (they need administrator permission)'));
    };
    if (process.platform === 'win32') {
      const ps = `Start-Process -FilePath '${lab.serviceExe.replace(/'/g, "''")}' -ArgumentList 'configure','--lang=${userLang()}' -Verb RunAs -Wait`;
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true }, done);
    } else execFile(lab.serviceExe, ['configure', '--lang=' + userLang()], done);      // (tests)
  }));

  // engine only
  h('remote:host-config', e => {
    if (!isEngine(e.sender)) return null;
    if (labHost) { const c = labHost.config(); return c && { mode: 'lab', ...c, name: c.pc, os: process.platform }; }
    return { mode: 'password', id: ensureId(), peerId: 'rdesk-' + ensureId(), salt: cfg().salt, name: os.hostname(), os: process.platform, agent: AGENT };
  });
  h('remote:host-sign-hello', (e, nonce, hostFp, clientFp) => (isEngine(e.sender) && labHost ? labHost.signHello(String(nonce), String(hostFp), String(clientFp)) : null));
  h('remote:host-policy', e => (isEngine(e.sender) && labHost ? labHost.signedPolicy() : null));
  h('remote:audit-tail', e => (isEngine(e.sender) && labHost ? labHost.auditTail() : []));
  h('remote:sas', e => { if (isEngine(e.sender) && sessionActive) injector.sas(); });
  // The agent got a new lab version (from a member's sign-in, a publish, or a setup file).
  function onPolicyUpdated(prev) {
    const c = labHost.config();
    if (!c) return;
    if (!prev || prev.labId !== c.labId || prev.peerId !== c.peerId) {     // another lab, or a new name
      if (engine) restartEngine('This PC was moved to another lab'); else startEngine();
      return;
    }
    if (engine) engine.webContents.send('remote:policy-changed', c);
    // someone in control whose access was just removed (or whose role changed) is disconnected
    const still = session && labHost.memberByFp(session.fp);
    if (session && engine && (!still || still.role !== session.role)) {
      labHost.audit('removed-during-session', { member: session.name });
      engine.webContents.send('remote:kick', 'Your access to this lab was changed');
    }
    setStatus(status);                         // the status file shows the new version
  }
  h('remote:verify-key', async (e, payload, peer) => {
    if (!isEngine(e.sender) || !labHost || !payload) return { ok: false, reason: 'not allowed' };
    const before = labHost.config();
    const r = labHost.verifyMember(payload);
    if (labHost.version() !== (before ? before.version : 0)) onPolicyUpdated(before);
    if (!r.ok) return r;
    if (payload.purpose === 'publish') { labHost.audit('publish', { member: r.member.name, version: labHost.version() }); return { ...r, version: labHost.version() }; }
    if (!(await askConsent(r.member.name))) { labHost.audit('declined', { member: r.member.name }); return { ok: false, reason: 'The person at that PC declined the connection.' }; }
    endSession();                            // a new controller replaces the old one
    session = { ...r.member, peer, started: Date.now() };
    sessionActive = true;
    currentSid = ++sessionSeq;
    injector.start().then(ok => { if (!ok && engine) engine.webContents.send('remote:input-error', injector.error || 'input helper failed'); });
    labHost.audit('connect', { member: r.member.name, role: r.member.role, fp: r.member.fp });
    setStatus({ state: 'connected', peer: r.member.name });
    openBanner(r.member.name);
    setTimeout(() => { if (engine && inputDesktop !== 'Default') engine.webContents.send('remote:desktop', inputDesktop); updateScreenHelper(); }, 1500);
    return { ...r, version: labHost.version(), sid: currentSid };
  });
  h('remote:pake-start', e => (isEngine(e.sender) ? pakeStart() : null));
  h('remote:verify', async (e, nonce, mac, peer, bind, extra) => {
    if (!isEngine(e.sender)) return { ok: false, reason: 'not allowed' };
    const name = String(peer || 'someone').slice(0, 60);       // what the other PC calls itself (not verified)
    bind = bind && typeof bind.hostFp === 'string' && typeof bind.clientFp === 'string' ? { hostFp: bind.hostFp, clientFp: bind.clientFp } : null;
    const from = extra && typeof extra === 'object' ? { addr: cleanAddr(extra.addr), relay: !!extra.relay } : {};
    const pk = extra && extra.pake && typeof extra.pake === 'object' ? { id: String(extra.pake.id), A: extra.pake.A, m1: extra.pake.m1 } : null;
    const r = verify(String(nonce), String(mac), bind, extra && typeof extra.cnonce === 'string' ? extra.cnonce : '', pk);
    if (!r.ok) {
      if (AGENT) audit('denied', { name, addr: from.addr, reason: r.reason });
      historyAdd('denied', name, from, r.code || 'bad');
      return { ok: false, reason: r.reason };
    }
    if (AGENT && !(await askConsent(name))) {
      audit('declined', { name, addr: from.addr }); historyAdd('denied', name, from, 'declined');
      return { ok: false, reason: 'The person at that PC declined the connection.' };
    }
    endSession();                       // a new controller replaces the old one
    historyAdd('session', name, from);
    sessionActive = true;
    currentSid = ++sessionSeq;
    r.sid = currentSid;
    injector.start().then(ok => { if (!ok && engine) engine.webContents.send('remote:input-error', injector.error || 'input helper failed'); });
    setStatus({ state: 'connected', peer: name });
    if (AGENT) {
      session = { name, started: Date.now() };
      audit('connect', { name, addr: from.addr, relay: from.relay });
      openBanner(name);
      setTimeout(() => { if (engine && inputDesktop !== 'Default') engine.webContents.send('remote:desktop', inputDesktop); updateScreenHelper(); }, 1500);
    }
    return r;
  });
  h('remote:session-end', (e, sid) => { if (isEngine(e.sender) && (sid == null || sid === currentSid)) { endSession(); setStatus({ state: 'online' }); } });
  h('remote:status', (e, s) => { if (isEngine(e.sender) && !(sessionActive && s.state === 'online')) setStatus(s); });
  h('remote:displays', async e => isEngine(e.sender) ? (await listDisplays()).map(({ source, ...d }) => d) : []);
  h('remote:select-display', async (e, i) => {
    if (!isEngine(e.sender)) return null;
    const list = await listDisplays();
    const d = list[i] || list.find(x => x.primary) || list[0];
    if (!d) return null;
    capture = { source: d.source, rect: d.rect };
    const { source, ...info } = d;
    return info;
  });
  ipcMain.on('remote:input', (e, ev) => {
    if (!sessionActive || !isEngine(e.sender) || !ev) return;
    if (dragging && (ev.t === 'm' || ev.t === 'b' || ev.t === 'w')) return;
    if (ev.t === 'm' && capture.rect) {
      const r = capture.rect;
      const x = Math.min(Math.max(ev.x, 0), 1), y = Math.min(Math.max(ev.y, 0), 1);
      injector.move(r.x + Math.min(Math.floor(x * r.width), r.width - 1), r.y + Math.min(Math.floor(y * r.height), r.height - 1));
    } else if (ev.t === 'b') injector.button(ev.b, !!ev.d);
    else if (ev.t === 'w') injector.wheel(ev.dx || 0, ev.dy || 0);
    else if (ev.t === 'k') injector.key(String(ev.c), !!ev.d, !!ev.r);
    else if (ev.t === 'release') injector.releaseAll();
  });

  // sessions (client)
  h('remote:connect', (_e, { id, password, name, remember }) => {
    id = String(id || '').replace(/\D/g, '');
    if (id.length !== 9) throw new Error('The ID has 9 digits');
    let pw = password;
    const list = saved();
    const existing = list.find(s => s.id === id);
    if (!pw && existing && existing.pw) pw = dec(existing.pw);
    if (!pw) throw new Error('Enter the password');
    // saved (or its password updated) only once the password has worked: see session:signed-in
    return openSession({ mode: 'password', id, peerId: 'rdesk-' + id, password: pw, name: name || (existing && existing.name), remember: !!remember });
  });
  // the session window signed in: keep that PC in the list with the password that worked (if it was to be
  // remembered, or is already in the list, e.g. its password was changed and retyped)
  // the session window signing in to a PC: answer the PC's half of the sign-in with the typed password
  // (the key is derived here, off the main thread; nothing that leaves lets anyone test password guesses)
  h('session:pake', async (e, q) => {
    if (!sessionCreds.has(e.sender.id) || !q || typeof q.password !== 'string' || !/^[0-9a-f]{16,128}$/.test(q.salt || '') || !/^[0-9a-f]{64}$/.test(q.nonce || '')) return null;
    const key = await new Promise((res, rej) => crypto.pbkdf2(q.password, Buffer.from(q.salt, 'hex'), PBKDF2_ROUNDS, 32, 'sha256', (err, k) => (err ? rej(err) : res(k))));
    return srp.clientAnswer(key, q.B, { nonce: q.nonce, salt: q.salt, hostFp: String(q.hostFp), clientFp: String(q.clientFp) });
  });
  h('session:signed-in', (e, password) => {
    const c = sessionCreds.get(e.sender.id);
    if (!c || c.mode !== 'password' || typeof password !== 'string' || !password) return false;
    c.password = password;
    const list = saved();
    const existing = list.find(s => s.id === c.id);
    if (!c.remember && !existing) return false;
    if (existing && existing.pw && dec(existing.pw) === password && (existing.name || '') === (c.name || existing.name || '')) return false;
    writeAppSettings({ remoteSaved: [...list.filter(s => s.id !== c.id), { id: c.id, name: c.name || (existing && existing.name) || c.id, pw: enc(password) }] });
    if (manager && !manager.isDestroyed()) manager.webContents.send('remote:saved-changed');
    return true;
  });
  // the Files panel opens where it was last time, per PC
  const filesKey = c => (c.mode === 'lab' ? 'lab:' + c.peerId : 'id:' + c.id);
  h('session:files-dir', (e, dir) => {
    const c = sessionCreds.get(e.sender.id);
    if (!c) return null;
    const dirs = readAppSettings().remoteFileDirs || {};
    if (dir == null) return dirs[filesKey(c)] || null;
    const next = { ...dirs };
    delete next[filesKey(c)];
    next[filesKey(c)] = String(dir).slice(0, 1000);
    const keys = Object.keys(next);                             // keep the 100 most recent
    for (const k of keys.slice(0, Math.max(0, keys.length - 100))) delete next[k];
    writeAppSettings({ remoteFileDirs: next });
    return true;
  });
  // Files panel preferences: favourite folders on each PC (per PC) and on this computer, where downloads go,
  // and the folder last open on this computer. null reads them; an object changes those keys.
  h('session:file-prefs', (e, patch) => {
    const c = sessionCreds.get(e.sender.id);
    if (!c) return null;
    const st = readAppSettings(), key = filesKey(c);
    const paths = v => (Array.isArray(v) ? v.map(String).filter(p => p && p.length <= 1000).slice(-20) : []);
    if (patch && typeof patch === 'object') {
      const next = {};
      if ('remoteFavs' in patch) {
        const all = { ...(st.remoteFileFavs || {}) }; delete all[key];
        const list = paths(patch.remoteFavs); if (list.length) all[key] = list;
        const keys = Object.keys(all); for (const k of keys.slice(0, Math.max(0, keys.length - 100))) delete all[k];
        next.remoteFileFavs = all;
      }
      if ('localFavs' in patch) next.localFileFavs = paths(patch.localFavs);
      if ('downloadDir' in patch) next.fileDownloadDir = patch.downloadDir ? String(patch.downloadDir).slice(0, 1000) : null;
      if ('localDir' in patch) next.localFilesDir = patch.localDir ? String(patch.localDir).slice(0, 1000) : null;
      writeAppSettings(next);
      return true;
    }
    const isDir = p => { try { return !!p && fs.statSync(p).isDirectory(); } catch { return false; } };
    return { remoteFavs: (st.remoteFileFavs || {})[key] || [], localFavs: st.localFileFavs || [],
             downloadDir: isDir(st.fileDownloadDir) ? st.fileDownloadDir : null, localDir: isDir(st.localFilesDir) ? st.localFilesDir : null };
  });
  h('fs:places', () => {
    const p = n => { try { return app.getPath(n); } catch { return null; } };
    return { home: os.homedir(), desktop: p('desktop'), documents: p('documents'), downloads: p('downloads') };
  });
  h('remote:saved', () => publicSaved());
  h('remote:forget', (_e, id) => { writeAppSettings({ remoteSaved: saved().filter(s => s.id !== id) }); return publicSaved(); });
  h('session:creds', e => {
    const c = sessionCreds.get(e.sender.id);
    if (!c) return null;
    const me = labClient ? labClient.me().name : os.hostname();
    return { ...c, me };
  });

  /* ---------------- lab edition: member side ---------------- */
  if (labClient) {
    const L = labClient;
    h('lab:me', () => L.me());
    h('lab:set-name', (_e, n) => L.setName(n));
    h('lab:labs', () => L.labs());
    h('lab:import-text', (_e, t) => L.importSetup(t));
    h('lab:import-file', async e => {
      const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { title: 'Import lab file', filters: [{ name: 'ScreenShare lab', extensions: ['json'] }], properties: ['openFile'] });
      if (r.canceled || !r.filePaths[0]) return null;
      return L.importSetup(fs.readFileSync(r.filePaths[0], 'utf8'));
    });
    h('lab:export-file', async (e, labId) => {
      const v = L.lab(labId);
      const r = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), { title: 'Save lab setup file',
        defaultPath: path.join(app.getPath('documents'), 'lab-setup.json'), filters: [{ name: 'ScreenShare lab', extensions: ['json'] }] });
      if (r.canceled || !r.filePath) return null;
      fs.writeFileSync(r.filePath, L.exportSetup(labId));
      log(`lab: exported setup file for "${v.lab}" v${v.version}`);
      return r.filePath;
    });
    h('lab:create', (_e, name) => L.createLab(name));
    h('lab:update', (_e, labId, changes) => { const v = L.update(labId, changes || {}); setTimeout(() => { try { syncLocalAgent(); } catch {} }, 0); return v; });
    h('lab:forget', (_e, labId) => { L.forget(labId); return L.labs(); });
    h('lab:target', (_e, labId, pc) => L.target(labId, String(pc || '').trim()));
    h('lab:connect', (_e, labId, pc) => {
      pc = String(pc || '').trim();
      if (!pc) throw new Error('Enter the PC name');
      const t = L.target(labId, pc);
      return openSession({ ...t, id: t.peerId, name: `${pc} – ${t.lab}` });
    });
    h('lab:set-published', (_e, labId, pc, v) => L.setPublished(labId, pc, v));
    h('lab:save-pc', (_e, labId, pc, on) => L.savePc(labId, pc, on !== false));
    h('lab:remember', (_e, labId, pc) => { L.remember(labId, pc); if (manager && !manager.isDestroyed()) manager.webContents.send('lab:changed'); });
    h('lab:check-host', (_e, labId, pc, hello, hostFp, clientFp) => L.checkHost(labId, pc, hello || {}, String(hostFp), String(clientFp)));
    h('lab:trust-host', (_e, labId, pc, hostKey) => L.trustHost(labId, pc, hostKey));
    h('lab:sign-auth', (_e, labId, pc, nonce, hostFp, clientFp, purpose) => L.signAuth(labId, pc, String(nonce), String(hostFp), String(clientFp), purpose === 'publish' ? 'publish' : 'session'));
    h('lab:version', (_e, labId) => L.version(labId));
    h('lab:signed-policy', (_e, labId) => L.signedPolicy(labId));
    h('lab:offer', (_e, labId, sp) => L.offer(labId, sp));
    // a lab PC's own status (written by its background agent), if this is one
    const readThisPc = () => { try { return lab.statusFile ? JSON.parse(fs.readFileSync(lab.statusFile, 'utf8')) : null; } catch { return null; } };
    // Linux: the app and this computer's own agent share the user's files, so they pass newer lab versions to
    // each other directly (on Windows the agent's folder is for administrators only: there it goes over the network)
    function syncLocalAgent() {
      if (process.platform !== 'linux' || !lab.agentDir) return;
      const st = readThisPc();
      if (!st || !st.labId || st.state === 'off' || !agentPid() || !L.lab(st.labId)) return;
      const mine = L.version(st.labId), theirs = st.version || 0;
      if (mine > theirs) {
        const f = path.join(lab.agentDir, 'lab-setup.json');
        if (!fs.existsSync(f)) { fs.writeFileSync(f, L.exportSetup(st.labId), { mode: 0o600 }); log(`lab: passing version ${mine} to this PC's agent (it has ${theirs})`); }
      } else if (theirs > mine) {
        try {
          const h = JSON.parse(fs.readFileSync(path.join(lab.agentDir, 'lab-host.json'), 'utf8'));
          if (h.policy && L.offer(st.labId, h.policy) && manager && !manager.isDestroyed()) manager.webContents.send('lab:changed');
        } catch {}
      }
      if (theirs && (L.lab(st.labId).publish || {})[slug(st.pc)] !== theirs) L.setPublished(st.labId, st.pc, theirs);
    }
    h('lab:this-pc', () => {
      try { syncLocalAgent(); } catch (e) { log('lab: local sync: ' + e.message); }
      const st = readThisPc();
      // Linux: an agent that was stopped without saying so (killed, crashed)
      if (st && process.platform === 'linux' && st.state !== 'off' && st.pid && !agentPid()) return { ...st, state: 'off' };
      return st;
    });

    /* ---- this computer as a lab PC, on Linux (Windows lab PCs are set up by the installer and its service) ---- */
    const { slug } = require('./lab');
    const pcName = () => process.env.SCREENSHARE_PC_NAME || os.hostname();
    const agentAutostartFile = () => path.join(os.homedir(), '.config', 'autostart', 'screenshare-remote-lab-pc.desktop');
    const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
    // (checks it really is our agent: a stale number may belong to another program by now)
    // (Chromium rewrites its command line into one space-separated title, so match the flag either way)
    const isAgent = pid => { try { return /(^|[\s\0])--lab-agent([\s\0]|$)/.test(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8')); } catch { return false; } };
    const agentPid = () => { const st = readThisPc(); return st && st.pid && alive(st.pid) && isAgent(st.pid) ? st.pid : 0; };
    async function stopAgent() {
      const pid = agentPid();
      if (!pid) return;
      try { process.kill(pid, 'SIGTERM'); } catch {}
      for (let i = 0; i < 30 && alive(pid); i++) await new Promise(r => setTimeout(r, 100));
      if (alive(pid)) try { process.kill(pid, 'SIGKILL'); } catch {}
    }
    function writeAgentAutostart(on) {
      const f = agentAutostartFile();
      if (!on) { fs.rmSync(f, { force: true }); return; }
      const { exe, args } = launchCommand();
      const q = s => /[\s"'\\$`]/.test(s) ? `"${s.replace(/(["\\$`])/g, '\\$1')}"` : s;
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, ['[Desktop Entry]', 'Type=Application', 'Name=ScreenShare Remote (lab PC)',
        'Comment=Lets members of your lab control this PC',
        `Exec=${[exe, ...(process.argv.includes('--no-sandbox') ? ['--no-sandbox'] : []), ...args.filter(a => a !== '--background'), '--lab-agent'].map(q).join(' ')}`,
        'Terminal=false', 'X-GNOME-Autostart-enabled=true', 'X-GNOME-Autostart-Delay=5', ''].join('\n'));
    }
    h('lab:host-info', () => {
      const st = readThisPc(), pid = agentPid();
      return { canHost: process.platform === 'linux', pc: pcName(), running: !!pid, labId: pid && st ? st.labId : null,
               autostart: fs.existsSync(agentAutostartFile()) };
    });
    h('lab:host-start', async (_e, labId, autostart) => {
      if (process.platform !== 'linux') throw new Error('On Windows, lab PCs are set up with the installer');
      let v = L.lab(labId), added = false;
      if (!v.myRole) throw new Error('Your key is not in this lab');
      // admins: put this PC in the lab's list, so members see it
      if (v.myRole === 'admin' && !v.pcs.some(x => slug(x) === slug(pcName()))) { v = L.update(labId, { pcs: [...v.pcs, pcName()] }); added = true; }
      await stopAgent();
      fs.mkdirSync(lab.agentDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(lab.agentDir, 'lab-setup.json'), L.exportSetup(labId), { mode: 0o600 });
      const { exe, args } = launchCommand();
      const { spawn } = require('child_process');
      // (carry over --no-sandbox: if this copy needed it, so will the agent)
      const extra = process.argv.includes('--no-sandbox') ? ['--no-sandbox'] : [];
      const p = spawn(exe, [...extra, ...args.filter(a => a !== '--background'), '--lab-agent'], { detached: true, stdio: 'ignore', env: process.env });
      p.unref();
      writeAgentAutostart(!!autostart);
      log(`lab: this PC (${pcName()}) is now a lab PC of "${v.lab}"${autostart ? ', also after login' : ''}`);
      return { pc: pcName(), added, version: v.version, listed: v.pcs.some(x => slug(x) === slug(pcName())) };
    });
    h('lab:host-autostart', (_e, on) => { if (agentPid()) writeAgentAutostart(!!on); return fs.existsSync(agentAutostartFile()); });
    h('lab:host-stop', async () => {
      await stopAgent();
      writeAgentAutostart(false);
      const st = readThisPc();
      if (st) try { fs.writeFileSync(lab.statusFile, JSON.stringify({ ...st, state: 'off', pid: 0, updated: new Date().toISOString() })); } catch {}
      log('lab: this PC is no longer reachable as a lab PC');
      return true;
    });
  }
  h('session:set-title', (e, title) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.setTitle(String(title)); });

  // clipboard + files (our own local pages only: engine, manager, sessions)
  // (Windows test: the controller and the PC are one machine there, with one clipboard; the controller's side
  //  leaves it alone, or the two would pass the same files back and forth)
  const testSharedClip = !!(process.env.SCREENSHARE_TEST && process.env.SCREENSHARE_TEST_CONTROLLER_NO_CLIPBOARD);
  h('clip:watch', (e, on) => (testSharedClip && !isEngine(e.sender) ? null : watchClipboard(e.sender, !!on)));
  h('clip:set', async (e, payload) => {
    if (testSharedClip && !isEngine(e.sender)) return;
    try { await setClipboard(payload || {}); if (payload && payload.kind === 'files') log(`clipboard: ${payload.paths.length} item(s) ready to paste`); }
    catch (e) { log(`clipboard: could not set ${payload && payload.kind}: ${e.message}`); throw e; }
  });
  h('remote:log', (_e, m) => log(String(m).slice(0, 500)));
  h('fs:list', (e, dir) => listDir(dir ? guard(e, dir) : null, !!(AGENT && isEngine(e.sender))));
  h('fs:downloads', () => { const d = path.join(userDirs().downloads, 'ScreenShare'); fs.mkdirSync(d, { recursive: true }); return d; });
  h('fs:open-read', async (e, p) => {
    p = guard(e, p);
    const st = await fs.promises.stat(p);
    if (st.isDirectory()) throw new Error('That is a folder');
    const fd = await fs.promises.open(p, 'r');
    const handle = nextHandle++; handles.set(handle, fd);
    return { handle, size: st.size, name: path.basename(p) };
  });
  h('fs:read', async (_e, handle, offset, length) => {
    const fd = handles.get(handle); if (!fd) throw new Error('closed');
    const buf = Buffer.alloc(Math.min(length, 1024 * 1024));
    const { bytesRead } = await fd.read(buf, 0, buf.length, offset);
    return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
  });
  h('fs:open-write', async (e, dir, name) => {
    const p = guard(e, uniquePath(String(dir), name), true);
    const fd = await fs.promises.open(p, 'wx');
    const handle = nextHandle++; handles.set(handle, fd);
    return { handle, path: p };
  });
  h('fs:write', async (_e, handle, data) => { const fd = handles.get(handle); if (!fd) throw new Error('closed'); await fd.write(Buffer.from(data)); });
  h('fs:close', async (e, handle, removePath) => {
    const fd = handles.get(handle); handles.delete(handle);
    if (fd) await fd.close().catch(() => {});
    if (removePath) guard(e, removePath, true);
    if (removePath) await fs.promises.rm(removePath, { force: true }).catch(() => {});
  });
  // (never from the lab agent: a file manager started by the system account would give the person at the PC its rights)
  h('fs:reveal', (_e, p) => { if (!AGENT) shell.showItemInFolder(String(p)); });
  h('fs:walk', (e, paths) => walk((paths || []).map(p => guard(e, p))));
  h('fs:stage', () => newStage());
  h('fs:unique', (e, base, names) => uniqueNames(guard(e, base), (names || []).map(String)));
  h('fs:mkdir-rel', async (e, base, rel) => { await fs.promises.mkdir(guard(e, safeJoin(base, rel), true), { recursive: true }); });
  h('fs:open-write-rel', async (e, base, rel) => {
    const p = guard(e, safeJoin(base, rel), true);
    await fs.promises.mkdir(path.dirname(p), { recursive: true });
    const fd = await fs.promises.open(p, 'w');
    const handle = nextHandle++; handles.set(handle, fd);
    return { handle, path: p };
  });
  h('fs:join', (_e, base, names) => (names || []).map(n => safeJoin(String(base), String(n))));
  h('remote:drop-files', async (e, paths, x, y) => isEngine(e.sender) ? dropFiles(paths, x, y) : { ok: false });

  return {
    startAppTray, startUpdateChecks,
    start() {
      if (hostEnabled()) { startEngine(); updateTray(); }
      if (AGENT && !labHost) {
        if (!hostEnabled()) setStatus({ state: 'off' });
        if (process.platform === 'win32' || process.env.SCREENSHARE_TEST_DESKTOP) startDesktopWatch();
        // the settings dialog changed the password or options: a new password ends sessions made with the old one
        let stamp = lab.accessStamp ? lab.accessStamp() : '';
        let keyNow = cfg().key;
        setInterval(() => {
          const st = lab.accessStamp ? lab.accessStamp() : '';
          if (st === stamp) return;
          stamp = st;
          const keyChanged = cfg().key !== keyNow; keyNow = cfg().key;
          if (!hostEnabled()) { stopEngine('Remote access to that PC was turned off'); return; }
          if (!engine) startEngine();
          else if (keyChanged) restartEngine('The password of that PC was changed');
          else setStatus(status);
        }, 3000).unref();
      }
      if (labHost) {
        setStatus({ state: labHost.ready() ? 'starting' : 'not-set-up' });
        if (process.platform === 'win32' || process.env.SCREENSHARE_TEST_DESKTOP) startDesktopWatch();
        // a new setup file (installer run again; on Linux, the app passing on a newer version): pick it up
        setInterval(() => {
          const before = labHost.config();
          labHost.importPending();
          if (JSON.stringify(labHost.config()) !== JSON.stringify(before)) onPolicyUpdated(before);
        }, 4000).unref();
      }
    },
    isEnabled: () => hostEnabled(),
    isEngine,
    captureSource: () => capture.source,
    openManager,
    shutdown() { injector.stop(); clipFiles.stop(); stopScreenHelper(); },
  };
};
