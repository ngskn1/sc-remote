// Cross-machine check (GitHub Actions, .github/workflows/cross-test.yml): SC-Remote installed on a Windows computer
// controls a Linux PC on another machine (test/cross/linux-host.sh), each with its own real clipboard.
// Copies text and files both ways, as a person would: Ctrl+C in Explorer / a file manager, Ctrl+V on the other side.
// The Linux PC shows its clipboard in ~/clipstate.txt and copies what is put in ~/copy-request (see linux-host.sh).
import { _electron as electron } from 'playwright';
import fs from 'fs'; import path from 'path'; import { execFileSync, spawn } from 'child_process';

const OUT = path.resolve('test-output'); fs.mkdirSync(OUT, { recursive: true });
const APP = process.env.SC_APP || 'C:\\Program Files\\SC-Remote\\SC-Remote.exe';
const { CROSS_ID: id, CROSS_PASSWORD: password } = process.env;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; return c; };
const until = async (fn, ms = 20000, step = 500) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch {} await sleep(step); } return v; };
const ps = cmd => { try { return execFileSync('powershell.exe', ['-NoProfile', '-Sta', '-Command', cmd], { encoding: 'utf8' }).trim(); } catch (e) { return 'ERROR ' + String(e.stderr || e.message).split('\n')[0]; } };
const winFiles = () => ps("Add-Type -AssemblyName System.Windows.Forms; for ($i = 0; $i -lt 10; $i++) { try { [System.Windows.Forms.Clipboard]::GetFileDropList() | ForEach-Object { $_ }; break } catch { Start-Sleep -Milliseconds 200 } }");
const winText = () => ps('Get-Clipboard -Raw');
const section = t => console.log(`\n==================== ${t} ====================`);
const LOG = path.join(process.env.APPDATA, 'SC-Remote', 'remote.log');
const logTail = () => { try { return fs.readFileSync(LOG, 'utf8').split('\n').slice(-40).join('\n'); } catch (e) { return `(${e.code})`; } };

section('connect to the Linux PC');
const app = await electron.launch({ executablePath: APP, args: [], timeout: 60000, env: { ...process.env, SCREENSHARE_LANG: 'en' } });
const M = await app.firstWindow(); await M.waitForLoadState();
let s = null;
// (the Linux PC may still be starting: try for a few minutes)
for (let i = 0; i < 20 && !s; i++) {
  const [w] = await Promise.all([app.waitForEvent('window'), M.evaluate(o => window.remoteApp.connect(o), { id, password, name: 'Linux PC', remember: false })]);
  await w.waitForLoadState();
  const up = await until(() => w.evaluate(() => { const v = document.getElementById('screen'); return v && v.videoWidth > 0; }), 30000);
  if (up) s = w;
  else { console.log('not yet:', await w.evaluate(() => document.getElementById('omsg').textContent).catch(() => '?')); await w.close().catch(() => {}); await sleep(15000); }
}
if (!ok(!!s, 'connected to the Linux PC')) { console.log(logTail()); process.exit(1); }
const acts = () => s.evaluate(() => [...document.querySelectorAll('#acts .act')].map(a => a.textContent.replace(/\s+/g, ' ').trim()));
const clearActs = () => s.evaluate(() => document.querySelectorAll('#acts .act').forEach(a => a.remove()));
// a small file on the Linux PC, read through the session's file channel
const readRemote = p => s.evaluate(p => new Promise((res, rej) => {
  const parts = [];
  request({ op: 'get', path: p }, { first: () => {}, chunk: d => parts.push(new Uint8Array(d)), done: () => {
    const all = new Uint8Array(parts.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of parts) { all.set(x, o); o += x.length; }
    res(new TextDecoder().decode(all));
  }, fail: e => rej(new Error(String(e && e.message || e))) }).catch(rej);
}), p);
const home = (await s.evaluate(() => rpc({ op: 'list', path: '' }))).home;
console.log('the Linux PC\'s home:', home);
const clipThere = () => readRemote(home + '/clipstate.txt');
const putThere = async (localFile, dir) => { await s.evaluate(([p, d]) => pushWalk({ items: [{ path: p, rel: p.split(/[\\/]/).pop(), dir: false, size: 1 }], total: 1, roots: [p.split(/[\\/]/).pop()] }, d, { set() {} }), [localFile, dir]); };
await sleep(3000);

section('text: Windows → Linux');
ps("Set-Clipboard -Value 'text from windows'");
const t1 = await until(async () => /text from windows/.test(await clipThere()), 20000);
ok(t1, 'text copied on Windows is on the Linux PC\'s clipboard');

section('text: Linux → Windows');
const tr = path.join(OUT, 'text-request.txt'); fs.writeFileSync(tr, 'text from linux');
await putThere(tr, home);
const t2 = await until(() => winText() === 'text from linux', 20000);
ok(t2, 'text copied on the Linux PC is on Windows\' clipboard: ' + JSON.stringify(winText()));

section('files: Windows → Linux (Ctrl+C in Explorer)');
await clearActs();
const SRC = path.join(OUT, 'from-windows.txt'); fs.writeFileSync(SRC, 'made on windows');
const explorerCopy = spawn('powershell.exe', ['-NoProfile', '-Sta', '-Command',
  `Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.DataObject; ` +
  `$d.SetData([System.Windows.Forms.DataFormats]::FileDrop, [string[]]@('${SRC}')); [System.Windows.Forms.Clipboard]::SetDataObject($d, $false); ` +
  `$end = (Get-Date).AddSeconds(60); while ((Get-Date) -lt $end) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 20 }`], { stdio: 'ignore' });
