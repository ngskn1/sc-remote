# ScreenShare (desktop app)

This is the same screen sharing as `screenshare.html`, plus **game audio without the Discord echo** (no setup, no virtual cables) and **remote desktop** for controlling your own PCs.

| File | Platform | How to run |
|---|---|---|
| `ScreenShare-2.5.0-portable.exe` | Windows 10/11 x64 | Double-click it. Nothing is installed. |
| `ScreenShare-2.5.0.AppImage` | Linux x64 | Run `chmod +x ScreenShare-2.5.0.AppImage`, then `./ScreenShare-2.5.0.AppImage` |

Everything in the browser version works here too: a fixed room code, saved friends, wait-for-host and auto-rejoin, and changing any setting, the audio source or the shared window while live. See `README.md` next to `screenshare.html`.

**Only the person streaming needs the app.** Viewers can use the app or just open `screenshare.html` in a browser, because both speak the same protocol.

Settings are saved in a `ScreenShare-data` folder next to the executable. Keep the two together on a USB stick and your settings travel with them.

**New in 2.5.0:** a new sign-in for remote desktop (SRP, a password-authenticated key exchange). Neither a stranger who connects to your PC nor something posing as the PC you connect to gets anything it could use to test password guesses on its own computer: each try needs a new connection, and the lockout limits those. 2.5.0 (and SC-Remote 1.4.0) only connect to PCs running 2.5.0 / SC-Remote 1.4.0 or newer, so update the PCs you connect to first; older apps can still connect to an updated PC.

**2.4.0:** the PC you connect to must prove that it knows the password too, before it receives a single key press. **This computer** has a **Connection history**: who connected, from which address and for how long, and who tried with a wrong password.

**2.3.1:** a saved PC keeps the password that actually worked. A mistyped one is no longer saved, and retyping a changed password updates the saved one. The Files panel reopens in the folder you last used on that PC.

**2.3.0:** the remote password check is tied to the encrypted connection, so a compromised connection server can't relay it. SC-Remote PCs only accept apps from 2.3.0 on; older hosts still work with this version. Ctrl+Alt+Del is the real one on PCs that support it. Closing the control window ends the session on the other PC right away. The 2.2.0 notes still apply: a second computer taking over no longer confuses the host.

There's also a separate edition, **SC-Remote**, for the group's lab PCs. It works like AnyDesk: an ID and password per PC, a Windows installer, and a background service so the PC is reachable from startup, with the sign-in screen, Ctrl+Alt+Del and UAC prompts. From 1.3.0 it updates itself from this repository's GitHub releases. From 1.5.0 there's also a Mac app (connects to the PCs) and a Linux AppImage (connects, and can be controlled while someone is signed in), built and published with each release. See `windows/GUIDE.md`, and **Releasing SC-Remote** below. (The key-based lab edition, `lab/ADMIN-GUIDE.md`, is paused.)

## Audio options

| Option | What friends hear |
|---|---|
| ★ **Everything except Discord** (default) | The game and anything else playing, but not the voice call |
| **Only: <app>** | Just that one app |
| Everything, including Discord (Windows only) | All sound, which means echo. Only for when you're not in a call |
| Audio devices (via **Find audio devices**) | A capture device, the same as the browser version |

The host's stats overlay shows a live level bar (`audio: … ▮▮▮▯▯`). Use it to check that sound is captured before your friends join.

### How it works

**Windows:** the app uses the system's per-app audio capture. "Except Discord" removes Discord's whole process tree from the capture, and "Only <app>" captures a single app's process tree.
- You need Windows 10 build 20348 or newer, or Windows 11. On older builds, choose "Everything, including Discord".
- Windows "N" editions also need the free Media Feature Pack.

**Linux:** the app creates the same "ScreenShare-Game" output as `game-audio-linux.sh` and routes the chosen apps into it. It then records that output with `parec`. You keep hearing everything normally, and Discord stays on your regular output.
- New sound streams get routed within 1.5 s.
- When you stop sharing or close the app, the output is removed and every app goes back to your speakers. This also happens if the app was killed: the next launch tidies up.
- An app only shows up in the "Only" list while it is playing sound. Start the game, then click **↻ Apps**.
- `pactl` and `parec` are required: `sudo apt install pulseaudio-utils`. Linux Mint and Ubuntu have both already. This works with PipeWire, which Debian 12+ uses by default, and with PulseAudio.

