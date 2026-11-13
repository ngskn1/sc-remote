// Windows end-to-end check (GitHub Actions, .github/workflows/windows-test.yml): SC-Remote installed with its
// service (the agent runs as the system account in the signed-in session), and a second copy of the app on the
// same PC connects to it. Copies files and text both ways through the clipboard, and uses the Files panel.
// Everything it sees goes to stdout and to test-output/ (screenshots, logs).
import { _electron as electron } from 'playwright';
import fs from 'fs'; import path from 'path'; import crypto from 'crypto'; import { execFileSync } from 'child_process';

const OUT = path.resolve('test-output'); fs.mkdirSync(OUT, { recursive: true });
const APP = process.env.SC_APP || 'C:\\Program Files\\SC-Remote\\SC-Remote.exe';
const DATA = 'C:\\ProgramData\\SC-Remote';
const AGENT_LOG = path.join(DATA, 'agent', 'profile', 'remote.log');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; return c; };
const until = async (fn, ms = 20000, step = 300) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch {} await sleep(step); } return v; };
const ps = cmd => { try { return execFileSync('powershell.exe', ['-NoProfile', '-Sta', '-Command', cmd], { encoding: 'utf8' }).trim(); } catch (e) { return 'ERROR ' + String(e.stderr || e.message).split('\n')[0]; } };
// the clipboard's file list as the signed-in user's programs see it (.NET/OLE, as Explorer reads it), with retries
const userFileList = () => ps("for ($i = 0; $i -lt 10; $i++) { try { $l = [System.Windows.Forms.Clipboard]::GetFileDropList(); $l | ForEach-Object { $_ }; break } catch { Start-Sleep -Milliseconds 200 } }; if ($i -eq 10) { 'CLIPBOARD UNREADABLE' }".replace('for (', 'Add-Type -AssemblyName System.Windows.Forms; for ('));
const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return `(${e.code})`; } };
let agentLogMark = 0;
const agentLogSince = () => { const all = read(AGENT_LOG); const s = all.slice(agentLogMark); agentLogMark = all.length; return s.trim(); };
const section = t => console.log(`\n==================== ${t} ====================`);

/* ---------- this PC's remote access: a password, on ---------- */
section('setup');
console.log('signed in:', ps('query user'));
const id = String(100000000 + crypto.randomInt(899999999));
const salt = crypto.randomBytes(16).toString('hex'), password = 'e2e-' + crypto.randomBytes(6).toString('hex');
fs.writeFileSync(path.join(DATA, 'agent', 'access.json'), JSON.stringify({ enabled: true, id, banner: false, consent: 'never', lang: 'en', salt,
  key: crypto.pbkdf2Sync(password, Buffer.from(salt, 'hex'), 150000, 32, 'sha256').toString('hex') }, null, 2));
const status = () => { try { return JSON.parse(fs.readFileSync(path.join(DATA, 'status.json'), 'utf8')); } catch { return {}; } };
const online = await until(() => status().state === 'online' && status().id === id, 90000, 1000);
console.log('status.json:', JSON.stringify(status()));
console.log('agent processes:', ps("Get-CimInstance Win32_Process -Filter \"Name='SC-Remote.exe'\" | ForEach-Object { $o = Invoke-CimMethod -InputObject $_ -MethodName GetOwner; \"$($_.ProcessId) session $($_.SessionId) $($o.Domain)\\$($o.User) $($_.CommandLine.Substring(0, [Math]::Min(90, $_.CommandLine.Length)))\" }"));
console.log('session.json:', read(path.join(DATA, 'session.json')));
if (!ok(online, 'the service started the agent and it is online with ID ' + id)) {
  console.log('--- service.log\n' + read(path.join(DATA, 'agent', 'service.log')).slice(-4000));
  console.log('--- agent log\n' + read(AGENT_LOG).slice(-4000));
  process.exit(1);
}
agentLogSince();

