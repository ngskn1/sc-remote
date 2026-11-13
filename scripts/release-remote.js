// Publishes an SC-Remote release on GitHub: the Windows installer, the Mac disk image and the Linux AppImage,
// plus "sc-remote-update.json", the signed manifest that installed copies look for (https://github.com/<repo>/releases/latest/download/sc-remote-update.json).
//
//   node scripts/release-remote.js            write dist-remote/sc-remote-update.json (and check it)
//   node scripts/release-remote.js --publish  ... and create the GitHub release v<version> with all of them (gh CLI)
//
// The release key comes from SC_REMOTE_UPDATE_KEY (the PEM text; in GitHub Actions, the repository secret) or from
// a file named in SC_REMOTE_UPDATE_KEY_FILE. It must match build/sc-remote/update-public.pem, which is built into
// every copy: a release signed with any other key is refused by the app and by the service.
// Release notes (optional, shown with the update): RELEASE_NOTES.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { signManifest, verifyManifest, MANIFEST_NAME } = require('../remote/update');

const root = path.join(__dirname, '..');
const { version: VERSION, repo: REPO } = require('../build/sc-remote/release.json');
require('../build/remote.config.js');            // (writes build/sc-remote/update.json, as the build does)
const publish = process.argv.includes('--publish');
const fail = m => { console.error('release: ' + m); process.exit(1); };

// a tag push must match the version in build/sc-remote/release.json
const ref = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : null;
if (ref && ref !== 'v' + VERSION) fail(`the tag ${ref} doesn't match SC-Remote's version ${VERSION} (build/sc-remote/release.json)`);

// The downloads: the Windows installer (always), and the Mac disk image and Linux AppImage when built.
// RELEASE_REQUIRE=win32,darwin,linux (as the release workflow sets it) makes a missing one an error.
const tag = 'v' + VERSION;
const FILES = {
  win32: `SC-Remote-Setup-${VERSION}.exe`,
  darwin: `SC-Remote-${VERSION}-mac.dmg`,
  linux: 'SC-Remote-x86_64.AppImage',
};
const required = (process.env.RELEASE_REQUIRE || 'win32').split(',').map(s => s.trim()).filter(Boolean);
const assets = {};
for (const [platform, file] of Object.entries(FILES)) {
  const p = path.join(root, 'dist-remote', file);
  if (!fs.existsSync(p)) {
    if (required.includes(platform)) fail(`${p} not found (build it first: see build/remote.config.js)`);
    continue;
  }
  const data = fs.readFileSync(p);
  assets[platform] = { file, path: p, url: `https://github.com/${REPO}/releases/download/${tag}/${file}`,
                       sha256: crypto.createHash('sha256').update(data).digest('hex'), size: data.length };
}
if (!assets.win32) fail('the Windows installer is missing');

let key = process.env.SC_REMOTE_UPDATE_KEY || '';
if (!key && process.env.SC_REMOTE_UPDATE_KEY_FILE) key = fs.readFileSync(process.env.SC_REMOTE_UPDATE_KEY_FILE, 'utf8');
if (!/BEGIN (RSA )?PRIVATE KEY/.test(key)) fail('no release key: set SC_REMOTE_UPDATE_KEY (or SC_REMOTE_UPDATE_KEY_FILE)');

// the top-level file/url/sha256/size are the Windows installer: what the Windows service and SC-Remote 1.3–1.4 read
const w = assets.win32;
const manifest = {
  product: 'SC-Remote', version: VERSION, file: w.file, url: w.url, sha256: w.sha256, size: w.size,
  platforms: Object.fromEntries(Object.entries(assets).map(([k, a]) => [k, { file: a.file, url: a.url, sha256: a.sha256, size: a.size }])),
  notes: (process.env.RELEASE_NOTES || '').trim(), date: new Date().toISOString(),
};
const doc = signManifest(manifest, key);
// the same check every installed copy makes, with the public key that is built into them
verifyManifest(doc, fs.readFileSync(path.join(root, 'build', 'sc-remote', 'update-public.pem'), 'utf8'));
const out = path.join(root, 'dist-remote', MANIFEST_NAME);
fs.writeFileSync(out, JSON.stringify(doc, null, 2) + '\n');
console.log(`signed ${MANIFEST_NAME}: SC-Remote ${VERSION}`);
for (const [k, a] of Object.entries(assets)) console.log(`  ${k.padEnd(6)} ${a.file}  ${(a.size / 1048576).toFixed(1)} MB  sha256 ${a.sha256}`);

if (publish) {
  const gh = (...a) => execFileSync('gh', a, { stdio: 'inherit', cwd: root });
  const list = [['Windows', 'win32'], ['Mac', 'darwin'], ['Linux', 'linux']].filter(([, k]) => assets[k]);
  const notes = [manifest.notes,
    '**Windows:** ' + `\`${FILES.win32}\`` + (assets.darwin ? ' · **Mac:** ' + `\`${FILES.darwin}\`` : '') + (assets.linux ? ' · **Linux:** ' + `\`${FILES.linux}\`` : ''),
    'Computadores com o SC-Remote 1.3 ou mais novo atualizam pelo próprio programa (Este computador › Reiniciar e atualizar). No Mac, o aviso abre esta página. Guia: windows/GUIDE.md.',
    'PCs with SC-Remote 1.3 or newer update from the app itself (This computer › Restart and update). On a Mac, the notice opens this page. Guide: windows/GUIDE.md.',
  ].filter(Boolean).join('\n\n');
  const files = [...list.map(([, k]) => assets[k].path), out];
  let exists = false;
  try { execFileSync('gh', ['release', 'view', tag, '--repo', REPO], { stdio: 'ignore', cwd: root }); exists = true; } catch {}
  if (exists) gh('release', 'upload', tag, ...files, '--repo', REPO, '--clobber');
  else gh('release', 'create', tag, ...files, '--repo', REPO, '--title', `SC-Remote ${VERSION}`, '--notes', notes, '--latest');
  console.log(`published https://github.com/${REPO}/releases/tag/${tag}`);
}
