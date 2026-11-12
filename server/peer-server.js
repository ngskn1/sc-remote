// Connection server for a ScreenShare Remote lab: the PCs find each other here, then talk directly.
// It never sees the screen, input or files (those are encrypted between the two PCs).
//   PORT=9000 KEY=peerjs node peer-server.js        (HOST=0.0.0.0 on machines without IPv6)
const { PeerServer } = require('peer');
const port = +process.env.PORT || 9000;
PeerServer({
  port,
  ...(process.env.HOST ? { host: process.env.HOST } : {}),
  path: '/',
  key: process.env.KEY || 'peerjs',
  allow_discovery: false,          // nobody can list who is connected
  proxied: !!process.env.PROXIED,  // set when it runs behind an HTTPS reverse proxy (recommended)
  alive_timeout: 60000,
});
console.log(`ScreenShare lab connection server on port ${port}`);
