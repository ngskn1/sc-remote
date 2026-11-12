# ScreenShare Remote: lab admin guide

ScreenShare Remote is the lab edition of ScreenShare. It does remote desktop only, with no streaming. It is made for a group that shares a set of Windows PCs:

- **Lab PCs** can be reached from the moment they boot, before anyone signs in. Members can use the sign-in screen, the lock screen and administrator (UAC) prompts, and can send Ctrl+Alt+Del.
- **Members** sign in with a personal key, not a shared password. Removing someone takes effect without changing anything for anyone else.
- **Admins** decide who is a member, which PCs belong to the lab and the rules on the PCs. Every PC keeps a log of who connected.

| File | What it is |
|---|---|
| `ScreenShare-Remote-Setup-1.0.3.exe` | Windows 10/11 installer. Installs the member app; with a lab file next to it, it also makes the PC a lab PC. |
| `ScreenShare-Remote-1.0.3.AppImage` | The member app for Linux. A Linux PC can also be made a lab PC from the app (see 3b), reachable once someone is logged in. |

The personal ScreenShare app (streaming plus remote desktop with an ID and password) stays separate. Both can be installed on the same PC.

---

## 1. Create the lab (once, by the first admin)

1. Install ScreenShare Remote on your own PC by running the installer with no lab file next to it. This installs only the member app.
2. Open it, type your name, then click **Labs › New lab…**. You are the lab's first admin.
3. Click **Manage**:
   - **Lab PCs:** type each lab PC's Windows computer name, one per line. You can find it in Settings › System › About (for example `LAB-PC-01`).
   - **Rules:** see section 5. The defaults are reasonable.
4. Click **Export lab file…** and save `lab-setup.json`.

## 2. Add the members

Each member installs the app (without a lab file), opens it and clicks **Copy access key**. They send you the result, which looks like `Mia: SSK1-…`.

Paste it into **Manage › Members**, choose Member or Admin, and click **Add**.

- The access key is public. It only identifies the person, and the secret half never leaves their PC. Sending it by email or chat is fine.
- To make sure a key really came from that person, compare the fingerprint (e.g. `8A5F-QHMF-3ETC`). They see it under their key; you see it in the members table. Read it to each other over the phone or in person.
- Make at least two admins, so the lab doesn't depend on one person's PC.

Then export the lab file again and give it to the members. They import it with **Import lab file…** and their app then lists the lab's PCs.

## 3. Install the lab PCs

On each lab PC, put `lab-setup.json` in the same folder as the installer and run the installer as an administrator. It does the following:

- installs the app to `C:\Program Files\ScreenShare Remote`;
- registers the **ScreenShare Remote** Windows service, which starts at boot;
- creates `C:\ProgramData\ScreenShare Remote`. Only administrators can change it. It holds the PC's identity key, its copy of the lab, the log and status;
- allows the app through Windows Firewall;
- enables Ctrl+Alt+Del from a service. This is the policy "Disable or enable software Secure Attention Sequence" = Services.

For many PCs at once, a silent install works: `ScreenShare-Remote-Setup-1.0.3.exe /S`, with `lab-setup.json` in the same folder. You can run it from a USB stick, a network share or your deployment tool.

To check a PC, open the app on it. The header shows "This PC: LAB-PC-01 in Physics Lab (v3) – reachable".

**The app on your own PC is only for connecting.** A PC can be connected *to* only if it is set up as a lab PC. Being in the lab as an admin or member isn't enough. The same PC can be both, for example an admin's desktop that is also a lab PC.

## 3b. Linux PCs as lab PCs

Linux has no installer or service, so the app does this itself. On the Linux PC, open the app (with the lab imported) and use the **This PC as a lab PC** section:

1. Choose the lab.
2. Leave **Also after restarts** on, to start it again at every login.
3. Turn on the **Reachable by lab members** switch.

