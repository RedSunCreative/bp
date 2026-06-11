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
  # Inject direct Anthropic call (simulates reverting to browser API key)
  sed -i '' 's/const PROXY    = /const _PROXY_DISABLED = /' "$BP"
  echo "  Injected: disabled PROXY constant"
  # Inject API_KEY guard back into sendMessage (simulates guard not removed)
  sed -i '' 's/if (!text) return;/if (!text || !API_KEY) return;/' "$BP"
  echo "  Injected: restored !API_KEY guard in sendMessage"
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
# BREAK-TEST CLEANUP
# ──────────────────────────────────────────────────────────────
if [[ "$BREAK_MODE" == "--break" ]]; then
  sed -i '' 's/const _PROXY_DISABLED = /const PROXY    = /' "$BP"
  sed -i '' 's/if (!text || !API_KEY) return;/if (!text) return;/' "$BP"
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
