// Files on the clipboard (what a file manager puts there on Ctrl+C), read and written per OS.
//  Linux: the formats Nemo/Nautilus/Caja ("x-special/gnome-copied-files") and KDE/others ("text/uri-list") use,
//         through Electron's raw clipboard formats.
//  Windows: Explorer's file-drop list, through a small long-lived PowerShell helper (Windows Forms clipboard).
//  Mac: Finder's file list ("NSFilenamesPboardType", a property list of paths; one file URL as a fallback).
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

/* ---------------- Mac ---------------- */
const xmlUnescape = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const xmlEscape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function parsePlistPaths(xml) {
  return [...String(xml).matchAll(/<string>([^<]*)<\/string>/g)].map(m => xmlUnescape(m[1])).filter(p => p.startsWith('/'));
}
function plistOf(paths) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
         '<plist version="1.0">\n<array>\n' + paths.map(p => `\t<string>${xmlEscape(p)}</string>\n`).join('') + '</array>\n</plist>\n';
}
function readMac() {
  try { const paths = parsePlistPaths(clipboard.read('NSFilenamesPboardType')); if (paths.length) return paths; } catch {}
  try { const paths = parseUris(clipboard.read('public.file-url')); if (paths.length) return paths; } catch {}
  return null;
}
function writeMac(paths) {
  clipboard.writeBuffer('NSFilenamesPboardType', Buffer.from(plistOf(paths), 'utf8'));
}