"Except Discord" covers the desktop Discord app, Vesktop and Legcord. Discord running in a browser tab can't be told apart from the rest of the browser.

## If the stream's fps drops while you play (Windows)

Windows gives the focused game priority over everything else. Since version 2.1.0, the app stops Chromium from throttling itself when the game covers its window, and runs its capture and encoding at above-normal priority.

If the host stats still show **⚠ capture is getting only N fps**, the game is using all of the GPU and the screen capture can't get a turn. OBS and Discord have the same limitation. Fixes, best first:

1. **Cap the game's fps** a little below what it normally reaches, e.g. 120 if it runs at ~140, or turn on V-Sync. Use the in-game limiter, NVIDIA Control Panel → *Max Frame Rate*, AMD Software → *Frame Rate Target Control*, or RTSS. This is usually all it takes.
2. Use **borderless / windowed fullscreen** instead of exclusive fullscreen.
3. Try toggling Settings → System → Display → Graphics → **Hardware-accelerated GPU scheduling**, then reboot. It helps on some PCs.
4. **Laptops with two GPUs:** in Settings → System → Display → Graphics, add ScreenShare and set it to *High performance*, so it runs on the same GPU as the game.

### GPU or CPU encoder

The stats line for each viewer names the encoder, e.g. `GPU encoder (Media Foundation)` (AMD/NVIDIA/Intel) or `CPU encoder (OpenH264)`. Compare it with the capture fps:

- **Captured fps is fine, but the viewer fps is low** (e.g. `60/60fps captured` but `→ viewer: … 30fps … GPU encoder`): the GPU encoder is the bottleneck. AMD's encoder in particular can stall on fast-changing game frames in Chromium. In the app, set **Encoder → CPU (software)** and click **Restart to apply**. H.264 then uses OpenH264, the same encoder Linux uses, and a modern CPU handles 1080p60 easily. Friends rejoin automatically after the restart, but you press **Start sharing** again. The choice is remembered.
- **⚠ the CPU encoder can't keep up**: switch back to **GPU (hardware)**, or lower the resolution or fps.
- **Browser version:** turn off chrome://flags → *Hardware-accelerated video encode* and restart Chrome, or pick codec **VP8**, which always encodes on the CPU.

The browser version can't get the throttling fix, so on Windows the app streams games more smoothly.

## Remote desktop (since 2.1.0)

Control your other computers from this one, AnyDesk-style. Open **Remote desktop** in the app's top bar.

### On the PC you want to control (the host)

1. In **This computer**, set a **password** (at least 6 characters), then switch on **Allow remote control of this PC**.
2. Tick **Start with the computer** so it starts in the background at every login. It then runs in the tray, where it shows the ID and status and lets you disconnect the controller or turn remote access off.
3. Write down the 9-digit **ID**. It never changes unless you press **New ID**.

For it to be reachable after a reboot, the PC has to log in by itself:

- **Linux Mint:** System Settings → **Login Window** → Users → turn on **automatic login** for your user. On the login screen, keep the normal **Cinnamon** session (X11). The "Cinnamon on Wayland" session can't be remote-controlled.
- **Windows 11:**
  1. Settings → Accounts → Sign-in options → turn off *"For improved security, only allow Windows Hello sign-in…"*.
  2. Press Win+R, run `netplwiz`, untick *"Users must enter a user name and password"* and enter your password once.
  3. Also set Settings → Accounts → Sign-in options → *If you've been away…* to **Never**, because the Windows lock screen can't be controlled remotely.
- **Keep this PC awake** (on by default) stops the PC from going to sleep while remote access is on. The screen may still turn off, which is fine.

### On the PC you control from (the client)

In **Connect to a PC**, enter the ID and password, then **Connect**.
- Tick **Remember** to save it as a one-click button. The password is stored encrypted with the system keychain.
- If the host is off or rebooting, the window keeps retrying and reconnects by itself.
- If the host turns remote access off or changes the password, the window says so and offers **Connect again**.

The session window:

- **Toolbar:** move the pointer to the top edge, or tick **Pin**. It shows the latency and fps.
- **Screen:** shown when the host has several monitors.
- **Quality:**
  - **Sharp text** is the default. It keeps text crisp and drops frames if the connection is slow.
  - **Smooth** keeps things moving and lets the picture soften first.
  - **FPS:** 15/30/60.
  - **Codec:** VP8 by default (low delay, cheap on the CPU); H.264 and VP9 are also available.
