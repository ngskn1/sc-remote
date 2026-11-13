'use strict';
// Restarting an AppImage. Electron's app.relaunch() starts a helper from inside the AppImage, and the AppImage
// is unmounted as soon as this copy exits, so the helper dies and nothing comes back (seen updating 1.5.0 → 1.5.1:
// the file was replaced, but the app stayed closed). Instead, a shell outside the AppImage waits for this process
// to end and then starts the AppImage file again.
const { spawn } = require('child_process');
const os = require('os');

// This process's environment without what the AppImage added (paths into its mount, which will be gone)
function outsideEnv(env = process.env) {
  const dir = env.APPDIR, out = { ...env };
  for (const k of ['APPDIR', 'APPIMAGE', 'ARGV0', 'OWD']) delete out[k];
  if (dir) {
    for (const k of ['PATH', 'LD_LIBRARY_PATH', 'XDG_DATA_DIRS', 'GSETTINGS_SCHEMA_DIR']) {
      if (out[k] == null) continue;
      const kept = out[k].split(':').filter(p => p && p !== dir && !p.startsWith(dir + '/'));
      if (kept.length) out[k] = kept.join(':'); else delete out[k];
    }
  }
  if (!out.PATH) out.PATH = '/usr/local/bin:/usr/bin:/bin';
  return out;
}

// Start `file` with `args` once this process has ended (call app.exit() right after)
function relaunchAfterExit(file, args = []) {
  const trace = process.env.SCREENSHARE_RELAUNCH_LOG;        // (a file to follow the restart in, for testing)
  const out = trace ? require('fs').openSync(trace, 'a') : 'ignore';
  const p = spawn('/bin/sh', ['-c', (trace ? 'set -x; ' : '') +
    // (first let go of what the AppImage handed down: its runtime keeps the old copy mounted while anything holds it)
    'exec 3>&- 4>&- 5>&- 6>&- 7>&- 8>&- 9>&-; ' +
    'while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; shift; exec "$@"', 'sc-relaunch', String(process.pid), file, ...args],
    { detached: true, stdio: ['ignore', out, out], env: outsideEnv(), cwd: os.homedir() });
  p.unref();
  if (trace) require('fs').closeSync(out);
}

module.exports = { relaunchAfterExit, outsideEnv };
