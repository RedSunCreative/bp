#!/usr/bin/env node
/*
 * test_persistence_e2e.js — END-TO-END persistence test for bp.html
 *
 * The round-trip test (test_persistence.js) proves buildSessionSnapshot ->
 * applySession preserves every field. This test proves the ACTUAL runtime path
 * that has historically lost user data (especially chat):
 *
 *   1. autoSave() actually fires and serializes the chat into localStorage.
 *   2. loadFromSupabase() restores it when Supabase is EMPTY (localStorage fallback).
 *   3. loadFromSupabase() prefers the NEWER localStorage copy over a STALE Supabase
 *      row (the "load newest wins" logic) — this is the bug that made chat vanish.
 *   4. loadFromSupabase() prefers Supabase when IT is newer.
 *
 * It executes the REAL autoSave / loadFromSupabase / buildSessionSnapshot /
 * applySession from bp.html inside a vm sandbox. The only behavioral change vs.
 * the round-trip harness: setTimeout runs its callback synchronously (so the
 * debounced autoSave actually fires) and fetch is controllable per-scenario.
 *
 * Exit 0 = all scenarios pass. Non-zero = a real persistence bug.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BP_PATH = process.env.BP_FILE || path.join(__dirname, 'bp.html');
const CHAT = 'E2E_CHAT_SENTINEL';

function extractFirstInlineScript(html) {
  const re = /<script\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (/\bsrc\s*=/i.test(m[1] || '')) continue;
    const start = re.lastIndex;
    const end = html.indexOf('</script>', start);
    if (end === -1) throw new Error('no closing </script>');
    return html.slice(start, end);
  }
  throw new Error('no inline <script> block found');
}

function makeFakeElement() {
  const store = { innerHTML: '', value: '', textContent: '', className: '', checked: false, style: {}, dataset: {}, children: [], scrollTop: 0, scrollHeight: 0 };
  const handler = {
    get(t, p) {
      if (p === Symbol.toPrimitive || p === 'toString') return () => '[FakeElement]';
      if (p in store) return store[p];
      return new Proxy(function () {}, handler);
    },
    set(t, p, v) { store[p] = v; return true; },
    apply() { return makeFakeElement(); },
  };
  return new Proxy(function () {}, handler);
}

function makeDocument() {
  return {
    getElementById: () => makeFakeElement(),
    querySelector: () => makeFakeElement(),
    querySelectorAll: () => [],
    getElementsByClassName: () => [],
    getElementsByTagName: () => [],
    createElement: () => makeFakeElement(),
    createElementNS: () => makeFakeElement(),
    createTextNode: () => makeFakeElement(),
    createDocumentFragment: () => makeFakeElement(),
    addEventListener: () => {}, removeEventListener: () => {},
    execCommand: () => true,
    body: makeFakeElement(), head: makeFakeElement(), documentElement: makeFakeElement(),
    cookie: '', readyState: 'complete', title: '',
  };
}

function makeLocalStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(String(k)) ? map.get(String(k)) : null),
    setItem: (k, v) => { map.set(String(k), String(v)); },
    removeItem: (k) => { map.delete(String(k)); },
    clear: () => map.clear(),
    key: (i) => Array.from(map.keys())[i] ?? null,
    get length() { return map.size; },
  };
}

function buildSandboxAndLoad(scriptSrc) {
  const localStorage = makeLocalStorage();
  const noop = () => {};
  const fakeWindow = {};

  const sandbox = {
    document: makeDocument(),
    localStorage,
    sessionStorage: makeLocalStorage(),
    console: { log: noop, warn: noop, error: noop, info: noop, debug: noop },
    // fetch delegates to a swappable impl the test controls per-scenario.
    __fetchImpl: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]), text: () => Promise.resolve('') }),
    fetch: function () { return sandbox.__fetchImpl.apply(null, arguments); },
    // KEY DIFFERENCE: run the timer callback synchronously so the REAL debounced
    // autoSave actually executes (its localStorage write happens before any await).
    setTimeout: (fn) => { try { fn(); } catch (e) {} return 0; },
    clearTimeout: noop,
    setInterval: () => 0,
    clearInterval: noop,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: noop,
    queueMicrotask: (fn) => { try { fn(); } catch (e) {} },
    alert: noop, confirm: () => true, prompt: () => null,
    atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
    btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
    URL: { createObjectURL: () => 'blob:stub', revokeObjectURL: noop },
    Blob: function Blob() {}, FileReader: function FileReader() {},
    navigator: { userAgent: 'node-test', clipboard: { writeText: () => Promise.resolve() }, onLine: true },
    location: { href: 'http://localhost/bp.html', hostname: 'localhost', search: '', hash: '', reload: noop, replace: noop, assign: noop },
    history: { pushState: noop, replaceState: noop },
    crypto: (typeof globalThis.crypto !== 'undefined') ? globalThis.crypto : { getRandomValues: (a) => a, randomUUID: () => '00000000-0000-0000-0000-000000000000' },
    Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error, Map, Set, Promise, Symbol, Reflect, Proxy, parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
  };
  sandbox.window = fakeWindow;
  sandbox.self = fakeWindow;
  sandbox.globalThis = sandbox;
  fakeWindow.localStorage = localStorage;
  fakeWindow.location = sandbox.location;
  fakeWindow.navigator = sandbox.navigator;
  fakeWindow.document = sandbox.document;
  fakeWindow.fetch = sandbox.fetch;
  fakeWindow.setTimeout = sandbox.setTimeout;
  fakeWindow.addEventListener = noop;

  const context = vm.createContext(sandbox);

  const epilogue = `
;(function(){
  try { globalThis.__SNAP__   = buildSessionSnapshot; } catch(e) {}
  try { globalThis.__APPLY__  = applySession;        } catch(e) {}
  try { globalThis.__AUTOSAVE__ = autoSave;          } catch(e) {}
  try { globalThis.__LOAD__   = loadFromSupabase;    } catch(e) {}
  try { globalThis.__state    = state;               } catch(e) {}
  try { globalThis.__episodeStore = episodeStore;    } catch(e) {}
  try { globalThis.__activeEp  = activeEp;            } catch(e) {}
  try { globalThis.__setLoaded = function(v){ _supabaseLoaded = v; }; } catch(e) {}
})();
`;
  vm.runInContext(scriptSrc + '\n' + epilogue, context, { filename: 'bp.html#inline', timeout: 20000 });
  return sandbox;
}

// ── helpers ──────────────────────────────────────────────────────────────────
function setChat(sb, text) {
  const ep = sb.__activeEp ? sb.__activeEp() : sb.__episodeStore[1];
  ep.conversationLog = [{ role: 'boo', text, rawText: text, html: text }];
}
function chatPresent(sb, text) {
  const ep = sb.__activeEp ? sb.__activeEp() : sb.__episodeStore[1];
  const log = (ep && ep.conversationLog) || [];
  return JSON.stringify(log).indexOf(text) !== -1;
}
function wipeChat(sb) {
  const ep = sb.__activeEp ? sb.__activeEp() : sb.__episodeStore[1];
  if (ep) ep.conversationLog = [];
  // also clear all episodeStore buckets so restore must repopulate
  Object.keys(sb.__episodeStore).forEach((k) => { sb.__episodeStore[k].conversationLog = []; });
}
// Build a snapshot object carrying a specific chat sentinel + savedAt, without
// disturbing the live state we use for the rest of the test.
function snapshotWith(sb, chatText, savedAtISO) {
  const ep = sb.__activeEp ? sb.__activeEp() : sb.__episodeStore[1];
  const saved = ep.conversationLog;
  ep.conversationLog = [{ role: 'boo', text: chatText, rawText: chatText, html: chatText }];
  const snap = JSON.parse(JSON.stringify(sb.__SNAP__()));
  ep.conversationLog = saved; // restore live
  snap.savedAt = savedAtISO;
  return snap;
}

const results = [];
function check(name, cond) { results.push([name, !!cond]); }

async function main() {
  const html = fs.readFileSync(BP_PATH, 'utf8');
  const scriptSrc = extractFirstInlineScript(html);

  let sb;
  try { sb = buildSandboxAndLoad(scriptSrc); }
  catch (e) { console.error('FATAL: sandbox load failed:\n' + (e && e.stack || e)); process.exit(2); }

  const autoSave = sb.__AUTOSAVE__;
  const loadFromSupabase = sb.__LOAD__;
  if (typeof autoSave !== 'function' || typeof loadFromSupabase !== 'function') {
    console.error('FATAL: autoSave/loadFromSupabase not exposed (autoSave=' + typeof autoSave + ', loadFromSupabase=' + typeof loadFromSupabase + ')');
    process.exit(2);
  }
  // Post-load precondition: in production autoSave only ever fires AFTER
  // loadFromSupabase() completes (the load gate added 2026-06-26). These scenarios
  // exercise that post-load behavior, so open the gate.
  if (typeof sb.__setLoaded === 'function') sb.__setLoaded(true);

  // ── Scenario 1: autoSave serializes chat into localStorage ─────────────────
  setChat(sb, CHAT);
  autoSave('e2e', true); // setTimeout runs synchronously -> localStorage written
  const localRaw = sb.localStorage.getItem('boo_autosave');
  check('autoSave writes a localStorage snapshot', !!localRaw);
  check('autoSave snapshot CONTAINS the chat message', !!localRaw && localRaw.indexOf(CHAT) !== -1);

  // ── Scenario 2: Supabase EMPTY -> localStorage fallback restores chat ──────
  // localStorage currently holds the snapshot from scenario 1 (with CHAT).
  sb.__fetchImpl = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]), text: () => Promise.resolve('') });
  wipeChat(sb);
  await loadFromSupabase();
  check('Supabase empty -> chat restored from localStorage', chatPresent(sb, CHAT));

  // ── Scenario 3: Supabase STALE, localStorage NEWER -> newer local wins ─────
  // Make a stale Supabase row (old savedAt, DIFFERENT chat) and ensure local is newer.
  const STALE = 'E2E_STALE_SUPABASE';
  const staleSnap = snapshotWith(sb, STALE, '2000-01-01T00:00:00.000Z');
  // Refresh localStorage to "now" with the real CHAT via a fresh autoSave.
  setChat(sb, CHAT);
  autoSave('e2e-newer', true); // writes localStorage with savedAt = now
  sb.__fetchImpl = (url) => {
    const u = String(url);
    if (/builder_state/.test(u) && /GET|select/.test(u) || /select=/.test(u)) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([{ data: staleSnap, history: [] }]), text: () => Promise.resolve('') });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve('') });
  };
  wipeChat(sb);
  await loadFromSupabase();
  check('Stale Supabase + newer local -> NEWER local chat wins', chatPresent(sb, CHAT));
  check('Stale Supabase + newer local -> stale chat NOT loaded', !chatPresent(sb, STALE));

  // ── Scenario 4: Supabase NEWER -> Supabase wins ────────────────────────────
  const FRESH = 'E2E_FRESH_SUPABASE';
  const future = new Date(Date.now() + 3600 * 1000).toISOString();
  const freshSnap = snapshotWith(sb, FRESH, future);
  // local currently has CHAT at "now" (older than future)
  sb.__fetchImpl = (url) => {
    const u = String(url);
    if (/builder_state/.test(u)) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([{ data: freshSnap, history: [] }]), text: () => Promise.resolve('') });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve('') });
  };
  wipeChat(sb);
  await loadFromSupabase();
  check('Newer Supabase -> Supabase chat wins', chatPresent(sb, FRESH));

  // ── Scenario 5: season brief guard — empty brief must NOT clobber a good one ─
  // Reproduces the reported loss: a real brief exists, then a snapshot is built
  // while the in-memory brief is empty. The guard must preserve the saved brief.
  const BRIEF = 'E2E_SEASON_BRIEF_ACCUMULATED';
  const flush = () => new Promise((r) => setImmediate(r)); // drain async autoSave continuation
  // 1) Establish a known-good saved brief: put it in state, autoSave (sets _lastSavedSnap).
  if (!sb.__state.seasons[0]) sb.__state.seasons[0] = { number: 1 };
  sb.__state.seasons[0].seasonBrief = BRIEF;
  autoSave('seed-brief', true);
  await flush(); // let autoSave's async body run to `_lastSavedSnap = snapshot`
  // 2) Now the in-memory brief gets emptied (simulating the bug path).
  sb.__state.seasons[0].seasonBrief = '';
  // 3) Build a snapshot — the guard should refuse to persist the empty brief.
  const guardedSnap = sb.__SNAP__();
  const guardedBrief = guardedSnap && guardedSnap.state && guardedSnap.state.seasons && guardedSnap.state.seasons[0] && guardedSnap.state.seasons[0].seasonBrief;
  check('Empty brief does NOT overwrite a saved brief (guard holds)', guardedBrief === BRIEF);
  check('Guard also restores brief into live state', sb.__state.seasons[0].seasonBrief === BRIEF);

  // ── Report ─────────────────────────────────────────────────────────────────
  const pad = (s, n) => (String(s) + ' '.repeat(n)).slice(0, n);
  console.log('');
  console.log('  ' + pad('END-TO-END PERSISTENCE SCENARIO', 60) + 'RESULT');
  console.log('  ' + '-'.repeat(60 + 6));
  let failures = 0;
  results.forEach(([name, ok]) => {
    if (!ok) failures++;
    console.log('  ' + pad(name, 60) + (ok ? 'PASS' : 'FAIL'));
  });
  console.log('  ' + '-'.repeat(60 + 6));
  if (failures === 0) {
    console.log('  ALL ' + results.length + ' END-TO-END SCENARIOS PASS (autoSave + load-newest preserve chat).');
    process.exit(0);
  } else {
    console.log('  ' + failures + ' of ' + results.length + ' END-TO-END SCENARIOS FAILED.');
    process.exit(1);
  }
}

main().catch((e) => { console.error('FATAL: ' + (e && e.stack || e)); process.exit(2); });
