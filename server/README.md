# Your own connection server (optional)

By default a ScreenShare Remote lab uses the free public PeerJS server and relay. Run your own if you want it
to depend on nothing outside your group, or if the public one is unreliable from your network.

**What you need:** any always-on Linux machine or small VPS reachable from the internet (or from all lab PCs and
members), with Node.js 18+.

```sh
cd server
npm install
PORT=9000 node peer-server.js          # or: npm start
```

Keep it running with systemd (example unit below) and put HTTPS in front of it (`Caddyfile.example`, run the
server with `PROXIED=1`). Then, in the app: **Manage › Rules on the lab PCs › Connection server and relay** →
host, port 443, path `/`, HTTPS on → **Save rules** → **Send to all lab PCs**.

Without HTTPS (e.g. inside a university network only): port 9000, HTTPS off.

**Relay (TURN):** only needed when PCs can't connect directly. See `turnserver.conf.example` (coturn).
Without your own relay, the lab keeps using the public one.

```ini
# /etc/systemd/system/screenshare-peer.service
[Unit]
Description=ScreenShare lab connection server
After=network-online.target
[Service]
WorkingDirectory=/opt/screenshare-server
Environment=PORT=9000 PROXIED=1
ExecStart=/usr/bin/node peer-server.js
Restart=always
User=nobody
[Install]
WantedBy=multi-user.target
```