- **Keyboard:** every key goes to the remote PC as a *physical* key, so the remote PC applies its own layout. ABNT2 keys such as Ç, the accents and the /? key work.
  - In **Fullscreen**, the Windows/Super key and Alt+Tab also go to the remote PC. Hold **Esc** to leave fullscreen.
  - **Keys ▾** sends Ctrl+Alt+Del, Alt+Tab, Super, Alt+F4, Print Screen or Ctrl+Alt+L.
- **Clipboard:** text, images and **files** sync both ways while ticked.
  - **Copy/paste files:** select files or folders in your file manager and press **Ctrl+C** (or right-click → Copy). They're sent to the other PC in the background, and a card in the corner shows the progress. When it says *Ready*, press **Ctrl+V** in a folder over there.
  - This works in both directions, so you can also copy on the remote PC and paste on yours.
  - Folders keep their structure.
  - Copies up to 2 GB go automatically; for bigger ones use the Files panel.
  - Cut (Ctrl+X) is treated as copy, so the originals stay where they were.
- **Drag & drop onto the remote PC:** drag files or folders from your PC onto the remote screen and release them where you want them, e.g. on its desktop, into an open folder or onto an app. ScreenShare sends them over and drops them at that exact spot.
  - If the spot doesn't accept files, they're also on the remote clipboard, so Ctrl+V there works.
  - Dropping onto the **Files** panel uploads into the folder shown there.
  - Dragging *out* of the remote screen onto your PC isn't supported. Copy there and paste here instead.
- **Files panel:** browse the remote PC's folders. Click a file to download it to `Downloads/ScreenShare` on this PC. **Upload…** sends files into the open folder.
- Files waiting to be pasted are kept in a temporary `ScreenShare-transfers` folder and cleaned up after a day.
- If this window loses focus, every held key and button is released on the remote PC, so nothing stays stuck.

### Security

- Only someone with the ID **and** the password can connect.
- **Password storage:** the password is never sent or stored in plain text. The host keeps a salted, stretched hash (PBKDF2, 150,000 rounds) and checks a one-time signature from the client.
- **Lockout:** after 5 wrong passwords the host refuses everyone for 60 s.
- **Encryption:** video, input, clipboard and files travel encrypted end to end (DTLS).
- **One controller at a time:** a new login replaces the old one.

### Limits

- **Windows admin windows:** on a Windows host, windows that run as administrator (e.g. Task Manager, installers, UAC prompts) ignore remote input, and the lock and login screens can't be seen or used. This is how Windows protects them; AnyDesk needs a system service for it. Run ScreenShare as administrator if you need to control admin apps.
- **Linux:** the host needs an X11 session, which is Mint's default. Locking the screen is fine: you can type the password on the lock screen remotely.
- **Network:** both PCs need internet access. No port forwarding is needed. Behind strict networks the connection falls back to a slower relay.

## First launch

**Windows** shows a "Windows protected your PC" warning because the exe isn't code-signed. Click **More info → Run anyway**. A portable exe unpacks itself on every start, so it takes a few seconds to open.

**Linux:** AppImages need FUSE 2. On Debian 12, run `sudo apt install libfuse2`. Without it, run the app with `./ScreenShare-2.5.0.AppImage --appimage-extract-and-run`.

## Build from source

You need Node.js 20+. Both packages are built from Linux, so you don't need Windows or Wine.

```sh
npm install
npm start                      # run in development
npm run dist                   # dist/ScreenShare-*-portable.exe and dist/ScreenShare-*.AppImage
npm run dist:remote            # SC-Remote: dist-remote/SC-Remote-Setup-*.exe
npm run dist:remote-linux      # SC-Remote: dist-remote/SC-Remote-x86_64.AppImage
npm run dist:remote-mac        # SC-Remote: dist-remote/SC-Remote-*-mac.dmg (on a Mac only)
SCREENSHARE_EDITION=remote npm start   # run it in development (add --agent to run the background agent)
npm run dist:lab               # the paused key-based lab edition
```

SC-Remote's Windows service (with its settings window and updater) and helper are small C# programs (`windows/`). `npm run windows-bin` compiles them with the C# compiler that comes with Windows (.NET Framework 4), or with Mono's `mcs` on Linux. Building the Windows installer on Linux also needs Wine, which electron-builder uses to make the uninstaller. The simplest place to build the installer is Windows.

