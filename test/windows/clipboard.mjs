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
         SCREENSHARE_TEST: '1', SCREENSHARE_TEST_CONTROLLER_NO_CLIPBOARD: '1',
         // copies of 100 KB or more ask first here (2 GB normally)
         SCREENSHARE_TEST_CLIP_LIMIT: '100000' } });
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
// (this app doesn't touch the clipboard it shares with the PC here: it keeps what it was sent instead)
const gotText = await until(() => app.evaluate(() => { const c = globalThis.__scTestClip; return !!c && c.kind === 'text' && c.data === 'hello from the PC'; }), 10000);
ok(gotText, 'text copied on the PC arrives here: ' + JSON.stringify(await app.evaluate(() => globalThis.__scTestClip || null)));
console.log('agent log:\n' + agentLogSince());

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
// as Explorer does it: a live OLE clipboard object, rendered on request by the program that copied (which keeps
// running and answering), not data handed to Windows up front
const { spawn } = await import('child_process');
const explorerCopy = spawn('powershell.exe', ['-NoProfile', '-Sta', '-Command',
  `Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.DataObject; ` +
  `$d.SetData([System.Windows.Forms.DataFormats]::FileDrop, [string[]]@('${HOSTFILE}')); [System.Windows.Forms.Clipboard]::SetDataObject($d, $false); ` +
  `$end = (Get-Date).AddSeconds(45); while ((Get-Date) -lt $end) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 20 }`], { stdio: 'ignore' });
await sleep(3000);
console.log('after an Explorer-style copy, the clipboard (as the user):', userFileList());
await until(async () => (await acts()).some(a => /from-the-pc/.test(a) && /Ready: press Ctrl\+V here|failed/i.test(a)), 20000);
let a2 = await acts();
console.log('activity:', JSON.stringify(a2), 'toast:', await toastText());
console.log('agent log:\n' + agentLogSince());
ok(a2.some(a => /Ready: press Ctrl\+V here/.test(a) && /from-the-pc/.test(a)), 'a file copied Explorer-style on the PC (live clipboard object) arrives here, ready to paste');
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

// copied from Windows' own folders: not offered (the members may only fetch the user's things)
section('files from a system folder are not offered');
await s.evaluate(() => document.querySelectorAll('#acts .act').forEach(a => a.remove()));
ps(`Set-Clipboard -Path 'C:\\Windows\\win.ini'`);
await sleep(4000);
const a3 = await acts(), logNow = agentLogSince();
console.log('activity:', JSON.stringify(a3), '\nagent log:\n' + logNow);
ok(!a3.some(a => /win\.ini/i.test(a)) && /not offered/.test(logNow), 'a file copied from C:\\Windows is not offered to the controller');

// a picture copied on the PC
section('picture: the PC → this app');
ps(`Add-Type -AssemblyName System.Windows.Forms, System.Drawing; $b = New-Object System.Drawing.Bitmap 64, 48; $g = [System.Drawing.Graphics]::FromImage($b); $g.Clear([System.Drawing.Color]::OrangeRed); [System.Windows.Forms.Clipboard]::SetImage($b)`);
const gotPic = await until(() => app.evaluate(() => { const c = globalThis.__scTestClip; return !!c && c.kind === 'image'; }), 10000);
ok(gotPic, 'a picture copied on the PC arrives here');

/* ---------- the Files panel ---------- */
// the helper itself, run as the signed-in user (not the system account): does it see what was copied?
section('the clipboard helper, as the user');
{
  const src = fs.readFileSync(path.resolve('remote/clipfiles.js'), 'utf8');
  const script = eval('`' + src.match(/const WIN_SCRIPT = `([\s\S]*?)`;/)[1] + '`');
  const { spawn } = await import('child_process');
  const h = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Sta', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = ''; h.stdout.on('data', d => { out += d; }); h.stderr.on('data', d => { err += d; });
  await until(() => /READY/.test(out), 30000);
  const ask = async l => { const n = out.split('\n').length; h.stdin.write(l + '\n'); await until(() => out.split('\n').length > n, 10000, 50); return out.trim().split('\n').pop().trim(); };
  ps(`Set-Clipboard -Path '${HOSTFILE}'`);
  console.log('GET after Set-Clipboard:', await ask('GET'));
  console.log('SET:', await ask('SET ' + JSON.stringify([HOSTFILE2])), '| user sees:', userFileList());
  console.log('GET:', await ask('GET'));
  if (err.trim()) console.log('helper errors:', err.trim().slice(0, 1500));
  h.stdin.end(); h.kill();
}