Members connect to it by its hostname (shown in that section). If you are an admin, the PC is added to the lab's PC list for you. Otherwise, ask an admin to add it. Turning the switch off makes it unreachable again. The app and this PC's own agent pass new lab versions to each other directly, so changes you make as an admin apply to your own PC within a few seconds.

Unlike a Windows lab PC, it only works while someone is logged in (no sign-in screen), and it runs with that user's rights. It needs X11 (Linux Mint's default), like the personal edition's remote desktop.

## 4. Connecting

Members open the app and click a PC, or type its computer name. That is the name, not the key fingerprint (`XXXX-XXXX-XXXX`), which only identifies people.

PCs you connected to that aren't in the lab's list show up under **Recent**, for example a member's own PC. **Save** turns one into a button, and **×** removes it again. You can also save a typed name without connecting. Saved PCs and history stay on your computer only. The lab's list is just the shared directory, not a permission: any PC set up for the lab accepts all of its members, listed or not. The window works like the personal edition: clipboard, files, drag-and-drop, screen choice and quality. In addition:

- **Keys ▾ › Ctrl + Alt + Del** sends the real thing. Use it to unlock or sign in.
- When the PC is at the sign-in screen, the lock screen or a UAC prompt, you see and control it. That picture comes from a simpler capture, so it is a bit less sharp, and it switches back automatically.
- While someone is connected, the PC shows a bar at the top: *"Mia is controlling this PC"*. It has an **End** button if your rules allow it.
- Admins have a **Log** button that shows the PC's connection log.

**Files on lab PCs:** members can only browse, download and upload inside the user folder of whoever is signed in at the PC (`C:\Users\<name>`), plus files that person copied. When nobody is signed in, that is `C:\Users\Public`. The background service runs with full system rights, so without this limit any member could read or change any file on the PC.

## 5. Rules (Manage › Rules on the lab PCs)

| Rule | Default | Meaning |
|---|---|---|
| Show who is connected | on | The bar at the top of the PC's screen. |
| The person at the PC can end the session | on | The bar's **End** button. |
| Ask the person at the PC first | off | When someone is signed in, they get Allow / Decline (30 s, then declined). At the sign-in screen nobody is asked. |
| Clipboard sync | on | Copy and paste between the PCs. |
| File transfer | on | Files panel, copy-paste of files, drag-and-drop. |
| Connection server / relay | public | See section 8. |

## 6. Changing the lab later

Every change (member added or removed, role, PC list, rules) creates a new, signed **version** of the lab. Lab PCs accept a new version only when an admin of the version they already have signed it. So nobody, including a member with a copy of the file, can give themselves access, and an old file can't undo a removal.

New versions reach the PCs in three ways:

1. **Send to all lab PCs** (in Manage). It shows each PC's result. PCs that are off get it next time.
2. Whenever any member who has the new version connects to a PC, their app delivers it.
3. Re-running the installer with a new `lab-setup.json`.

Members' apps also pick up newer versions from the PCs they connect to.

**Removing someone:** remove them, then click **Send to all lab PCs**. If they are connected at that moment, they are disconnected. Their key stops working on each PC as soon as that PC has the new version, so send it rather than waiting.

## 7. When a PC is reinstalled

A reinstalled PC gets a new identity key. The first member who connects afterwards sees *"The identity of LAB-PC-01 changed… If it was reinstalled, you can trust the new identity"*. Click **Trust the new identity** only if you know the PC was reinstalled. Otherwise, something else may be pretending to be that PC.

## 8. The connection server

The PCs find each other through a small "signaling" server. The session itself (screen, input, clipboard, files) goes directly between the two PCs, encrypted end to end. When a direct path isn't possible, it goes through a relay (TURN), still encrypted.

- **By default** the lab uses the free public PeerJS server and relay. It costs nothing and needs no setup, but it comes with no guarantee of uptime. The server sees which IP addresses connect, but not the contents.
- **Your own server:** the `server/` folder in the source has a ready-made setup: PeerJS server, optional coturn relay, and an HTTPS example. Enter it in **Manage › Rules › Connection server and relay**, save, and **Send to all lab PCs**. Publishing tries the new server first and falls back to the old one for PCs that haven't switched yet. After this, PCs and members all use your server.

