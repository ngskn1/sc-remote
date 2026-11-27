'use strict';
// SC-Remote's file worker, run by the Windows agent as the person signed in at the PC (through the service's
// helper: "as-user", with SC-Remote's program in Node mode), so members reach exactly the files that person may.
// One JSON request per line on stdin: {"id":1,"fn":"list","args":[…]}; one answer per line on stdout:
// {"id":1,"ok":true,"value":…} or {"id":1,"ok":false,"error":"…"}. File data travels as {"b64":"…"}.
const readline = require('readline');
const ops = require('./fsops');

const allowed = new Set(['list', 'walk', 'unique', 'uniquePath', 'openRead', 'read', 'openWrite', 'openWritePath', 'write', 'close', 'mkdir', 'stage', 'realish', 'ping']);
const decode = v => (v && typeof v === 'object' && typeof v.b64 === 'string' ? Buffer.from(v.b64, 'base64') : v);
const encode = v => (Buffer.isBuffer(v) ? { b64: v.toString('base64') } : v);
const say = o => process.stdout.write(JSON.stringify(o) + '\n');

readline.createInterface({ input: process.stdin }).on('line', async line => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (!m || !allowed.has(m.fn)) { say({ id: m && m.id, ok: false, error: 'unknown request' }); return; }
  try {
    const value = m.fn === 'ping' ? { user: require('os').userInfo().username, home: require('os').homedir() }
      : await ops[m.fn](...(Array.isArray(m.args) ? m.args : []).map(decode));
    say({ id: m.id, ok: true, value: encode(value) });
  } catch (e) {
    say({ id: m.id, ok: false, error: e && e.code === 'EPERM' || e && e.code === 'EACCES' ? 'EACCES: access denied' : String(e && e.message || e) });
  }
});
process.stdin.on('end', () => process.exit(0));