// the same, as the system account in this session (as the agent runs), with Sysinternals PsExec
section('the clipboard seen by the system account (PsExec)');
{
  const agentSession = ps("(Get-CimInstance Win32_Process -Filter \"Name='SC-Remote.exe'\" | Where-Object { $_.CommandLine -like '*--agent*' } | Select-Object -First 1).SessionId");
  const out = path.join(OUT, 'system-clipboard.txt');
  const { spawn } = await import('child_process');
  const psexec = 'C:\\Tools\\PsExec64.exe';
  if (fs.existsSync(psexec)) {
    const p = spawn(psexec, ['-accepteula', '-nobanner', '-s', '-i', agentSession, 'powershell.exe', '-NoProfile', '-Sta', '-ExecutionPolicy', 'Bypass', '-File', path.resolve('test/windows/system-clipboard.ps1'), out, '14'], { stdio: 'ignore' });
    await sleep(4000);
    console.log('user copies A:', ps(`Set-Clipboard -Path '${HOSTFILE}'`));
    await sleep(4000);
    console.log('user copies B:', ps(`Set-Clipboard -Path '${HOSTFILE2}'`));
    await new Promise(r => { p.on('exit', r); setTimeout(r, 20000); });
    console.log(read(out));
    console.log('the same seen by the user:', ps(`powershell -NoProfile -Sta -File '${path.resolve('test/windows/system-clipboard.ps1')}' '${out}.user' 2; Get-Content '${out}.user'`));
  } else console.log('(no PsExec)');
}

section('Files panel');
await s.evaluate(() => document.getElementById('filesBtn').click());
await until(async () => (await s.inputValue('#path')) !== '', 20000);
console.log('Files panel opens at:', await s.inputValue('#path'), '| entries:', (await s.textContent('#list')).slice(0, 200));
ok((await s.inputValue('#path')).toLowerCase() === userHome.toLowerCase(), 'the Files panel opens in the signed-in user\'s folder');
await s.screenshot({ path: path.join(OUT, '4-files-panel.png') });
console.log('agent log:\n' + agentLogSince());