## 9. Troubleshooting (on a lab PC)

| What | Where |
|---|---|
| Is the service running? | `sc query ScreenShareRemote` (or Services › ScreenShare Remote) |
| Service log | `C:\ProgramData\ScreenShare Remote\agent\service.log` |
| App log | `C:\ProgramData\ScreenShare Remote\agent\profile\remote.log` |
| Who connected | `C:\ProgramData\ScreenShare Remote\agent\audit.log` (or the **Log** button) |
| Current state | `C:\ProgramData\ScreenShare Remote\status.json` |

- **"Not reachable"** means one of four things: the PC is off, it has no internet, its name in the lab list differs from its real computer name, or it isn't set up as a lab PC.
- **The PC doesn't show up after installing** usually means `lab-setup.json` wasn't next to the installer. Run it again with the file there.
- **Antivirus** may be suspicious of an unsigned service that starts a program on the sign-in screen, because it does what remote-access tools do. If it blocks `ScreenShareRemoteService.exe`, `ScreenShareRemoteHelper.exe` or `ScreenShare Remote.exe`, add an exception for `C:\Program Files\ScreenShare Remote`.

**Uninstall:** use Settings › Apps › ScreenShare Remote. This removes the service, the firewall rule and `C:\ProgramData\ScreenShare Remote`, and restores the Ctrl+Alt+Del policy.

---

## How the security works

- **Personal keys:** each member's app makes an Ed25519 key pair. The private key is encrypted with Windows' own data protection (or the Linux keyring) and never leaves that PC.
- **Signed lab policy:** the member list, PCs and rules are signed by an admin and versioned. Each PC and app accepts only newer versions signed by an admin of the version it has. Old copies can't be replayed to undo a removal.
- **PC identity:** each lab PC has its own key, and members' apps remember it the first time. A different key is reported, not silently accepted.
- **Tied to the connection:** both sign-in signatures include the two ends' encryption certificate fingerprints. A compromised connection server can't relay a sign-in to somewhere else (man in the middle).
- **On the PC:** the agent runs as the system account (needed for the sign-in screen). It never opens file dialogs or file managers, its windows have no developer tools, and file access is limited as described in section 4. Ctrl+Alt+Del is sent by the service on request.
- **Log:** each PC records setup, connects and disconnects, refusals, rule changes, sessions ended at the PC, and switches to the sign-in screen.

### Honest limits

- **Not tested on Windows yet.** It was built and tested on Linux. The Windows service, the sign-in-screen capture and Ctrl+Alt+Del are compiled but have never run on a real Windows PC. Do a test round on one lab PC before rolling it out (section 10).
- **Not audited.** This is a homemade tool, not audited security software. The design follows standard practice, but it hasn't been reviewed by anyone else.
- **Chromium sandbox off on lab PCs.** The engine runs on Electron (Chromium) under the system account, where Chromium's sandbox can't run. Keep the app updated. Connecting needs the lab's random ID, which only members and PCs have.
- **Equal to sitting at the PC.** At the sign-in screen, a member can do whatever someone sitting at the PC could do.
- **IT approval.** Check with your institution's IT before installing a remote-access service on its PCs.

## 10. First test round (recommended)

On one lab PC:

1. Install it with the lab file and reboot.
2. Before signing in, connect from another PC. You should see the sign-in screen. Send Ctrl+Alt+Del if needed, type the password and sign in.
3. Lock the PC (Win+L), then unlock it remotely.
4. Start something as administrator, so a UAC prompt appears, and answer it remotely.
5. Copy a file both ways and use the Files panel.
6. Remove a test member, click **Send to all lab PCs**, and check that they can't connect.

If any step fails, send the two logs from section 9.
