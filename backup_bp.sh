#!/usr/bin/env bash
# backup_bp.sh — independent off-app backup of the BP Supabase row.
#
# Why this exists: the app's own localStorage + Supabase row are both overwritten
# on every save. This script pulls the live row and writes a TIMESTAMPED, immutable
# copy to ./backups/ — a floor that survives any app bug. Run it anytime, or
# schedule it (cron / launchd) for automatic periodic backups.
#
# Usage:
#   bash backup_bp.sh            # backs up the 'k12boss' row (98)
#   bash backup_bp.sh 97         # back up a specific row id (e.g. lbv = 97)
#
# Restore: the saved JSON is the row's {data, history}. To restore, PATCH it back:
#   curl -X PATCH "$SB_URL/rest/v1/builder_state?id=eq.<ROW>" \
#     -H "apikey: $KEY" -H "Authorization: Bearer $KEY" \
#     -H "Content-Type: application/json" -H "Prefer: return=minimal" \
#     --data @backups/<file>.json
# (The file already has the {data, history} shape PATCH expects.)

set -euo pipefail

ROW="${1:-98}"
SB_URL="https://gogudwpuhmidngsbqfjg.supabase.co"
KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdvZ3Vkd3B1aG1pZG5nc2JxZmpnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg3MTQ2NTMsImV4cCI6MjA5NDI5MDY1M30.O6n_tRQsMU29wFV_RArcN9n6gP8KSDWJQqM4P6cTq3s"

DIR="${BACKUP_DIR:-$(cd "$(dirname "$0")" && pwd)/backups}"   # BACKUP_DIR overrides (auto_backup_bp.sh uses backups/auto)
mkdir -p "$DIR"
TS="$(date +%Y-%m-%d_%H%M%S)"
OUT="$DIR/builder_state-row${ROW}-${TS}.json"

echo "Backing up row $ROW from Supabase…"
HTTP=$(curl -s -o "$OUT" -w "%{http_code}" \
  "$SB_URL/rest/v1/builder_state?id=eq.${ROW}&select=data,history" \
  -H "apikey: $KEY" -H "Authorization: Bearer $KEY")

if [[ "$HTTP" != "200" ]]; then
  echo "ERROR: Supabase returned HTTP $HTTP — backup NOT saved." >&2
  rm -f "$OUT"
  exit 1
fi

# Verify it actually contains data, and report the season-brief size as a sanity check.
# An empty result (e.g. the row doesn't exist) is deleted, not kept as a 2-byte "backup".
if ! python3 - "$OUT" <<'PY'
import json, sys
p = sys.argv[1]
rows = json.load(open(p))
if not rows or not isinstance(rows, list) or not rows[0].get('data'):
    print("ERROR: backup file has no data — refusing to keep an empty backup.", file=sys.stderr)
    sys.exit(1)
data = rows[0]['data']
seasons = (data.get('state') or {}).get('seasons') or []
brief = (seasons[0] or {}).get('seasonBrief', '') if seasons else ''
hist = rows[0].get('history') or []
print(f"  OK: data savedAt={data.get('savedAt')}")
print(f"  seasonBrief: {len(brief)} chars | history snapshots: {len(hist)}")
PY
then
  rm -f "$OUT"
  exit 1
fi

# Keep the last 60 PLAIN timestamped backups; prune older ones. Only files named exactly
# builder_state-row<ROW>-YYYY-MM-DD_HHMMSS.json are ever pruned — hand-named safety backups
# (PRE-RECOVERY, PRE-PINS, …-backup-…) never match and are never deleted.
ls -1t "$DIR"/builder_state-row${ROW}-*.json 2>/dev/null \
  | grep -E "/builder_state-row${ROW}-[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{6}\.json$" \
  | tail -n +61 | while IFS= read -r f; do rm -f "$f"; done || true

echo "Saved: $OUT"
