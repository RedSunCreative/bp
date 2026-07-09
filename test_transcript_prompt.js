#!/usr/bin/env node
/*
 * test_transcript_prompt.js — Boo prompts the user to LOAD a transcript instead
 * of pretending the card is the whole interview.
 *
 * When Boo needs detail he doesn't have, he emits `LOAD-TRANSCRIPT: <guest>`; the
 * app strips that from the chat and renders a one-tap "Load transcript" button.
 * Proves against the REAL parseReply / buildTranscriptLoadActions /
 * booReadRecordingByName in a vm sandbox:
 *   1. parseReply strips the directive from the visible text and records the target.
 *   2. buildTranscriptLoadActions turns it into exactly one load action.
 *   3. booReadRecordingByName loads the RICHEST matching recording (skips the thin
 *      retake fragment when a guest has two).
 *   4. No button when that transcript is already loaded.
 *
 * Exit 0 = all pass. 1 = assertion failed. 2 = sandbox load failure.
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
    const start = re.lastIndex; const end = html.indexOf('</script>', start);
    if (end === -1) throw new Error('no closing </script>');
    return html.slice(start, end);
  }
  throw new Error('no inline <script> found');
}
function makeFakeElement() {
  const store = { innerHTML:'', value:'', textContent:'', className:'', checked:false, style:{}, dataset:{}, children:[], scrollTop:0, scrollHeight:0 };
  const handler = {
    get(t,p){ if(p===Symbol.toPrimitive||p==='toString') return ()=>'[FakeElement]'; if(p in store) return store[p]; return new Proxy(function(){return makeFakeElement();},handler); },
    set(t,p,v){ store[p]=v; return true; }, apply(){ return makeFakeElement(); },
  };
  return new Proxy(function(){}, handler);
}
function makeDocument() {
  return { getElementById:()=>makeFakeElement(), querySelector:()=>makeFakeElement(), querySelectorAll:()=>[],
    getElementsByClassName:()=>[], getElementsByTagName:()=>[], createElement:()=>makeFakeElement(),
    createTextNode:()=>makeFakeElement(), createDocumentFragment:()=>makeFakeElement(),
    addEventListener:()=>{}, removeEventListener:()=>{}, execCommand:()=>true,
    body:makeFakeElement(), head:makeFakeElement(), documentElement:makeFakeElement(), cookie:'', readyState:'complete', title:'' };
}
function makeLocalStorage(){ const map=new Map(); return {
  getItem:k=>map.has(String(k))?map.get(String(k)):null, setItem:(k,v)=>{map.set(String(k),String(v));},
  removeItem:k=>{map.delete(String(k));}, clear:()=>map.clear(), key:i=>Array.from(map.keys())[i]??null, get length(){return map.size;} };
}
function buildSandbox(scriptSrc) {
  const localStorage = makeLocalStorage(); const noop=()=>{}; const fakeWindow={};
  const sandbox = {
    document: makeDocument(), localStorage, sessionStorage: makeLocalStorage(),
    console: { log:noop, warn:noop, error:noop, info:noop, debug:noop },
    fetch: () => Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve({}), text:()=>Promise.resolve('') }),
    setTimeout: ()=>0, clearTimeout: noop, setInterval: ()=>0, clearInterval: noop,
    requestAnimationFrame: ()=>0, cancelAnimationFrame: noop, queueMicrotask: fn=>{try{fn();}catch(e){}},
    alert: noop, confirm: ()=>true, prompt: ()=>null,
    navigator: { userAgent:'node-test', onLine:true },
    location: { href:'http://localhost/bp.html', hostname:'localhost', search:'', hash:'', reload:noop },
    history: { pushState:noop, replaceState:noop },
    crypto: (typeof globalThis.crypto!=='undefined')?globalThis.crypto:{ getRandomValues:a=>a, randomUUID:()=>'0' },
    Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error, Map, Set, Promise, Symbol, Reflect, Proxy,
    parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
  };
  sandbox.window=fakeWindow; sandbox.self=fakeWindow; sandbox.globalThis=sandbox;
  fakeWindow.localStorage=localStorage; fakeWindow.location=sandbox.location; fakeWindow.navigator=sandbox.navigator;
  fakeWindow.document=sandbox.document; fakeWindow.addEventListener=noop;
  const context = vm.createContext(sandbox);
  const epilogue = `
;(function(){
  try { globalThis.__parseReply = parseReply; } catch(e){ globalThis.__e1 = String(e); }
  try { globalThis.__buildActions = buildTranscriptLoadActions; } catch(e){ globalThis.__e2 = String(e); }
  try { globalThis.__byName = booReadRecordingByName; } catch(e){ globalThis.__e3 = String(e); }
  try { globalThis.__getPending = function(){ return _pendingLoadTargets; }; } catch(e){ globalThis.__e4 = String(e); }
  try { globalThis.__setActive = function(a){ _activeTranscriptIds = a; }; } catch(e){ globalThis.__e5 = String(e); }
  try { globalThis.__setTx = function(id,t){ _transcriptStore[id] = t; }; } catch(e){ globalThis.__e6 = String(e); }
  try { globalThis.__setBooRead = function(fn){ booReadRecording = fn; }; } catch(e){ globalThis.__e7 = String(e); }
  try { globalThis.__state = state; } catch(e){ globalThis.__e8 = String(e); }
  try { globalThis.__setTrigger = function(fn){ triggerBooDirectly = fn; }; } catch(e){ globalThis.__e9 = String(e); }
  try { globalThis.__getActive = function(){ return _activeTranscriptIds; }; } catch(e){ globalThis.__e10 = String(e); }
})();`;
  vm.runInContext(scriptSrc + '\n' + epilogue, context, { filename:'bp.html#inline', timeout:20000 });
  return sandbox;
}

let PASS=0, FAIL=0;
function ok(c,n){ if(c){console.log('PASS: '+n);PASS++;} else {console.log('FAIL: '+n);FAIL++;} }

function main() {
  let sb;
  try { sb = buildSandbox(extractFirstInlineScript(fs.readFileSync(BP_PATH,'utf8'))); }
  catch(e){ console.error('FATAL: sandbox load failed:\n'+(e&&e.stack||e)); process.exit(2); }
  const errs = ['__e1','__e2','__e3','__e4','__e5','__e6','__e7','__e8'].filter(k=>sb[k]);
  if (errs.length || typeof sb.__parseReply!=='function' || typeof sb.__buildActions!=='function') {
    console.error('FATAL: could not expose prompt internals: '+errs.map(k=>k+'='+sb[k]).join('; ')); process.exit(2);
  }
  const parseReply=sb.__parseReply, buildActions=sb.__buildActions, byName=sb.__byName, state=sb.__state;

  // Two recordings for one guest: d1 is the full interview, d2 the thin retake fragment.
  state.recordings = [{ id:'d1', guest:'Dora Palfi' }, { id:'d2', guest:'Dora Palfi' }];
  state.guestRepo = [];
  sb.__setTx('d1', 'X'.repeat(50000));
  sb.__setTx('d2', 'y'.repeat(500));

  // 3. Resolver picks the RICHEST recording.
  const loaded = [];
  sb.__setBooRead(function(id){ loaded.push(id); });
  byName('Dora Palfi');
  ok(loaded.length === 1 && loaded[0] === 'd1', 'booReadRecordingByName loads the richest recording (skips the fragment)');

  // 1. parseReply strips the directive and records the target.
  const out = parseReply('I can give you the gist, but the exact wording is in the interview.\nLOAD-TRANSCRIPT: Dora Palfi\nWant me to pull it?');
  ok(out.indexOf('LOAD-TRANSCRIPT') === -1, 'LOAD-TRANSCRIPT directive stripped from the visible reply');
  ok(out.indexOf('exact wording is in the interview') !== -1, 'surrounding prose is preserved');
  ok((sb.__getPending() || []).indexOf('Dora Palfi') !== -1, 'parseReply records the load target');

  // 2. buildTranscriptLoadActions -> exactly one one-tap load action, and it works.
  sb.__setActive([]);
  const acts = buildActions();
  ok(acts && acts.length === 1 && /Load Dora Palfi's transcript/.test(acts[0].label), 'builds one one-tap load action');
  loaded.length = 0;
  acts[0].action();
  ok(loaded[0] === 'd1', 'tapping the load action loads the richest recording');

  // 4. No button when that transcript is already loaded.
  parseReply('LOAD-TRANSCRIPT: Dora Palfi');       // re-arm the target
  sb.__setActive(['d1']);
  ok(buildActions() === null, 'no load button when the transcript is already loaded');

  // Unknown guest -> no action (and no crash).
  parseReply('LOAD-TRANSCRIPT: Nobody McNoface');
  sb.__setActive([]);
  ok(buildActions() === null, 'no load button for a guest with no recording');

  // LOAD-TRANSCRIPT: ALL -> a single "load all" action that loads every recording.
  sb.__setTrigger(function(){});   // don't fire a real Boo turn
  parseReply('Here is my provisional plan from the cards.\nLOAD-TRANSCRIPT: ALL\nLoad them so I can finalize.');
  sb.__setActive([]);
  const allActs = buildActions();
  ok(allActs && allActs.length === 1 && /Load all 2 transcripts/.test(allActs[0].label), 'LOAD-TRANSCRIPT: ALL builds one load-all action for every recording with a transcript');
  allActs[0].action();
  const active = sb.__getActive() || [];
  ok(active.indexOf('d1') !== -1 && active.indexOf('d2') !== -1, 'load-all action loads every recording at once');
  parseReply('LOAD-TRANSCRIPT: ALL');
  ok(buildActions() === null, 'no load-all button when everything is already loaded');

  console.log('\n' + PASS + ' passed, ' + FAIL + ' failed');
  process.exit(FAIL === 0 ? 0 : 1);
}
main();
