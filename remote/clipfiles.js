// Files on the clipboard (what a file manager puts there on Ctrl+C), read and written per OS.
//  Linux: the formats Nemo/Nautilus/Caja ("x-special/gnome-copied-files") and KDE/others ("text/uri-list") use,
//         through Electron's raw clipboard formats.
//  Windows: Explorer's file-drop list, through a small long-lived PowerShell helper (Windows Forms clipboard).
const { clipboard, ClipboardItem } = require('electron');
const { spawn } = require('child_process');
const { pathToFileURL, fileURLToPath } = require('url');
const fs = require('fs');
const path = require('path');

const raw = f => `electron application/osclipboard;format="${f}"`;

function parseUris(text) {
  return String(text).split(/\r?\n/).map(s => s.trim()).filter(s => s.startsWith('file://'))
    .map(u => { try { return fileURLToPath(u); } catch { return null; } }).filter(Boolean);
}

/* ---------------- Linux ---------------- */
async function readLinux() {
  let items;
  try { items = await clipboard.read(); } catch { return null; }
  for (const it of items) {
    for (const t of [raw('x-special/gnome-copied-files'), 'text/uri-list', raw('text/uri-list')]) {
      if (!it.types.includes(t)) continue;
      try {
        const paths = parseUris(await (await it.getType(t)).text());
        if (paths.length) return paths;
      } catch {}
    }
  }
  return null;
}
async function writeLinux(paths) {
  const uris = paths.map(p => pathToFileURL(p).href);
  await clipboard.write([new ClipboardItem({
    [raw('x-special/gnome-copied-files')]: new Blob(['copy\n' + uris.join('\n')]),   // Nemo, Nautilus, Caja
    [raw('text/uri-list')]: new Blob([uris.join('\r\n') + '\r\n']),                    // KDE, Thunar, most others
    'text/plain': new Blob([paths.join('\n')], { type: 'text/plain' }),
  })]);
}

/* ---------------- Windows ---------------- */
const WIN_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
[Console]::Out.WriteLine('READY'); [Console]::Out.Flush()
while ($true) {
  $l = [Console]::In.ReadLine()
  if ($null -eq $l) { break }
  try {
    if ($l -eq 'GET') {
      $arr = @()
      if ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) { foreach ($f in [System.Windows.Forms.Clipboard]::GetFileDropList()) { $arr += [string]$f } }
      [Console]::Out.WriteLine('OK ' + (ConvertTo-Json -Compress -InputObject @($arr)))
    } elseif ($l.StartsWith('SET ')) {
      $paths = [string[]]@(foreach ($p in (ConvertFrom-Json $l.Substring(4))) { [string]$p })
      $data = New-Object System.Windows.Forms.DataObject
      $data.SetData([System.Windows.Forms.DataFormats]::FileDrop, $true, $paths)
      # "copy" like Explorer's Ctrl+C (1 = DROPEFFECT_COPY)
      $data.SetData('Preferred DropEffect', (New-Object System.IO.MemoryStream (,[byte[]](1, 0, 0, 0))))
      # copy = $true: Windows keeps the data itself. Otherwise Explorer would have to ask this process for it
      # on paste, and this process never answers while it waits for the next line: the paste silently fails.
      [System.Windows.Forms.Clipboard]::SetDataObject($data, $true, 10, 100)
      $check = [System.Windows.Forms.Clipboard]::GetFileDropList()
      if ($check.Count -ne $paths.Count) { throw "the clipboard did not keep the files ($($check.Count) of $($paths.Count))" }
      [Console]::Out.WriteLine('OK []')
    }
  } catch { [Console]::Out.WriteLine('ERR ' + $_.Exception.Message.Replace([char]10, ' ')) }
  [Console]::Out.Flush()
}`;

let win = null;
function winHelper() {
  if (win) return win;
  const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Sta', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(WIN_SCRIPT, 'utf16le').toString('base64')], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  const queue = [];
  let buf = '', resolveReady;
  const ready = new Promise(r => { resolveReady = r; setTimeout(() => r(false), 20000); });
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (line === 'READY') { resolveReady(true); continue; }
      const q = queue.shift(); if (!q) continue;
      if (line.startsWith('OK ')) { try { q.resolve(JSON.parse(line.slice(3))); } catch { q.resolve([]); } }
      else q.reject(new Error(line.slice(4)));
    }
  });
  proc.on('exit', () => { win = null; queue.splice(0).forEach(q => q.reject(new Error('clipboard helper stopped'))); resolveReady(false); });
  proc.on('error', () => {});
  const ask = async line => {
    if (!(await ready)) throw new Error('clipboard helper unavailable');
    return new Promise((resolve, reject) => { queue.push({ resolve, reject }); proc.stdin.write(line + '\n'); });
  };
  win = { ask, proc };
  return win;
}

/* ---------------- API ---------------- */
async function readFiles() {
  if (process.platform === 'linux') return readLinux();
  if (process.platform === 'win32') {
    const list = await winHelper().ask('GET');
    return list.length ? list : null;
  }
  return null;
}
async function writeFiles(paths) {
  if (process.platform === 'linux') return writeLinux(paths);
  if (process.platform === 'win32') return winHelper().ask('SET ' + JSON.stringify(paths));
  throw new Error('not supported on this OS');
}
function stop() { if (win) { try { win.proc.stdin.end(); win.proc.kill(); } catch {} win = null; } }

module.exports = { readFiles, writeFiles, stop, parseUris };
