// Publishes an SC-Remote release on GitHub: the installer plus "sc-remote-update.json", the signed manifest that
// installed copies look for (https://github.com/<repo>/releases/latest/download/sc-remote-update.json).
//
//   node scripts/release-remote.js            write dist-remote/sc-remote-update.json (and check it)
//   node scripts/release-remote.js --publish  ... and create the GitHub release v<version> with both files (gh CLI)
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

const file = `SC-Remote-Setup-${VERSION}.exe`;
const installer = path.join(root, 'dist-remote', file);
if (!fs.existsSync(installer)) fail(`${installer} not found: run "npm run dist:remote" first`);

let key = process.env.SC_REMOTE_UPDATE_KEY || '';
if (!key && process.env.SC_REMOTE_UPDATE_KEY_FILE) key = fs.readFileSync(process.env.SC_REMOTE_UPDATE_KEY_FILE, 'utf8');
if (!/BEGIN (RSA )?PRIVATE KEY/.test(key)) fail('no release key: set SC_REMOTE_UPDATE_KEY (or SC_REMOTE_UPDATE_KEY_FILE)');

const data = fs.readFileSync(installer);
const tag = 'v' + VERSION;
const manifest = {
  product: 'SC-Remote', version: VERSION, file,
  url: `https://github.com/${REPO}/releases/download/${tag}/${file}`,
  sha256: crypto.createHash('sha256').update(data).digest('hex'), size: data.length,
  notes: (process.env.RELEASE_NOTES || '').trim(), date: new Date().toISOString(),
};
const doc = signManifest(manifest, key);
// the same check every installed copy makes, with the public key that is built into them
verifyManifest(doc, fs.readFileSync(path.join(root, 'build', 'sc-remote', 'update-public.pem'), 'utf8'));
const out = path.join(root, 'dist-remote', MANIFEST_NAME);
fs.writeFileSync(out, JSON.stringify(doc, null, 2) + '\n');
console.log(`signed ${MANIFEST_NAME}: SC-Remote ${VERSION}, ${file}, ${(data.length / 1048576).toFixed(1)} MB, sha256 ${manifest.sha256}`);

if (publish) {
  const gh = (...a) => execFileSync('gh', a, { stdio: 'inherit', cwd: root });
  const notes = [manifest.notes, `Instale ou atualize com **${file}**. Computadores com o SC-Remote 1.3 ou mais novo atualizam pelo próprio programa (Este computador › Reiniciar e atualizar).`,
    `Install or update with **${file}**. PCs with SC-Remote 1.3 or newer update from the app itself (This computer › Restart and update).`].filter(Boolean).join('\n\n');
  let exists = false;
  try { execFileSync('gh', ['release', 'view', tag, '--repo', REPO], { stdio: 'ignore', cwd: root }); exists = true; } catch {}
  if (exists) gh('release', 'upload', tag, installer, out, '--repo', REPO, '--clobber');
  else gh('release', 'create', tag, installer, out, '--repo', REPO, '--title', `SC-Remote ${VERSION}`, '--notes', notes, '--latest');
  console.log(`published https://github.com/${REPO}/releases/tag/${tag}`);
}
