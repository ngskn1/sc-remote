// electron-builder settings for the lab edition ("ScreenShare Remote"): remote desktop only, Windows installer
// with the background service, plus an AppImage for members on Linux.
//   npm run dist:lab
const LAB_VERSION = '1.0.3';
module.exports = {
  appId: 'local.screenshare.remote',
  productName: 'ScreenShare Remote',
  extraMetadata: {
    name: 'screenshare-remote', productName: 'ScreenShare Remote', version: LAB_VERSION, edition: 'lab',
    description: 'Remote desktop for a lab: members sign in with personal keys, lab PCs reachable from boot',
  },
  files: [
    'main.js', 'remote-preload.js', 'remote/**/*', 'package.json',
    'app/lab.html', 'app/lab-prompt.html', 'app/remote-host.html', 'app/remote-session.html',
    'app/remote-common.js', 'app/peerjs.min.js', 'app/icon-tray.png', 'app/i18n.js',
    '!node_modules/loopback-capture/**',
  ],
  directories: { output: 'dist-lab' },
  // the Windows service and helper run outside the app archive
  win: { target: [{ target: 'nsis', arch: ['x64'] }], signAndEditExecutable: false, extraResources: [{ from: 'windows/bin', to: 'lab', filter: ['*.exe'] }] },
  nsis: {
    oneClick: true, perMachine: true, include: 'build/lab-installer.nsh',
    artifactName: 'ScreenShare-Remote-Setup-${version}.exe', shortcutName: 'ScreenShare Remote', uninstallDisplayName: 'ScreenShare Remote',
  },
  linux: { target: [{ target: 'AppImage', arch: ['x64'] }], category: 'Network', icon: 'build/icon.png' },
  appImage: { artifactName: 'ScreenShare-Remote-${version}.AppImage' },
  publish: null,
  npmRebuild: false,
};
