#!/usr/bin/env node
/*
 * test_transcript_sync.js — mechanical test for the DURABLE transcript store.
 *
 * Transcripts used to live only in a browser's localStorage, so they never
 * reached other devices or collaborators (Matt & Kartik). They now persist to
 * the `builder_transcripts` Supabase table, with localStorage + memory as fast
 * caches. This proves, against the REAL functions extracted from bp.html into a
 * vm sandbox wired to a FAKE in-memory Supabase (a programmable fetch):
 *   1. saveTranscript() writes all three layers — memory, localStorage, AND an
 *      upsert POST to builder_transcripts (merge-duplicates, correct body).
 *   2. The load gate holds: pushTranscript() writes NOTHING before _supabaseLoaded.
 *   3. hydrateTranscripts() PULLS a server-only transcript into the fast layers
 *      AND BACKFILLS a local-only transcript up to the server (the migration).
 *   4. loadTranscript() reads the fast layers after hydration.
 *
 * Exit 0 = all pass. Exit 1 = an assertion failed. Exit 2 = sandbox load failure.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BP_PATH = process.env.BP_FILE || path.join(__dirname, 'bp.html');
const tick = () => new Promise((r) => setImmediate(r)); // flush real microtasks/promises

function extractFirstInlineScript(html) {
  const re = /<script\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (/\bsrc\s*=/i.test(m[1] || '')) continue;
    const start = re.lastIndex;
    const end = html.indexOf('</script>', start);
    if (end === -1) throw new Error('no closing </script> after first inline <script>');
    return html.slice(start, end);
  }
  throw new Error('no inline <script> block found in bp.html');
}
function makeFakeElement() {
  const store = { innerHTML: '', value: '', textContent: '', className: '', checked: false, style: {}, dataset: {}, children: [] };
  const handler = {
    get(t, p) {
      if (p === Symbol.toPrimitive || p === 'toString') return () => '[FakeElement]';
      if (p in store) return store[p];
      return new Proxy(function () { return makeFakeElement(); }, handler);
    },
    set(t, p, v) { store[p] = v; return true; },
    apply() { return makeFakeElement(); },
  };
  return new Proxy(function () {}, handler);
}
function makeDocument() {
  return {
    getElementById: () => makeFakeElement(), querySelector: () => makeFakeElement(),
    querySelectorAll: () => [], getElementsByClassName: () => [], getElementsByTagName: () => [],
    createElement: () => makeFakeElement(), createTextNode: () => makeFakeElement(),
    createDocumentFragment: () => makeFakeElement(),
    addEventListener: () => {}, removeEventListener: () => {}, execCommand: () => true,
    body: makeFakeElement(), head: makeFakeElement(), documentElement: makeFakeElement(),
    cookie: '', readyState: 'complete', title: '',
  };
}
function makeLocalStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(String(k)) ? map.get(String(k)) : null),
    setItem: (k, v) => { map.set(String(k), String(v)); },
    removeItem: (k) => { map.delete(String(k)); }, clear: () => map.clear(),
    key: (i) => Array.from(map.keys())[i] ?? null, get length() { return map.size; },
    _map: map,
  };
}

// A programmable fake Supabase for builder_transcripts.
//   server: Map "show|rec" -> transcript.   posts: log of upsert bodies seen.
function makeFakeServer() {
  const server = new Map();
  const posts = [];
  const key = (s, r) => String(s) + '|' + String(r);
  function fetchImpl(url, opts) {
    opts = opts || {};
    const method = (opts.method || 'GET').toUpperCase();
    if (url.indexOf('/builder_transcripts') === -1) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve('') });
    }
    if (method === 'POST') {
      const body = JSON.parse(opts.body || '{}');
      const prefer = (opts.headers && (opts.headers.Prefer || opts.headers.prefer)) || '';
      posts.push({ body, prefer, headers: opts.headers || {} });
      server.set(key(body.show_code, body.recording_id), body.transcript); // upsert (merge-duplicates)
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]), text: () => Promise.resolve('') });
    }
    // GET ?show_code=eq.<code>&select=recording_id,transcript
    const m = /show_code=eq\.([^&]+)/.exec(url);
    const code = m ? decodeURIComponent(m[1]) : '';
    const rows = [];
    for (const [k, v] of server) {
      const [s, r] = k.split('|');
      if (s === code) rows.push({ recording_id: r, transcript: v });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(rows), text: () => Promise.resolve('') });
  }
  return { server, posts, key, fetchImpl };
}

function buildSandbox(scriptSrc, fetchImpl) {
  const localStorage = makeLocalStorage();
  const noop = () => {};
  const fakeWindow = {};
  const sandbox = {
    document: makeDocument(), localStorage, sessionStorage: makeLocalStorage(),
    console: { log: noop, warn: noop, error: noop, info: noop, debug: noop },
    fetch: fetchImpl,
    setTimeout: (fn) => { return 0; }, clearTimeout: noop, setInterval: () => 0, clearInterval: noop,
    requestAnimationFrame: () => 0, cancelAnimationFrame: noop,
    queueMicrotask: (fn) => { try { fn(); } catch (e) {} },
    alert: noop, confirm: () => true, prompt: () => null,
    navigator: { userAgent: 'node-test', onLine: true },
    location: { href: 'http://localhost/bp.html', hostname: 'localhost', search: '', hash: '', reload: noop },
    history: { pushState: noop, replaceState: noop },
    crypto: (typeof globalThis.crypto !== 'undefined') ? globalThis.crypto : { getRandomValues: (a) => a, randomUUID: () => '0' },
    Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error, Map, Set, Promise, Symbol, Reflect, Proxy,
    parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
  };
  sandbox.window = fakeWindow; sandbox.self = fakeWindow; sandbox.globalThis = sandbox;
  fakeWindow.localStorage = localStorage; fakeWindow.location = sandbox.location;
  fakeWindow.navigator = sandbox.navigator; fakeWindow.document = sandbox.document;
  fakeWindow.fetch = fetchImpl; fakeWindow.addEventListener = noop;
  const context = vm.createContext(sandbox);
  const epilogue = `
;(function(){
  try { globalThis.__save = saveTranscript; } catch(e){ globalThis.__e1 = String(e); }
  try { globalThis.__load = loadTranscript; } catch(e){ globalThis.__e2 = String(e); }
  try { globalThis.__push = pushTranscript; } catch(e){ globalThis.__e3 = String(e); }
  try { globalThis.__hydrate = hydrateTranscripts; } catch(e){ globalThis.__e4 = String(e); }
  try { globalThis.__state = state; } catch(e){ globalThis.__e5 = String(e); }
  try { globalThis.__setLoaded = function(v){ _supabaseLoaded = v; }; } catch(e){ globalThis.__e6 = String(e); }
  try { globalThis.__setShow = function(v){ currentShowCode = v; }; } catch(e){ globalThis.__e7 = String(e); }
  try { globalThis.__txKey = _transcriptKey; } catch(e){ globalThis.__e8 = String(e); }
})();
`;
  vm.runInContext(scriptSrc + '\n' + epilogue, context, { filename: 'bp.html#inline-script', timeout: 20000 });
  return sandbox;
}

let PASS = 0, FAIL = 0;
function ok(cond, name) { if (cond) { console.log('PASS: ' + name); PASS++; } else { console.log('FAIL: ' + name); FAIL++; } }

async function main() {
  const { server, posts, key, fetchImpl } = makeFakeServer();
  let sb;
  try {
    sb = buildSandbox(extractFirstInlineScript(fs.readFileSync(BP_PATH, 'utf8')), fetchImpl);
  } catch (e) {
    console.error('FATAL: sandbox load failed:\n' + (e && e.stack || e));
    process.exit(2);
  }
  const errs = ['__e1', '__e2', '__e3', '__e4', '__e5', '__e6', '__e7', '__e8'].filter((k) => sb[k]);
  if (errs.length || typeof sb.__save !== 'function' || typeof sb.__hydrate !== 'function') {
    console.error('FATAL: could not expose transcript internals: ' + errs.map((k) => k + '=' + sb[k]).join('; '));
    process.exit(2);
  }
  const save = sb.__save, load = sb.__load, push = sb.__push, hydrate = sb.__hydrate;
  const state = sb.__state, ls = sb.localStorage, txKey = sb.__txKey;
  sb.__setShow('k12boss');

  // ── 2. Load gate: NO write before _supabaseLoaded ─────────────────────────
  sb.__setLoaded(false);
  posts.length = 0;
  push('gated', 'should-not-persist'); await tick();
  ok(posts.length === 0, 'load gate: pushTranscript writes nothing before _supabaseLoaded');
  ok(!server.has(key('k12boss', 'gated')), 'load gate: server has no row for the pre-load write');

  // ── 1. saveTranscript writes all three layers ─────────────────────────────
  sb.__setLoaded(true);
  posts.length = 0;
  save('id1', 'TXT1'); await tick();
  ok(load('id1') === 'TXT1', 'saveTranscript: memory/local read-back via loadTranscript');
  ok(ls.getItem(txKey('id1')) === 'TXT1', 'saveTranscript: localStorage cache written');
  ok(server.get(key('k12boss', 'id1')) === 'TXT1', 'saveTranscript: upserted to Supabase');
  ok(posts.length === 1 && /merge-duplicates/.test(posts[0].prefer), 'saveTranscript: upsert uses resolution=merge-duplicates');
  ok(posts[0].body.show_code === 'k12boss' && posts[0].body.recording_id === 'id1' && posts[0].body.transcript === 'TXT1',
     'saveTranscript: upsert body carries show_code + recording_id + transcript');

  // upsert twice on same id → still one server row, latest value (merge, not dup)
  save('id1', 'TXT1-v2'); await tick();
  ok(server.get(key('k12boss', 'id1')) === 'TXT1-v2', 'saveTranscript: re-save merges (latest value, no duplicate)');

  // ── 3. hydrateTranscripts: pull server-only + backfill local-only ─────────
  // Set up: id_server exists only on the server; id_local exists only locally.
  server.set(key('k12boss', 'id_server'), 'FROMSERVER');
  ls.setItem(txKey('id_local'), 'LOCALONLY');            // local cache only
  state.recordings = [{ id: 'id_server' }, { id: 'id_local' }];
  posts.length = 0;
  await hydrate();
  ok(load('id_server') === 'FROMSERVER', 'hydrate: server-only transcript pulled into fast layers');
  ok(ls.getItem(txKey('id_server')) === 'FROMSERVER', 'hydrate: pulled transcript cached to localStorage');
  ok(server.get(key('k12boss', 'id_local')) === 'LOCALONLY', 'hydrate: local-only transcript BACKFILLED to server (migration)');
  const backfilled = posts.filter((p) => p.body.recording_id === 'id_local');
  ok(backfilled.length === 1, 'hydrate: backfill upserts each local-only transcript exactly once');
  const repushedServer = posts.filter((p) => p.body.recording_id === 'id_server');
  ok(repushedServer.length === 0, 'hydrate: does NOT re-push transcripts already on the server');

  // ── isolation: localStorage cache keys are namespaced per show_code ───────
  // (The in-memory layer is per-session and not show-keyed — fine, since a page
  //  session only ever runs one show code; localStorage + the server query are
  //  what keep shows isolated across sessions/devices.)
  sb.__setShow('othershow');
  ok(ls.getItem(txKey('id1')) == null, 'show scoping: localStorage cache keys are namespaced per show_code');

  console.log('\n' + PASS + ' passed, ' + FAIL + ' failed');
  process.exit(FAIL === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL: ' + (e && e.stack || e)); process.exit(2); });
