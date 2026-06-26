#!/usr/bin/env node
/*
 * test_protocol.js — proves the Data Mutation Protocol on bp.html.
 *
 * Executes the REAL generateSeasonBrief / clearGuestRepo / onUserConfirmation /
 * autoSave from bp.html in a vm sandbox with a STATEFUL fake Supabase (PATCH
 * updates the server; GET reads it back, so verify read-backs are real).
 *
 * Proves:
 *   DESTRUCTIVE (Regenerate Season Brief):
 *     - backup is created BEFORE anything changes
 *     - the brief is NOT overwritten while awaiting confirmation (gated)
 *     - typing "proceed" (onUserConfirmation(true)) applies + verifies via read-back
 *     - cancelling leaves the original brief untouched
 *   SILENT (autoSave): backup + verify-after-write happen with no confirmation gate.
 *
 * Exit 0 = all protocol assertions pass.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BP_PATH = process.env.BP_FILE || path.join(__dirname, 'bp.html');
const ORIGINAL = 'ORIGINAL_SEASON_BRIEF_accumulated_work_do_not_lose';
const NEWBRIEF = 'NEWLY_GENERATED_BRIEF_from_regenerate';

function extractFirstInlineScript(html) {
  const re = /<script\b([^>]*)>/gi; let m;
  while ((m = re.exec(html)) !== null) {
    if (/\bsrc\s*=/i.test(m[1] || '')) continue;
    const start = re.lastIndex, end = html.indexOf('</script>', start);
    if (end === -1) throw new Error('no closing </script>');
    return html.slice(start, end);
  }
  throw new Error('no inline <script> found');
}
function makeFakeElement() {
  const store = { innerHTML: '', value: '', textContent: '', className: '', checked: false, style: {}, dataset: {}, children: [], scrollTop: 0, scrollHeight: 0 };
  const handler = {
    get(t, p) { if (p === Symbol.toPrimitive || p === 'toString') return () => '[FakeElement]'; if (p in store) return store[p]; return new Proxy(function () {}, handler); },
    set(t, p, v) { store[p] = v; return true; }, apply() { return makeFakeElement(); },
  };
  return new Proxy(function () {}, handler);
}
function makeDocument() {
  return { getElementById: () => makeFakeElement(), querySelector: () => makeFakeElement(), querySelectorAll: () => [], getElementsByClassName: () => [], getElementsByTagName: () => [], createElement: () => makeFakeElement(), createElementNS: () => makeFakeElement(), createTextNode: () => makeFakeElement(), createDocumentFragment: () => makeFakeElement(), addEventListener: () => {}, removeEventListener: () => {}, execCommand: () => true, body: makeFakeElement(), head: makeFakeElement(), documentElement: makeFakeElement(), cookie: '', readyState: 'complete', title: '' };
}
function makeLocalStorage() {
  const map = new Map();
  return { getItem: (k) => (map.has(String(k)) ? map.get(String(k)) : null), setItem: (k, v) => { map.set(String(k), String(v)); }, removeItem: (k) => { map.delete(String(k)); }, clear: () => map.clear(), key: (i) => Array.from(map.keys())[i] ?? null, get length() { return map.size; } };
}

// Stateful fake Supabase: PATCH writes server.data, GET reads it back.
const server = { data: null, history: [] };
function fetchImpl(url, opts) {
  const u = String(url); const method = (opts && opts.method) || 'GET';
  if (/claude-proxy/.test(u)) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ content: [{ text: NEWBRIEF }] }) });
  if (/builder_state/.test(u)) {
    if (method === 'PATCH') { try { const b = JSON.parse(opts.body); server.data = b.data; if (b.history) server.history = b.history; } catch (e) {} return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) }); }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([{ data: server.data, history: server.history }]) });
  }
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
}

function buildSandbox(scriptSrc) {
  const localStorage = makeLocalStorage(); const noop = () => {}; const win = {};
  const sandbox = {
    document: makeDocument(), localStorage, sessionStorage: makeLocalStorage(),
    console: { log: noop, warn: noop, error: noop, info: noop, debug: noop },
    fetch: function () { return fetchImpl.apply(null, arguments); },
    setTimeout: (fn) => { try { fn(); } catch (e) {} return 0; }, clearTimeout: noop, setInterval: () => 0, clearInterval: noop,
    requestAnimationFrame: () => 0, cancelAnimationFrame: noop, queueMicrotask: (fn) => { try { fn(); } catch (e) {} },
    alert: noop, confirm: () => true, prompt: () => null,
    atob: (s) => Buffer.from(String(s), 'base64').toString('binary'), btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
    URL: { createObjectURL: () => 'blob:stub', revokeObjectURL: noop }, Blob: function () {}, FileReader: function () {},
    navigator: { userAgent: 'node', clipboard: { writeText: () => Promise.resolve() }, onLine: true },
    location: { href: 'http://localhost/bp.html', hostname: 'localhost', search: '', hash: '', reload: noop }, history: { pushState: noop, replaceState: noop },
    crypto: (typeof globalThis.crypto !== 'undefined') ? globalThis.crypto : { getRandomValues: (a) => a, randomUUID: () => '0' },
    Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error, Map, Set, Promise, Symbol, Reflect, Proxy, parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
  };
  sandbox.window = win; sandbox.self = win; sandbox.globalThis = sandbox;
  win.localStorage = localStorage; win.location = sandbox.location; win.document = sandbox.document; win.fetch = sandbox.fetch; win.setTimeout = sandbox.setTimeout; win.addEventListener = noop;
  const context = vm.createContext(sandbox);
  const epilogue = `
;(function(){
  try { globalThis.__P = dataMutationProtocol; } catch(e){}
  try { globalThis.__confirm = onUserConfirmation; } catch(e){}
  try { globalThis.__gen = generateSeasonBrief; } catch(e){}
  try { globalThis.__autoSave = autoSave; } catch(e){}
  try { globalThis.__state = state; } catch(e){}
  try { globalThis.__snap = buildSessionSnapshot; } catch(e){}
  try { globalThis.__setLoaded = function(v){ _supabaseLoaded = v; }; } catch(e){}
})();`;
  vm.runInContext(scriptSrc + '\n' + epilogue, context, { filename: 'bp.html#inline', timeout: 20000 });
  return sandbox;
}

const flush = () => new Promise((r) => setImmediate(r));
const results = [];
function check(name, cond) { results.push([name, !!cond]); }

async function main() {
  const html = fs.readFileSync(BP_PATH, 'utf8');
  const sb = buildSandbox(extractFirstInlineScript(html));
  const P = sb.__P, confirm = sb.__confirm, gen = sb.__gen, autoSave = sb.__autoSave, state = sb.__state;
  if (typeof gen !== 'function' || !P || typeof confirm !== 'function') { console.error('FATAL: protocol internals not exposed'); process.exit(2); }
  // Post-load precondition: autoSave only fires after loadFromSupabase() completes
  // (load gate added 2026-06-26). This test exercises post-load behavior.
  if (typeof sb.__setLoaded === 'function') sb.__setLoaded(true);

  // Seed: a real accumulated brief exists, and the fake server already holds it.
  if (!state.seasons[0]) state.seasons[0] = { number: 1 };
  state.seasons[0].seasonBrief = ORIGINAL;
  server.data = JSON.parse(JSON.stringify(sb.__snap()));

  // ── DESTRUCTIVE: Regenerate, then CONFIRM ──────────────────────────────────
  const p1 = gen();              // kicks off: fetch new brief -> backup -> showDiff(await)
  await flush(); await flush();  // advance to the confirmation await
  check('1. backup created before any change', !!sb.localStorage.getItem('boo_protocol_backup'));
  check('2. operation is GATED (brief NOT overwritten pre-confirm)', state.seasons[0].seasonBrief === ORIGINAL);
  check('3. protocol reports a pending confirmation', P.hasPending());
  // backup contains the ORIGINAL value (recoverable)
  let bk = {}; try { bk = JSON.parse(sb.localStorage.getItem('boo_protocol_backup')); } catch (e) {}
  check('4. backup captured the ORIGINAL brief', bk.currentValue === ORIGINAL);

  confirm(true);                 // user types "proceed"
  await p1;                      // apply + verify run
  check('5. after proceed, brief is applied (NEW value in state)', state.seasons[0].seasonBrief === NEWBRIEF);
  check('6. verify read-back: server actually holds the NEW brief',
    server.data && server.data.state && server.data.state.seasons && server.data.state.seasons[0] && server.data.state.seasons[0].seasonBrief === NEWBRIEF);

  // ── DESTRUCTIVE: Regenerate, then CANCEL ───────────────────────────────────
  state.seasons[0].seasonBrief = ORIGINAL;          // pretend we're back to the good brief
  server.data = JSON.parse(JSON.stringify(sb.__snap()));
  const p2 = gen();
  await flush(); await flush();
  check('7. second regenerate is gated again', P.hasPending() && state.seasons[0].seasonBrief === ORIGINAL);
  confirm(false);                // user types anything else -> cancel
  await p2;
  check('8. after cancel, ORIGINAL brief is untouched', state.seasons[0].seasonBrief === ORIGINAL);

  // ── SILENT: autoSave backs up + verifies with no gate ──────────────────────
  sb.localStorage.removeItem('boo_protocol_backup');
  autoSave('routine-keystroke', true);
  await flush();
  check('9. autoSave is NOT gated (no pending confirmation)', !P.hasPending());
  check('10. autoSave wrote the session to localStorage', !!sb.localStorage.getItem('boo_autosave'));
  check('11. autoSave created a silent protocol backup', !!sb.localStorage.getItem('boo_protocol_backup'));

  // ── report ─────────────────────────────────────────────────────────────────
  const pad = (s, n) => (String(s) + ' '.repeat(n)).slice(0, n);
  console.log('');
  console.log('  ' + pad('DATA MUTATION PROTOCOL ASSERTION', 62) + 'RESULT');
  console.log('  ' + '-'.repeat(68));
  let fails = 0;
  results.forEach(([n, ok]) => { if (!ok) fails++; console.log('  ' + pad(n, 62) + (ok ? 'PASS' : 'FAIL')); });
  console.log('  ' + '-'.repeat(68));
  if (fails === 0) { console.log('  ALL ' + results.length + ' PROTOCOL ASSERTIONS PASS (destructive gated, autoSave silent).'); process.exit(0); }
  console.log('  ' + fails + ' of ' + results.length + ' PROTOCOL ASSERTIONS FAILED.'); process.exit(1);
}
main().catch((e) => { console.error('FATAL: ' + (e && e.stack || e)); process.exit(2); });
