// Compiles the Windows service and helper of ScreenShare Remote (C#, .NET Framework 4.7.2+, which Windows 10/11 have).
// Uses Mono's compiler on Linux/macOS, or the C# compiler that comes with .NET Framework on Windows.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const src = path.join(root, 'windows'), out = path.join(root, 'windows', 'bin');
fs.mkdirSync(out, { recursive: true });
const winCsc = process.env.WINDIR && path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const csc = winCsc && fs.existsSync(winCsc) ? winCsc : 'mcs';
const sdk = csc === 'mcs' ? ['-sdk:4.7.2'] : [];
const build = (file, exe, refs, target = 'exe', main = null) => {
  execFileSync(csc, [...sdk, '-nologo', '-target:' + target, '-optimize+', '-platform:anycpu', ...(main ? ['-main:' + main] : []), ...refs.map(r => '-r:' + r), '-out:' + path.join(out, exe), path.join(src, file)], { stdio: 'inherit' });
  console.log('built', exe);
};
build('Helper.cs', 'ScreenShareRemoteHelper.exe', ['System.Drawing.dll']);
// a window-less program: a service, its settings dialog, and setup commands for the installer (no console flashing)
build('Service.cs', 'ScreenShareRemoteService.exe', ['System.ServiceProcess.dll', 'System.Windows.Forms.dll', 'System.Drawing.dll', 'System.Web.Extensions.dll'], 'winexe', 'Program');
