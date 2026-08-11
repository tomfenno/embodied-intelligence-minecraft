#!/bin/bash
# Positions the Minecraft client window to the left half of the main
# screen, every launch. Invoked via Prism Launcher's PreLaunchCommand (see
# achievement_hunter/workshop_demo/PLAN.md) — backgrounds itself
# immediately so it never blocks the actual game launch, then polls for
# the game window to appear before positioning it.
#
# Requires Accessibility permission granted to Prism Launcher (System
# Settings -> Privacy & Security -> Accessibility) — this is what lets
# System Events control another app's window. Silently gives up after 60s
# if the window never appears or the permission isn't granted; the game
# still launches normally either way.

LOG="$(dirname "$0")/../.run/position_window.log"
mkdir -p "$(dirname "$LOG")"

(
  echo "[$(date)] waiting for window..." >> "$LOG"
  for _ in $(seq 1 60); do
    sleep 1
    count=$(osascript -e 'tell application "System Events" to tell process "java" to count windows' 2>>"$LOG")
    if [ -n "$count" ] && [ "$count" -ge 1 ] 2>/dev/null; then
      echo "[$(date)] window found (count=$count), positioning..." >> "$LOG"
      RESULT=$(osascript <<'EOF' 2>&1
tell application "Finder"
  set screenBounds to bounds of window of desktop
end tell
set screenWidth to item 3 of screenBounds
set screenHeight to item 4 of screenBounds

tell application "System Events"
  tell process "java"
    set position of window 1 to {0, 0}
    set size of window 1 to {screenWidth / 2, screenHeight}
  end tell
end tell
return "positioned OK, screenWidth=" & screenWidth & " screenHeight=" & screenHeight
EOF
)
      echo "[$(date)] result: $RESULT" >> "$LOG"
      break
    fi
  done
) &
exit 0