await sleep(2000);
console.log('Windows\' clipboard:', winFiles());
await until(async () => (await acts()).some(a => /from-windows/.test(a) && /Ready|failed/i.test(a)), 30000);
console.log('cards:', JSON.stringify(await acts()));
let there = await until(async () => { const c = await clipThere(); return /from-windows\.txt/.test(c) && c; }, 20000);
console.log('the Linux PC\'s clipboard:', there || await clipThere());
ok(!!there, 'a file copied in Explorer is on the Linux PC\'s clipboard, ready to paste');
await sleep(5000);
const still = await clipThere();
ok(/from-windows\.txt/.test(still), 'and still there 5 s later: ' + still.replace(/\n/g, ' | '));
explorerCopy.kill();

section('files: Linux → Windows (Ctrl+C in the file manager)');
await clearActs();
const FL = path.join(OUT, 'from-linux.txt'); fs.writeFileSync(FL, 'made on linux');
await putThere(FL, home + '/copy-request');
await until(async () => (await acts()).some(a => /from-linux/.test(a) && /Ready|failed/i.test(a)), 30000);
console.log('cards:', JSON.stringify(await acts()));
const got = await until(() => { const l = winFiles(); return /from-linux\.txt/.test(l) && l; }, 20000);
console.log('Windows\' clipboard:', got || winFiles());
ok(!!got, 'a file copied on the Linux PC is on Windows\' clipboard, ready to paste in Explorer');
if (got) {
  const DEST = path.join(OUT, 'pasted'); fs.mkdirSync(DEST, { recursive: true });
  const p = got.split(/\r?\n/).find(x => /from-linux\.txt$/.test(x));
  ps(`$sh = New-Object -ComObject Shell.Application; $sh.NameSpace('${DEST}').CopyHere('${p}', 16); Start-Sleep 2`);
  ok(fs.existsSync(path.join(DEST, 'from-linux.txt')) && fs.readFileSync(path.join(DEST, 'from-linux.txt'), 'utf8') === 'made on linux', 'pasting it in a folder gives the same file');
}
await sleep(5000);
ok(/from-linux\.txt/.test(winFiles()), 'and still on Windows\' clipboard 5 s later: ' + winFiles());

// names as people write them: accents and spaces (both ways)
section('files with accents and spaces, both ways');
await clearActs();
const ACC = path.join(OUT, 'acentuação e espaços'); fs.mkdirSync(ACC, { recursive: true });
const SRC2 = path.join(ACC, 'relatório final ç.txt'); fs.writeFileSync(SRC2, 'conteúdo do windows');
const explorerCopy2 = spawn('powershell.exe', ['-NoProfile', '-Sta', '-Command',
  `Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.DataObject; ` +
  `$d.SetData([System.Windows.Forms.DataFormats]::FileDrop, [string[]]@('${SRC2}')); ` +
  `[System.Windows.Forms.Clipboard]::SetDataObject($d, $false); ` +
  `$end = (Get-Date).AddSeconds(60); while ((Get-Date) -lt $end) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 20 }`], { stdio: 'ignore' });
await sleep(2500);
console.log('Windows\' clipboard:', winFiles());
await until(async () => (await acts()).some(a => /relat/.test(a) && /Ready|failed/i.test(a)), 30000);
console.log('cards:', JSON.stringify(await acts()));
const there2 = await until(async () => { const c = await clipThere(); return /relat/.test(c) && c; }, 20000);
console.log('the Linux PC\'s clipboard:', there2 || await clipThere());
ok(!!there2 && /relat%C3%B3rio%20final%20%C3%A7\.txt/.test(there2), 'a file with accents and spaces copied in Explorer is on the Linux PC\'s clipboard');
explorerCopy2.kill();
await clearActs();
const FL2 = path.join(OUT, 'ação linux é.txt'); fs.writeFileSync(FL2, 'feito no linux');
await putThere(FL2, home + '/copy-request');
await until(async () => (await acts()).some(a => /linux é/.test(a) && /Ready|failed/i.test(a)), 30000);
console.log('cards:', JSON.stringify(await acts()));
const got2 = await until(() => { const l = winFiles(); return /linux/.test(l) && /\.txt/.test(l) && l; }, 20000);
console.log('Windows\' clipboard:', got2 || winFiles());
const exists2 = ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::GetFileDropList() | ForEach-Object { (Split-Path $_ -Leaf) + ' exists=' + (Test-Path -LiteralPath $_) }`);
console.log('as Windows sees them:', exists2);
ok(/exists=True/.test(exists2) && /ação linux é\.txt/.test(exists2), 'a file with accents copied on the Linux PC is on Windows\' clipboard, and the file exists');
ps("Set-Clipboard -Value 'olá, ação: ü € 日本'");
ok(await until(async () => /olá, ação: ü € 日本/.test(await clipThere()), 20000), 'text with accents reaches the Linux PC intact');

section('logs');
console.log('--- this app\'s log (Windows):\n' + logTail());
// (tell the Linux PC it may stop: a file named cross-done in its home)
fs.writeFileSync(path.join(OUT, 'cross-done'), '1'); await putThere(path.join(OUT, 'cross-done'), home).catch(() => {});
await app.close().catch(() => {});
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