// The members' file operations run as the signed-in user: other drives work, and Windows' permissions apply
section('Files panel: other drives, as the signed-in user');
const OUTD = 'D:\\sc-test-' + id;
fs.mkdirSync(path.join(OUTD, 'deep'), { recursive: true });
fs.writeFileSync(path.join(OUTD, 'outside.txt'), 'from drive D\n');
fs.writeFileSync(path.join(OUTD, 'deep', 'big.bin'), crypto.randomBytes(5000));
// a folder this user is refused (a deny entry for them: it holds even for an administrator); the system account isn't
fs.mkdirSync(path.join(OUTD, 'system-only'));
fs.writeFileSync(path.join(OUTD, 'system-only', 'secret.txt'), 'secret');
console.log(ps(`icacls '${OUTD}\\system-only' /deny "$($env:USERNAME):(OI)(CI)F"`));
console.log('can this user list it?', ps(`try { Get-ChildItem '${OUTD}\\system-only' -ErrorAction Stop | Out-Null; 'yes' } catch { 'no: ' + $_.Exception.Message }`));
const listOf = p => s.evaluate(p => rpc({ op: 'list', path: p }).then(r => ({ path: r.path, parent: r.parent, roots: r.roots, names: r.entries.map(e => e.name) }), e => ({ error: String(e && e.message || e) })), p);
const dRoot = await listOf('D:\\');
console.log('D:\\ →', JSON.stringify(dRoot).slice(0, 400));
ok(!dRoot.error && dRoot.names.includes(path.basename(OUTD)), 'drive D: can be listed');
ok(/files: working as/.test(read(AGENT_LOG)), 'the PC runs file operations as the signed-in user: ' + (read(AGENT_LOG).match(/files: working as .*/) || ['(not in the log)'])[0]);
const above = await listOf(path.dirname(userHome));
ok(!above.error, 'a folder above the user\'s own can be listed (' + path.dirname(userHome) + '): ' + (above.error || above.names.slice(0, 5).join(', ')));
const secret = await listOf(path.join(OUTD, 'system-only'));
ok(!!secret.error, 'a folder the signed-in user is refused is refused here too: ' + (secret.error || JSON.stringify(secret)));
const secretFile = await s.evaluate(p => rpc({ op: 'walk', paths: [p] }).then(() => 'read', e => 'refused: ' + String(e && e.message || e)), path.join(OUTD, 'system-only', 'secret.txt'));
ok(/refused/.test(secretFile), 'and so is the file in it: ' + secretFile);
await s.evaluate(p => openDir(p), OUTD);
await until(async () => /outside\.txt/.test(await s.textContent('#list')), 10000);
const dlDirNow = await s.evaluate(async () => { await loadFilePrefs(); return dlDir; });
await s.evaluate(() => { const r = [...document.querySelectorAll('#list > *')].find(x => /outside\.txt/.test(x.textContent)); r.click(); });
const gotD = await until(() => fs.existsSync(path.join(dlDirNow, 'outside.txt')) && read(path.join(dlDirNow, 'outside.txt')) === 'from drive D\n', 20000);
ok(gotD, 'downloaded a file from drive D: into ' + dlDirNow);
await s.evaluate(p => downloadFolder(p), path.join(OUTD, 'deep'));
const gotDeep = await until(() => fs.existsSync(path.join(dlDirNow, 'deep', 'big.bin')) && fs.readFileSync(path.join(dlDirNow, 'deep', 'big.bin')).equals(fs.readFileSync(path.join(OUTD, 'deep', 'big.bin'))), 20000);
ok(gotDeep, 'downloaded a whole folder from drive D:');
const mine = path.join(OUT, 'mine.bin'); fs.writeFileSync(mine, crypto.randomBytes(3000));
await s.evaluate(([p, d]) => uploadInto([p], d), [mine, OUTD]);
const upD = await until(() => fs.existsSync(path.join(OUTD, 'mine.bin')) && fs.readFileSync(path.join(OUTD, 'mine.bin')).equals(fs.readFileSync(mine)), 20000);
ok(upD, 'uploaded into drive D:');
// (the owner a file gets when this user makes it themselves: an administrator's files belong to Administrators)
fs.writeFileSync(path.join(OUTD, 'made-by-user.txt'), 'x');
const ownerOf = f => ps(`[System.IO.File]::GetAccessControl('${f}').GetOwner([System.Security.Principal.NTAccount]).Value`);
const owner = ownerOf(path.join(OUTD, 'mine.bin')), userOwner = ownerOf(path.join(OUTD, 'made-by-user.txt'));
ok(upD && owner === userOwner && !/ERROR/.test(owner), `what was uploaded has the owner the user's own files get: ${owner} (the user's: ${userOwner})`);
const upSecret = await s.evaluate(([p, d]) => pushWalk({ items: [{ path: p, rel: 'mine.bin', dir: false, size: 3000 }], total: 3000, roots: ['mine.bin'] }, d, { set() {} }).then(() => 'written', e => 'refused: ' + String(e && e.message || e)), [mine, path.join(OUTD, 'system-only')]);
ok(/refused/.test(upSecret) && !fs.existsSync(path.join(OUTD, 'system-only', 'mine.bin')), 'uploading into that folder is refused: ' + upSecret);
console.log('agent log:\n' + agentLogSince());

// Large copies ask first, in the same corner card (100 KB here)
section('large copies ask first');
const large = path.join(OUT, 'large.bin'); fs.writeFileSync(large, crypto.randomBytes(200000));
await s.evaluate(() => document.querySelectorAll('#acts .act').forEach(a => a.remove()));
await s.evaluate(p => { sendClipFiles([p]); }, large);
const askText = await until(async () => (await s.evaluate(() => { const a = document.querySelector('#acts .act.ask'); return a && a.textContent; })), 15000);
ok(!!askText && /large\.bin/.test(askText), 'copying a large file asks first: ' + askText);
await sleep(1500);
ok(!(await acts()).some(a => /Copying|Ready/.test(a)), 'nothing is sent before the answer');
await s.evaluate(() => document.querySelector('#acts .act.ask a').click());
const readyBig = await until(async () => (await acts()).find(a => /Ready/.test(a)), 30000);
ok(!!readyBig, 'answering Copy sends it: ' + readyBig);
const pcList = await until(() => { const l = userFileList(); return /large\.bin/.test(l) && l; }, 15000);
ok(!!pcList, 'and it is on the PC\'s clipboard, ready to paste: ' + pcList);
console.log('agent log:\n' + agentLogSince());

section('logs');
console.log('--- the agent\'s whole log:\n' + read(AGENT_LOG).split('\n').filter(l => /clip|file|stage|error|fail/i.test(l)).slice(-80).join('\n'));
fs.copyFileSync(AGENT_LOG, path.join(OUT, 'agent-remote.log'));
try { fs.copyFileSync(path.join(DATA, 'agent', 'service.log'), path.join(OUT, 'service.log')); } catch {}
await app.close().catch(() => {});
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