/* ---------- the other copy of the app connects ---------- */
section('connect');
const CLIENT = path.join(OUT, 'client');
fs.mkdirSync(path.join(CLIENT, 'Roaming'), { recursive: true }); fs.mkdirSync(path.join(CLIENT, 'Local'), { recursive: true });
const app = await electron.launch({ executablePath: APP, args: [], timeout: 60000,
  env: { ...process.env, APPDATA: path.join(CLIENT, 'Roaming'), LOCALAPPDATA: path.join(CLIENT, 'Local'), SCREENSHARE_LANG: 'en',
         // one machine, one clipboard: this copy (the controller) doesn't touch it, so only the PC's side does
         SCREENSHARE_TEST: '1', SCREENSHARE_TEST_CONTROLLER_NO_CLIPBOARD: '1' } });
const M = await app.firstWindow(); await M.waitForLoadState();
const [s] = await Promise.all([app.waitForEvent('window'), M.evaluate(o => window.remoteApp.connect(o), { id, password, name: 'Windows PC', remember: false })]);
await s.waitForLoadState();
const videoSize = () => s.evaluate(() => { const v = document.getElementById('screen'); return v && v.videoWidth ? `${v.videoWidth}x${v.videoHeight}` : ''; });
const overlay = () => s.evaluate(() => document.getElementById('overlay').classList.contains('hidden') ? '' : document.getElementById('omsg').textContent);
const acts = () => s.evaluate(() => [...document.querySelectorAll('#acts .act')].map(a => a.textContent.replace(/\s+/g, ' ').trim()));
const toastText = () => s.evaluate(() => document.getElementById('toast').classList.contains('hidden') ? '' : document.getElementById('toast').textContent);
const connected = await until(async () => (await videoSize()) !== '', 90000, 500);
ok(connected, `connected and showing the PC's screen (${await videoSize()}); overlay: "${await overlay()}"`);
await s.screenshot({ path: path.join(OUT, '1-connected.png') });
console.log('agent log:\n' + agentLogSince());
if (!connected) { await app.close().catch(() => {}); process.exit(1); }
await sleep(3000);       // (clipboard sync starts after the session settles)

/* ---------- text, both ways ---------- */
section('text: this app → the PC');
await s.evaluate(() => send({ t: 'clip', kind: 'text', data: 'hello from the controller' }));
await sleep(2500);
ok(ps('Get-Clipboard') === 'hello from the controller', 'text sent to the PC is on its clipboard: "' + ps('Get-Clipboard') + '"');
console.log('agent log:\n' + agentLogSince());
section('text: the PC → this app');
ps("Set-Clipboard -Value 'hello from the PC'");
const gotText = await until(() => app.evaluate(async ({ clipboard }) => (await clipboard.readText()) === 'hello from the PC'), 8000);
ok(gotText, 'text copied on the PC: still on the clipboard here (one machine, so this only shows nothing broke)');

/* ---------- files: this app → the PC (Ctrl+C here, Ctrl+V there) ---------- */
section('files: this app → the PC');
const SRC = path.join(OUT, 'from-controller'); fs.mkdirSync(SRC, { recursive: true });
fs.writeFileSync(path.join(SRC, 'report.txt'), 'made on the controller');
await s.evaluate(p => sendClipFiles([p]), path.join(SRC, 'report.txt'));
await until(async () => (await acts()).some(a => /Ready|failed|cancelled/i.test(a)), 30000);
console.log('activity:', JSON.stringify(await acts()), 'toast:', await toastText());
await sleep(2500);
const onClip = userFileList();
console.log('the PC\'s clipboard (as the signed-in user):', onClip);
const pasted = onClip.split(/\r?\n/).find(p => /report\.txt$/.test(p));
ok(!!pasted, 'the file is on the PC\'s clipboard, ready for Ctrl+V');
if (pasted) {
  console.log('readable by the user:', ps(`Get-Content -LiteralPath '${pasted}'`));
  try { console.log('its permissions:', execFileSync('icacls', [pasted], { encoding: 'utf8' }).trim()); } catch {}
  // what Explorer's paste does: copy the clipboard's files into a folder
  const DEST = path.join(OUT, 'pasted-on-pc'); fs.mkdirSync(DEST, { recursive: true });
  console.log('paste (shell copy):', ps(`$sh = New-Object -ComObject Shell.Application; $sh.NameSpace('${DEST}').CopyHere('${pasted}', 16); Start-Sleep 2; Get-ChildItem '${DEST}' | ForEach-Object Name`));
  ok(read(path.join(DEST, 'report.txt')) === 'made on the controller', 'pasting it into a folder on the PC gives the same file');
}
console.log('agent log:\n' + agentLogSince());
await s.screenshot({ path: path.join(OUT, '2-files-to-pc.png') });

