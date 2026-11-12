// Linux: per-app audio by routing apps into a virtual output (PipeWire or PulseAudio, via pactl).
// A null sink "ScreenShare-Game" is looped back to your speakers so you still hear everything;
// Its monitor is recorded with parec (or pw-record) and streamed to the page as raw PCM, because
// Chromium hides "Monitor of …" devices on Linux. Discord stays on your normal output.
const { execFile, execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SINK = 'screenshare_game';
const DESC = 'ScreenShare-Game';
const DISCORD = /discord|vesktop|legcord|webcord/i;
const env = { ...process.env, LC_ALL: 'C' };   // pactl output is localised otherwise

let ourModules = [];   // modules we loaded (unloaded on stop); a sink made by game-audio-linux.sh is left alone
// Remember them on disk too, so a crash or a killed app gets cleaned up on the next launch.
const STATE = path.join(os.tmpdir(), `screenshare-modules-${process.getuid ? process.getuid() : 0}.json`);
function saveState() {
  try { ourModules.length ? fs.writeFileSync(STATE, JSON.stringify(ourModules)) : fs.rmSync(STATE, { force: true }); } catch {}
}
let timer = null;
let recorder = null;

// Resolves once the process has actually started; rejects if the program is missing.
function spawnChecked(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.once('spawn', () => resolve(child));
    child.once('error', reject);
  });
}

// s16le stereo 48 kHz from the sink's monitor, the same format the Windows capture produces.
async function startRecorder(onChunk) {
  let child;
  try {
    child = await spawnChecked('parec', ['-d', `${SINK}.monitor`, '--format=s16le', '--rate=48000', '--channels=2',
      '--raw', '--latency-msec=20', '--client-name=ScreenShare']);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    try {
      child = await spawnChecked('pw-record', ['--target', SINK, '-P', '{ stream.capture.sink = true }',
        '--format', 's16', '--rate', '48000', '--channels', '2', '--latency', '20ms', '-']);
    } catch (e2) {
      throw new Error(e2.code === 'ENOENT' ? 'parec not found. Install it with: sudo apt install pulseaudio-utils' : e2.message);
    }
  }
  let err = '';
  child.stderr.on('data', d => { err = (err + d).slice(-500); });
  child.stdout.on('data', onChunk);
  child.on('exit', code => { if (recorder === child && code) console.error('audio recorder exited', code, err); });
  recorder = child;
}

function pactl(args) {
  return new Promise((resolve, reject) => {
    execFile('pactl', args, { env }, (err, stdout, stderr) => {
      if (err) reject(new Error(err.code === 'ENOENT'
        ? 'pactl not found. Install it with: sudo apt install pulseaudio-utils'
        : (stderr || err.message).trim()));
      else resolve(stdout);
    });
  });
}

async function sinkInputs() {
  const [out, mods] = await Promise.all([pactl(['list', 'sink-inputs']), pactl(['list', 'short', 'modules'])]);
  const loopbacks = new Set(mods.split('\n').filter(l => /\tmodule-(loopback|combine-sink)\b/.test(l)).map(l => l.split('\t')[0]));
  return out.split(/^Sink Input #/m).slice(1).map(block => {
    const props = {};
    for (const m of block.matchAll(/^\s+([\w.-]+) = "(.*)"$/gm)) props[m[1]] = m[2];
    return {
      index: block.match(/^(\d+)/)[1],
      sink: (block.match(/^\s+Sink: (\d+)/m) || [])[1],
      // loopback streams must never be moved into our sink (that would feed it back into itself)
      owned: loopbacks.has((block.match(/^\s+Owner Module: (\d+)/m) || [])[1])
        || /loopback/i.test([props['media.name'], props['node.name'], props['application.name']].join(' ')),
      pid: Number(props['application.process.id']) || 0,
      name: props['application.name'] || '',
      binary: props['application.process.binary'] || '',
    };
  });
}

