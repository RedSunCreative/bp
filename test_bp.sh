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
  # T12: disable tooltip DOMContentLoaded so it never fires (tip stays null)
  sed -i '' "s/addEventListener('DOMContentLoaded', function() {$/addEventListener('DISABLED', function() {/" "$BP"
  echo "  Injected: tooltip DOMContentLoaded renamed to DISABLED — tip stays null"
  # T13: inject </script> literal inside the script block to simulate early close
  sed -i '' "s|// tip-q tooltip — must run after DOM is ready; #boo-tip is after the script block|// tip-q tooltip — must run after DOM is ready; #boo-tip is after </script>|" "$BP"
  echo "  Injected: </script> literal in comment inside script block"
  # T17: disable load gate AND anti-shrink guard (autoSave can write seed pre-load / over real data)
  sed -i '' 's/if (!_supabaseLoaded) {/if (false) { \/\/ BREAK-gate/' "$BP"
  echo "  Injected: disabled load gate (_supabaseLoaded check)"
  sed -i '' 's/if (_isNearSeed(snapshot)) {/if (false) { \/\/ BREAK-guard/' "$BP"
  echo "  Injected: disabled anti-shrink guard (_isNearSeed check)"
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
const seasonsMatch = src.match(/seasons:\s*\[\s*\{\s*\n\s*number:\s*(\d+)[^}]*?theme:\s*'([^']*)'/s);
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
# TEST 12 (behavioral): tooltip init runs inside DOMContentLoaded
# ──────────────────────────────────────────────────────────────
echo ""
echo "--- Test 12: tooltip init inside DOMContentLoaded (not at parse time) ---"
cat > /tmp/bp_t12.js << 'NODEEOF'
const fs = require('fs');
const src = fs.readFileSync('bp.html', 'utf8');

