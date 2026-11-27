'use strict';
// File operations for the Files panel, copy-paste and drag-and-drop. SC-Remote runs them either in its own
// process or, for the Windows agent (which runs as the system account), in remote/userfs.js started as the person
// signed in at the PC, so that Windows lets members use exactly the files that person may use.
// Everything here takes and returns plain values (the worker passes them as JSON; file data as base64).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const handles = new Map();
let nextHandle = 1;
const keep = fd => { const h = nextHandle++; handles.set(h, fd); return h; };

// rel uses '/' and must stay inside base (no "..", no absolute paths)
function safeJoin(base, rel) {
  const parts = String(rel).split(/[\\/]+/).filter(x => x && x !== '.');
  if (!parts.length || parts.some(x => x === '..')) throw new Error('bad path');
  return path.join(String(base), ...parts.map(x => x.replace(/[:*?"<>|\x00-\x1f]/g, '_')));
}

async function list(dir, home) {
  dir = path.resolve(String(dir || home));
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
  const parent = path.dirname(dir);
  const roots = process.platform === 'win32'
    ? 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(l => l + ':\\').filter(r => { try { fs.readdirSync(r); return true; } catch { return false; } })
    : ['/'];
  return { path: dir, parent: parent !== dir ? parent : null, sep: path.sep, home, roots, entries };
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
  for (const p of paths) await add(String(p), path.basename(String(p)));
  return { items, total, roots: paths.map(p => path.basename(String(p))) };
}

function unique(base, names) {
  const used = new Set();
  return names.map(n => {
    n = String(n);
    const ext = path.extname(n), stem = n.slice(0, n.length - ext.length);
    let name = n;
    for (let i = 2; fs.existsSync(path.join(String(base), name)) || used.has(name); i++) name = `${stem} (${i})${ext}`;
    used.add(name);
    return name;
  });
}

function uniquePath(dir, name) {
  name = path.basename(String(name)).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_') || 'file';
  let p = path.join(String(dir), name);
  const ext = path.extname(name), base = name.slice(0, name.length - ext.length);
  for (let n = 2; fs.existsSync(p); n++) p = path.join(String(dir), `${base} (${n})${ext}`);
  return p;
}

async function openRead(p) {
  p = String(p);
  const st = await fs.promises.stat(p);
  if (st.isDirectory()) throw new Error('That is a folder');
  const fd = await fs.promises.open(p, 'r');
  return { handle: keep(fd), size: st.size, name: path.basename(p) };
}
async function read(handle, offset, length) {
  const fd = handles.get(handle); if (!fd) throw new Error('closed');
  const buf = Buffer.alloc(Math.max(0, Math.min(Number(length) || 0, 1024 * 1024)));
  const { bytesRead } = await fd.read(buf, 0, buf.length, Number(offset) || 0);
  return buf.subarray(0, bytesRead);
}
// a new file (never an existing one) in dir; p: the path to use (already checked by the caller), else a free name
async function openWrite(dir, name, p) {
  p = p ? String(p) : uniquePath(dir, name);
  const fd = await fs.promises.open(p, 'wx');
  return { handle: keep(fd), path: p };
}
async function openWritePath(p) {
  p = String(p);
  await fs.promises.mkdir(path.dirname(p), { recursive: true });
  const fd = await fs.promises.open(p, 'w');
  return { handle: keep(fd), path: p };
}
async function write(handle, data) {
  const fd = handles.get(handle); if (!fd) throw new Error('closed');
  await fd.write(Buffer.from(data));
}
async function close(handle, removePath) {
  const fd = handles.get(handle); handles.delete(handle);
  if (fd) await fd.close().catch(() => {});
  if (removePath) await fs.promises.rm(String(removePath), { force: true }).catch(() => {});
}
async function mkdir(p) { await fs.promises.mkdir(String(p), { recursive: true }); }
async function stage(root) {
  const p = path.join(String(root), new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex'));
  await fs.promises.mkdir(p, { recursive: true });
  return p;
}
// the real location of p (links and junctions resolved), also when the last parts don't exist yet
function realish(p) {
  const rest = [];
  for (let cur = path.resolve(String(p)); ; ) {
    try { return path.join(fs.realpathSync.native(cur), ...rest); } catch {}
    const up = path.dirname(cur);
    if (up === cur) return null;
    rest.unshift(path.basename(cur)); cur = up;
  }
}

module.exports = { safeJoin, list, walk, unique, uniquePath, openRead, read, openWrite, openWritePath, write, close, mkdir, stage, realish };
