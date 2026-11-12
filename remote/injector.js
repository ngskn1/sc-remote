// Runs the per-OS input helper as one long-lived process and feeds it commands over stdin.
// One process (instead of one per event) keeps each injected event well under a millisecond.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { lookup, MODIFIERS } = require('./keymap');

class Injector {
  constructor(log = () => {}) {
    this.log = log;
    this.proc = null;
    this.ready = null;
    this.error = '';
    this.down = new Set();          // keys currently held, released on disconnect so nothing gets stuck
    this.buttons = new Set();
    this.pendingMove = null;
    this.moveScheduled = false;
    this.helperPath = () => null;   // lab edition on Windows: the compiled helper (follows the login/lock/UAC desktop)
    this.onDesktop = null;          // set by the lab agent: called with the input desktop's name when it changes
  }

  start() {
    if (this.proc) return this.ready;
    let cmd, args;
    if (process.platform === 'linux') {
      // Packaged apps keep scripts inside app.asar, which python can't open: pass the code inline.
      cmd = 'python3';
      args = ['-u', '-c', fs.readFileSync(path.join(__dirname, 'inject-linux.py'), 'utf8')];
    } else if (process.platform === 'win32' && this.helperPath()) {
      cmd = this.helperPath();
      args = ['input'];
    } else if (process.platform === 'win32') {
      const script = fs.readFileSync(path.join(__dirname, 'inject-windows.ps1'), 'utf8');
      cmd = 'powershell.exe';
      args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
    } else {
      this.error = 'Remote control is not supported on this OS';
      return (this.ready = Promise.resolve(false));
    }
    const proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.proc = proc;
    this.ready = new Promise(resolve => {
      let out = '';
      const done = ok => { resolve(ok); };
      proc.stdout.on('data', d => {
        out += d;
        let i;
        while ((i = out.indexOf('\n')) >= 0) {
          const line = out.slice(0, i).trim(); out = out.slice(i + 1);
          if (line === 'READY') done(true);
          else if (line.startsWith('D ')) { if (this.onDesktop) this.onDesktop(line.slice(2)); }
          else if (line.startsWith('ERR')) { this.error = line.slice(4); this.log('injector: ' + line); }
        }
      });
      proc.stderr.on('data', d => { this.error = String(d).trim().split('\n').pop(); this.log('injector stderr: ' + String(d).trim()); });
      proc.on('error', e => { this.error = e.code === 'ENOENT' ? `${cmd} not found` : e.message; done(false); });
      proc.on('exit', code => {
        if (this.proc === proc) { this.proc = null; this.ready = null; }
        if (code) this.log(`injector exited (${code}): ${this.error}`);
        done(false);
        // the lab agent needs it all the time (desktop reports): start it again
        if (this.onDesktop && !this.stopped) setTimeout(() => { if (!this.proc && !this.stopped) this.start(); }, 2000).unref();
      });
      setTimeout(() => done(false), 20000);
    });
    return this.ready;
  }

  stop() {
    this.stopped = true;
    this.releaseAll();
    if (this.proc) {
      // Close stdin so the helper processes the releases above and exits by itself; kill only if it hangs.
      const proc = this.proc;
      try { proc.stdin.end(); } catch {}
      setTimeout(() => { try { proc.kill(); } catch {} }, 1500).unref();
      this.proc = null; this.ready = null;
    }
  }

  send(line) {
    if (this.proc && this.proc.stdin.writable) this.proc.stdin.write(line + '\n');
  }

  // Coalesce pointer moves: only the latest position per event-loop turn is sent.
  move(x, y) {
    this.pendingMove = [Math.round(x), Math.round(y)];
    if (this.moveScheduled) return;
    this.moveScheduled = true;
    setImmediate(() => {
      this.moveScheduled = false;
      if (this.pendingMove) { this.send(`M ${this.pendingMove[0]} ${this.pendingMove[1]}`); this.pendingMove = null; }
    });
  }

  flushMove() {
    if (this.pendingMove) { this.send(`M ${this.pendingMove[0]} ${this.pendingMove[1]}`); this.pendingMove = null; }
  }

  button(b, down) {
    if (![1, 2, 3, 8, 9].includes(b)) return;
    this.flushMove();                      // click where the pointer is now, not where it was
    down ? this.buttons.add(b) : this.buttons.delete(b);
    this.send(`B ${b} ${down ? 1 : 0}`);
  }

  wheel(dx, dy) {
    dx = Math.max(-20, Math.min(20, Math.round(dx))); dy = Math.max(-20, Math.min(20, Math.round(dy)));
    if (!dx && !dy) return;
    this.flushMove();
    this.send(`W ${dx} ${dy}`);
  }

  // repeat: the controlling PC's auto-repeat. X11 repeats held keys by itself, Windows doesn't.
  key(code, down, repeat = false) {
    const k = lookup(code);
    if (!k) return;
    if (down && repeat && process.platform === 'linux') return;
    if (!down && !this.down.has(code)) return;          // never send a release for a key we didn't press
    down ? this.down.add(code) : this.down.delete(code);
    if (process.platform === 'linux') this.send(`K ${k.evdev} ${down ? 1 : 0}`);
    else this.send(`K ${k.scan} ${k.ext ? 1 : 0} ${k.vk} ${down ? 1 : 0}`);
  }

  // Perform a file drag-and-drop on this PC: press inside the drag-source window at (sx,sy), then — while
  // the app is blocked running the native drag — the helper alone moves to (dx,dy) and releases.
  // beforeRelease runs the native drag (it blocks until the drop happens).
  dragTo(sx, sy, dx, dy, startDrag) {
    this.releaseAll();
    const q = [];
    q.push(`M ${sx} ${sy}`, 'S 60', 'B 1 1', 'S 60');
    for (let i = 1; i <= 5; i++) q.push(`M ${sx + i * 3} ${sy + i * 3}`, 'S 25');   // past the drag threshold
    this.send(q.join('\n'));
    return () => {
      // queued before the blocking native drag starts; the helper plays it on its own clock
      const r = [];
      r.push('S 250');
      const steps = 12;
      for (let i = 1; i <= steps; i++) {
        const x = Math.round(sx + 15 + (dx - sx - 15) * i / steps), y = Math.round(sy + 15 + (dy - sy - 15) * i / steps);
        r.push(`M ${x} ${y}`, 'S 30');
      }
      r.push(`M ${dx} ${dy}`, 'S 250', 'B 1 0', 'S 50');
      this.send(r.join('\n'));
      startDrag();
    };
  }

  // Ctrl+Alt+Del on Windows (the secure attention sequence): only the system can send it, so the helper asks
  // Windows to (works when the host runs as the lab service; on Linux, Ctrl+Alt+Del keys are sent instead).
  sas() {
    if (process.platform === 'win32') { this.send('SAS'); return; }
    for (const k of ['ControlLeft', 'AltLeft', 'Delete']) this.key(k, true);
    for (const k of ['Delete', 'AltLeft', 'ControlLeft']) this.key(k, false);
  }

  // Release everything held, modifiers last (so e.g. Ctrl isn't left down after Ctrl+C).
  releaseAll() {
    const keys = [...this.down];
    for (const c of keys.filter(c => !MODIFIERS.has(c))) this.key(c, false);
    for (const c of keys.filter(c => MODIFIERS.has(c))) this.key(c, false);
    for (const b of [...this.buttons]) this.button(b, false);
  }
}

module.exports = { Injector };
