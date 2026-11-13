// electron-builder settings for SC-Remote: remote desktop only, AnyDesk-style (ID + password per PC).
//  Windows: installer with a background service so PCs are reachable from startup   npm run dist:remote
//  Linux:   AppImage; connects, and can be controlled while someone is signed in      npm run dist:remote-linux
//  Mac:     disk image (Intel + Apple Silicon); connects only. Built on a Mac         npm run dist:remote-mac
//  (GitHub Actions builds all three for each release: .github/workflows/release-sc-remote.yml)
// Icon: put a 256×256 PNG at build/sc-remote/icon.png (installer and shortcuts; the program's own icon is set
// when building on Windows) and replace app/icon-tray.png (tray, 32×32 or larger).
const fs = require('fs');
const path = require('path');
const { publicKeyParts, MANIFEST_NAME } = require('../remote/update');
// SC-Remote's version and its GitHub repository (releases: installers + signed update manifests).
// To release a new version, raise "version" in build/sc-remote/release.json (see .github/workflows).
const { version: VERSION, repo: REPO } = require('./sc-remote/release.json');
const icon = path.join(__dirname, 'sc-remote', 'icon.png');
// Updates: the app and the service trust only manifests signed with the key whose public half is here
const publicKey = fs.readFileSync(path.join(__dirname, 'sc-remote', 'update-public.pem'), 'utf8');
const manifestUrl = `https://github.com/${REPO}/releases/latest/download/${MANIFEST_NAME}`;
// (the service reads its copy next to it: resources\service\update.json)
fs.writeFileSync(path.join(__dirname, 'sc-remote', 'update.json'), JSON.stringify({
  product: 'SC-Remote', version: VERSION, manifestUrl, allowedPrefix: `https://github.com/${REPO}/releases/download/`, ...publicKeyParts(publicKey),
}, null, 2));
module.exports = {
  appId: 'local.sc-remote',
  productName: 'SC-Remote',
  extraMetadata: {
    name: 'sc-remote', productName: 'SC-Remote', version: VERSION, edition: 'remote',
    description: 'SC-Remote: remote desktop with an ID and password, reachable from startup',
    feedbackUrl: 'https://docs.google.com/forms/d/e/1FAIpQLSfgZWdA__7rPYBjxiTIyL99z-nENiVpir4bZa54XLz8ewiinQ/viewform',
    update: { repo: REPO, manifestUrl, publicKey },
  },
  files: [
    'main.js', 'remote-preload.js', 'remote/**/*', 'package.json',
    'app/remote.html', 'app/remote-host.html', 'app/remote-session.html', 'app/lab-prompt.html', 'app/i18n.js',
    'app/remote-common.js', 'app/peerjs.min.js', 'app/icon-tray.png',
    '!node_modules/loopback-capture/**',
  ],
  directories: { output: 'dist-remote' },
  // the Windows service, its settings window and the input/capture helper run outside the app archive
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }], signAndEditExecutable: false,
    extraResources: [{ from: 'windows/bin', to: 'service', filter: ['*.exe'] }, { from: 'build/sc-remote/update.json', to: 'service/update.json' }],
    ...(fs.existsSync(icon) ? { icon } : {}),
  },
  linux: {
    target: [{ target: 'AppImage', arch: ['x64'] }], category: 'Network', executableName: 'sc-remote',
    synopsis: 'Remote desktop with an ID and password', ...(fs.existsSync(icon) ? { icon } : {}),
  },
  // one name for every version: the app replaces this file when it updates itself (the release says the version)
  appImage: { artifactName: 'SC-Remote-x86_64.AppImage' },
  // No Apple developer account: an ad-hoc signature (needed to run on Apple Silicon). macOS asks people to allow
  // the app once (System Settings › Privacy & Security › Open Anyway): see windows/GUIDE.md.
  mac: {
    target: [{ target: 'dmg', arch: ['universal'] }], identity: '-', hardenedRuntime: false,
    category: 'public.app-category.utilities', ...(fs.existsSync(icon) ? { icon } : {}),
  },
  dmg: { artifactName: 'SC-Remote-${version}-mac.dmg' },
  nsis: {
    oneClick: true, perMachine: true, include: 'build/remote-installer.nsh',
    artifactName: 'SC-Remote-Setup-${version}.exe', shortcutName: 'SC-Remote', uninstallDisplayName: 'SC-Remote',
  },
  publish: null,
  npmRebuild: false,
};
