const { app, BrowserWindow, ipcMain, session, desktopCapturer, MessageChannelMain, webContents, safeStorage } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Editions from one code base:
//  - personal ("ScreenShare"): streaming + remote desktop with ID and password, portable
//  - remote ("SC-Remote"): remote desktop only, AnyDesk-style ID and password, Windows installer; a
//    system service starts the "agent" (this app with --agent) before anyone signs in
//  - lab (paused): remote desktop only, members sign in with personal keys (agent: --lab-agent)
const PKG = require('./package.json');
const EDITION = process.env.SCREENSHARE_EDITION || PKG.edition || 'personal';
const LAB = EDITION === 'lab';
const REMOTE_ED = EDITION === 'remote';
const REMOTE_ONLY = LAB || REMOTE_ED;                     // no streaming
const AGENT = (LAB && (process.argv.includes('--lab-agent') || process.argv.includes('--agent'))) || (REMOTE_ED && process.argv.includes('--agent'));
// the remote edition is named by its build (SC-Remote); the paused lab edition keeps its old name
const PRODUCT = REMOTE_ED ? (PKG.edition === 'remote' ? PKG.productName : 'SC-Remote') : LAB ? 'ScreenShare Remote' : 'ScreenShare';
if (REMOTE_ONLY) app.setName(PRODUCT);                    // before anything reads the profile folder
// lab files shared by the agent and the app: ProgramData on Windows (set up by the installer)
// (tests: SCREENSHARE_TEST_PLATFORM=darwin runs the Mac's connect-only behaviour on Linux)
const PLATFORM = (process.env.SCREENSHARE_TEST && process.env.SCREENSHARE_TEST_PLATFORM) || process.platform;
const LAB_ROOT = process.env.SCREENSHARE_LAB_ROOT || (process.platform === 'win32'
  ? path.join(process.env.ProgramData || 'C:\\ProgramData', REMOTE_ED ? PRODUCT : 'ScreenShare Remote')
  : path.join(os.homedir(), '.local', 'share', 'screenshare-remote'));
const AGENT_DIR = path.join(LAB_ROOT, 'agent');          // the PC's identity key, policy, audit log (admins only)
if (AGENT) {
  try { fs.mkdirSync(path.join(AGENT_DIR, 'profile'), { recursive: true }); app.setPath('userData', path.join(AGENT_DIR, 'profile')); } catch {}
  // the agent runs as the system account in the user's session, where Chromium's sandbox can't start
  if (process.platform === 'win32') app.commandLine.appendSwitch('no-sandbox');
}

// Portable: keep settings in a folder next to the .exe / AppImage instead of the user profile.
const portableDir = !REMOTE_ONLY && (process.env.PORTABLE_EXECUTABLE_DIR || (process.env.APPIMAGE && path.dirname(process.env.APPIMAGE)));
if (portableDir) {
  const dir = path.join(portableDir, 'ScreenShare-data');
  try { fs.mkdirSync(dir, { recursive: true }); app.setPath('userData', dir); } catch { /* read-only folder: use the default */ }
}

// App settings that must be known before Chromium starts (stored next to the page's own settings).
const SETTINGS_FILE = path.join(app.getPath('userData'), 'app-settings.json');
function readAppSettings() { try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return {}; } }
function writeAppSettings(patch) {
  const next = { ...readAppSettings(), ...patch };
  try { fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true }); fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2)); } catch {}
  return next;
}
// Video encoder: 'hardware' = GPU encoder when available (AMD/NVIDIA/Intel via Media Foundation, VA-API…),
// 'software' = CPU encoders (OpenH264 for H.264, libvpx for VP8/VP9). Chromium reads this only at startup.
const ENCODER = readAppSettings().encoder === 'software' ? 'software' : 'hardware';
if (ENCODER === 'software') app.commandLine.appendSwitch('disable-accelerated-video-encode');

// Keep capture/encoding at full speed while the game is in front of this window.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
// Windows: Chromium treats a window covered by a fullscreen game as hidden and throttles it. Turn that off.
if (process.platform === 'win32') app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
if (process.platform === 'linux') app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');

const audio = REMOTE_ONLY ? null
  : process.env.SCREENSHARE_FAKE_AUDIO ? require('./scripts/fake-audio')
  : process.platform === 'win32' ? require('./audio-windows')
  : process.platform === 'linux' ? require('./audio-linux')
  : null;

let win = null;
let audioPort = null;
let remote = null;
const BACKGROUND = process.argv.includes('--background');    // started with the computer: no window, just the remote host
const serverQuery = () => process.env.SCREENSHARE_SERVER ? { server: process.env.SCREENSHARE_SERVER } : {};