Files:

- `main.js`: the window, the screen/window picker, and the audio IPC.
- `audio-windows.js`: per-app capture through the [loopback-capture](https://github.com/WerdoxDev/loopback-capture) addon (MIT).
- `audio-linux.js`: PipeWire/PulseAudio routing through `pactl`.
- `app/screenshare.html`: the shared UI. It's the same file as the browser version and detects when it's running inside the app.
- `remote/host-main.js`: the remote-desktop host (ID/password, tray, start with the computer, clipboard, files) and its windows.
- `remote/injector.js`, `remote/inject-linux.py` and `remote/inject-windows.ps1`: mouse and keyboard input through X11 XTEST and Windows SendInput. Both are built in and nothing extra is installed. The injector also performs file drops, by starting a real drag and carrying it to the drop point.
- `remote/clipfiles.js`: file lists on the clipboard. On Linux it uses Nemo/Nautilus and `text/uri-list` formats; on Windows, Explorer's file-drop list.
- `app/remote-host.html` (hidden host engine), `app/remote.html` (settings + connect) and `app/remote-session.html` (the control window).
- Lab edition: `remote/lab.js` (keys, the signed lab policy, PC identities, audit log), `app/lab.html` (member/admin window), `app/lab-prompt.html` (the on-screen bar and the consent prompt), `build/lab.config.js` + `build/lab-installer.nsh` (lab installer, paused), `server/` (optional self-hosted connection server).
- SC-Remote (icon: put a 256×256 PNG at `build/sc-remote/icon.png` and replace `app/icon-tray.png`; Portuguese/English texts in `app/i18n.js`): `windows/Service.cs` (the Windows service: starts the agent in the screen's session as the system account; its settings window; installer commands), `windows/Helper.cs` (input and capture on the sign-in/lock/UAC desktop, Ctrl+Alt+Del), `build/remote.config.js` + `build/remote-installer.nsh` (installer), `build/sc-remote/release.json` (version, repository), `remote/update.js` + `scripts/release-remote.js` (signed update manifests), `windows/GUIDE.md`.

## Releasing SC-Remote

Releases are built and published by GitHub Actions (`.github/workflows/release-sc-remote.yml`) on Windows, Mac and Linux runners; each build is started once to check that it works before anything is published. Each release has the Windows installer, the Mac disk image, the Linux AppImage, and `sc-remote-update.json`, a small manifest (version, and the download address and SHA-256 of each file) signed with the **release key**. Installed copies check `releases/latest/download/sc-remote-update.json` when they start. They only accept a manifest signed with that key, and the service checks the downloaded installer against the manifest's SHA-256 before running it.

To release a new version:

1. Raise `"version"` in `build/sc-remote/release.json` (e.g. `1.4.0` → `1.4.1`) and commit.
2. Push a matching tag: `git tag v1.4.1 && git push origin main v1.4.1`. Or, in the repository's **Actions** tab, run **SC-Remote release**.
3. After about 10 minutes the release appears under **Releases**. PCs show the update the next time SC-Remote starts, or within 12 hours if it's already running.

Optional release notes: set the repository variable `SC_REMOTE_RELEASE_NOTES` (Settings › Secrets and variables › Actions › Variables) before releasing.

**The release key.** The private key is stored only in the repository secret `SC_REMOTE_UPDATE_KEY`. Its public half, `build/sc-remote/update-public.pem`, is built into every copy. Never commit the private key (`.gitignore` blocks `*.pem` except the public one). If the key is lost or leaked, make a new pair, replace `update-public.pem` and the secret, and install the next version by hand on every PC once, since copies only trust the old key. To make a new pair: `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out key.pem` and `openssl pkey -in key.pem -pubout -out build/sc-remote/update-public.pem`.

To sign locally instead (e.g. to test): `npm run dist:remote`, then `SC_REMOTE_UPDATE_KEY_FILE=key.pem npm run release:remote` writes `dist-remote/sc-remote-update.json`, and adding `-- --publish` uploads the files with the `gh` CLI.

See `SECURITY.md` for how the pieces are protected, the known limits, and how to report a problem.

**Test hooks (development only):** `SCREENSHARE_FAKE_AUDIO=1` replaces the capture with a 440 Hz tone. `SCREENSHARE_SERVER=host:port` uses a self-hosted PeerJS server (`npx peer --port 9000`).
