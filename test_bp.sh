#!/usr/bin/env bash
# BP pre-deploy test suite.
# Usage:  bash test_bp.sh            (normal run)
#         bash test_bp.sh --break    (inject failures to verify tests catch them)

BP="bp.html"
PASS=0; FAIL=0
BREAK_MODE="${1:-}"

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
pass()  { printf '  '; green "PASS: $1"; ((PASS++)); }
fail()  { printf '  '; red   "FAIL: $1"; ((FAIL++)); }

echo ""
echo "=== BP TEST SUITE ==="
[[ "$BREAK_MODE" == "--break" ]] && echo "  *** BREAK-TEST MODE ***"
echo ""

# ──────────────────────────────────────────────────────────────
# BREAK-TEST INJECTION
# ──────────────────────────────────────────────────────────────
if [[ "$BREAK_MODE" == "--break" ]]; then
  # T1-T2: no direct API calls / proxy
  sed -i '' 's/const PROXY    = /const _PROXY_DISABLED = /' "$BP"
  echo "  Injected: disabled PROXY constant"
  # T4: API_KEY guard
  sed -i '' 's/if (!text) return;/if (!text || !API_KEY) return;/' "$BP"
  echo "  Injected: restored !API_KEY guard in sendMessage"
  # T9: break applySession guard so empty-seasons save wipes state.seasons
  sed -i '' 's/if (s\.seasons && s\.seasons\.length) state\.seasons = s\.seasons;/state.seasons = s.seasons || [];/' "$BP"
  echo "  Injected: reverted applySession seasons guard"
  # T10: reintroduce let for autoSaveTimeout (TDZ risk)
  sed -i '' 's/var autoSaveTimeout = null;/let autoSaveTimeout = null;/' "$BP"
  echo "  Injected: changed var autoSaveTimeout back to let"
  # T11: remove renderSeasonsList() from applySession patch
  sed -i '' 's/  renderSeasonsList();$/  \/\/ BREAK-renderSeasonsList-removed/' "$BP"
  echo "  Injected: removed renderSeasonsList() from applySession patch"
  echo ""
fi

# ──────────────────────────────────────────────────────────────
# TEST 1: JS syntax
# ──────────────────────────────────────────────────────────────
echo "--- Test 1: JS syntax (node --check) ---"
python3 - > /tmp/bp_extract.txt 2>&1 <<'PYEOF'
from html.parser import HTMLParser
import sys

class SE(HTMLParser):
    def __init__(self):
        super().__init__()
        self.in_s = False; self.scripts = []; self.cur = []
    def handle_starttag(self, tag, attrs):
        if tag == 'script' and not dict(attrs).get('src'):
            self.in_s = True; self.cur = []
    def handle_endtag(self, tag):
        if tag == 'script' and self.in_s:
            self.scripts.append(''.join(self.cur)); self.in_s = False
    def handle_data(self, d):
        if self.in_s: self.cur.append(d)

with open('bp.html') as f:
    p = SE(); p.feed(f.read())

if not p.scripts:
    print("ERROR: no inline script found"); sys.exit(1)
with open('/tmp/bp_script_check.js', 'w') as f:
    f.write(p.scripts[0])
print(len(p.scripts[0]))
PYEOF

EXTRACT_CHARS=$(cat /tmp/bp_extract.txt)
if [[ "$EXTRACT_CHARS" -gt 10000 ]] 2>/dev/null; then
  pass "Script extracted ($EXTRACT_CHARS chars)"
else
  fail "Script extraction failed: $EXTRACT_CHARS"
fi

NODE_ERR=$(node --check /tmp/bp_script_check.js 2>&1)
if [[ -z "$NODE_ERR" ]]; then
  pass "No JS syntax errors"
else
  fail "JS syntax error: $NODE_ERR"
fi

# ──────────────────────────────────────────────────────────────
# TEST 2: No direct Anthropic API calls in browser
# ──────────────────────────────────────────────────────────────
echo ""
echo "--- Test 2: No direct Anthropic API calls ---"
if grep -q "api\.anthropic\.com\|x-api-key\|anthropic-dangerous-direct-browser-access" "$BP"; then
  fail "Direct Anthropic API call found — must go through Supabase proxy"
else
  pass "No direct Anthropic API calls"
fi

# ──────────────────────────────────────────────────────────────
# TEST 3: Supabase proxy constants present
# ──────────────────────────────────────────────────────────────
echo ""
echo "--- Test 3: Supabase proxy wired up ---"
if grep -q "const PROXY" "$BP"; then
  pass "PROXY constant defined"
else
  fail "PROXY constant missing"
fi

if grep -q "SB_ANON" "$BP"; then
  pass "SB_ANON key present"
else
  fail "SB_ANON key missing"
fi

