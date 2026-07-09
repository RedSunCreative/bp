#!/usr/bin/env node
/*
 * test_transcript_tip.js — the one-time "unload to save tokens" tip + unload.
 *
 * While a transcript is loaded, Boo offers ONCE (after a few turns) to unload it,
 * and the user taps to confirm (Boo can't self-execute). Proves against the REAL
 * maybeOfferTranscriptUnloadTip / clearActiveTranscripts in a vm sandbox with a
 * spied addMsg:
 *   1. No tip before the threshold; the tip fires exactly once at turn 3.
 *   2. It does NOT fire again on later turns (one-shot per load).
 *   3. The tip's "Unload" action clears _activeTranscriptIds.
 *   4. With nothing loaded, the tip logic is a no-op.
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
  try { globalThis.__maybeTip = maybeOfferTranscriptUnloadTip; } catch(e){ globalThis.__e1 = String(e); }
  try { globalThis.__clear = clearActiveTranscripts; } catch(e){ globalThis.__e2 = String(e); }
  try { globalThis.__setActive = function(a){ _activeTranscriptIds = a; }; } catch(e){ globalThis.__e3 = String(e); }
  try { globalThis.__getActive = function(){ return _activeTranscriptIds; }; } catch(e){ globalThis.__e4 = String(e); }
  try { globalThis.__resetTip = function(){ _txTurns = 0; _txTipShown = false; }; } catch(e){ globalThis.__e5 = String(e); }
  try { globalThis.__setAddMsg = function(fn){ addMsg = fn; }; } catch(e){ globalThis.__e6 = String(e); }
  try { globalThis.__state = state; } catch(e){ globalThis.__e7 = String(e); }
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
  const errs = ['__e1','__e2','__e3','__e4','__e5','__e6','__e7'].filter(k=>sb[k]);
  if (errs.length || typeof sb.__maybeTip!=='function' || typeof sb.__clear!=='function') {
    console.error('FATAL: could not expose tip internals: '+errs.map(k=>k+'='+sb[k]).join('; ')); process.exit(2);
  }
  const maybeTip=sb.__maybeTip, clear=sb.__clear, state=sb.__state;
  const calls = [];
  sb.__setAddMsg(function(role, html, actions){ calls.push({ role: role, html: html, actions: actions }); });
  state.recordings = [{ id:'r1', guest:'Dora Palfi' }];

  const tips = () => calls.filter(c => c.role==='boo' && Array.isArray(c.actions) && c.actions.some(a => /Unload transcript/.test(a.label)));

  // Load a transcript (simulate booReadRecording's state), reset the tip clock.
  sb.__setActive(['r1']); sb.__resetTip();

  maybeTip(); // turn 1
  maybeTip(); // turn 2
  ok(tips().length === 0, 'no unload tip before the threshold (turns 1–2)');

  maybeTip(); // turn 3
  ok(tips().length === 1, 'unload tip fires exactly once at turn 3');
  const tip = tips()[0];
  ok(tip.actions.some(a => /Unload transcript/.test(a.label)) && tip.actions.some(a => /Keep/.test(a.label)),
     'tip offers both Unload and Keep actions');

  maybeTip(); // turn 4
  maybeTip(); // turn 5
  ok(tips().length === 1, 'tip does NOT fire again on later turns (one-shot per load)');

  // The Unload action clears the loaded transcript.
  const unload = tip.actions.find(a => /Unload transcript/.test(a.label));
  unload.action();
  ok((sb.__getActive() || []).length === 0, 'tapping Unload clears _activeTranscriptIds');

  // With nothing loaded, the tip logic is a no-op (no throw, no new tip).
  const before = tips().length;
  maybeTip();
  ok(tips().length === before, 'no tip offered when no transcript is loaded');

  console.log('\n' + PASS + ' passed, ' + FAIL + ' failed');
  process.exit(FAIL === 0 ? 0 : 1);
}
main();