/* ---------------- Windows ---------------- */
// The file list on the Windows clipboard (CF_HDROP), read and written with the plain Win32 clipboard functions.
// Not .NET's Clipboard class: that goes through OLE, which calls into whichever program owns the clipboard over
// COM. Between the system account (SC-Remote's agent) and the signed-in user's programs (Explorer) those calls
// are refused, so copying files failed both ways. Win32 calls involve no COM: Windows itself hands the data over.
const WIN_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
using System; using System.Collections.Generic; using System.IO; using System.Runtime.InteropServices; using System.Text; using System.Threading;
public static class SCClip {
  [DllImport("user32.dll", SetLastError = true)] static extern bool OpenClipboard(IntPtr owner);
  [DllImport("user32.dll", SetLastError = true)] static extern bool CloseClipboard();
  [DllImport("user32.dll", SetLastError = true)] static extern bool EmptyClipboard();
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetClipboardData(uint format, IntPtr data);
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr GetClipboardData(uint format);
  [DllImport("user32.dll")] static extern bool IsClipboardFormatAvailable(uint format);
  [DllImport("user32.dll")] static extern uint GetClipboardSequenceNumber();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern uint RegisterClipboardFormat(string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GlobalAlloc(uint flags, UIntPtr size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GlobalLock(IntPtr h);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GlobalUnlock(IntPtr h);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GlobalFree(IntPtr h);
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern uint DragQueryFile(IntPtr drop, uint i, StringBuilder name, uint size);
  const uint CF_HDROP = 15, CF_UNICODETEXT = 13, GMEM_MOVEABLE = 2;
  // a hidden window to own the clipboard while setting it (Windows refuses SetClipboardData without an owner)
  static System.Windows.Forms.NativeWindow owner;
  static IntPtr Owner() {
    if (owner == null) { owner = new System.Windows.Forms.NativeWindow(); var cp = new System.Windows.Forms.CreateParams(); cp.Parent = new IntPtr(-3); owner.CreateHandle(cp); }
    return owner.Handle;
  }
  // another program may have it open for a moment
  static void Open() {
    for (int i = 0; i < 40; i++) { if (OpenClipboard(Owner())) return; Thread.Sleep(25); }
    throw new Exception("the clipboard is busy (error " + Marshal.GetLastWin32Error() + ")");
  }
  static uint seq = 0; static string[] last = new string[0];
  public static string[] Get() {
    uint s = GetClipboardSequenceNumber();
    if (s != 0 && s == seq) return last;                         // unchanged: don't even open it
    if (!IsClipboardFormatAvailable(CF_HDROP)) { seq = s; last = new string[0]; return last; }
    Open();
    try {
      var list = new List<string>();
      IntPtr h = GetClipboardData(CF_HDROP);
      if (h != IntPtr.Zero) {
        uint n = DragQueryFile(h, 0xFFFFFFFF, null, 0);
        for (uint i = 0; i < n; i++) { uint len = DragQueryFile(h, i, null, 0); var sb = new StringBuilder((int)len + 1); DragQueryFile(h, i, sb, len + 1); list.Add(sb.ToString()); }
      }
      seq = s; last = list.ToArray();
      return last;
    } finally { CloseClipboard(); }
  }
  // Everything that was copied, as one line of JSON: {"seq":n,"files":[…],"text":"…","png":"<base64>"|null}.
  // Used when this runs as the signed-in user for SC-Remote's agent: Windows shows the system account an empty
  // clipboard. The picture (costly) only when asked for and the clipboard changed since the caller's "have".
  static uint tseq = 0; static string ttext = "";
  static string Text() {
    uint s = GetClipboardSequenceNumber();
    if (s != 0 && s == tseq) return ttext;
    string t = "";
    if (IsClipboardFormatAvailable(CF_UNICODETEXT)) {
      Open();
      try {
        IntPtr h = GetClipboardData(CF_UNICODETEXT);
        if (h != IntPtr.Zero) { IntPtr p = GlobalLock(h); if (p != IntPtr.Zero) { try { t = Marshal.PtrToStringUni(p); } finally { GlobalUnlock(h); } } }
      } finally { CloseClipboard(); }
    }
    tseq = s; ttext = t == null ? "" : t;
    return ttext;
  }
  static string Png() {
    if (!System.Windows.Forms.Clipboard.ContainsImage()) return null;
    using (var img = System.Windows.Forms.Clipboard.GetImage()) {
      if (img == null) return null;
      using (var ms = new MemoryStream()) {
        img.Save(ms, System.Drawing.Imaging.ImageFormat.Png);
        return ms.Length > 20 * 1024 * 1024 ? null : Convert.ToBase64String(ms.ToArray());
      }
    }
  }
  // (no backslashes here: this text passes through JavaScript and PowerShell quoting)
  const char Q = (char)34, BS = (char)92;
  static void Json(StringBuilder o, string v) {
    if (v == null) { o.Append("null"); return; }
    o.Append(Q);
    foreach (char c in v) {
      if (c == Q || c == BS) o.Append(BS).Append(c);
      else if (c < (char)32 || c == (char)0x2028 || c == (char)0x2029) o.Append(BS).Append('u').Append(((int)c).ToString("x4"));
      else o.Append(c);
    }
    o.Append(Q);
  }
  static void Key(StringBuilder o, string k) { o.Append(Q).Append(k).Append(Q).Append(':'); }
  public static string Read(bool image, uint have) {
    uint s = GetClipboardSequenceNumber();
    var o = new StringBuilder("{");
    Key(o, "seq"); o.Append(s); o.Append(',');
    Key(o, "files"); o.Append('[');
    string[] files = Get();
    for (int i = 0; i < files.Length; i++) { if (i > 0) o.Append(','); Json(o, files[i]); }
    o.Append("],");
    Key(o, "text"); Json(o, files.Length > 0 ? "" : Text()); o.Append(',');
    string png = null;
    if (image && files.Length == 0 && s != have) { try { png = Png(); } catch { } }
    Key(o, "png"); Json(o, png);
    o.Append('}');
    return o.ToString();
  }
  static IntPtr Global(byte[] b) {
    IntPtr h = GlobalAlloc(GMEM_MOVEABLE, (UIntPtr)b.Length);
    if (h == IntPtr.Zero) throw new Exception("out of memory");
    Marshal.Copy(b, 0, GlobalLock(h), b.Length); GlobalUnlock(h);
    return h;
  }
  // like Explorer's Ctrl+C: the list of files (DROPFILES, wide names) and "copy" as the preferred action
  public static void Set(string[] paths) {
    var sb = new StringBuilder(); foreach (var p in paths) { sb.Append(p); sb.Append('\\0'); } sb.Append('\\0');
    byte[] names = Encoding.Unicode.GetBytes(sb.ToString()), drop = new byte[20 + names.Length];
    BitConverter.GetBytes(20).CopyTo(drop, 0);                  // pFiles: the names start after this header
    BitConverter.GetBytes(1).CopyTo(drop, 16);                  // fWide
    names.CopyTo(drop, 20);
    IntPtr hDrop = Global(drop), hEffect = Global(BitConverter.GetBytes(1));     // DROPEFFECT_COPY
    Open();
    try {
      EmptyClipboard();
      if (SetClipboardData(CF_HDROP, hDrop) == IntPtr.Zero) { GlobalFree(hDrop); GlobalFree(hEffect); throw new Exception("Windows refused the file list (error " + Marshal.GetLastWin32Error() + ")"); }
      if (SetClipboardData(RegisterClipboardFormat("Preferred DropEffect"), hEffect) == IntPtr.Zero) GlobalFree(hEffect);
    } finally { CloseClipboard(); }
  }
}
'@
[Console]::Out.WriteLine('READY'); [Console]::Out.Flush()
while ($true) {
  $l = [Console]::In.ReadLine()
  if ($null -eq $l) { break }
  try {
    if ($l.StartsWith('READ ')) {
      $a = $l.Split(' ')
      [Console]::Out.WriteLine('OK ' + [SCClip]::Read($a[1] -eq '1', [uint32]$a[2]))
    } elseif ($l -eq 'GET') {
      [Console]::Out.WriteLine('OK ' + (ConvertTo-Json -Compress -InputObject @([SCClip]::Get())))
    } elseif ($l.StartsWith('SET ')) {
      $paths = [string[]]@(foreach ($p in (ConvertFrom-Json $l.Substring(4))) { [string]$p })
      [SCClip]::Set($paths)
      $check = [SCClip]::Get()
      if ($check.Count -ne $paths.Count) { throw "the clipboard did not keep the files ($($check.Count) of $($paths.Count))" }
      [Console]::Out.WriteLine('OK []')
    }
  } catch { [Console]::Out.WriteLine('ERR ' + $_.Exception.Message.Replace([char]10, ' ')) }
  [Console]::Out.Flush()
}`;

// SC-Remote's agent runs as the system account, and Windows shows that account an empty clipboard (its own copies
// do reach the user). So for the agent the helper runs as the person signed in, started by SC-Remote's helper
// program ("as-user"): configure({ asUser: () => [helper.exe, ['as-user']] | null, log }).
let conf = { asUser: null, log: () => {} };
function configure(c) { conf = { ...conf, ...c }; stop(); }
const PS_ARGS = () => ['-NoProfile', '-NonInteractive', '-Sta', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(WIN_SCRIPT, 'utf16le').toString('base64')];
let win = null, winDownUntil = 0;
function winHelper() {
  if (win) return win;
  const launcher = conf.asUser && conf.asUser();
  if (launcher && Date.now() < winDownUntil) throw new Error('clipboard helper unavailable (nobody signed in?)');
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const [cmd, args] = launcher ? [launcher[0], [...launcher[1], ps, ...PS_ARGS()]] : ['powershell.exe', PS_ARGS()];
  const proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', launcher ? 'pipe' : 'ignore'], windowsHide: true });
  const started = Date.now();
  if (launcher) {
    let err = '';
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', d => { err = (err + d).slice(-500); });
    proc.on('exit', code => {
      // nobody signed in (3), or it could not start: try again a little later rather than every half second
      if (Date.now() - started < 15000) winDownUntil = Date.now() + 10000;
      conf.log(`clipboard helper (as the signed-in user) ended: ${code}${err.trim() ? ' — ' + err.trim() : ''}`);
    });
  }
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
  win = { ask, proc, asUser: !!launcher };
  return win;
}

/* ---------------- API ---------------- */
async function readFiles() {
  if (process.platform === 'linux') return readLinux();
  if (process.platform === 'darwin') return readMac();
  if (process.platform === 'win32') {
    const list = await winHelper().ask('GET');
    return list.length ? list : null;
  }
  return null;
}
async function writeFiles(paths) {
  if (process.platform === 'linux') return writeLinux(paths);
  if (process.platform === 'darwin') return writeMac(paths);
  if (process.platform === 'win32') return winHelper().ask('SET ' + JSON.stringify(paths));
  throw new Error('not supported on this OS');
}
// Everything copied (files, text, picture) through the helper, when it runs as the signed-in user; else null
// (the caller reads the clipboard itself). The picture is only sent again when the clipboard changed.
let shot = { seq: -1, png: null };
async function readAll(withImage) {
  if (process.platform !== 'win32' || !(conf.asUser && conf.asUser())) return null;
  const r = await winHelper().ask(`READ ${withImage ? 1 : 0} ${withImage ? Math.max(shot.seq, 0) : 0}`);
  if (!r || typeof r !== 'object') return null;
  let png = null;
  if (withImage) {
    if (r.png) shot = { seq: r.seq, png: Buffer.from(r.png, 'base64') };
    else if (r.seq !== shot.seq) shot = { seq: r.seq, png: null };
    png = shot.png;
  }
  return { text: typeof r.text === 'string' ? r.text : '', png, files: Array.isArray(r.files) ? r.files.map(String) : [] };
}
function stop() { if (win) { try { win.proc.stdin.end(); win.proc.kill(); } catch {} win = null; } }

module.exports = { readFiles, writeFiles, readAll, configure, stop, parseUris, parsePlistPaths, plistOf, WIN_SCRIPT };