/* ---------- files: the PC → this app (Ctrl+C there, Ctrl+V here) ---------- */
section('files: the PC → this app');
const userHome = process.env.USERPROFILE;
const HOSTFILE = path.join(userHome, 'Documents', 'from-the-pc.txt');
fs.mkdirSync(path.dirname(HOSTFILE), { recursive: true }); fs.writeFileSync(HOSTFILE, 'made on the PC');
await s.evaluate(() => document.querySelectorAll('#acts .act').forEach(a => a.remove()));
// as Explorer does it: its "Copy" command, with the copying program still running (a live clipboard object)
const { spawn } = await import('child_process');
const explorerCopy = spawn('powershell.exe', ['-NoProfile', '-Sta', '-Command',
  `$f = Get-Item -LiteralPath '${HOSTFILE}'; (New-Object -ComObject Shell.Application).NameSpace($f.DirectoryName).ParseName($f.Name).InvokeVerb('copy'); Start-Sleep 40`], { stdio: 'ignore' });
await sleep(3000);
console.log('after Explorer\'s Copy, the clipboard (as the user):', userFileList());
await until(async () => (await acts()).some(a => /from-the-pc/.test(a) && /Ready: press Ctrl\+V here|failed/i.test(a)), 20000);
let a2 = await acts();
console.log('activity:', JSON.stringify(a2), 'toast:', await toastText());
console.log('agent log:\n' + agentLogSince());
ok(a2.some(a => /Ready: press Ctrl\+V here/.test(a) && /from-the-pc/.test(a)), 'a file copied with Explorer\'s Copy on the PC arrives here, ready to paste');
explorerCopy.kill();
// and copied by a program that sets the list and exits (Set-Clipboard)
const HOSTFILE2 = path.join(userHome, 'Documents', 'second-from-the-pc.txt'); fs.writeFileSync(HOSTFILE2, 'second');
await s.evaluate(() => document.querySelectorAll('#acts .act').forEach(a => a.remove()));
console.log('Set-Clipboard:', ps(`Set-Clipboard -Path '${HOSTFILE2}'`), '| clipboard now:', userFileList());
await until(async () => (await acts()).some(a => /second-from-the-pc/.test(a) && /Ready: press Ctrl\+V here|failed/i.test(a)), 20000);
a2 = await acts();
console.log('activity:', JSON.stringify(a2), 'toast:', await toastText());
console.log('agent log:\n' + agentLogSince());
ok(a2.some(a => /Ready: press Ctrl\+V here/.test(a) && /second-from-the-pc/.test(a)), 'a file put on the clipboard with Set-Clipboard on the PC arrives here too');
console.log('agent log:\n' + agentLogSince());
await s.screenshot({ path: path.join(OUT, '3-files-from-pc.png') });

/* ---------- the Files panel ---------- */
section('Files panel');
await s.evaluate(() => document.getElementById('filesBtn').click());
await until(async () => (await s.inputValue('#path')) !== '', 20000);
console.log('Files panel opens at:', await s.inputValue('#path'), '| entries:', (await s.textContent('#list')).slice(0, 200));
ok((await s.inputValue('#path')).toLowerCase() === userHome.toLowerCase(), 'the Files panel opens in the signed-in user\'s folder');
await s.screenshot({ path: path.join(OUT, '4-files-panel.png') });
console.log('agent log:\n' + agentLogSince());

section('logs');
console.log('--- the agent\'s whole log:\n' + read(AGENT_LOG).split('\n').filter(l => /clip|file|stage|error|fail/i.test(l)).slice(-80).join('\n'));
fs.copyFileSync(AGENT_LOG, path.join(OUT, 'agent-remote.log'));
try { fs.copyFileSync(path.join(DATA, 'agent', 'service.log'), path.join(OUT, 'service.log')); } catch {}
await app.close().catch(() => {});
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
