# Security

SC-Remote and ScreenShare's remote desktop give whoever has a PC's ID **and** password full control of that PC. This page says what protects that, what doesn't, and how to report a problem.

## Reporting a problem

Please don't open a public issue for a security problem. Use **Security › Report a vulnerability** on the GitHub repository (private), or the feedback form linked at the bottom of the SC-Remote window, and say that it's about security. Include the version (bottom of the window) and what you did.

## What protects a PC

- **Password, never stored or sent.** The PC keeps a PBKDF2-SHA256 key (150 000 rounds) derived from the password, in a file only administrators and the system account can read. Signing in is a challenge and response over that key.
- **Checked both ways, tied to the connection.** The response covers both ends' DTLS certificate fingerprints, so it can't be relayed over another connection. The PC answers with its own proof that it knows the password, and the app sends nothing (input, clipboard, files) and shows nothing until that proof checks out.
- **Lockout.** 5 wrong passwords lock sign-ins for 1 minute, then 2, 4… up to 30.
- **Encrypted sessions.** Screen, input, clipboard and files travel over WebRTC (DTLS/SRTP) directly between the two PCs, or through a relay that can't decrypt them. The connection server only introduces them.
- **History and log.** Every connection and refused attempt is listed in the app (Connection history) and in `agent\audit.log` (administrators).
- **Updates.** Releases are built by GitHub Actions. Each carries a manifest signed with an RSA-3072 key kept as a repository secret; the app and the service only accept a manifest signed with it, for a newer version, with a download inside this repository's releases whose SHA-256 matches. The installer runs from folders only administrators can write.
- **Windows service.** Runs as the system account so the sign-in screen, lock screen and UAC prompts can be controlled. Its settings need an administrator. Remote file access is limited to the signed-in user's folder. The app's windows can't navigate to other pages or open new ones.

## Known limits

- **Not audited.** This is a small project, reviewed by its authors only.
- **Password guessing by an impostor.** Someone who poses as a PC (by taking its ID on the connection server while it's off) gets one response per connection attempt and can test password guesses against it offline. Long random passwords make that impractical; short or common ones don't. A password-authenticated key exchange would remove this; it is not implemented.
- **Unsandboxed Chromium as the system account.** The service's agent accepts WebRTC connections before the password is checked. A Chromium vulnerability reachable that way would run as the system account. Keep PCs updated.
- **Public connection server.** IDs aren't secret and can be probed. Anyone who knows an ID can trigger the lockout (keeping the owner out too) or occupy the ID while the PC is off. They can't sign in or read anything.
- **Unsigned binaries.** Windows shows a SmartScreen warning for the installer. Download it only from this repository's Releases page. Updates don't depend on Windows' signature check: they're verified with the release key.
- **Local users.** The file limit and the history are not designed to withstand someone who has both the PC's password and an account on that PC.
- **The names in the history** are whatever the connecting computer reports.

## For maintainers

- The release key exists only as the `SC_REMOTE_UPDATE_KEY` Actions secret and one offline backup. Anyone who can push to this repository or run its workflows can publish an update that every PC will offer to install, so protect the GitHub account with two-factor authentication and don't add collaborators with write access unless they should have that power.
- The release workflow only runs for tags and manual runs from the repository itself; pull requests from forks never see the secret.