// One copy at a time: the remote host keeps a fixed ID, and a second copy would fight over it.
// (The lab agent has its own profile folder, so it doesn't block the app of whoever is signed in.)
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
// Our windows only ever show the app's own pages: no navigating elsewhere (a link, a dropped file), no new
// windows, no embedded pages. (The agent's windows run with the system account's rights.)
app.on('web-contents-created', (_e, wc) => {
  const stay = (e, url) => { if (url !== wc.getURL()) e.preventDefault(); };     // (reloading the same page is fine)
  wc.on('will-navigate', stay);
  wc.on('will-redirect', stay);
  wc.on('will-attach-webview', e => e.preventDefault());
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
});
app.on('second-instance', (_e, argv) => { if (!AGENT && !argv.includes('--background')) openMainWindow(); });

function openMainWindow() {
  if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); return; }
  createWindow();
}

const ownPids = () => new Set([process.pid, ...app.getAppMetrics().map(m => m.pid)]);

function createWindow() {
  if (REMOTE_ONLY) { remote.openManager(); return; }
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 720, minHeight: 520,
    backgroundColor: '#111318',
    autoHideMenuBar: true,
    title: 'ScreenShare',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  win.loadFile(path.join(__dirname, 'app', 'screenshare.html'), { query: serverQuery() });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('closed', () => { if (audio) audio.stopSync(); win = null; });
}

// Screen/window picker: list sources and let the page show them, instead of the browser's dialog.
let pendingPick = null;
ipcMain.on('pick-source:result', (_e, id) => { if (pendingPick) { pendingPick(id); pendingPick = null; } });

function setupCapture() {
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      // the remote host captures the screen the controller picked, without any dialog
      const from = request.frame ? webContents.fromFrame(request.frame) : null;
      if (remote && remote.isEngine(from)) { const src = remote.captureSource(); callback(src ? { video: src } : null); return; }
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } });
      // On Wayland the system dialog already asked the user and returns just the chosen source.
      let chosen = sources.length === 1 ? sources[0] : null;
      if (!chosen && sources.length) {
        if (pendingPick) pendingPick(null);
        const id = await new Promise(resolve => {
          pendingPick = resolve;
          (from || win.webContents).send('pick-source', sources.map(s => ({
            id: s.id, name: s.name, screen: s.id.startsWith('screen:'), thumb: s.thumbnail.toDataURL(),
          })));
        });
        chosen = sources.find(s => s.id === id) || null;
      }
      callback(chosen ? { video: chosen } : null);
    } catch (e) {
      console.error('capture picker', e);
      callback(null);
    }
  });
}

// ---- per-app audio ----
function stopAudio() {
  if (audio) audio.stop();
  if (audioPort) { try { audioPort.close(); } catch {} audioPort = null; }
}

ipcMain.handle('audio:list', async () => {
  if (!audio) return [];
  return audio.list(ownPids());
});

ipcMain.handle('audio:start', async (event, id) => {
  if (!audio) throw new Error('Per-app audio is not supported on this OS');
  stopAudio();
  // PCM from the native capture goes straight to the page's audio thread through a MessagePort.
  const { port1, port2 } = new MessageChannelMain();
  // Pipes deliver arbitrary byte counts; only whole frames (4 bytes: 2 ch × s16) go to the page.
  let carry = null;
  const onChunk = chunk => {
    if (carry) { chunk = Buffer.concat([carry, chunk]); carry = null; }
    const extra = chunk.length % 4;
    if (extra) { carry = Buffer.from(chunk.subarray(chunk.length - extra)); chunk = chunk.subarray(0, chunk.length - extra); }
    if (chunk.length) { try { port1.postMessage(new Uint8Array(chunk)); } catch {} }   // copy: don't ship Node's shared buffer pool
  };
  let result;
  try { result = await audio.start(id, onChunk, ownPids); }
  catch (e) { audio.stop(); port1.close(); port2.close(); throw e; }
  if (result.type === 'pcm') {
    audioPort = port1;
    event.sender.postMessage('audio:port', null, [port2]);
  } else {
    port1.close(); port2.close();
  }
  return result;
});

ipcMain.handle('audio:stop', () => stopAudio());
ipcMain.handle('remote:open', () => remote && remote.openManager());

