// Bundles PeerJS next to the page so the app works without any CDN.
const fs = require('fs');
const path = require('path');
const src = require.resolve('peerjs/dist/peerjs.min.js');
fs.copyFileSync(src, path.join(__dirname, '..', 'app', 'peerjs.min.js'));
console.log('copied peerjs.min.js');
