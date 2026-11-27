// Which ways of putting files on the clipboard does Explorer accept for Paste? (windows-explorer-paste.yml)
// Explorer's Paste is greyed out (no Paste command on a folder) when it doesn't accept the clipboard's contents.
import fs from 'fs'; import path from 'path'; import { execFileSync, spawn } from 'child_process';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const OUT = path.resolve('test-output'); fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ps = cmd => { try { return execFileSync('powershell.exe', ['-NoProfile', '-Sta', '-Command', cmd], { encoding: 'utf8' }).trim(); } catch (e) { return 'ERROR ' + String(e.stderr || e.message).split('\n')[0]; } };
const FILE = path.join(OUT, 'paste-me.txt'); fs.writeFileSync(FILE, 'x');
const verbs = () => ps(`$sh = New-Object -ComObject Shell.Application; $f = $sh.NameSpace('${OUT}').ParseName('target'); ($f.Verbs() | ForEach-Object { $_.Name -replace '&','' } | Where-Object { $_ }) -join ', '`);
fs.mkdirSync(path.join(OUT, 'target'), { recursive: true });
const report = async (how) => { await sleep(1500); const v = verbs(); console.log(`${/Paste/.test(v) ? 'PASTE OK   ' : 'NO PASTE   '} ${how}\n            formats: ${ps("Add-Type -AssemblyName System.Windows.Forms; ([System.Windows.Forms.Clipboard]::GetDataObject().GetFormats()) -join ', '")}`); };

ps(`Set-Clipboard -Path '${FILE}'`); await report('Set-Clipboard -Path (OLE, .NET)');
ps("Set-Clipboard -Value 'reset'");

// SC-Remote's helper (remote/clipfiles.js), as it runs: started, SET, and still running
const m = require('module'); const load = m._load; m._load = function (r, ...a) { if (r === 'electron') return { clipboard: {}, ClipboardItem: class {} }; return load.call(this, r, ...a); };
const { WIN_SCRIPT } = require('../../remote/clipfiles.js');
const helper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Sta', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(WIN_SCRIPT, 'utf16le').toString('base64')], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
let out = ''; helper.stdout.setEncoding('utf8'); helper.stdout.on('data', d => { out += d; });
const ask = async line => { const n = out.length; helper.stdin.write(line + '\n'); for (let i = 0; i < 100 && !out.slice(n).includes('\n'); i++) await sleep(100); return out.slice(n).trim(); };
for (let i = 0; i < 100 && !/READY/.test(out); i++) await sleep(100);
console.log('helper:', await ask('SET ' + JSON.stringify([FILE])));
await report('SC-Remote helper SET (Win32 CF_HDROP + Preferred DropEffect), helper running');
console.log('helper GET:', await ask('GET'));
await report('... after the helper read it back (GET)');
helper.stdin.end(); await sleep(1500);
await report('... after the helper ended');

// .NET DataObject through OLE, copied (what SetDataObject(…, true) does)
ps(`Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.DataObject; $c = New-Object System.Collections.Specialized.StringCollection; $c.Add('${FILE}') | Out-Null; $d.SetFileDropList($c); $ms = New-Object IO.MemoryStream(,[byte[]](1,0,0,0)); $d.SetData('Preferred DropEffect', $ms); [System.Windows.Forms.Clipboard]::SetDataObject($d, $true)`);
await report('OLE DataObject with FileDrop + Preferred DropEffect, flushed');
