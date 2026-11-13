# Security

SC-Remote and ScreenShare's remote desktop give whoever has a PC's ID **and** password full control of that PC. This page says what protects that, what doesn't, and how to report a problem.

## Reporting a problem

Please don't open a public issue for a security problem. Use **Security › Report a vulnerability** on the GitHub repository (private), or the feedback form linked at the bottom of the SC-Remote window, and say that it's about security. Include the version (bottom of the window) and what you did.

## What protects a PC

- **Password, never stored or sent.** The PC keeps a PBKDF2-SHA256 key (150 000 rounds) derived from the password, in a file only administrators and the system account can read.
- **Sign-in that gives nothing away.** Signing in is SRP-6a, a password-authenticated key exchange (`remote/srp.js`: RFC 5054's 3072-bit group, SHA-256, with the PBKDF2 key as the secret). Neither side receives anything it could test password guesses against on its own computer: a stranger who connects to a PC, or an impostor that took a PC's ID, gets one guess per connection, and the lockout limits those. Both sides prove that they know the password, the proofs cover both ends' DTLS certificate fingerprints (so they can't be relayed over another connection), and the app sends nothing (input, clipboard, files) and shows nothing until the PC's proof checks out. An app refuses a PC that doesn't offer this sign-in.
- **Lockout.** 5 wrong passwords lock sign-ins for 1 minute, then 2, 4… up to 30.
- **Encrypted sessions.** Screen, input, clipboard and files travel over WebRTC (DTLS/SRTP) directly between the two PCs, or through a relay that can't decrypt them. The connection server only introduces them.
- **History and log.** Every connection and refused attempt is listed in the app (Connection history) and in `agent\audit.log` (administrators).
- **Updates.** Releases are built by GitHub Actions. Each carries a manifest signed with an RSA-3072 key kept as a repository secret; the app and the service only accept a manifest signed with it, for a newer version, with a download inside this repository's releases whose SHA-256 matches. The installer runs from folders only administrators can write. On Linux the app itself makes the same checks before it replaces its AppImage; on a Mac, people download new versions from the Releases page themselves.
- **Windows service.** Runs as the system account so the sign-in screen, lock screen and UAC prompts can be controlled. Its settings need an administrator. Remote file access is limited to the signed-in user's folder. The app's windows can't navigate to other pages or open new ones.

## Known limits

- **Not audited.** This is a small project, reviewed by its authors only.
- **Mac app not notarized.** It carries only an ad-hoc signature (no Apple developer account), so macOS can't tell who made it and asks people to allow it once. Download it only from this repository's Releases page.
- **The sign-in code is ours.** SRP-6a is a standard protocol, and the implementation is checked against the RFC 5054 test vector and an independent big-number implementation, but it has not been reviewed by a cryptographer. Its arithmetic is not constant-time.
- **Older apps.** A PC still accepts apps from before this sign-in (ScreenShare 2.3/2.4, SC-Remote up to 1.3.1) with the earlier signed challenge, so they keep working during an upgrade. That costs the PC nothing, but those apps can still be fooled by an impostor PC into handing over something to test guesses against. Update them.
- **Short passwords.** Guessing over the network is slow (5 tries, then a growing lockout), not impossible. Use 12 or more random characters.
- **Unsandboxed Chromium as the system account.** The service's agent accepts WebRTC connections before the password is checked. A Chromium vulnerability reachable that way would run as the system account. Keep PCs updated.
- **Public connection server.** IDs aren't secret and can be probed. Anyone who knows an ID can trigger the lockout (keeping the owner out too) or occupy the ID while the PC is off. They can't sign in or read anything.
- **Unsigned binaries.** Windows shows a SmartScreen warning for the installer. Download it only from this repository's Releases page. Updates don't depend on Windows' signature check: they're verified with the release key.
- **Local users.** The file limit and the history are not designed to withstand someone who has both the PC's password and an account on that PC.
- **The names in the history** are whatever the connecting computer reports.

## For maintainers

- The release key exists only as the `SC_REMOTE_UPDATE_KEY` Actions secret and one offline backup. Anyone who can push to this repository or run its workflows can publish an update that every PC will offer to install, so protect the GitHub account with two-factor authentication and don't add collaborators with write access unless they should have that power.
- The release workflow only runs for tags and manual runs from the repository itself; pull requests from forks never see the secret.