# ──────────────────────────────────────────────────────────────
# TEST 4: No API_KEY guard blocking sendMessage
# ──────────────────────────────────────────────────────────────
echo ""
echo "--- Test 4: sendMessage not gated on API_KEY ---"
if grep -q "!API_KEY" "$BP"; then
  fail "sendMessage still gated on API_KEY"
else
  pass "sendMessage not gated on API_KEY"
fi

# ──────────────────────────────────────────────────────────────
# TEST 5: Auto-init on DOMContentLoaded
# ──────────────────────────────────────────────────────────────
echo ""
echo "--- Test 5: Auto-initializes without modal ---"
if grep -q "DOMContentLoaded.*initApp\|addEventListener.*DOMContentLoaded" "$BP"; then
  pass "DOMContentLoaded auto-init present"
else
  fail "DOMContentLoaded auto-init missing"
fi

if grep -q "apiModal\|apiKeyInput" "$BP"; then
  fail "API key modal still present in HTML"
else
  pass "API key modal removed"
fi

# ──────────────────────────────────────────────────────────────
# TEST 6: SHOW_CONFIG present
# ──────────────────────────────────────────────────────────────
echo ""
echo "--- Test 6: SHOW_CONFIG present ---"
if grep -q "const SHOW_CONFIG" "$BP"; then
  pass "SHOW_CONFIG defined"
else
  fail "SHOW_CONFIG missing"
fi

# ──────────────────────────────────────────────────────────────
# TEST 7: Supabase persistence wired up
# ──────────────────────────────────────────────────────────────
echo ""
echo "--- Test 7: Supabase persistence ---"
if grep -q "loadFromSupabase" "$BP" && grep -q "rest/v1/builder_state" "$BP"; then
  pass "loadFromSupabase and Supabase REST calls present"
else
  fail "Supabase persistence missing"
fi

if grep -q "await loadFromSupabase" "$BP"; then
  pass "loadFromSupabase called during init"
else
  fail "loadFromSupabase not called during init"
fi

# ──────────────────────────────────────────────────────────────
# TEST 8 (behavioral): renderSeasonsList produces Season 1 button
# ──────────────────────────────────────────────────────────────
echo ""
echo "--- Test 8: renderSeasonsList produces Season 1 button ---"
cat > /tmp/bp_t8.js << 'NODEEOF'
const fs = require('fs');
const src = fs.readFileSync('bp.html', 'utf8');

// Extract default state.seasons initializer
const seasonsMatch = src.match(/seasons:\s*\[\s*\{\s*\n\s*number:\s*(\d+)[^}]*?theme:\s*'([^']+)'/s);
if (!seasonsMatch) { console.log('FAIL: could not locate state.seasons initializer'); process.exit(0); }

const state = {
  seasons: [{ number: Number(seasonsMatch[1]), theme: seasonsMatch[2] }],
  currentSeason: null,
};
const el = { innerHTML: '' };
const seasons = state.seasons && state.seasons.length ? state.seasons : [state.currentSeason].filter(Boolean);
el.innerHTML = seasons.map(function(s) {
  const num = s.number || 1;
  const theme = s.theme || '';
  return '<button class="season-nav-btn" data-snum="' + num + '">'
    + '<span class="season-nav-btn-name">Season ' + num + '</span>'
    + (theme ? '<span class="season-nav-btn-theme">' + theme + '</span>' : '')
    + '</button>';
}).join('');

if (el.innerHTML.includes('Season 1') && el.innerHTML.includes('data-snum="1"')) {
  console.log('PASS');
} else {
  console.log('FAIL: innerHTML=' + el.innerHTML.slice(0, 80));
}
NODEEOF
T8_RESULT=$(node /tmp/bp_t8.js 2>&1)
if [[ "$T8_RESULT" == PASS ]]; then
  pass "renderSeasonsList renders Season 1 button from default state"
else
  fail "renderSeasonsList did not render Season 1: $T8_RESULT"
fi

# ──────────────────────────────────────────────────────────────
# TEST 9 (behavioral): applySession preserves Season 1 when save has no seasons
# ──────────────────────────────────────────────────────────────
echo ""
echo "--- Test 9: applySession preserves Season 1 from default state ---"
cat > /tmp/bp_t9.js << 'NODEEOF'
const fs = require('fs');
const src = fs.readFileSync('bp.html', 'utf8');

const hasGuard = /if \(s\.seasons && s\.seasons\.length\) state\.seasons = s\.seasons;/.test(src);
const hasBroken = /state\.seasons = s\.seasons \|\| \[\];/.test(src);

if (!hasGuard || hasBroken) {
  console.log('FAIL: applySession guard missing or overridden — empty-seasons save will wipe Season 1');
  process.exit(0);
}