ipcMain.handle('encoder:get', () => ENCODER);
ipcMain.handle('encoder:set', (_e, value) => {
  if (!['hardware', 'software'].includes(value)) return ENCODER;
  writeAppSettings({ encoder: value });
  return value;
});
// Restart to apply the encoder. Portable builds must relaunch the outer .exe / AppImage,
// because the unpacked copy they run from is removed when the app exits.
ipcMain.handle('app:restart', () => {
  const outer = process.env.PORTABLE_EXECUTABLE_FILE || process.env.APPIMAGE;
  app.relaunch(outer ? { execPath: outer, args: [] } : {});
  cleanupSync();
  app.exit(0);
});

// Clean up the audio routing however the app ends: normal quit, window closed, Ctrl+C, logout/shutdown.
function cleanupSync() { if (audio) audio.stopSync(); if (remote) remote.shutdown(); }
app.on('will-quit', cleanupSync);
process.on('exit', cleanupSync);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { cleanupSync(); app.exit(0); });

// Windows gives the focused game priority; run our capture, encoder and audio processes at
// above-normal priority so they keep up. (Re-applied because Chromium starts processes later.)
function boostPriority() {
  if (process.platform !== 'win32') return;
  for (const m of app.getAppMetrics()) {
    if (!['Browser', 'GPU', 'Tab', 'Utility'].includes(m.type)) continue;
    try { os.setPriority(m.pid, os.constants.priority.PRIORITY_ABOVE_NORMAL); } catch {}
  }
}

// SC-Remote updates: the release manifest on GitHub and the key it must be signed with (both set at build time,
// see build/remote.config.js). The service installs the update; see windows/Service.cs.
function updateConfig() {
  const u = PKG.update || {};
  const test = !!process.env.SCREENSHARE_TEST;           // (tests: a local manifest, signed with a test key)
  const manifestUrl = (test && process.env.SCREENSHARE_UPDATE_URL) || u.manifestUrl;
  const publicKey = test && process.env.SCREENSHARE_UPDATE_KEY ? fs.readFileSync(process.env.SCREENSHARE_UPDATE_KEY, 'utf8') : u.publicKey;
  if (!manifestUrl || !publicKey) return null;
  const allowedPrefix = (test && process.env.SCREENSHARE_UPDATE_PREFIX) || (u.repo ? `https://github.com/${u.repo}/releases/download/` : null);
  return { manifestUrl, publicKey, allowedPrefix, page: (test && process.env.SCREENSHARE_UPDATE_PAGE) || (u.repo ? `https://github.com/${u.repo}/releases/latest` : null),
           stateFile: path.join(LAB_ROOT, 'update-state.json'), justUpdated: process.argv.includes('--updated') };
}

