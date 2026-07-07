#!/usr/bin/env node
/*
 * test_storyshapes.js — mechanical test for the Story Shapes model in bp.html.
 *
 * Story Shapes make the season narrative model data-driven (Plot Mountain,
 * Man in Hole, …) instead of hardcoding one arc. This proves, against the REAL
 * functions extracted from bp.html and run in a vm sandbox:
 *   1. Default shape is plot-mountain, and getEpArcBeat() reproduces the LEGACY
 *      Plot Mountain mapping EXACTLY for 8 episodes (regression guard — the
 *      rewire from hardcoded beats to shape-driven must not change behavior).
 *   2. Switching to man-in-hole changes the per-episode beats (the lens works).
 *   3. setStoryShape() writes the choice to the DURABLE state.seasons record
 *      (so selectSeason(), which reassigns currentSeason, keeps it) — and it
 *      rides currentSeason into the persisted snapshot.
 *   4. An unknown shape id is ignored (no-op, active shape unchanged).
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
    alert: noop, confirm: () => true, prompt: () => null,
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
  try { globalThis.__STORY_SHAPES = STORY_SHAPES; } catch(e){ globalThis.__err1 = String(e); }
  try { globalThis.__getEpArcBeat = getEpArcBeat; } catch(e){ globalThis.__err2 = String(e); }
  try { globalThis.__setStoryShape = setStoryShape; } catch(e){ globalThis.__err3 = String(e); }
  try { globalThis.__activeStoryShapeId = activeStoryShapeId; } catch(e){ globalThis.__err4 = String(e); }
  try { globalThis.__state = state; } catch(e){ globalThis.__err5 = String(e); }
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
  const errs = ['__err1', '__err2', '__err3', '__err4', '__err5'].filter((k) => sb[k]);
  if (errs.length || typeof sb.__getEpArcBeat !== 'function' || typeof sb.__setStoryShape !== 'function') {
    console.error('FATAL: could not expose story-shape internals: ' + errs.map((k) => k + '=' + sb[k]).join('; '));
    process.exit(2);
  }
  const { __getEpArcBeat: getEpArcBeat, __setStoryShape: setStoryShape, __activeStoryShapeId: activeStoryShapeId, __state: state, __STORY_SHAPES: SHAPES } = sb;
  const beat = (n) => getEpArcBeat(n).label;

  // 1. Default = plot-mountain, and legacy mapping preserved EXACTLY (8 eps).
  ok(activeStoryShapeId() === 'plot-mountain', 'default active shape is plot-mountain');
  ok(SHAPES && SHAPES['plot-mountain'] && SHAPES['man-in-hole'], 'registry has plot-mountain and man-in-hole');
  const legacy = { 1: 'Exposition', 2: 'Exposition', 3: 'Conflict', 4: 'Conflict', 5: 'Rising', 6: 'Rising', 7: 'Climax', 8: 'Resolution' };
  let legacyOk = true;
  for (let n = 1; n <= 8; n++) if (beat(n) !== legacy[n]) { legacyOk = false; console.log('   E' + n + ' expected ' + legacy[n] + ' got ' + beat(n)); }
  ok(legacyOk, 'Plot Mountain per-episode beats match the legacy hardcoded mapping (E1-8)');

  // 2. Switching shape changes the per-episode beats (the lens works).
  setStoryShape('man-in-hole');
  ok(activeStoryShapeId() === 'man-in-hole', 'setStoryShape switches the active shape');
  ok(beat(1) === 'Comfortable', 'man-in-hole: E1 is Comfortable');
  ok(beat(5) === 'In the Hole', 'man-in-hole: a middle episode is In the Hole');
  ok(beat(8) === 'Climbing Out', 'man-in-hole: E8 is Climbing Out');

  // 3. Choice written to the DURABLE season record (survives selectSeason reassign).
  const srec = (state.seasons || []).find((s) => s.number === (state.currentSeason && state.currentSeason.number));
  ok(srec && srec.storyShape === 'man-in-hole', 'shape choice persisted on the durable state.seasons record');
  ok(state.currentSeason && state.currentSeason.storyShape === 'man-in-hole', 'shape choice also on currentSeason (rides into snapshot)');

  // 4. Unknown shape id is ignored.
  setStoryShape('does-not-exist');
  ok(activeStoryShapeId() === 'man-in-hole', 'unknown shape id is a no-op');

  console.log('');
  console.log(FAIL === 0 ? ('All ' + PASS + ' story-shape assertions passed.') : (FAIL + ' assertion(s) failed.'));
  process.exit(FAIL === 0 ? 0 : 1);
}

main();
