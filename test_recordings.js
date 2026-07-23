#!/usr/bin/env node
/*
 * test_recordings.js — mechanical test for Season-Planning recording import.
 *
 * Step 1 of the post-production pipeline: import a transcript → Boo distills it
 * to a compact "recording card" (persisted) while the bulky transcript stays out
 * of the autosave snapshot. This proves, against the REAL functions extracted
 * from bp.html in a vm sandbox:
 *   1. buildCharacterizePrompt() embeds the transcript + asks for the labeled
 *      card fields (and the label), and never emits a pipe/Tier line that
 *      parseReply could hijack into a guest card.
 *   2. parseRecordingCard() parses a well-formed labeled reply into the right
 *      object (fields + timecoded quotes), and is safe on messy/missing input.
 *   3. state.recordings survives buildSessionSnapshot -> applySession (cards are
 *      persisted); transcripts are NOT in the snapshot.
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
  try { globalThis.__buildPrompt = buildCharacterizePrompt; } catch(e){ globalThis.__e1 = String(e); }
  try { globalThis.__parseCard = parseRecordingCard; } catch(e){ globalThis.__e2 = String(e); }
  try { globalThis.__SNAP = buildSessionSnapshot; } catch(e){ globalThis.__e3 = String(e); }
  try { globalThis.__APPLY = applySession; } catch(e){ globalThis.__e4 = String(e); }
  try { globalThis.__state = state; } catch(e){ globalThis.__e5 = String(e); }
  try { globalThis.__buildPlan = buildSeasonPlanPrompt; } catch(e){ globalThis.__e6 = String(e); }
  try { globalThis.__recCtx = buildRecordingsContext; } catch(e){ globalThis.__e7 = String(e); }
  try { globalThis.__seasonState = buildSeasonStateContext; } catch(e){ globalThis.__e8 = String(e); }
})();
`;
  vm.runInContext(scriptSrc + '\n' + epilogue, context, { filename: 'bp.html#inline-script', timeout: 20000 });
  return sandbox;
}

let PASS = 0, FAIL = 0;
function ok(cond, name) { if (cond) { console.log('PASS: ' + name); PASS++; } else { console.log('FAIL: ' + name); FAIL++; } }

const WELL_FORMED = [
  'GUEST: Dr. Dominick Sanders',
  'TITLE: Director of Innovation, Trident Academy',
  'ARC: Built a state CS program from scratch, now guards against AI widening the access gap.',
  'TENSION: Access is not the same as equity.',
  'FEAR: Districts adopting tools too fast.',
  'OPPORTUNITY: Syntax is no longer the barrier.',
  'WISH: Bring the farthest-from-opportunity in first.',
  'SHAPE: Man in Hole — the equity gap is the hole; the barbershop model is the way through.',
  'QUOTES:',
  '- [05:01] Access does not always equal the equity piece.',
  '- [39:58] Slow cook my ribs — do not cook fast.',
  '- [24:56] Syntax or bust, no longer.',
  'SUMMARY: A practitioner episode on who gets left behind when the tools change.',
].join('\n');

function main() {
  let sb;
  try {
    sb = buildSandboxAndLoad(extractFirstInlineScript(fs.readFileSync(BP_PATH, 'utf8')));
  } catch (e) {
    console.error('FATAL: extracted script failed to load in sandbox:\n' + (e && e.stack || e));
    process.exit(2);
  }
  const errs = ['__e1', '__e2', '__e3', '__e4', '__e5'].filter((k) => sb[k]);
  if (errs.length || typeof sb.__buildPrompt !== 'function' || typeof sb.__parseCard !== 'function') {
    console.error('FATAL: could not expose recording internals: ' + errs.map((k) => k + '=' + sb[k]).join('; '));
    process.exit(2);
  }
  const { __buildPrompt: buildCharacterizePrompt, __parseCard: parseRecordingCard,
    __SNAP: buildSessionSnapshot, __APPLY: applySession, __state: state,
    __buildPlan: buildSeasonPlanPrompt, __recCtx: buildRecordingsContext } = sb;
  if (typeof buildSeasonPlanPrompt !== 'function' || typeof buildRecordingsContext !== 'function') {
    console.error('FATAL: could not expose planning internals');
    process.exit(2);
  }

  // 1. Prompt builder embeds transcript + field labels + label, and stays non-hijackable.
  const prompt = buildCharacterizePrompt('SPEAKER: barbershop computing at 05:01', 'Dominick');
  ok(prompt.indexOf('barbershop computing') !== -1, 'prompt embeds the transcript text');
  ok(/GUEST:/.test(prompt) && /QUOTES:/.test(prompt) && /SHAPE:/.test(prompt), 'prompt asks for the labeled card fields');
  ok(prompt.indexOf('Dominick') !== -1, 'prompt includes the recording label');
  ok(!/\|\s*Tier:/i.test(prompt), 'prompt contains no pipe+Tier line (safe from parseReply guest-card hijack)');

  // 2. Parser on a well-formed reply.
  const card = parseRecordingCard(WELL_FORMED, 'rec-x', 'Dominick');
  ok(card.guest === 'Dr. Dominick Sanders', 'parses GUEST');
  ok(card.shape.indexOf('Man in Hole') === 0, 'parses SHAPE');
  ok(card.tension === 'Access is not the same as equity.', 'parses TENSION');
  ok(card.quotes.length === 3, 'parses all three QUOTES');
  ok(!!card.quotes[0] && card.quotes[0].timecode === '05:01' && /Access does not/.test(card.quotes[0].quote), 'parses quote timecode + text');
  ok(card.id === 'rec-x' && card.label === 'Dominick', 'carries id + label');

  // 3. Parser is safe on messy / missing input.
  const messy = parseRecordingCard('total nonsense with no labels\nrandom - line', 'rec-y', '');
  ok(messy.guest === '' && messy.quotes.length === 0, 'messy input -> empty defaults, no throw');
  ok(parseRecordingCard('', 'rec-z').quotes.length === 0, 'empty input -> empty card, no throw');

  // 4. Recording cards survive the snapshot -> applySession round-trip; transcript is NOT in the snapshot.
  state.recordings = [{ id: 'rec-1', label: 'Dominick', guest: 'Dr. Dominick Sanders', title: 'Director', arc: 'a', tension: 't', fear: 'f', opportunity: 'o', wish: 'w', shape: 'Man in Hole', summary: 's', quotes: [{ timecode: '12:03', quote: 'q1' }], addedAt: '2026-07-07' }];
  const snap = buildSessionSnapshot();
  ok(snap.state && Array.isArray(snap.state.recordings) && snap.state.recordings.length === 1, 'snapshot captures state.recordings');
  ok(JSON.stringify(snap).indexOf('TRANSCRIPT') === -1, 'snapshot does not carry raw transcript text');
  const round = JSON.parse(JSON.stringify(snap));
  state.recordings = [];
  applySession(round);
  ok(state.recordings.length === 1 && state.recordings[0].guest === 'Dr. Dominick Sanders'
    && state.recordings[0].quotes[0].timecode === '12:03',
    'recordings survive snapshot -> applySession round-trip');

  // 5. Plan-Season kickoff launches the hypothesis-driven interrogation (Movement 1),
  //    stakes-first, one question — NOT the old container-first framing.
  const plan = buildSeasonPlanPrompt();
  ok(/MOVEMENT 1/.test(plan) && /interrogate the story/i.test(plan), 'plan prompt launches Movement 1 (interrogate the story)');
  ok(/CONFLICT\/PROBLEM/.test(plan) && /stakes-first/i.test(plan), 'plan prompt opens with the stakes-first Conflict/Problem question');
  ok(/exactly ONE question/i.test(plan) && /never give me a menu/i.test(plan), 'plan prompt holds the one-question discipline (no menu)');
  ok(!/PRODUCTION CONTAINER/.test(plan) && !/recombine/i.test(plan), 'plan prompt dropped the old container-first framing');
  ok(/confirm or correct/i.test(plan), 'plan prompt frames later questions as propose-then-confirm (hypothesis-driven)');

  // 6. Recording context (injected into every planning turn) surfaces the WHOLE card,
  //    not just shape/tension/arc + 2 quotes. Distinctive values + a 3rd quote so the
  //    check discriminates the richer output from the old throttled one.
  state.recordings = [{ id: 'rec-rc', guest: 'Dr. Dominick Sanders', title: 'Director', shape: 'Man in Hole',
    arc: 'ARCVAL_z', tension: 'TENSIONVAL_z', fear: 'FEARVAL_z', opportunity: 'OPPVAL_z', wish: 'WISHVAL_z',
    summary: 'SUMMARYVAL_z', quotes: [{ timecode: '05:01', quote: 'Q1' }, { timecode: '39:58', quote: 'Q2' }, { timecode: '24:56', quote: 'Q3' }] }];
  const rc = buildRecordingsContext();
  ok(rc.indexOf('Dr. Dominick Sanders') !== -1 && /Man in Hole/.test(rc), 'recordings context lists guest + candidate shape');
  ok(rc.indexOf('FEARVAL_z') !== -1, 'recordings context surfaces Fear');
  ok(rc.indexOf('OPPVAL_z') !== -1, 'recordings context surfaces Opportunity');
  ok(rc.indexOf('WISHVAL_z') !== -1, 'recordings context surfaces Wish');
  ok(rc.indexOf('SUMMARYVAL_z') !== -1, 'recordings context surfaces the Summary');
  ok(rc.indexOf('[24:56]') !== -1, 'recordings context surfaces ALL quotes with timecodes (3rd present, not capped at 2)');

  // 7. Season-state context reflects real state — no resurrected old plan when blank.
  const buildSeasonStateContext = sb.__seasonState;
  // Start Fresh clears BOTH currentSeason and seasons[0]; mirror that.
  if (state.currentSeason) state.currentSeason.theme = '';
  state.seasons[0].theme = '';
  state.seasons[0].episodes = [];
  state.recordings = [{ id: 'r', guest: 'X' }];
  const blank = buildSeasonStateContext();
  ok(/NOT YET PLANNED/.test(blank) && blank.indexOf('What Do We Teach Now') === -1 && blank.indexOf('Plot Mountain') === -1,
    'blank season -> "not yet planned", no resurrected old theme/arc');
  ok(blank.indexOf('1 recording') !== -1, 'blank season context notes the imported recordings');
  if (state.currentSeason) state.currentSeason.theme = 'A Fresh Theme';
  state.seasons[0].theme = 'A Fresh Theme';
  state.seasons[0].episodes = [{ number: 1 }];
  const planned = buildSeasonStateContext();
  ok(/CURRENT STATE/.test(planned) && planned.indexOf('A Fresh Theme') !== -1, 'themed season -> current-state context with the real theme');

  console.log('');
  console.log(FAIL === 0 ? ('All ' + PASS + ' recording assertions passed.') : (FAIL + ' assertion(s) failed.'));
  process.exit(FAIL === 0 ? 0 : 1);
}

main();
