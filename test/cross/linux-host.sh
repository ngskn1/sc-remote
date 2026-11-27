#!/bin/bash
# The Linux PC for test/cross (a Windows computer controls it from another machine): SC-Remote's agent on a virtual
# screen, plus a helper that lets the controller see and set this PC's clipboard through files in ~ :
#   ~/clipstate.txt  what is on the clipboard now (file list, then "--- text ---" and the text)
#   ~/copy-request/  a file put here is copied to the clipboard, as a file manager does (Ctrl+C)
#   ~/text-request.txt  its text is copied to the clipboard
#   ~/cross-done     the controller is finished
set -u
export DISPLAY=:99
Xvfb :99 -screen 0 1600x1000x24 >/dev/null 2>&1 &
sleep 2
ROOT="$HOME/scroot"; mkdir -p "$ROOT/agent" "$HOME/copy-request" "$HOME/copied"
node -e '
const c = require("crypto"), salt = c.randomBytes(16).toString("hex");
require("fs").writeFileSync(process.argv[1], JSON.stringify({ enabled: true, id: process.env.CROSS_ID, banner: false, consent: "never", lang: "en", salt,
  key: c.pbkdf2Sync(process.env.CROSS_PASSWORD, Buffer.from(salt, "hex"), 150000, 32, "sha256").toString("hex") }));' "$ROOT/agent/access.json"
SCREENSHARE_EDITION=remote SCREENSHARE_LAB_ROOT="$ROOT" SCREENSHARE_LANG=en SCREENSHARE_PC_NAME="Linux PC" \
  ./node_modules/electron/dist/electron . --no-sandbox --agent >"$HOME/agent-stdout.txt" 2>&1 &
for i in $(seq 60); do grep -q '"online"' "$ROOT/status.json" 2>/dev/null && break; sleep 1; done
echo "status: $(cat "$ROOT/status.json" 2>/dev/null)"
end=$(( $(date +%s) + ${CROSS_MINUTES:-25} * 60 ))
while [ ! -f "$HOME/cross-done" ] && [ "$(date +%s)" -lt "$end" ]; do
  for f in "$HOME"/copy-request/*; do
    [ -e "$f" ] || continue
    n=$(basename "$f"); mv "$f" "$HOME/copied/$n"
    printf 'copy\nfile://%s' "$HOME/copied/$n" | timeout 600 xclip -selection clipboard -t x-special/gnome-copied-files -i &
    echo "$(date +%T) copied $n (as a file manager does)"
  done
  if [ -f "$HOME/text-request.txt" ]; then
    mv "$HOME/text-request.txt" "$HOME/text-copied.txt"
    timeout 600 xclip -selection clipboard -i "$HOME/text-copied.txt" &
    echo "$(date +%T) copied the text: $(cat "$HOME/text-copied.txt")"
  fi
  { timeout 2 xclip -selection clipboard -o -t text/uri-list 2>/dev/null; echo; echo '--- text ---'; timeout 2 xclip -selection clipboard -o 2>/dev/null; } > "$HOME/clipstate.new"
  mv "$HOME/clipstate.new" "$HOME/clipstate.txt"
  sleep 1
done
echo "--- last clipboard state"; cat "$HOME/clipstate.txt"
echo "--- the agent's log"; cat "$ROOT/agent/profile/remote.log" 2>/dev/null | tail -80
