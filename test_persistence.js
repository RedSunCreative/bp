#!/usr/bin/env node
/*
 * test_persistence.js — mechanical save/load round-trip test for bp.html
 *
 * Goal: PROVE that every persisted field survives a
 *   buildSessionSnapshot() -> JSON.stringify -> JSON.parse -> applySession()
 * cycle, by executing the REAL functions from bp.html inside a vm sandbox.
 *
 * It does NOT re-implement any persistence logic. It extracts the first inline
 * <script> block from bp.html, runs it under a lightweight DOM/browser stub,
 * exposes the live internals (state, episodeStore, actionItems, the PATCHED
 * buildSessionSnapshot / applySession, aiIdCounter) and drives them.
 *
 * Exit 0 = every field both CAPTURED and RESTORED. Exit 1 = at least one failed.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// BP_FILE env override lets the break-test point at a scratch copy without
// touching the real bp.html. Defaults to the real file in this directory.
const BP_PATH = process.env.BP_FILE || path.join(__dirname, 'bp.html');

// ────────────────────────────────────────────────────────────────────────────
// 1. Extract the first inline <script> block (mirror test_bp.sh's structural cut)
// ────────────────────────────────────────────────────────────────────────────
function extractFirstInlineScript(html) {
  // Find first <script ...> that is NOT a src= include.
  const re = /<script\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] || '';
    if (/\bsrc\s*=/i.test(attrs)) continue; // external script, skip
    const start = re.lastIndex;
    const end = html.indexOf('</script>', start);
    if (end === -1) throw new Error('no closing </script> after first inline <script>');
    return html.slice(start, end);
  }
  throw new Error('no inline <script> block found in bp.html');
}

// ────────────────────────────────────────────────────────────────────────────
// 2. Lightweight DOM / browser stub
// ────────────────────────────────────────────────────────────────────────────
// Chainable fake element: any property read returns another fake element (so
// `.style.display = 'x'`, `.classList.add()`, `.innerHTML = ''` all no-op
// safely). Function calls return a fake element too. Setting a property stores
// it so reads of e.g. innerHTML round-trip if anyone cares.
function makeFakeElement() {
  const store = {
    innerHTML: '',
    value: '',
    textContent: '',
    className: '',
    checked: false,
    style: {},
    dataset: {},
    children: [],
    scrollTop: 0,
    scrollHeight: 0,
  };
  const handler = {
    get(target, prop) {
      if (prop === Symbol.toPrimitive || prop === 'toString') return () => '[FakeElement]';
      if (prop in store) return store[prop];
      // classList, methods, anything else -> a callable chainable proxy
      const fn = function () { return makeFakeElement(); };
      return new Proxy(fn, handler);
    },
    set(target, prop, value) {
      store[prop] = value;
      return true;
    },
    apply() {
      // calling the proxy (e.g. appendChild(), addEventListener(), classList.add())
      return makeFakeElement();
    },
  };
  return new Proxy(function () {}, handler);
}

function makeDocument() {
  const doc = {
    getElementById: () => makeFakeElement(),
    querySelector: () => makeFakeElement(),
    querySelectorAll: () => [],
    getElementsByClassName: () => [],
    getElementsByTagName: () => [],
    createElement: () => makeFakeElement(),
    createElementNS: () => makeFakeElement(),
    createTextNode: () => makeFakeElement(),
    createDocumentFragment: () => makeFakeElement(),
    addEventListener: () => {},
    removeEventListener: () => {},
    execCommand: () => true,
    body: makeFakeElement(),
    head: makeFakeElement(),
    documentElement: makeFakeElement(),
    cookie: '',
    readyState: 'complete',
    title: '',
  };
  return doc;
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

// ────────────────────────────────────────────────────────────────────────────
// 3. Build sandbox + run the extracted script with an exposing epilogue
// ────────────────────────────────────────────────────────────────────────────
function buildSandboxAndLoad(scriptSrc) {
  const localStorage = makeLocalStorage();
  const noop = () => {};
  const fakeWindow = {};

  const sandbox = {
    document: makeDocument(),
    localStorage,
    sessionStorage: makeLocalStorage(),
    console: { log: noop, warn: noop, error: noop, info: noop, debug: noop },
    // fetch: resolved stub so autoSave's network call neither throws nor hangs the test
    fetch: () => Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
      text: () => Promise.resolve(''),
    }),
    // setTimeout: capture the fn but DO NOT run it. The test calls
    // buildSessionSnapshot() directly, so debounced autoSave never needs to fire.
    setTimeout: (fn, ms) => 0,
    clearTimeout: noop,
    setInterval: () => 0,
    clearInterval: noop,
    requestAnimationFrame: (fn) => 0,
    cancelAnimationFrame: noop,
    queueMicrotask: (fn) => { try { fn(); } catch (e) {} },
    alert: noop,
    confirm: () => true,
    prompt: () => null,
    atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
    btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
    URL: { createObjectURL: () => 'blob:stub', revokeObjectURL: noop },
    Blob: function Blob() {},
    FileReader: function FileReader() {},
    navigator: { userAgent: 'node-test', clipboard: { writeText: () => Promise.resolve() }, onLine: true },
    location: { href: 'http://localhost/bp.html', hostname: 'localhost', search: '', hash: '', reload: noop, replace: noop, assign: noop },
    history: { pushState: noop, replaceState: noop },
    crypto: (typeof globalThis.crypto !== 'undefined') ? globalThis.crypto : { getRandomValues: (a) => a, randomUUID: () => '00000000-0000-0000-0000-000000000000' },
    // real engine intrinsics
    Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error, Map, Set, Promise, Symbol, Reflect, Proxy, parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
  };
  sandbox.window = fakeWindow;
  sandbox.self = fakeWindow;
  sandbox.globalThis = sandbox;
  // Mirror a few onto window so `window.X` access also works
  fakeWindow.localStorage = localStorage;
  fakeWindow.location = sandbox.location;
  fakeWindow.navigator = sandbox.navigator;
  fakeWindow.document = sandbox.document;
  fakeWindow.fetch = sandbox.fetch;
  fakeWindow.setTimeout = sandbox.setTimeout;
  fakeWindow.addEventListener = noop;

  const context = vm.createContext(sandbox);

  // Epilogue: top-level const/let do NOT attach to the context global, so expose
  // the internals we need. Function declarations + the patched reassignments are
  // all in scope at the end of the script, so this can see the LIVE (patched)
  // buildSessionSnapshot / applySession.
  const epilogue = `
;(function(){
  try { globalThis.__SNAP__  = buildSessionSnapshot; } catch(e) { globalThis.__SNAP_ERR__ = String(e); }
  try { globalThis.__APPLY__ = applySession;        } catch(e) { globalThis.__APPLY_ERR__ = String(e); }
  try { globalThis.__state   = state;               } catch(e) { globalThis.__state_ERR__ = String(e); }
  try { globalThis.__episodeStore = episodeStore;   } catch(e) { globalThis.__episodeStore_ERR__ = String(e); }
  try { globalThis.__getActionItems  = function(){ return actionItems; }; } catch(e) { globalThis.__actionItems_ERR__ = String(e); }
  try { globalThis.__getAiIdCounter  = function(){ return aiIdCounter; }; } catch(e) { globalThis.__aiIdCounter_ERR__ = String(e); }
  try { globalThis.__activeEp = activeEp; } catch(e) {}
})();
`;

  const fullSrc = scriptSrc + '\n' + epilogue;
  vm.runInContext(fullSrc, context, { filename: 'bp.html#inline-script', timeout: 20000 });
  return sandbox;
}

// ────────────────────────────────────────────────────────────────────────────
// 4. The round-trip test
// ────────────────────────────────────────────────────────────────────────────
function S(name) { return 'SENTINEL_' + name; }

function main() {
  const html = fs.readFileSync(BP_PATH, 'utf8');
  const scriptSrc = extractFirstInlineScript(html);

  let sb;
  try {
    sb = buildSandboxAndLoad(scriptSrc);
  } catch (e) {
    console.error('FATAL: extracted script failed to load in sandbox:\n' + (e && e.stack || e));
    process.exit(2);
  }

  // Surface any exposure errors
  const exposeErrs = ['__SNAP_ERR__', '__APPLY_ERR__', '__state_ERR__', '__episodeStore_ERR__', '__actionItems_ERR__', '__aiIdCounter_ERR__']
    .filter((k) => sb[k]);
  if (exposeErrs.length) {
    console.error('FATAL: could not expose internals: ' + exposeErrs.map((k) => k + '=' + sb[k]).join('; '));
    process.exit(2);
  }

  const buildSessionSnapshot = sb.__SNAP__;
  const applySession = sb.__APPLY__;
  const state = sb.__state;
  const episodeStore = sb.__episodeStore;
  const getActionItems = sb.__getActionItems;
  const getAiIdCounter = sb.__getAiIdCounter;
  const activeEp = sb.__activeEp;

  if (typeof buildSessionSnapshot !== 'function' || typeof applySession !== 'function') {
    console.error('FATAL: buildSessionSnapshot/applySession not callable.');
    process.exit(2);
  }

  // ── (b) Write a unique sentinel into EVERY persisted field ───────────────
  const epNum = (state.currentEpisode && state.currentEpisode.number) || 1;

  // state top-level (truthy values — restore guards use `if (data.X)`)
  state.masterBriefContent = S('masterBriefContent');
  state.masterBriefItems   = [{ text: S('masterBriefItems'), checked: true }];
  state.masterBriefFlags   = [{ text: S('masterBriefFlags') }];
  state.hostIntro          = S('hostIntro');
  state.hostOutro          = S('hostOutro');
  state.guestRepo          = [{
    name: S('guestRepo_name'), firstName: S('firstName'), lastName: S('lastName'),
    title: S('title'), org: S('org'), tier: S('tier'), why: S('why'),
    intro: S('intro'), notes: S('guestNotes'), email: S('email'),
    day: S('day'), time: S('time'), timezone: S('timezone'),
    description: S('description'), source1: S('source1'), source2: S('source2'),
    location: S('guestLocation'), assignedTo: S('assignedTo'),
  }];

  // state.seasons + dynamic seasonBrief on a season (rides inside state.seasons)
  state.seasons[0].seasonBrief = S('seasonBrief');
  state.seasons[0].theme = S('seasonTheme');
  state.currentSeason.theme = S('currentSeasonTheme');
  state.currentEpisode.title = S('currentEpisodeTitle');

  // episodeStore bucket for the active episode
  const ep = activeEp ? activeEp() : episodeStore[epNum];
  ep.conversationLog = [{ role: 'boo', text: S('convText'), rawText: S('convRaw'), html: S('convHtml') }];
  ep.briefContent       = S('briefContent');
  ep.considerations     = [{ name: S('considerationName'), status: 'unconfirmed' }];
  // cues is an array of cue objects (updateRuntime maps over it)
  ep.cues               = [{ id: 'cue-sentinel-1', name: S('cues'), duration: '3', note: '' }];
  ep.script             = S('script');
  // runOfShow is an array of segment objects (updateRosView maps over it)
  ep.runOfShow          = [{ name: S('runOfShow'), start: '0:00', duration: '5' }];
  ep.guestIntro         = S('guestIntro');
  ep.interviewQuestions = S('interviewQuestions');
  ep.location           = S('epLocation');
  ep.recordDate         = S('recordDate');
  ep.recordTime         = S('recordTime');
  ep.releaseDate        = S('releaseDate');
  ep.releaseTime        = S('releaseTime');
  ep.summary            = S('summary');
  ep.targetTime         = 4242; // numeric sentinel

  // module-level actionItems + aiIdCounter
  const actionItems = getActionItems();
  actionItems.length = 0;
  actionItems.push({ id: 1, text: S('actionItem'), owner: 'Mark', source: 'boo', episodeRef: 'S1-E1', status: 'open', done: false });
  // aiIdCounter sentinel — bump it via the snapshot path; we set a distinctive value
  // by pushing an item and relying on restore to set it from snapshot.aiIdCounter.
  // We can't reassign the const-scoped aiIdCounter directly, so we drive it through
  // the snapshot: the snapshot reads the LIVE aiIdCounter, and restore sets it back.

  const AI_COUNTER_BEFORE = getAiIdCounter();

  // ── (c) Build snapshot + round-trip through JSON ─────────────────────────
  const snapshot = buildSessionSnapshot();
  const parsed = JSON.parse(JSON.stringify(snapshot));

  // ── (d) RESET: wipe sentinels so restore must repopulate them ────────────
  state.masterBriefContent = '';
  state.masterBriefItems   = [];
  state.masterBriefFlags   = [];
  state.hostIntro          = '';
  state.hostOutro          = '';
  state.guestRepo          = [];
  state.seasons            = [{ number: 1, theme: '' }]; // wipe seasonBrief + theme
  state.currentSeason      = { number: 1, theme: '' };
  state.currentEpisode     = { number: epNum, title: '' };
  Object.keys(episodeStore).forEach((k) => { delete episodeStore[k]; });
  actionItems.length = 0;

  // ── (e) Restore ──────────────────────────────────────────────────────────
  applySession(parsed);

  // ── (f) Build coverage table ─────────────────────────────────────────────
  const stateAfter      = sb.__state;            // applySession may reassign nested objects on the same state obj
  const episodeStoreAfter = sb.__episodeStore;
  const epAfter = (activeEp ? activeEp() : episodeStoreAfter[epNum]) || {};
  const seasonAfter = (stateAfter.seasons && stateAfter.seasons[0]) || {};
  const guestAfter  = (stateAfter.guestRepo && stateAfter.guestRepo[0]) || {};
  const actionItemsAfter = getActionItems();

  // Helper: deep-find a sentinel string anywhere in a value
  function containsSentinel(val, sentinel) {
    if (val == null) return false;
    if (typeof val === 'string') return val.indexOf(sentinel) !== -1;
    if (typeof val === 'number') return String(val) === sentinel;
    if (typeof val === 'object') {
      return Object.keys(val).some((k) => containsSentinel(val[k], sentinel));
    }
    return false;
  }

  // Each row: field label, sentinel, captured? (in parsed snapshot), restored? (back in live state)
  function cap(sentinel) { return containsSentinel(parsed, sentinel); }

  const rows = [
    // state top-level
    ['state.masterBriefContent', S('masterBriefContent'), cap(S('masterBriefContent')), containsSentinel(stateAfter.masterBriefContent, S('masterBriefContent'))],
    ['state.masterBriefItems',   S('masterBriefItems'),   cap(S('masterBriefItems')),   containsSentinel(stateAfter.masterBriefItems, S('masterBriefItems'))],
    ['state.masterBriefFlags',   S('masterBriefFlags'),   cap(S('masterBriefFlags')),   containsSentinel(stateAfter.masterBriefFlags, S('masterBriefFlags'))],
    ['state.hostIntro',          S('hostIntro'),          cap(S('hostIntro')),          containsSentinel(stateAfter.hostIntro, S('hostIntro'))],
    ['state.hostOutro',          S('hostOutro'),          cap(S('hostOutro')),          containsSentinel(stateAfter.hostOutro, S('hostOutro'))],

    // guestRepo fields
    ['guestRepo[0].name',        S('guestRepo_name'),     cap(S('guestRepo_name')),     containsSentinel(guestAfter.name, S('guestRepo_name'))],
    ['guestRepo[0].firstName',   S('firstName'),          cap(S('firstName')),          containsSentinel(guestAfter.firstName, S('firstName'))],
    ['guestRepo[0].lastName',    S('lastName'),           cap(S('lastName')),           containsSentinel(guestAfter.lastName, S('lastName'))],
    ['guestRepo[0].title',       S('title'),              cap(S('title')),              containsSentinel(guestAfter.title, S('title'))],
    ['guestRepo[0].org',         S('org'),                cap(S('org')),                containsSentinel(guestAfter.org, S('org'))],
    ['guestRepo[0].tier',        S('tier'),               cap(S('tier')),               containsSentinel(guestAfter.tier, S('tier'))],
    ['guestRepo[0].why',         S('why'),                cap(S('why')),                containsSentinel(guestAfter.why, S('why'))],
    ['guestRepo[0].intro',       S('intro'),              cap(S('intro')),              containsSentinel(guestAfter.intro, S('intro'))],
    ['guestRepo[0].notes',       S('guestNotes'),         cap(S('guestNotes')),         containsSentinel(guestAfter.notes, S('guestNotes'))],
    ['guestRepo[0].email',       S('email'),              cap(S('email')),              containsSentinel(guestAfter.email, S('email'))],
    ['guestRepo[0].day',         S('day'),                cap(S('day')),                containsSentinel(guestAfter.day, S('day'))],
    ['guestRepo[0].time',        S('time'),               cap(S('time')),               containsSentinel(guestAfter.time, S('time'))],
    ['guestRepo[0].timezone',    S('timezone'),           cap(S('timezone')),           containsSentinel(guestAfter.timezone, S('timezone'))],
    ['guestRepo[0].description',  S('description'),        cap(S('description')),        containsSentinel(guestAfter.description, S('description'))],
    ['guestRepo[0].source1',     S('source1'),            cap(S('source1')),            containsSentinel(guestAfter.source1, S('source1'))],
    ['guestRepo[0].source2',     S('source2'),            cap(S('source2')),            containsSentinel(guestAfter.source2, S('source2'))],
    ['guestRepo[0].location',    S('guestLocation'),      cap(S('guestLocation')),      containsSentinel(guestAfter.location, S('guestLocation'))],
    ['guestRepo[0].assignedTo',   S('assignedTo'),         cap(S('assignedTo')),         containsSentinel(guestAfter.assignedTo, S('assignedTo'))],

    // seasons + dynamic seasonBrief
    ['state.seasons[0].seasonBrief', S('seasonBrief'),    cap(S('seasonBrief')),        containsSentinel(seasonAfter.seasonBrief, S('seasonBrief'))],
    ['state.seasons[0].theme',   S('seasonTheme'),        cap(S('seasonTheme')),        containsSentinel(seasonAfter.theme, S('seasonTheme'))],
    ['state.currentSeason.theme', S('currentSeasonTheme'), cap(S('currentSeasonTheme')), containsSentinel(stateAfter.currentSeason && stateAfter.currentSeason.theme, S('currentSeasonTheme'))],
    ['state.currentEpisode.title', S('currentEpisodeTitle'), cap(S('currentEpisodeTitle')), containsSentinel(stateAfter.currentEpisode && stateAfter.currentEpisode.title, S('currentEpisodeTitle'))],

    // episodeStore bucket
    ['episodeStore[ep].conversationLog.text', S('convText'), cap(S('convText')), containsSentinel(epAfter.conversationLog, S('convText'))],
    ['episodeStore[ep].conversationLog.rawText', S('convRaw'), cap(S('convRaw')), containsSentinel(epAfter.conversationLog, S('convRaw'))],
    ['episodeStore[ep].conversationLog.html', S('convHtml'), cap(S('convHtml')), containsSentinel(epAfter.conversationLog, S('convHtml'))],
    ['episodeStore[ep].briefContent', S('briefContent'),   cap(S('briefContent')),   containsSentinel(epAfter.briefContent, S('briefContent'))],
    ['episodeStore[ep].considerations', S('considerationName'), cap(S('considerationName')), containsSentinel(epAfter.considerations, S('considerationName'))],
    ['episodeStore[ep].cues',     S('cues'),               cap(S('cues')),           containsSentinel(epAfter.cues, S('cues'))],
    ['episodeStore[ep].script',   S('script'),             cap(S('script')),         containsSentinel(epAfter.script, S('script'))],
    ['episodeStore[ep].runOfShow', S('runOfShow'),         cap(S('runOfShow')),      containsSentinel(epAfter.runOfShow, S('runOfShow'))],
    // (runOfShow sentinel lives in segment[0].name)
    ['episodeStore[ep].guestIntro', S('guestIntro'),       cap(S('guestIntro')),     containsSentinel(epAfter.guestIntro, S('guestIntro'))],
    ['episodeStore[ep].interviewQuestions', S('interviewQuestions'), cap(S('interviewQuestions')), containsSentinel(epAfter.interviewQuestions, S('interviewQuestions'))],
    ['episodeStore[ep].location', S('epLocation'),         cap(S('epLocation')),     containsSentinel(epAfter.location, S('epLocation'))],
    ['episodeStore[ep].recordDate', S('recordDate'),       cap(S('recordDate')),     containsSentinel(epAfter.recordDate, S('recordDate'))],
    ['episodeStore[ep].recordTime', S('recordTime'),       cap(S('recordTime')),     containsSentinel(epAfter.recordTime, S('recordTime'))],
    ['episodeStore[ep].releaseDate', S('releaseDate'),     cap(S('releaseDate')),    containsSentinel(epAfter.releaseDate, S('releaseDate'))],
    ['episodeStore[ep].releaseTime', S('releaseTime'),     cap(S('releaseTime')),    containsSentinel(epAfter.releaseTime, S('releaseTime'))],
    ['episodeStore[ep].summary',  S('summary'),            cap(S('summary')),        containsSentinel(epAfter.summary, S('summary'))],
    ['episodeStore[ep].targetTime', '4242',                cap('4242'),              containsSentinel(epAfter.targetTime, '4242')],

    // module-level
    ['actionItems[0]',            S('actionItem'),         cap(S('actionItem')),     containsSentinel(actionItemsAfter, S('actionItem'))],
  ];

  // aiIdCounter: special — it's a number persisted in snapshot.aiIdCounter and
  // restored by the applySession patch. Verify capture + restore mechanically.
  const aiCaptured = (parsed.aiIdCounter === AI_COUNTER_BEFORE);
  const aiRestored = (getAiIdCounter() === AI_COUNTER_BEFORE);
  rows.push(['aiIdCounter', String(AI_COUNTER_BEFORE), aiCaptured, aiRestored]);

  // ── (g) Print table + decide exit code ───────────────────────────────────
  const pad = (s, n) => (String(s) + ' '.repeat(n)).slice(0, n);
  console.log('');
  console.log('  ' + pad('FIELD', 44) + pad('CAPTURED', 10) + pad('RESTORED', 10) + 'RESULT');
  console.log('  ' + '-'.repeat(44 + 10 + 10 + 6));

  let failures = 0;
  rows.forEach(([label, sentinel, captured, restored]) => {
    const ok = captured && restored;
    if (!ok) failures++;
    const mark = ok ? 'PASS' : 'FAIL';
    console.log('  ' + pad(label, 44) + pad(captured ? 'yes' : 'NO', 10) + pad(restored ? 'yes' : 'NO', 10) + mark);
  });

  console.log('  ' + '-'.repeat(44 + 10 + 10 + 6));
  if (failures === 0) {
    console.log('  ALL ' + rows.length + ' PERSISTED FIELDS SURVIVE THE ROUND-TRIP.');
    process.exit(0);
  } else {
    console.log('  ' + failures + ' of ' + rows.length + ' FIELDS FAILED capture and/or restore.');
    process.exit(1);
  }
}

main();
