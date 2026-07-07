#!/usr/bin/env node
/*
 * test_archives.js — mechanical test for Season Archives in bp.html.
 *
 * "Archive all of this" — a named, durable full-season snapshot you can retrieve
 * or model against. Proves, against the REAL functions in a vm sandbox:
 *   1. archiveCurrentSeason() captures a snapshot and STRIPS arcArchives from it
 *      (recursion guard — archives never nest inside archives), with metadata.
 *   2. arcArchives persist through buildSessionSnapshot -> applySession.
 *   3. restoreArcArchive() auto-archives the current state first, then restores
 *      the archived season faithfully (and does not lose the other archives).
 *   4. renderSeasonView() runs without throwing (guards the archive/recording
 *      wiring — a called-but-undefined render fn would break the Season tab).
 *
 * Exit 0 = all pass. Exit 1 = an assertion failed. Exit 2 = sandbox load failure.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BP_PATH = process.env.BP_FILE || path.join(__dirname, 'bp.html');

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
  const store = { innerHTML: '', value: '', textContent: '', className: '', checked: false, style: {}, dataset: {}, children: [], scrollTop: 0, scrollHeight: 0 };
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
    createElement: () => makeFakeElement(), createElementNS: () => makeFakeElement(),
    createTextNode: () => makeFakeElement(), createDocumentFragment: () => makeFakeElement(),
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
  };
}
function buildSandboxAndLoad(scriptSrc) {
  const localStorage = makeLocalStorage();
  const noop = () => {};
  const fakeWindow = {};
  const sandbox = {
    document: makeDocument(), localStorage, sessionStorage: makeLocalStorage(),
    console: { log: noop, warn: noop, error: noop, info: noop, debug: noop },
    fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve('') }),
    setTimeout: () => 0, clearTimeout: noop, setInterval: () => 0, clearInterval: noop,
    requestAnimationFrame: () => 0, cancelAnimationFrame: noop,
    queueMicrotask: (fn) => { try { fn(); } catch (e) {} },
    alert: noop, confirm: () => true, prompt: () => 'Test Archive',
    atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
    btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
    URL: { createObjectURL: () => 'blob:stub', revokeObjectURL: noop },
    Blob: function Blob() {}, FileReader: function FileReader() {},
    navigator: { userAgent: 'node-test', clipboard: { writeText: () => Promise.resolve() }, onLine: true },
    location: { href: 'http://localhost/bp.html', hostname: 'localhost', search: '', hash: '', reload: noop, replace: noop, assign: noop },
    history: { pushState: noop, replaceState: noop },
    crypto: (typeof globalThis.crypto !== 'undefined') ? globalThis.crypto : { getRandomValues: (a) => a, randomUUID: () => '0' },
    Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error, Map, Set, Promise, Symbol, Reflect, Proxy, parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
  };
  sandbox.window = fakeWindow; sandbox.self = fakeWindow; sandbox.globalThis = sandbox;
  fakeWindow.localStorage = localStorage; fakeWindow.location = sandbox.location;
  fakeWindow.navigator = sandbox.navigator; fakeWindow.document = sandbox.document;
  fakeWindow.fetch = sandbox.fetch; fakeWindow.setTimeout = sandbox.setTimeout; fakeWindow.addEventListener = noop;
  const context = vm.createContext(sandbox);
  const epilogue = `
;(function(){
  try { globalThis.__archive = archiveCurrentSeason; } catch(e){ globalThis.__e1 = String(e); }
  try { globalThis.__restore = restoreArcArchive; } catch(e){ globalThis.__e2 = String(e); }
  try { globalThis.__SNAP = buildSessionSnapshot; } catch(e){ globalThis.__e3 = String(e); }
  try { globalThis.__APPLY = applySession; } catch(e){ globalThis.__e4 = String(e); }
  try { globalThis.__state = state; } catch(e){ globalThis.__e5 = String(e); }
  try { globalThis.__renderSeason = renderSeasonView; } catch(e){ globalThis.__e6 = String(e); }
  try { globalThis.__startFresh = startFreshSeason; } catch(e){ globalThis.__e7 = String(e); }
  try { globalThis.__episodeStore = episodeStore; } catch(e){ globalThis.__e8 = String(e); }
})();
`;
  vm.runInContext(scriptSrc + '\n' + epilogue, context, { filename: 'bp.html#inline-script', timeout: 20000 });
  return sandbox;
}

let PASS = 0, FAIL = 0;
function ok(cond, name) { if (cond) { console.log('PASS: ' + name); PASS++; } else { console.log('FAIL: ' + name); FAIL++; } }

function main() {
  let sb;
  try {
    sb = buildSandboxAndLoad(extractFirstInlineScript(fs.readFileSync(BP_PATH, 'utf8')));
  } catch (e) {
    console.error('FATAL: extracted script failed to load in sandbox:\n' + (e && e.stack || e));
    process.exit(2);
  }
  const errs = ['__e1', '__e2', '__e3', '__e4', '__e5', '__e6'].filter((k) => sb[k]);
  if (errs.length || typeof sb.__archive !== 'function' || typeof sb.__restore !== 'function' || typeof sb.__renderSeason !== 'function') {
    console.error('FATAL: could not expose archive internals: ' + errs.map((k) => k + '=' + sb[k]).join('; '));
    process.exit(2);
  }
  const { __archive: archiveCurrentSeason, __restore: restoreArcArchive, __SNAP: buildSessionSnapshot,
    __APPLY: applySession, __state: state, __renderSeason: renderSeasonView,
    __startFresh: startFreshSeason, __episodeStore: episodeStore } = sb;
  if (typeof startFreshSeason !== 'function' || !episodeStore) {
    console.error('FATAL: could not expose startFreshSeason / episodeStore');
    process.exit(2);
  }

  // 4 (first — guards the wiring that broke): Season view renders without throwing.
  let rendered = true;
  try { renderSeasonView(); } catch (e) { rendered = false; console.log('   renderSeasonView threw: ' + e.message); }
  ok(rendered, 'renderSeasonView runs without throwing (archive/recording wiring intact)');

  // 1. Archive captures a snapshot and strips arcArchives (recursion guard) + metadata.
  const a1 = archiveCurrentSeason('First');
  ok((state.arcArchives || []).length === 1, 'archiveCurrentSeason adds one archive');
  ok(a1.snap && a1.snap.state && Array.isArray(a1.snap.state.seasons), 'archive snapshot contains the season state');
  ok(a1.snap.state.arcArchives === undefined, 'recursion guard: archive snapshot has NO arcArchives');
  ok(typeof a1.episodeCount === 'number' && a1.name === 'First', 'archive carries episodeCount + name');

  // 2. Deep recursion guard: a second archive still has no nested arcArchives.
  const a2 = archiveCurrentSeason('Second');
  ok((state.arcArchives || []).length === 2, 'second archive added');
  ok(a2.snap.state.arcArchives === undefined, 'recursion guard holds when arcArchives is already non-empty');

  // 3. arcArchives persist through snapshot -> applySession round-trip.
  const snap = buildSessionSnapshot();
  ok(Array.isArray(snap.state.arcArchives) && snap.state.arcArchives.length === 2, 'snapshot captures arcArchives');
  const round = JSON.parse(JSON.stringify(snap));
  state.arcArchives = [];
  applySession(round);
  ok((state.arcArchives || []).length === 2, 'arcArchives survive snapshot -> applySession');

  // 5. Restore round-trip: current season auto-archived first, then archived season restored.
  state.seasons[0].theme = 'ORIGINAL THEME';
  const archOrig = archiveCurrentSeason('orig');
  state.seasons[0].theme = 'CHANGED THEME';
  const before = state.arcArchives.length;
  restoreArcArchive(archOrig.id);
  ok(state.seasons[0].theme === 'ORIGINAL THEME', 'restore brings back the archived season');
  ok(state.arcArchives.length === before + 1, 'restore auto-archived the current state first (nothing lost)');

  // 6. Start Fresh zeroes episodes but PRESERVES guests (harvested to the repo).
  // Real episodeStore entries always carry conversationLog; mirror that here.
  episodeStore[1] = { conversationLog: [], considerations: [{ name: 'Kip Glazer', title: 'Principal, Mountain View HS' }] };
  episodeStore[2] = { conversationLog: [], considerations: [{ name: 'Dominick Sanders', title: 'Director of Innovation' }] };
  state.seasons[0].theme = 'What Do We Teach Now?';
  state.seasons[0].episodes = [{ number: 1, title: 'The Principal' }, { number: 2, title: 'Who Was Left Behind' }];
  state.seasons[0].seasonBrief = 'a long season brief that should be cleared';
  state.seasons[0].episodeCount = 9;
  state.guestRepo = [];
  const arcsBefore = (state.arcArchives || []).length;
  startFreshSeason();
  ok(state.seasons[0].episodes.length === 0 && state.seasons[0].episodeCount === 0, 'Start Fresh zeroes the episodes');
  ok(state.seasons[0].theme === '' && state.seasons[0].seasonBrief === '', 'Start Fresh clears theme + brief');
  ok(state.guestRepo.some(function (g) { return g.name === 'Kip Glazer'; })
    && state.guestRepo.some(function (g) { return g.name === 'Dominick Sanders'; }),
    'guests preserved in the repository (harvested from episodes)');
  ok(state.guestRepo.length >= 2 && state.guestRepo.every(function (g) { return !g.assignedTo; }), 'harvested guests are unassigned');
  ok((state.arcArchives || []).length === arcsBefore + 1, 'Start Fresh archived the previous season first');

  console.log('');
  console.log(FAIL === 0 ? ('All ' + PASS + ' archive assertions passed.') : (FAIL + ' assertion(s) failed.'));
  process.exit(FAIL === 0 ? 0 : 1);
}

main();