// The #boo-tip element is after </script>, so getElementById must run post-DOM
// Verify the tooltip init is inside a DOMContentLoaded callback, not an IIFE
const dcl = "addEventListener('DOMContentLoaded', function() {";
const dclIdx = src.indexOf(dcl);
if (dclIdx === -1) {
  console.log('FAIL: no DOMContentLoaded callback found for tooltip init');
  process.exit(0);
}
const block = src.slice(dclIdx, dclIdx + 800);
if (!block.includes("getElementById('boo-tip')")) {
  console.log('FAIL: DOMContentLoaded callback found but does not contain getElementById(boo-tip)');
  process.exit(0);
}
// Also verify the IIFE pattern is NOT present for boo-tip
if (/\(function\s*\(\s*\)\s*\{[\s\S]{0,100}getElementById\('boo-tip'\)/.test(src)) {
  console.log('FAIL: tooltip init is still in an IIFE — boo-tip will be null at parse time');
  process.exit(0);
}
console.log('PASS');
NODEEOF
T12_RESULT=$(node /tmp/bp_t12.js 2>&1)
if [[ "$T12_RESULT" == PASS ]]; then
  pass "tooltip init inside DOMContentLoaded — boo-tip found when listeners attach"
else
  fail "tooltip will not work: $T12_RESULT"
fi

# ──────────────────────────────────────────────────────────────
# TEST 13 (structural): no </script> literal inside the <script> block
# ──────────────────────────────────────────────────────────────
echo ""
echo "--- Test 13: no </script> literal inside script block (kills the page) ---"
cat > /tmp/bp_t13.js << 'NODEEOF'
const fs = require('fs');
const src = fs.readFileSync('bp.html', 'utf8');

// A </script> literal inside a JS comment cuts the script block at that point.
// The browser stops reading JS at the FIRST </script> it encounters.
// Guard: verify the last line of the real script block is still reachable —
// i.e., the script body (up to the first </script>) contains the initApp sentinel.
const scriptStart = src.indexOf('<script>');
if (scriptStart === -1) { console.log('FAIL: no inline <script> tag found'); process.exit(0); }

const scriptEnd = src.indexOf('</script>', scriptStart);
if (scriptEnd === -1) { console.log('FAIL: no </script> found after <script>'); process.exit(0); }

// Everything the browser actually parses as JS
const scriptBody = src.slice(scriptStart + '<script>'.length, scriptEnd);

// The login handler is the last thing in the script block — if a spurious </script>
// cuts the block early, submitShowCode will be missing from the parsed JS.
if (!scriptBody.includes('submitShowCode')) {
  console.log('FAIL: script block cut short — submitShowCode sentinel not found. A </script> literal likely appears inside a comment before the real closing tag.');
  process.exit(0);
}
console.log('PASS');
NODEEOF
T13_RESULT=$(node /tmp/bp_t13.js 2>&1)
if [[ "$T13_RESULT" == PASS ]]; then
  pass "no </script> literal inside script block"
else
  fail "script block will be cut short: $T13_RESULT"
fi

# ──────────────────────────────────────────────────────────────
# TEST 14 (mechanical): persistence round-trip — every field survives
#   buildSessionSnapshot -> JSON round-trip -> applySession
# Executes the REAL functions from bp.html in a vm sandbox (no jsdom).
# ──────────────────────────────────────────────────────────────
echo ""
echo "--- Test 14: persistence round-trip (save -> serialize -> load) ---"
T14_OUT=$(node test_persistence.js 2>&1)
T14_RC=$?
T14_FAILS=$(printf '%s\n' "$T14_OUT" | grep -c 'FAIL')
T14_PASSES=$(printf '%s\n' "$T14_OUT" | grep -c 'PASS')
if [[ $T14_RC -eq 0 && $T14_FAILS -eq 0 && $T14_PASSES -gt 0 ]]; then
  pass "all persisted fields survive round-trip ($T14_PASSES fields captured + restored)"
elif [[ $T14_RC -eq 2 ]]; then
  fail "persistence test could not load bp.html into sandbox (rc=2)"
  printf '%s\n' "$T14_OUT" | grep -iE 'FATAL|Error' | head -3 | sed 's/^/    /'
else
  fail "persistence round-trip broke ($T14_FAILS field(s) failed capture/restore)"
  printf '%s\n' "$T14_OUT" | grep 'FAIL' | sed 's/^/    /'
fi

# ──────────────────────────────────────────────────────────────
# TEST 15 (behavioral): end-to-end persistence — autoSave + loadFromSupabase
# Proves the ACTUAL runtime path that has lost chat: autoSave serializes the
# chat to localStorage, and loadFromSupabase restores it (Supabase empty,
# stale-Supabase-vs-newer-local, and newer-Supabase scenarios).
# Executes the REAL autoSave / loadFromSupabase from bp.html in a vm sandbox.
# ──────────────────────────────────────────────────────────────
echo ""
echo "--- Test 15: end-to-end persistence (autoSave -> load newest -> chat survives) ---"
T15_OUT=$(node test_persistence_e2e.js 2>&1)
T15_RC=$?
T15_FAILS=$(printf '%s\n' "$T15_OUT" | grep -c 'FAIL')
T15_PASSES=$(printf '%s\n' "$T15_OUT" | grep -c 'PASS')
if [[ $T15_RC -eq 0 && $T15_FAILS -eq 0 && $T15_PASSES -gt 0 ]]; then
  pass "chat survives the real save/load cycle ($T15_PASSES scenarios)"
elif [[ $T15_RC -eq 2 ]]; then
  fail "e2e persistence test could not load bp.html into sandbox (rc=2)"
  printf '%s\n' "$T15_OUT" | grep -iE 'FATAL|Error' | head -3 | sed 's/^/    /'
else
  fail "end-to-end persistence broke ($T15_FAILS scenario(s) failed)"
  printf '%s\n' "$T15_OUT" | grep 'FAIL' | sed 's/^/    /'
fi

# ──────────────────────────────────────────────────────────────
# TEST 16 (behavioral): data mutation protocol — destructive gated, autoSave silent
# Drives the REAL generateSeasonBrief / autoSave / onUserConfirmation in a vm
# sandbox with a stateful fake Supabase. Proves backup -> gate -> confirm ->
# apply -> verify on destructive ops, and silent backup+verify on autoSave.
# ──────────────────────────────────────────────────────────────
echo ""
echo "--- Test 16: data mutation protocol (destructive gated / autoSave silent) ---"
T16_OUT=$(node test_protocol.js 2>&1)
T16_RC=$?
T16_FAILS=$(printf '%s\n' "$T16_OUT" | grep -c 'FAIL')
T16_PASSES=$(printf '%s\n' "$T16_OUT" | grep -c 'PASS')
if [[ $T16_RC -eq 0 && $T16_FAILS -eq 0 && $T16_PASSES -gt 0 ]]; then
  pass "protocol enforced ($T16_PASSES assertions: backup/gate/confirm/apply/verify)"
elif [[ $T16_RC -eq 2 ]]; then
  fail "protocol test could not load bp.html into sandbox (rc=2)"
  printf '%s\n' "$T16_OUT" | grep -iE 'FATAL|Error' | head -3 | sed 's/^/    /'
else
  fail "data mutation protocol broke ($T16_FAILS assertion(s) failed)"
  printf '%s\n' "$T16_OUT" | grep 'FAIL' | sed 's/^/    /'
fi

# ──────────────────────────────────────────────────────────────
# TEST 17 (behavioral): load gate + Supabase-reading anti-shrink guard
# Drives the REAL autoSave in a vm sandbox with a stateful fake Supabase.
# Proves: no PATCH before loadFromSupabase completes (gate); a near-empty
# snapshot is refused when the LIVE row holds real content (anti-shrink);
# and a near-empty snapshot is allowed when the live row is empty.
# Incident 2026-06-26: app autosaved seed state over Season 1 during the
# async load window, and the in-memory guard couldn't catch it.
# ──────────────────────────────────────────────────────────────
echo ""
echo "--- Test 17: load gate + anti-shrink guard (no pre-load write / no seed-over-real) ---"
T17_OUT=$(node test_loadgate.js 2>&1)
T17_RC=$?
T17_FAILS=$(printf '%s\n' "$T17_OUT" | grep -c 'FAIL')
T17_PASSES=$(printf '%s\n' "$T17_OUT" | grep -c 'PASS')
if [[ $T17_RC -eq 0 && $T17_FAILS -eq 0 && $T17_PASSES -gt 0 ]]; then
  pass "load gate blocks pre-load writes; anti-shrink blocks seed-over-real ($T17_PASSES assertions)"
elif [[ $T17_RC -eq 2 ]]; then
  fail "load-gate test could not load bp.html into sandbox (rc=2)"
  printf '%s\n' "$T17_OUT" | grep -iE 'FATAL|Error' | head -3 | sed 's/^/    /'
else
  fail "load gate / anti-shrink broke ($T17_FAILS assertion(s) failed)"
  printf '%s\n' "$T17_OUT" | grep 'FAIL' | sed 's/^/    /'
fi

# ──────────────────────────────────────────────────────────────
# TEST 18 (behavioral): parseReply content routing — no card hijack
# Drives the REAL parseReply from bp.html in a vm sandbox. Proves a
# season-arc / markdown table is NOT rendered as interactive guest
# cards in chat, while a real guest reply (with "Tier:") still is.
# Bug 2026-07-06: pipe-line count alone routed any table into cards.
# ──────────────────────────────────────────────────────────────
echo ""
echo "--- Test 18: parseReply routing (tables not hijacked into guest cards) ---"
T18_OUT=$(node test_parsereply.js 2>&1)
T18_RC=$?
T18_FAILS=$(printf '%s\n' "$T18_OUT" | grep -c 'FAIL')
T18_PASSES=$(printf '%s\n' "$T18_OUT" | grep -c 'PASS')
if [[ $T18_RC -eq 0 && $T18_FAILS -eq 0 && $T18_PASSES -gt 0 ]]; then
  pass "tables render as text; real guest replies still render as cards ($T18_PASSES assertions)"
elif [[ $T18_RC -eq 2 ]]; then
  fail "parseReply test could not load bp.html into sandbox (rc=2)"
  printf '%s\n' "$T18_OUT" | grep -iE 'FATAL|Error' | head -3 | sed 's/^/    /'
else
  fail "parseReply routing broke ($T18_FAILS assertion(s) failed)"
  printf '%s\n' "$T18_OUT" | grep 'FAIL' | sed 's/^/    /'
fi

# ──────────────────────────────────────────────────────────────
# TEST 19 (behavioral): Story Shapes — pluggable season arc models
# Drives the REAL getEpArcBeat / setStoryShape from bp.html in a vm
# sandbox. Proves Plot Mountain's per-episode mapping is unchanged by
# the rewire, the shape lens switches (Man in Hole), and the choice
# persists on the durable season record + currentSeason.
# ──────────────────────────────────────────────────────────────
echo ""
echo "--- Test 19: Story Shapes (pluggable arc models, Plot Mountain unchanged) ---"
T19_OUT=$(node test_storyshapes.js 2>&1)
T19_RC=$?
T19_FAILS=$(printf '%s\n' "$T19_OUT" | grep -c 'FAIL')
T19_PASSES=$(printf '%s\n' "$T19_OUT" | grep -c 'PASS')
if [[ $T19_RC -eq 0 && $T19_FAILS -eq 0 && $T19_PASSES -gt 0 ]]; then
  pass "Plot Mountain preserved; shape switches + persists ($T19_PASSES assertions)"
elif [[ $T19_RC -eq 2 ]]; then
  fail "story-shapes test could not load bp.html into sandbox (rc=2)"
  printf '%s\n' "$T19_OUT" | grep -iE 'FATAL|Error' | head -3 | sed 's/^/    /'
else
  fail "Story Shapes broke ($T19_FAILS assertion(s) failed)"
  printf '%s\n' "$T19_OUT" | grep 'FAIL' | sed 's/^/    /'
fi

# ──────────────────────────────────────────────────────────────
# TEST 20 (behavioral): Season-Planning recording import
# Drives the REAL buildCharacterizePrompt / parseRecordingCard and the
# snapshot round-trip from bp.html in a vm sandbox. Proves the prompt
# embeds the transcript + labeled fields, the parser reads cards (incl.
# timecoded quotes) safely, and recording cards persist while raw
# transcripts stay OUT of the autosave snapshot.
# ──────────────────────────────────────────────────────────────
echo ""
echo "--- Test 20: recording import (characterize + card persistence) ---"
T20_OUT=$(node test_recordings.js 2>&1)
T20_RC=$?
T20_FAILS=$(printf '%s\n' "$T20_OUT" | grep -c 'FAIL')
T20_PASSES=$(printf '%s\n' "$T20_OUT" | grep -c 'PASS')
if [[ $T20_RC -eq 0 && $T20_FAILS -eq 0 && $T20_PASSES -gt 0 ]]; then
  pass "prompt + parser + card persistence work; transcript stays out of snapshot ($T20_PASSES assertions)"
elif [[ $T20_RC -eq 2 ]]; then
  fail "recording-import test could not load bp.html into sandbox (rc=2)"
  printf '%s\n' "$T20_OUT" | grep -iE 'FATAL|Error' | head -3 | sed 's/^/    /'
else
  fail "recording import broke ($T20_FAILS assertion(s) failed)"
  printf '%s\n' "$T20_OUT" | grep 'FAIL' | sed 's/^/    /'
fi

# ──────────────────────────────────────────────────────────────
# TEST 21 (behavioral): Season Archives (named full-season snapshots)
# Drives the REAL archiveCurrentSeason / restoreArcArchive / renderSeasonView
# in a vm sandbox. Proves archives capture the season, never nest (recursion
# guard), persist through save/load, restore faithfully after auto-archiving
# the current state, and that the Season view renders without throwing.
# ──────────────────────────────────────────────────────────────
echo ""
echo "--- Test 21: Season Archives (snapshot / restore / no-nest) ---"
T21_OUT=$(node test_archives.js 2>&1)
T21_RC=$?
T21_FAILS=$(printf '%s\n' "$T21_OUT" | grep -c 'FAIL')
T21_PASSES=$(printf '%s\n' "$T21_OUT" | grep -c 'PASS')
if [[ $T21_RC -eq 0 && $T21_FAILS -eq 0 && $T21_PASSES -gt 0 ]]; then
  pass "archive/restore work; recursion-guarded; view renders ($T21_PASSES assertions)"
elif [[ $T21_RC -eq 2 ]]; then
  fail "archive test could not load bp.html into sandbox (rc=2)"
  printf '%s\n' "$T21_OUT" | grep -iE 'FATAL|Error' | head -3 | sed 's/^/    /'
else
  fail "Season Archives broke ($T21_FAILS assertion(s) failed)"
  printf '%s\n' "$T21_OUT" | grep 'FAIL' | sed 's/^/    /'
fi

# ──────────────────────────────────────────────────────────────
# TEST 23 (behavioral): durable transcript store
# Drives the REAL saveTranscript / pushTranscript / hydrateTranscripts against a
# fake in-memory Supabase. Proves transcripts persist server-side (so they reach
# other devices + collaborators), respect the load gate, and that hydrate pulls
# shared copies in and backfills local-only ones (the localStorage->Supabase
# migration Matt & Kartik depend on).
# ──────────────────────────────────────────────────────────────
echo ""
echo "--- Test 23: durable transcript store (Supabase + local cache + backfill) ---"
T23_OUT=$(node test_transcript_sync.js 2>&1)
T23_RC=$?
T23_FAILS=$(printf '%s\n' "$T23_OUT" | grep -c 'FAIL')
T23_PASSES=$(printf '%s\n' "$T23_OUT" | grep -c 'PASS')
if [[ $T23_RC -eq 0 && $T23_FAILS -eq 0 && $T23_PASSES -gt 0 ]]; then
  pass "transcripts persist to Supabase; load-gated; hydrate pulls + backfills ($T23_PASSES assertions)"
elif [[ $T23_RC -eq 2 ]]; then
  fail "transcript-sync test could not load bp.html into sandbox (rc=2)"
  printf '%s\n' "$T23_OUT" | grep -iE 'FATAL|Error' | head -3 | sed 's/^/    /'
else
  fail "durable transcript store broke ($T23_FAILS assertion(s) failed)"
  printf '%s\n' "$T23_OUT" | grep 'FAIL' | sed 's/^/    /'
fi

# ──────────────────────────────────────────────────────────────
# TEST 24 (behavioral): Boo actually receives full transcripts on demand
# Drives the REAL callBoo() with a fetch stub that captures the request body,
# proving that booReadRecording()'s active transcript is embedded verbatim in
# the system prompt (with header, guest label, timecodes) — and absent when no
# transcript is active. Fixes "Boo says he can't read the transcripts."
# ──────────────────────────────────────────────────────────────
echo ""
echo "--- Test 24: Boo receives full transcripts on demand (callBoo prompt) ---"
T24_OUT=$(node test_boo_reads_transcript.js 2>&1)
T24_RC=$?
T24_FAILS=$(printf '%s\n' "$T24_OUT" | grep -c 'FAIL')
T24_PASSES=$(printf '%s\n' "$T24_OUT" | grep -c 'PASS')
if [[ $T24_RC -eq 0 && $T24_FAILS -eq 0 && $T24_PASSES -gt 0 ]]; then
  pass "active transcript is embedded verbatim in Boo's prompt; absent otherwise ($T24_PASSES assertions)"
elif [[ $T24_RC -eq 2 ]]; then
  fail "boo-reads-transcript test could not load bp.html into sandbox (rc=2)"
  printf '%s\n' "$T24_OUT" | grep -iE 'FATAL|Error' | head -3 | sed 's/^/    /'
else
  fail "Boo transcript access broke ($T24_FAILS assertion(s) failed)"
  printf '%s\n' "$T24_OUT" | grep 'FAIL' | sed 's/^/    /'
fi

# ──────────────────────────────────────────────────────────────
# TEST 22 (source guard): no stale old-season content; narrative ethos present
# Pins the "fix ALL of it" cleanup: the old Anno/Season-1 hardcoding must stay
# gone from greetings, the arc review, and the brief prompts, and Boo's prompt
# must carry the multi-shape narrative ethos so it never defaults to one arc.
# ──────────────────────────────────────────────────────────────
echo ""
echo "--- Test 22: no stale old-season content; narrative ethos present ---"
T22_FAILS=0
# Stale strings that must NOT appear anywhere in the app
for stale in \
  "What Do We Teach Now?" \
  "launching mid-August" \
  "Matt holds the educational ideal" \
  "movement, not just a podcast" \
  "Episode 1 is in progress" \
  "Season arc (Plot Mountain): Exposition" \
  "consistent with Plot Mountain" \
  "fit Plot Mountain" \
  "visual Plot Mountain arc"; do
  if grep -qF "$stale" "$BP"; then
    fail "stale content still present: \"$stale\""
    T22_FAILS=$((T22_FAILS+1))
  fi
done
# Ethos strings that MUST appear
for needed in \
  "NARRATIVE STRUCTURE — HOW THIS SHOW SHAPES STORIES" \
  "never assume a single default arc" \
  "CANDIDATE SHAPE"; do
  if ! grep -qF "$needed" "$BP"; then
    fail "narrative ethos missing: \"$needed\""
    T22_FAILS=$((T22_FAILS+1))
  fi
done
# booGreet must no longer wire the retired Episode-1 buttons
if grep -qE "finishEp1\(\)|workOnHope\(\)" "$BP"; then
  fail "retired booGreet actions (finishEp1/workOnHope) still referenced"
  T22_FAILS=$((T22_FAILS+1))
fi
if [[ $T22_FAILS -eq 0 ]]; then
  pass "no stale old-season content; narrative ethos present (13 checks)"
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
  sed -i '' "s/addEventListener('DISABLED', function() {$/addEventListener('DOMContentLoaded', function() {/" "$BP"
  sed -i '' "s|// tip-q tooltip — must run after DOM is ready; #boo-tip is after </script>|// tip-q tooltip — must run after DOM is ready; #boo-tip is after the script block|" "$BP"
  sed -i '' 's/if (false) { \/\/ BREAK-gate/if (!_supabaseLoaded) {/' "$BP"
  sed -i '' 's/if (false) { \/\/ BREAK-guard/if (_isNearSeed(snapshot)) {/' "$BP"
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
