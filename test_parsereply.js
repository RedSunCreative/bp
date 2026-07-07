#!/usr/bin/env node
/*
 * test_parsereply.js — mechanical test for parseReply()'s content routing.
 *
 * Bug (2026-07-06): parseReply() detected "guest suggestions" by merely counting
 * pipe-delimited lines (>=2 lines with '|' and >=3 columns). Any markdown table or
 * season-arc table Boo wrote INTO CHAT was therefore hijacked into formatGuestSuggestions
 * and rendered as interactive guest CARDS inside the conversation (ADD GUEST / Consider /
 * Invite / REPO / Verify buttons). An archived season arc rendered as a wall of bogus cards.
 *
 * Fix: require the documented guest marker "Tier: Spotlight/Rising/Discovery" on the pipe
 * lines before routing to guest cards. This proves, against the REAL parseReply extracted
 * from bp.html and run in a vm sandbox:
 *   1. A season-arc pipe table (no Tier:)  -> NOT rendered as guest cards.
 *   2. A generic markdown table (no Tier:) -> NOT rendered as guest cards.
 *   3. A real guest reply (with Tier:)     -> STILL rendered as guest cards.
 *
 * Exit 0 = all pass. Exit 1 = an assertion failed. Exit 2 = sandbox load failure.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BP_PATH = process.env.BP_FILE || path.join(__dirname, 'bp.html');

// ── Extract the first inline <script> block (mirror test_persistence.js) ──
function extractFirstInlineScript(html) {
  const re = /<script\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] || '';
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const start = re.lastIndex;
    const end = html.indexOf('</script>', start);
    if (end === -1) throw new Error('no closing </script> after first inline <script>');
    return html.slice(start, end);
  }
  throw new Error('no inline <script> block found in bp.html');
}

// ── Lightweight DOM / browser stub (chainable fake element) ──
function makeFakeElement() {
  const store = {
    innerHTML: '', value: '', textContent: '', className: '', checked: false,
    style: {}, dataset: {}, children: [], scrollTop: 0, scrollHeight: 0,
  };
  const handler = {
    get(target, prop) {
      if (prop === Symbol.toPrimitive || prop === 'toString') return () => '[FakeElement]';
      if (prop in store) return store[prop];
      const fn = function () { return makeFakeElement(); };
      return new Proxy(fn, handler);
    },
    set(target, prop, value) { store[prop] = value; return true; },
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
  try { globalThis.__parseReply = parseReply; } catch(e){ globalThis.__parseReply_ERR__ = String(e); }
})();
`;
  vm.runInContext(scriptSrc + '\n' + epilogue, context, { filename: 'bp.html#inline-script', timeout: 20000 });
  return sandbox;
}

// ── Assertions ──
let PASS = 0, FAIL = 0;
function ok(cond, name) { if (cond) { console.log('PASS: ' + name); PASS++; } else { console.log('FAIL: ' + name); FAIL++; } }

// A rendered guest CARD is unmistakable: the card container + the ADD GUEST button.
function isRenderedAsCards(html) {
  return /class="guest-card"/.test(html) || /\+ ADD GUEST/.test(html) || /class="card-grid"/.test(html);
}

function main() {
  let sb;
  try {
    const html = fs.readFileSync(BP_PATH, 'utf8');
    sb = buildSandboxAndLoad(extractFirstInlineScript(html));
  } catch (e) {
    console.error('FATAL: extracted script failed to load in sandbox:\n' + (e && e.stack || e));
    process.exit(2);
  }
  if (sb.__parseReply_ERR__ || typeof sb.__parseReply !== 'function') {
    console.error('FATAL: could not expose parseReply: ' + (sb.__parseReply_ERR__ || 'not a function'));
    process.exit(2);
  }
  const parseReply = sb.__parseReply;

  // 1. Season-arc pipe table (the actual bug shape) — must NOT become cards.
  const seasonArc = [
    '**ARCHIVED SEASON ARC — PRE-PIVOT RECORD**',
    '',
    '| Ep | Arc | Title | Guest |',
    '|----|-----|-------|-------|',
    '| E1 | Exposition | "The Principal in the Room Where It Happened" | Kip Glazer |',
    '| E2 | Exposition | "Who Was Already Left Behind?" | Dominick Sanders |',
    '| E5 | Rising | "The Research Is In. Here'+"'"+'s What We Found." | Victoria Fudge |',
    '| E7 | Climax | "The Moment of Reckoning" | TBD |',
    '| E8 | Resolution | "We Built This For Them" | Dora Palfi |',
  ].join('\n');
  ok(!isRenderedAsCards(parseReply(seasonArc)), 'season-arc table is NOT hijacked into guest cards');

  // 2. Generic markdown table (no Tier:, no arc words) — must NOT become cards.
  const genericTable = [
    'Here are the tradeoffs:',
    '| Option | Pros | Cons |',
    '|--------|------|------|',
    '| A | fast | costly |',
    '| B | cheap | slow |',
  ].join('\n');
  ok(!isRenderedAsCards(parseReply(genericTable)), 'generic markdown table is NOT hijacked into guest cards');

  // 3. Real guest reply (documented format with Tier:) — MUST still render as cards.
  const guestReply = [
    'Here are three strong candidates:',
    'Jane Doe | Director of CS, Big District | Led a district-wide rollout; speaks plainly about tradeoffs. | Curriculum, Equity | Tier: Spotlight, LinkedIn: linkedin.com/in/janedoe',
    'John Smith | Researcher, Some Lab | Studies how kids learn to code with AI tutors. | AI, Learning | Tier: Rising, LinkedIn: linkedin.com/in/johnsmith',
    'Ada Lee | Teacher, Rural HS | Under-the-radar practitioner with a remarkable classroom story. | Access, Practice | Tier: Discovery, LinkedIn: linkedin.com/in/adalee',
  ].join('\n');
  ok(isRenderedAsCards(parseReply(guestReply)), 'real guest reply (with Tier:) STILL renders as guest cards');

  console.log('');
  console.log(FAIL === 0 ? ('All ' + PASS + ' parseReply routing assertions passed.') : (FAIL + ' assertion(s) failed.'));
  process.exit(FAIL === 0 ? 0 : 1);
}

main();