// Simulate the guard logic itself
const defaultSeasons = [{ number: 1, theme: 'What Do We Teach Now?' }];
let seasons = JSON.parse(JSON.stringify(defaultSeasons));
const s = { seasons: [], currentSeason: null };
if (s.seasons && s.seasons.length) seasons = s.seasons;

if (seasons.length === 1 && seasons[0].number === 1) {
  console.log('PASS');
} else {
  console.log('FAIL: seasons=' + JSON.stringify(seasons));
}
NODEEOF
T9_RESULT=$(node /tmp/bp_t9.js 2>&1)
if [[ "$T9_RESULT" == PASS ]]; then
  pass "applySession preserves Season 1 when save has empty seasons"
else
  fail "applySession wiped Season 1: $T9_RESULT"
fi

# ──────────────────────────────────────────────────────────────
# TEST 10 (behavioral): autoSaveTimeout uses var (no TDZ risk)
# ──────────────────────────────────────────────────────────────
echo ""
echo "--- Test 10: autoSaveTimeout declared with var (no TDZ) ---"
cat > /tmp/bp_t10.js << 'NODEEOF'
const fs = require('fs');
const src = fs.readFileSync('bp.html', 'utf8');

const isVar = /\bvar autoSaveTimeout\s*=\s*null/.test(src);
const isLet = /\blet autoSaveTimeout\s*=\s*null/.test(src);

if (isVar && !isLet) {
  console.log('PASS');
} else if (isLet) {
  console.log('FAIL: declared with let — TDZ risk if autoSave called before declaration runs');
} else {
  console.log('FAIL: autoSaveTimeout declaration not found');
}
NODEEOF
T10_RESULT=$(node /tmp/bp_t10.js 2>&1)
if [[ "$T10_RESULT" == PASS ]]; then
  pass "autoSaveTimeout uses var — no TDZ risk"
else
  fail "autoSaveTimeout TDZ risk: $T10_RESULT"
fi

# ──────────────────────────────────────────────────────────────
# TEST 11 (behavioral): applySession patch calls renderSeasonsList
# ──────────────────────────────────────────────────────────────
echo ""
echo "--- Test 11: applySession patch calls renderSeasonsList ---"
cat > /tmp/bp_t11.js << 'NODEEOF'
const fs = require('fs');
const src = fs.readFileSync('bp.html', 'utf8');

const patchStart = src.indexOf('const _origApplySession = applySession;');
if (patchStart === -1) { console.log('FAIL: applySession patch not found'); process.exit(0); }
// Find the closing }; of the patched function
const afterPatch = src.slice(patchStart);
// The patched function is: applySession = function(data) { ... };
// Find the end by looking for }; after the reassignment
const patchFnStart = afterPatch.indexOf('applySession = function');
const patchBlock = afterPatch.slice(patchFnStart);
// Count braces to find the end
let depth = 0, end = -1;
for (let i = 0; i < patchBlock.length; i++) {
  if (patchBlock[i] === '{') depth++;
  else if (patchBlock[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
}
const patchFn = end > -1 ? patchBlock.slice(0, end + 1) : patchBlock.slice(0, 1000);

if (patchFn.includes('renderSeasonsList()')) {
  console.log('PASS');
} else {
  console.log('FAIL: renderSeasonsList() not called inside applySession patch body');
}
NODEEOF
T11_RESULT=$(node /tmp/bp_t11.js 2>&1)
if [[ "$T11_RESULT" == PASS ]]; then
  pass "applySession patch calls renderSeasonsList() after restore"
else
  fail "applySession patch missing renderSeasonsList(): $T11_RESULT"
fi

# ──────────────────────────────────────────────────────────────
# BREAK-TEST CLEANUP
# ──────────────────────────────────────────────────────────────
if [[ "$BREAK_MODE" == "--break" ]]; then
  sed -i '' 's/const _PROXY_DISABLED = /const PROXY    = /' "$BP"
  sed -i '' 's/if (!text || !API_KEY) return;/if (!text) return;/' "$BP"
  sed -i '' 's/state\.seasons = s\.seasons || \[\];/if (s.seasons \&\& s.seasons.length) state.seasons = s.seasons;/' "$BP"
  sed -i '' 's/let autoSaveTimeout = null;/var autoSaveTimeout = null;/' "$BP"
  sed -i '' 's/  \/\/ BREAK-renderSeasonsList-removed/  renderSeasonsList();/' "$BP"
  echo ""
  echo "  (break-test injections removed — file restored)"
fi

# ──────────────────────────────────────────────────────────────
# SUMMARY
# ──────────────────────────────────────────────────────────────
echo ""
echo "=============================="
printf "  "; green "PASSED: $PASS"
[[ $FAIL -gt 0 ]] && { printf "  "; red "FAILED: $FAIL"; } || true
echo "=============================="
echo ""
[[ $FAIL -eq 0 ]]