const appKey = si => (si.binary || si.name).toLowerCase();

async function sinkIndex() {
  const out = await pactl(['list', 'short', 'sinks']);
  const line = out.split('\n').find(l => l.split('\t')[1] === SINK);
  return line ? line.split('\t')[0] : null;
}

async function ensureSink() {
  let idx = await sinkIndex();
  if (idx) return idx;
  const def = ((await pactl(['info'])).match(/^Default Sink: (.*)$/m) || [])[1];
  const m1 = (await pactl(['load-module', 'module-null-sink', `sink_name=${SINK}`, `sink_properties=device.description=${DESC}`])).trim();
  ourModules.push(m1); saveState();
  const m2 = (await pactl(['load-module', 'module-loopback', `source=${SINK}.monitor`, ...(def ? [`sink=${def}`] : []), 'latency_msec=20'])).trim();
  ourModules.push(m2); saveState();
  idx = await sinkIndex();
  if (!idx) throw new Error('Could not create the ScreenShare-Game output');
  return idx;
}

// Streams we must never move: loopbacks (would feed back into themselves) and our own app.
function movable(si, ownPids) {
  return !si.owned && !ownPids.has(si.pid);
}

async function list(ownPids = new Set()) {
  const seen = new Map();
  for (const si of await sinkInputs()) {
    if (!movable(si, ownPids) || DISCORD.test(si.name + ' ' + si.binary)) continue;
    const key = appKey(si);
    if (key && !seen.has(key)) seen.set(key, `Only: ${si.name || si.binary}${si.binary && si.binary !== si.name ? ` (${si.binary})` : ''}`);
  }
  return [
    { id: 'except-discord', label: 'Everything except Discord', recommended: true },
    ...[...seen].map(([key, label]) => ({ id: 'app:' + key, label })),
  ];
}

async function start(id, onChunk, ownPidsFn = () => new Set()) {
  stop();
  const target = await ensureSink();
  const wanted = id === 'except-discord'
    ? si => !DISCORD.test(si.name + ' ' + si.binary)
    : si => appKey(si) === id.slice(4);
  // Re-check every 1.5 s so sounds the game opens later (new streams) also get routed.
  const tick = async () => {
    const own = ownPidsFn();
    for (const si of await sinkInputs().catch(() => [])) {
      if (si.sink === target || !movable(si, own) || !wanted(si)) continue;
      await pactl(['move-sink-input', si.index, SINK]).catch(() => {});
    }
  };
  await tick();
  timer = setInterval(tick, 1500);
  await startRecorder(onChunk);
  return { type: 'pcm', note: '' };
}

function stop() {
  clearInterval(timer); timer = null;
  if (recorder) { recorder.kill(); recorder = null; }
  // unloading the sink sends its streams back to your normal output automatically
  for (const m of ourModules.reverse()) execFile('pactl', ['unload-module', m], { env }, () => {});
  ourModules = [];
  saveState();
}

function stopSync() {           // on quit: must finish before the process exits
  clearInterval(timer); timer = null;
  if (recorder) { recorder.kill('SIGKILL'); recorder = null; }
  for (const m of ourModules.reverse()) { try { execFileSync('pactl', ['unload-module', m], { env }); } catch {} }
  ourModules = [];
  saveState();
}

// After a crash: unload modules a previous run left behind (only if they are still ours).
function recoverStale() {
  let ids = [];
  try { ids = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return; }
  try {
    const mods = execFileSync('pactl', ['list', 'short', 'modules'], { env }).toString().split('\n');
    for (const id of [...ids].sort((a, b) => b - a)) {
      if (mods.some(l => l.split('\t')[0] === id && l.includes(SINK))) {
        try { execFileSync('pactl', ['unload-module', id], { env }); } catch {}
      }
    }
  } catch {}
  try { fs.rmSync(STATE, { force: true }); } catch {}
}

module.exports = { list, start, stop, stopSync, recoverStale, _sinkInputs: sinkInputs };
