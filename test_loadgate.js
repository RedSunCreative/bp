#!/usr/bin/env node
/*
 * test_loadgate.js — proves the load gate + Supabase-reading anti-shrink guard
 * added to autoSave() in bp.html (incident 2026-06-26 fix).
 *
 * Executes the REAL autoSave / buildSessionSnapshot from bp.html in a vm sandbox
 * with a STATEFUL fake Supabase (PATCH records a write + updates server.data;
 * GET reads it back, so the guard's live-row read is real).
 *
 * Assertions:
 *   A1 (LOAD GATE):    while _supabaseLoaded === false, autoSave performs NO PATCH.
 *   A2 (ANTI-SHRINK):  with _supabaseLoaded === true, a near-seed snapshot is BLOCKED
 *                      (no PATCH) when the LIVE row holds real content.
 *   A3 (ALLOW):        with _supabaseLoaded === true, a near-seed snapshot IS written
 *                      when the live row is empty (legit first save).
 *
 * Exit 0 = all pass. Exit 1 = an assertion failed. Exit 2 = sandbox load failed.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BP_PATH = process.env.BP_FILE || path.join(__dirname, 'bp.html');

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

// Stateful fake Supabase. PATCH records a write + updates server.data; GET reads it back.
const server = { data: null, history: [], patches: 0 };
function fetchImpl(url, opts) {
  const u = String(url); const method = (opts && opts.method) || 'GET';
  if (/claude-proxy/.test(u)) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ content: [{ text: '' }] }) });
  if (/builder_state/.test(u)) {
    if (method === 'PATCH') { server.patches++; try { const b = JSON.parse(opts.body); server.data = b.data; if (b.history) server.history = b.history; } catch (e) {} return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) }); }
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
  // Epilogue runs in the SAME lexical scope as the script, so it can read/assign
  // the top-level `let` flags (_supabaseLoaded, _lastSavedSnap).
  const epilogue = `
;(function(){
  try { globalThis.__autoSave = autoSave; } catch(e){}
  try { globalThis.__state = state; } catch(e){}
  try { globalThis.__snap = buildSessionSnapshot; } catch(e){}
  try { globalThis.__setLoaded   = function(v){ _supabaseLoaded = v; }; } catch(e){}
  try { globalThis.__getLoaded   = function(){ return _supabaseLoaded; }; } catch(e){}
  try { globalThis.__setLastSnap = function(v){ _lastSavedSnap = v; }; } catch(e){}
})();`;
  vm.runInContext(scriptSrc + '\n' + epilogue, context, { filename: 'bp.html#inline', timeout: 20000 });
  return sandbox;
}

const flush = () => new Promise((r) => setImmediate(r));
async function settle() { for (let i = 0; i < 12; i++) await flush(); }
const results = [];
function check(name, cond) { results.push([name, !!cond]); }

// Force the live `state` into a near-seed shape (1 episode, no brief, no guests).
function makeSeed(state) {
  state.seasons = [{ number: 1, episodes: [{ number: 1, title: '', guest: null }], seasonBrief: '' }];
  state.currentSeason = state.seasons[0];
  state.currentEpisode = state.seasons[0].episodes[0];
  state.guestRepo = [];
}
// A full payload as the LIVE row would hold it (real content).
function fullRow() {
  return { state: { seasons: [{ number: 1, seasonBrief: 'X'.repeat(2000), episodes: [{ number: 1 }, { number: 2 }] }] }, guestRepo: [{ name: 'Kip' }] };
}
// Force the live `state` into a REAL-content shape (so anti-shrink would NOT block).
// Used to isolate the LOAD GATE: only the gate can stop this write.
function makeFull(state) {
  state.seasons = [{ number: 1, seasonBrief: 'X'.repeat(2000), episodes: [{ number: 1 }, { number: 2 }], }];
  state.currentSeason = state.seasons[0];
  state.currentEpisode = state.seasons[0].episodes[0];
  state.guestRepo = [{ name: 'Kip' }];
}

async function main() {
  const html = fs.readFileSync(BP_PATH, 'utf8');
  const sb = buildSandbox(extractFirstInlineScript(html));
  const autoSave = sb.__autoSave, state = sb.__state;
  if (typeof autoSave !== 'function' || !state || typeof sb.__setLoaded !== 'function') {
    console.error('FATAL: autoSave/state/_supabaseLoaded not exposed — fix not present?'); process.exit(2);
  }

  // ── A1: LOAD GATE — no write before load completes ──────────────────────────
  // Use REAL-content state so the anti-shrink guard would NOT block — this isolates
  // the gate as the ONLY thing preventing the write (so break-test flips A1, not A2).
  sb.__setLastSnap(null);
  sb.__setLoaded(false);                 // simulate: loadFromSupabase has NOT finished
  makeFull(state);
  server.data = null;                    // empty row — only the gate stops the write
  server.patches = 0;
  autoSave('click-during-load', true);
  await settle();
  check('A1. LOAD GATE: no PATCH while _supabaseLoaded === false', server.patches === 0);

  // ── A2: ANTI-SHRINK — near-seed blocked when live row has real content ───────
  sb.__setLastSnap(null);
  sb.__setLoaded(true);                   // load complete
  makeSeed(state);
  server.data = fullRow();                // live row 98 holds full Season data
  server.patches = 0;
  autoSave('seed-over-real-data', true);
  await settle();
  check('A2. ANTI-SHRINK: near-seed write BLOCKED when live row holds content', server.patches === 0);

  // ── A3: ALLOW — near-seed write proceeds when the live row is empty ──────────
  sb.__setLastSnap(null);
  sb.__setLoaded(true);
  makeSeed(state);
  server.data = null;                     // live row is empty (legit first save)
  server.patches = 0;
  autoSave('first-save-empty-row', true);
  await settle();
  check('A3. ALLOW: near-seed write proceeds when live row is empty', server.patches === 1);

  // ── report ──────────────────────────────────────────────────────────────────
  const pad = (s, n) => (String(s) + ' '.repeat(n)).slice(0, n);
  console.log('');
  console.log('  ' + pad('LOAD-GATE / ANTI-SHRINK ASSERTION', 62) + 'RESULT');
  console.log('  ' + '-'.repeat(68));
  let fails = 0;
  results.forEach(([n, ok]) => { if (!ok) fails++; console.log('  ' + pad(n, 62) + (ok ? 'PASS' : 'FAIL')); });
  console.log('  ' + '-'.repeat(68));
  if (fails === 0) { console.log('  ALL ' + results.length + ' LOAD-GATE ASSERTIONS PASS.'); process.exit(0); }
  console.log('  ' + fails + ' of ' + results.length + ' LOAD-GATE ASSERTIONS FAILED.'); process.exit(1);
}
main().catch((e) => { console.error('FATAL: ' + (e && e.stack || e)); process.exit(2); });
