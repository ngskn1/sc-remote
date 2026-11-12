// Windows: per-app audio with WASAPI process loopback (via the loopback-capture addon).
// "Everything except Discord" excludes Discord's whole process tree; "Only <app>" includes one app's tree.
const { execFile } = require('child_process');

const DISCORD = /^(discord(ptb|canary|development)?|vesktop|legcord)\.exe$/i;
const SHELL_APPS = /^(ApplicationFrameHost|TextInputHost|ShellExperienceHost|SearchHost|StartMenuExperienceHost|LockApp|SystemSettings|explorer)$/i;

let capture = null;

function powershell(script) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

const asArray = x => (x == null ? [] : Array.isArray(x) ? x : [x]);

// One PowerShell call: every process (for Discord's tree) and every process with a visible window (the app list).
async function snapshot() {
  const out = await powershell(`
    $ErrorActionPreference = 'SilentlyContinue'
    $p = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name)
    $w = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | Select-Object Id, ProcessName, MainWindowTitle)
    [pscustomobject]@{ procs = $p; windows = $w } | ConvertTo-Json -Compress -Depth 3`);
  const data = JSON.parse(out);
  return { procs: asArray(data.procs), windows: asArray(data.windows) };
}

function discordRoot(procs) {
  const discord = procs.filter(p => DISCORD.test(p.Name || ''));
  const ids = new Set(discord.map(p => p.ProcessId));
  const root = discord.find(p => !ids.has(p.ParentProcessId));
  return root ? root.ProcessId : null;
}

function descendants(procs, rootPid) {
  const set = new Set([rootPid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of procs) if (set.has(p.ParentProcessId) && !set.has(p.ProcessId)) { set.add(p.ProcessId); grew = true; }
  }
  return set;
}

async function list() {
  const { procs, windows } = await snapshot();
  const discord = discordRoot(procs);
  const mine = descendants(procs, process.pid);
  const apps = windows
    .filter(w => !mine.has(w.Id) && !SHELL_APPS.test(w.ProcessName) && !DISCORD.test(w.ProcessName + '.exe'))
    .sort((a, b) => a.MainWindowTitle.localeCompare(b.MainWindowTitle))
    .map(w => ({ id: 'pid:' + w.Id, label: `Only: ${w.MainWindowTitle.slice(0, 60)} (${w.ProcessName}.exe)` }));
  return [
    { id: 'except-discord', label: discord ? 'Everything except Discord' : 'Everything except Discord (Discord not running)', recommended: true },
    ...apps,
    { id: 'system', label: 'Everything, including Discord (echo!)' },
  ];
}

async function start(id, onChunk) {
  stop();
  let LoopbackCapture;
  try { ({ LoopbackCapture } = require('loopback-capture')); }
  catch (e) { throw new Error('The audio capture module failed to load: ' + e.message); }

  const cap = new LoopbackCapture();
  let note = '';
  try {
    if (id === 'system') {
      cap.startSystemAudio(onChunk);
    } else if (id === 'except-discord') {
      const pid = discordRoot((await snapshot()).procs);
      if (!pid) note = 'Discord was not running when you started, so its audio is not excluded. Restart sharing after opening Discord.';
      // excluding our own process tree when Discord is absent = "everything"
      cap.start(pid || process.pid, false, onChunk);
    } else if (id.startsWith('pid:')) {
      cap.start(Number(id.slice(4)), true, onChunk);
    } else {
      throw new Error('Unknown audio source');
    }
  } catch (e) {
    throw new Error(/HRESULT/.test(e.message)
      ? `${e.message}. Per-app audio needs Windows 10 build 20348+ or Windows 11; "Everything, including Discord" works on older versions.`
      : e.message);
  }
  capture = cap;
  return { type: 'pcm', note };
}

function stop() {
  if (!capture) return;
  try { capture.stop(); } catch {}
  capture = null;
}

module.exports = { list, start, stop, stopSync: stop };