app.whenReady().then(() => {
  // the agent's windows run with the system account's rights: no menu shortcuts (reload, developer tools…)
  if (AGENT) require('electron').Menu.setApplicationMenu(null);
  boostPriority();
  setInterval(boostPriority, 5000);
  if (audio && audio.recoverStale) audio.recoverStale();
  setupCapture();
  // a small log next to the settings, so problems on the other PC can be looked at afterwards
  const LOG = path.join(app.getPath('userData'), 'remote.log');
  const log = msg => {
    try {
      if (fs.existsSync(LOG) && fs.statSync(LOG).size > 512 * 1024) fs.renameSync(LOG, LOG + '.old');
      fs.appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`);
    } catch {}
  };
  const lab = {};
  // who is signed in at this PC (written by the service), so the agent puts files in their folders
  const userContext = () => {
    try {
      const u = JSON.parse(fs.readFileSync(path.join(LAB_ROOT, 'session.json'), 'utf8'));
      if (u.home && fs.existsSync(u.home)) return { home: u.home, temp: u.temp || path.join(u.home, 'AppData', 'Local', 'Temp'), downloads: u.downloads || path.join(u.home, 'Downloads') };
    } catch {}
    if (process.platform !== 'win32') return null;
    const pub = path.join(process.env.PUBLIC || 'C:\\Users\\Public');      // nobody signed in
    return { home: pub, temp: path.join(AGENT_DIR, 'transfers'), downloads: path.join(pub, 'Downloads') };
  };
  let settingsIO = { readAppSettings, writeAppSettings };
  if (REMOTE_ED && AGENT) {
    // the ID, password check and options come from access.json, written by the service's settings dialog
    // (as an administrator); only the system account and administrators can read it
    const ACCESS = path.join(AGENT_DIR, 'access.json');
    const readAccess = () => { try { return JSON.parse(fs.readFileSync(ACCESS, 'utf8')); } catch { return {}; } };
    settingsIO = {
      readAppSettings: () => { const a = readAccess(); return { ...readAppSettings(), remote: { enabled: a.enabled === true, id: a.id, salt: a.salt, key: a.key, keepAwake: true } }; },
      writeAppSettings: patch => {
        const { remote: r, ...rest } = patch;
        if (r && r.id) { const a = readAccess(); if (a.id !== r.id) { a.id = r.id; try { fs.writeFileSync(ACCESS, JSON.stringify(a, null, 2)); } catch {} } }
        if (Object.keys(rest).length) writeAppSettings(rest);
        return settingsIO.readAppSettings();
      },
    };
    lab.agent = true;
    lab.statusFile = path.join(LAB_ROOT, 'status.json');
    lab.userContext = userContext;
    lab.helper = path.join(process.resourcesPath || '', 'service', 'ScreenShareRemoteHelper.exe');
    lab.options = () => { const a = readAccess(); return { banner: a.banner !== false, consent: a.consent === 'ask' ? 'ask' : 'never', localEnd: a.localEnd !== false, lang: a.lang }; };
    lab.accessStamp = () => { try { return String(fs.statSync(ACCESS).mtimeMs); } catch { return ''; } };
    // who connected, when (administrators can read it next to access.json)
    const AUDIT = path.join(AGENT_DIR, 'audit.log');
    lab.audit = (event, detail = {}) => {
      try {
        if (fs.existsSync(AUDIT) && fs.statSync(AUDIT).size > 2 * 1024 * 1024) fs.renameSync(AUDIT, AUDIT + '.old');
        fs.appendFileSync(AUDIT, JSON.stringify({ t: new Date().toISOString(), event, ...detail }) + '\n');
      } catch {}
    };
  } else if (REMOTE_ED) {
    // the app: on Windows the service runs this PC's remote access (its settings dialog needs an administrator)
    lab.statusFile = path.join(LAB_ROOT, 'status.json');
    lab.serviceExe = process.env.SCREENSHARE_SERVICE_EXE ||
      (process.platform === 'win32' ? path.join(process.resourcesPath || '', 'service', 'ScreenShareRemoteService.exe') : null);
  }
  if (LAB) {
    const L = require('./remote/lab');
    if (AGENT) {
      lab.host = L.labHost({ dataDir: AGENT_DIR, log });
      lab.statusFile = path.join(LAB_ROOT, 'status.json');
      lab.userContext = userContext;
      lab.helper = path.join(process.resourcesPath || '', 'lab', 'ScreenShareRemoteHelper.exe');
    } else {
      lab.client = L.labClient({ userDir: app.getPath('userData'), safeStorage, log });
      lab.statusFile = path.join(LAB_ROOT, 'status.json');     // shows this PC's agent state
      lab.agentDir = AGENT_DIR;                                  // Linux: the app sets this PC up as a lab PC itself
    }
  }
  // connection history: written by whichever process is this PC's host (the service's agent, or this app)
  if (!LAB) {
    const viaService = AGENT || !!(lab.serviceExe && fs.existsSync(lab.serviceExe));
    lab.historyFile = viaService ? path.join(LAB_ROOT, 'history.json') : path.join(app.getPath('userData'), 'remote-history.json');
  }
  log(`started ${app.getVersion()} (${EDITION}${AGENT ? ' agent' : ''}) on ${process.platform}${BACKGROUND ? ' (background)' : ''}${process.argv.includes('--updated') ? ' (just updated)' : ''}`);
  remote = require('./remote/host-main')({ ...settingsIO, appDir: __dirname, serverQuery, openMainWindow, log, lab, edition: EDITION,
    product: PRODUCT, feedbackUrl: process.env.SCREENSHARE_FEEDBACK_URL || PKG.feedbackUrl || null,
    defaultLang: REMOTE_ED ? 'pt' : 'en',
    trayApp: REMOTE_ED && !AGENT,       // SC-Remote stays in the tray (ID, state, open, quit; not on a Mac)
    minPassword: REMOTE_ED ? 8 : 6,
    update: REMOTE_ED && !AGENT ? updateConfig() : null });
  // hosts: the agent; the personal app; the remote edition's app where there's no service (Linux).
  // (the lab app and, on Windows, the remote edition's app only connect: the service's agent is this PC's host)
  const serviceHere = !!(lab.serviceExe && fs.existsSync(lab.serviceExe));
  if (AGENT || (!LAB && !serviceHere && PLATFORM !== 'darwin')) remote.start();   // (a Mac only connects)
  if (AGENT) return;                      // the agent shows nothing (except the banner while someone is connected)
  macMenus();
  if (REMOTE_ED) remote.startAppTray();
  if (BACKGROUND && !REMOTE_ED && !remote.isEnabled()) { app.quit(); return; }    // autostart entry left over, remote access off
  if (!BACKGROUND) createWindow();
  if (process.env.SCREENSHARE_SMOKE) smokeTest();
});

// Mac: the menu bar. In a remote session every shortcut goes to the other PC (Cmd+C, Cmd+W… arrive there as
// Ctrl+C, Ctrl+W), so a session window gets a menu with nothing on the keyboard except Quit (Cmd+Q).
function macMenus() {
  if (process.platform !== 'darwin') return;
  const { Menu } = require('electron');
  const full = Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]);
  const inSession = Menu.buildFromTemplate([
    { label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'Window', submenu: [{ label: 'Minimize', click: (_i, w) => w && w.minimize() }, { label: 'Close', click: (_i, w) => w && w.close() }] },
  ]);
  Menu.setApplicationMenu(full);
  app.on('browser-window-focus', (_e, w) => Menu.setApplicationMenu(w && w.scSession ? inSession : full));
}

// Release builds run this once on each system (SCREENSHARE_SMOKE=1): open the main window and a session window,
// check that they work, print the result and quit.
function smokeTest() {
  const done = (ok, info) => {
    const line = (ok ? 'SMOKE OK ' : 'SMOKE FAIL ') + JSON.stringify(info);
    console.log(line);
    if (process.env.SCREENSHARE_SMOKE_OUT) try { fs.writeFileSync(process.env.SCREENSHARE_SMOKE_OUT, line + '\n'); } catch {}
    app.exit(ok ? 0 : 1);
  };
  setTimeout(() => done(false, { error: 'timed out' }), 90000);
  const find = re => BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && re.test(w.webContents.getURL()) && !w.webContents.isLoading());
  const wait = async (re, ms) => { const end = Date.now() + ms; while (Date.now() < end) { const w = find(re); if (w) return w; await new Promise(r => setTimeout(r, 250)); } return null; };
  (async () => {
    try {
      const m = await wait(/remote\.html/, 30000);
      if (!m) return done(false, { error: 'the main window did not open' });
      await new Promise(r => setTimeout(r, 2000));
      const main = await m.webContents.executeJavaScript(`({ title: document.title, lang: document.documentElement.lang,
        sections: [...document.querySelectorAll('section')].filter(s => !s.classList.contains('hidden')).map(s => s.id || s.querySelector('h2').textContent),
        version: (document.getElementById('ver') || {}).textContent })`);
      await m.webContents.executeJavaScript(`window.remoteApp.connect({ id: '123456789', password: 'smoke-test-1', name: 'smoke', remember: false })`);
      const s = await wait(/remote-session\.html/, 30000);
      if (!s) return done(false, { error: 'the session window did not open', main });
      await new Promise(r => setTimeout(r, 1500));
      const session = await s.webContents.executeJavaScript(`({ title: document.title, overlay: document.getElementById('omsg').textContent })`);
      const srp = require('./remote/srp'), key = require('crypto').randomBytes(32);
      const ctx = { nonce: 'ab'.repeat(32), salt: 'cd'.repeat(16), hostFp: 'h', clientFp: 'c' };
      const hs = srp.hostStart(key.toString('hex')), ca = srp.clientAnswer(key, hs.B, ctx);
      const signIn = srp.hostFinish(key.toString('hex'), hs.b, hs.B, ca.A, ca.m1, ctx) === ca.m2;
      // a Mac shows "This Mac" (connect only); elsewhere this PC's own section (or the service's, on Windows)
      const layout = process.platform === 'darwin' ? main.sections.includes('macSec') && !main.sections.includes('hostSec')
                                                   : main.sections.includes('hostSec') || main.sections.includes('svcSec');
      done(signIn && layout, { platform: process.platform, arch: process.arch, version: app.getVersion(), main, session, signIn, layout });
    } catch (e) { done(false, { error: e.message }); }
  })();
}
// With remote access on, the hidden host window keeps the app running (in the tray) after windows close.
// The lab agent never quits by itself (its banner and prompt windows come and go).
// (SC-Remote keeps running in the tray: it is quit from the tray's menu)
app.on('window-all-closed', () => { if (!AGENT && !REMOTE_ED) app.quit(); });
// Mac: clicking the Dock icon with no window open brings the main window back
app.on('activate', () => { if (remote && !AGENT && BrowserWindow.getAllWindows().every(w => !w.isVisible())) openMainWindow(); });
