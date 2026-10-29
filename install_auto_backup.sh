#!/usr/bin/env bash
# install_auto_backup.sh — set up (or refresh) automatic BP backups on this Mac.
# macOS won't let background jobs read ~/Documents, so the job runs from, and writes to,
# ~/Library/Application Support/BooBackups/bp. bp/backups/auto is a link to that folder.
# Safe to re-run any time (e.g. after editing auto_backup_bp.sh or backup_bp.sh).
# Uninstall: launchctl unload ~/Library/LaunchAgents/net.redsuncreative.bp-backup.plist && rm that file
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HOME/Library/Application Support/BooBackups/bp"
BIN="$ROOT/bin"; AUTO="$ROOT/auto"
PL="$HOME/Library/LaunchAgents/net.redsuncreative.bp-backup.plist"
mkdir -p "$BIN" "$AUTO"
cp "$HERE/auto_backup_bp.sh" "$HERE/backup_bp.sh" "$BIN/"
# Point bp/backups/auto at the real folder (moving any files already there).
if [[ -d "$HERE/backups/auto" && ! -L "$HERE/backups/auto" ]]; then
  find "$HERE/backups/auto" -maxdepth 1 -type f -exec mv -n {} "$AUTO/" \;
  rmdir "$HERE/backups/auto"
fi
[[ -L "$HERE/backups/auto" ]] || ln -s "$AUTO" "$HERE/backups/auto"
cat > "$PL" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>net.redsuncreative.bp-backup</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$BIN/auto_backup_bp.sh</string></array>
  <key>EnvironmentVariables</key><dict><key>BP_AUTO_DIR</key><string>$AUTO</string></dict>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>7200</integer>
  <key>StandardErrorPath</key><string>$AUTO/launchd.err</string>
</dict>
</plist>
PLIST
plutil -lint "$PL" >/dev/null
launchctl unload "$PL" 2>/dev/null || true
launchctl load "$PL"
echo "Installed. Backups: $AUTO (also at bp/backups/auto). Log: auto_backup.log"
