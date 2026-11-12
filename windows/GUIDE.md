# SC-Remote: guide

SC-Remote is the remote-desktop-only edition of ScreenShare, for Windows PCs. It works like AnyDesk:

- **Each PC has a 9-digit ID and its own password.** Anyone with both can control that PC.
- **It's reachable from the moment the PC starts,** before anyone signs in. You can use the sign-in screen, the lock screen and administrator (UAC) prompts, and send a real Ctrl+Alt+Del.
- **The same app connects to other PCs** (ID + password, with a list of saved PCs).

| File | What it is |
|---|---|
| `SC-Remote-Setup-1.3.1.exe` | Windows 10/11 installer: the app, plus the background service that makes the PC reachable. Newer versions are on [the Releases page](https://github.com/ngskn1/sc-remote/releases/latest). |
| `ScreenShare-2.4.0-portable.exe` / `ScreenShare-2.4.0.AppImage` | The full ScreenShare (streaming + remote desktop). Use 2.4.0 or newer to connect to these PCs, e.g. from Linux. (2.3 still connects to an updated PC, but without checking that the PC is the real one.) |

## 1. Install on a lab PC

Run the installer. Windows asks for administrator permission. At the end, the **remote access settings** window opens:

- **Allow remote access to this PC:** leave it ticked.
- **This PC's ID:** write it down, or click **Copy**. You'll need it to connect.
- **Password:** at least 8 characters. Use a different, strong password on each PC (12+ characters is better), because the ID alone isn't secret.
- **Show a bar on screen while someone is connected:** on by default. The bar names who's connected and has an **End** button.
- **Ask the person at this PC before each connection:** off by default. When it's on, whoever is signed in gets Allow / Decline. At the sign-in screen nobody is asked.

Click **Save**. The PC is reachable a few seconds later and after every restart.

The installer also does the following:

- installs the **SC-Remote** Windows service, which starts at boot;
- adds SC-Remote to the tray for everyone who signs in to the PC. Its icon shows the PC's ID and whether someone is connected, and has **Copy ID**, **Open SC-Remote** and **Quit** (closing the window leaves it in the tray);
- creates `C:\ProgramData\SC-Remote`. The settings and log inside are readable only by administrators, and the password itself is never stored, only a hash of it;
- adds a Windows Firewall rule for the app;
- enables Ctrl+Alt+Del from a service. This is the policy "Disable or enable software Secure Attention Sequence" = Services.

**PCs you only connect from** (your own laptop, say) use the same installer. Untick **Allow remote access to this PC** and click Save. The service then stays idle and nobody can connect to that PC.

**Silent install** (`SC-Remote-Setup-1.3.1.exe /S`) skips the settings window, and remote access stays off. To set it up later, open the app on that PC and click **Configurar o acesso remoto…** (Set up remote access…).

## 2. Connecting

Open SC-Remote (from the Start menu, or the tray icon) and go to **Conectar a um PC** (Connect to a PC). Enter the ID and password, optionally a name, and keep **Remember this PC** ticked. The PC then appears in your list, with its password encrypted on your computer.

- **Keys ▾ › Ctrl + Alt + Del** sends the real thing, to unlock a PC or sign in.
- At the sign-in screen, the lock screen or a UAC prompt, you still see and control the PC. That picture is a bit less sharp, and it switches back by itself.
- Clipboard, file copy-paste, drag-and-drop and the Files panel work as in ScreenShare. On these PCs, files are limited to the signed-in user's own folder, or `C:\Users\Public` when nobody is signed in. The service has full system rights, so without this limit anyone with the password could read or change any file on the PC.

## 3. Changing the password or settings

On that PC, open SC-Remote. Under **Este computador** (This computer) you see the PC's ID and whether it's online. Click **Alterar senha ou configurações…** (Change password or settings…). Windows asks for administrator permission, and the same window as during installation opens.

- **New password:** this disconnects anyone connected. Leave it empty to keep the current one.
- **Untick "Allow remote access":** the PC becomes unreachable.

## Connection history

**Este computador** has **Histórico de conexões** (Connection history): every connection to this PC with its date, the name and network address of the computer that connected, and how long it lasted, plus the attempts that were refused (wrong password, too many wrong passwords, declined by the person at the PC). Anyone using the PC can read it, and nobody can edit or clear it from the app. It keeps the last 200 connections and the last 100 refused attempts, counted separately, so a burst of failed attempts can't push the real connections off the list.

The name is what the other computer calls itself, so it isn't proof of who it was. The address is the one the connection really used. A row of wrong passwords from an address you don't know means someone is guessing: change that PC's password to a longer one.

## Language and feedback

SC-Remote is in Portuguese by default. The **Idioma** (Language) menu at the bottom of the window switches it to English: the window, the session windows and the tray menu. The settings window and the bar on a controlled PC follow the language that was used when that PC's settings were last saved.

**Relatar um problema ou enviar sugestões** (Report a problem or send feedback), at the bottom of the window and in the tray menu, opens the group's form in the browser.

## Updates

SC-Remote looks for a new version every time it starts, and twice a day while it sits in the tray. When there is one:

- **Este computador** (This computer) shows **"Uma nova versão do SC-Remote está disponível"** (A new version is available) with a **Reiniciar e atualizar** (Restart and update) button. The tray menu gets **Atualizar para a versão …** (Update to version …).
- Clicking the button hands the update to the SC-Remote service. The service downloads the update from GitHub, checks that it's signed with the group's release key and that the file is intact, and installs it. No administrator prompt appears, and the PC's ID, password and settings stay as they are.
- SC-Remote closes, and about a minute later it reopens by itself showing **"O SC-Remote foi atualizado para a versão …"** (was updated to version …). Anyone connected to that PC is disconnected while it installs and can reconnect afterwards.
- If something goes wrong, the notice says what happened and offers **Tentar de novo** (Try again). The PC keeps the version it had and stays reachable.

Nothing is installed without someone clicking the button, so PCs nobody uses keep their version until someone does. Any user signed in to the PC can start an update, but only an official, signed version newer than the installed one is ever installed.

**Upgrading from 1.2.0:** 1.2.0 can't update itself. Run `SC-Remote-Setup-1.3.1.exe` on each PC once. Until a PC is updated, apps on 1.3.1 refuse to connect to it. It updates in place, keeping the ID, password and settings, and from then on updates come through the app.

**Upgrading from the test version:** if a PC has the earlier "ScreenShare Remote" installed, uninstall it first (Settings › Apps). SC-Remote is installed as a separate program, with its own service and folder.

## 4. Security, briefly

- **Password lockout:** after 5 wrong passwords, the PC refuses even the right one for 1 minute, then 2, 4… up to 30 minutes.
- **Tied to the connection:** the password check is bound to that encrypted connection, so a compromised connection server can't relay it somewhere else.
- **Checked both ways:** the PC must prove that it knows the password too, before the app sends it anything. A program that took the PC's ID on the connection server (possible while the PC is off) is refused with "não conseguiu provar que conhece a senha". That's why both ends need SC-Remote 1.3.1 / ScreenShare 2.4 or newer: older PCs can't give that proof and are refused.
- **Use long passwords.** Whoever manages to pose as a PC still sees one scrambled answer per connection attempt, which lets them test password guesses on their own computer. A password of 12 or more random characters makes that hopeless; a short or common one doesn't.
- **History:** see "Connection history" above.
- **Log:** every connection, refusal and switch to the sign-in screen is written to `C:\ProgramData\SC-Remote\agent\audit.log`.
- **The session itself** (screen, input, clipboard, files) is encrypted end to end between the two PCs. The free public PeerJS server only introduces them, and it sees their IP addresses but not the contents.

### Honest limits

- **The updater is new.** Its download and signature checks were tested, but the Windows-only steps (installing as the system account, reopening the app afterwards) run for the first time with the first real update, 1.3.0 → 1.3.1 or later. If that update fails, the PC keeps its version and stays reachable, and installing the new version by hand always works.
- **Not audited.** It's a homemade tool, not audited security software.
- **Chromium sandbox off.** The background part runs on Electron (Chromium) under the system account, where Chromium's sandbox can't run, and it talks to computers that haven't given the password yet. A serious Chromium bug could therefore be used against a PC by someone who only knows its ID. Install updates when they appear: each release brings the current Chromium fixes.
- **The connection server is someone else's.** PCs find each other through the free public PeerJS server. It can't read or alter sessions, but if it's down nobody connects, and anyone who knows a PC's ID can keep that PC offline or lock its password check by trying wrong passwords. A group server (`server/` in the source) removes that dependence.
- **The file limit is a guard rail.** Keeping remote file access inside the signed-in user's folder stops ordinary mistakes and snooping. It isn't a hard wall against someone who both has the PC's password and can already run programs on that PC.
- **Antivirus** may be suspicious of an unsigned service that starts a program on the sign-in screen, because it does what remote-access tools do. If it blocks something, add an exception for `C:\Program Files\SC-Remote`.
- **IT approval.** Check with your institution's IT before installing a remote-access service on its PCs.

## 5. Troubleshooting (on the PC)

| What | Where |
|---|---|
| Is the service running? | `sc query SCRemote` (or Services › SC-Remote) |
| Service log | `C:\ProgramData\SC-Remote\agent\service.log` |
| App log | `C:\ProgramData\SC-Remote\agent\profile\remote.log` |
| Connection log | `C:\ProgramData\SC-Remote\agent\audit.log` |
| Current state | `C:\ProgramData\SC-Remote\status.json` |
| Last update attempt | `C:\ProgramData\SC-Remote\update-state.json` (details in the service log) |

- **"… is offline"** means the PC is off, has no internet, remote access is turned off, or the ID is mistyped.
- **"needs a newer ScreenShare app"** means the app you connect from is too old. Update it.
- **"usa uma versão antiga"** (runs an older version) means the PC you connect to has SC-Remote 1.3.0 or older (or ScreenShare before 2.4). Update that PC.

**Uninstall:** use Settings › Apps › SC-Remote. This removes the service, the tray entry, the firewall rule and `C:\ProgramData\SC-Remote`, and restores the Ctrl+Alt+Del policy.

## 6. First test round (recommended)

On one PC:

1. Install it, set a password and note the ID.
2. Reboot. Before signing in, connect from another PC. You should see the sign-in screen. Send Ctrl+Alt+Del if needed, type the password and sign in.
3. Lock the PC (Win+L), then unlock it remotely.
4. Start something as administrator, so a UAC prompt appears, and answer it remotely.
5. Copy a file both ways and use the Files panel.
6. Change the password from the app on that PC and check that the old one stops working.

If any step fails, send me the logs from section 5.
