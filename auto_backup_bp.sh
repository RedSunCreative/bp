#!/usr/bin/env bash
# auto_backup_bp.sh — automatic off-app backups of the LIVE BP data, run by launchd
# (~/Library/LaunchAgents/net.redsuncreative.bp-backup.plist) at login and every 2 hours.
# Installed by install_auto_backup.sh, which copies this + backup_bp.sh to
# ~/Library/Application Support/BooBackups/bp/bin (macOS blocks background jobs from reading
# ~/Documents) — re-run the installer after editing either script.
#
# Backs up, into backups/auto/ (gitignored):
#   - builder_state row 98 (k12boss)        — via backup_bp.sh
#   - builder_transcripts for k12boss        — not covered by backup_bp.sh
# (lbv's row 97 does not exist in Supabase yet — add it to the lists below once it does.)
# A new copy identical to the previous one is discarded, so nothing piles up while you're not
# working. Only plain timestamped files are pruned (60 per row/show); hand-named backups in
# backups/ are never touched. Log: backups/auto/auto_backup.log
#
# Turn off:  launchctl unload ~/Library/LaunchAgents/net.redsuncreative.bp-backup.plist
# Turn on:   launchctl load   ~/Library/LaunchAgents/net.redsuncreative.bp-backup.plist
# Run now:   bash auto_backup_bp.sh
# Restore:   see the header of backup_bp.sh (row files) — transcripts restore by POSTing the
#            file's rows back to /rest/v1/builder_transcripts.

set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
AUTO="${BP_AUTO_DIR:-$HERE/backups/auto}"   # set by the launchd job; bp/backups/auto links here
mkdir -p "$AUTO"
LOG="$AUTO/auto_backup.log"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

SB_URL="https://gogudwpuhmidngsbqfjg.supabase.co"
KEY="$(grep -oE 'eyJ[A-Za-z0-9._-]{100,}' "$HERE/backup_bp.sh" | head -1)"

# Keep the newest file only if it differs from the one before it.
dedupe() {   # $1 = glob prefix (e.g. builder_state-row98-)
  local newest prev
  newest="$(ls -1t "$AUTO"/"$1"*.json 2>/dev/null | sed -n 1p)"
  prev="$(ls -1t "$AUTO"/"$1"*.json 2>/dev/null | sed -n 2p)"
  if [[ -n "$newest" && -n "$prev" ]] && cmp -s "$newest" "$prev"; then
    rm -f "$newest"; echo "unchanged"
  else
    echo "saved $(basename "$newest")"
  fi
}

for ROW in 98; do
  if BACKUP_DIR="$AUTO" bash "$HERE/backup_bp.sh" "$ROW" >/dev/null 2>>"$LOG"; then
    log "row $ROW: $(dedupe "builder_state-row${ROW}-")"
  else
    log "row $ROW: FAILED (see error above)"
  fi
done

for SHOW in k12boss; do
  OUT="$AUTO/builder_transcripts-${SHOW}-$(date +%Y-%m-%d_%H%M%S).json"
  HTTP=$(curl -s -o "$OUT" -w "%{http_code}" \
    "$SB_URL/rest/v1/builder_transcripts?show_code=eq.${SHOW}&select=*&order=recording_id" \
    -H "apikey: $KEY" -H "Authorization: Bearer $KEY")
  if [[ "$HTTP" != "200" ]] || ! python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$OUT" 2>/dev/null; then
    rm -f "$OUT"; log "transcripts $SHOW: FAILED (HTTP $HTTP)"; continue
  fi
  N=$(python3 -c "import json,sys; print(len(json.load(open(sys.argv[1]))))" "$OUT")
  log "transcripts $SHOW ($N): $(dedupe "builder_transcripts-${SHOW}-")"
  ls -1t "$AUTO"/builder_transcripts-${SHOW}-*.json 2>/dev/null | tail -n +61 | while IFS= read -r f; do rm -f "$f"; done
done
