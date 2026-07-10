#!/usr/bin/env node
/*
 * test_retry.js — callBoo auto-retries transient overloads instead of dead-ending.
 *
 * Drives the REAL callBoo in a vm sandbox with a controllable fetch. Proves:
 *   1. Overload-then-success: callBoo retries and returns the eventual reply,
 *      surfacing the "servers overloaded, trying again" note.
 *   2. Success first try: no retry, no note.
 *   3. Persistent overload: gives up after MAX_TRIES with a clear message.
 *   4. A real (non-transient) API error is NOT retried — surfaced immediately.
 *
 * setTimeout invokes callbacks immediately (the 60s abort is a no-op on the stub
 * fetch; the retry backoff resolves at once) so retries run fast in-test.
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
    const start = re.lastIndex, end = html.indexOf('</script>', start);
    if (end === -1) throw new Error('no closing </script>');
    return html.slice(start, end);
  }
  throw new Error('no inline <script> found');
}
function makeFakeElement() {
  const store = { innerHTML:'', value:'', textContent:'', className:'', checked:false, style:{}, dataset:{}, children:[], scrollTop:0, scrollHeight:0 };
  const handler = {
    get(t,p){ if(p===Symbol.toPrimitive||p==='toString') return ()=>'[FakeElement]'; if(p in store) return store[p]; return new Proxy(function(){}, handler); },
    set(t,p,v){ store[p]=v; return true; }, apply(){ return makeFakeElement(); },
  };
  return new Proxy(function(){}, handler);
}
function makeDocument() {
  return { getElementById:()=>makeFakeElement(), querySelector:()=>makeFakeElement(), querySelectorAll:()=>[], getElementsByClassName:()=>[], getElementsByTagName:()=>[], createElement:()=>makeFakeElement(), createElementNS:()=>makeFakeElement(), createTextNode:()=>makeFakeElement(), createDocumentFragment:()=>makeFakeElement(), addEventListener:()=>{}, removeEventListener:()=>{}, execCommand:()=>true, body:makeFakeElement(), head:makeFakeElement(), documentElement:makeFakeElement(), cookie:'', readyState:'complete', title:'' };
}
function makeLocalStorage(){ const map=new Map(); return { getItem:(k)=>(map.has(String(k))?map.get(String(k)):null), setItem:(k,v)=>{map.set(String(k),String(v));}, removeItem:(k)=>{map.delete(String(k));}, clear:()=>map.clear(), key:(i)=>Array.from(map.keys())[i]??null, get length(){return map.size;} }; }

// Controllable fetch: first `overloads` calls return HTTP 529 overloaded, then success.
const api = { calls: 0, overloads: 0, mode: 'overload' };
function fetchImpl(url, opts) {
  const u = String(url);
  if (/builder_state|builder_transcripts/.test(u)) return Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve([]) });
  api.calls++;
  if (api.mode === 'apierror') {
    return Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve({ error:{ type:'invalid_request_error', message:'bad request' } }) });
  }
  if (api.overloads > 0) {
    api.overloads--;
    return Promise.resolve({ ok:false, status:529, json:()=>Promise.resolve({ error:{ type:'overloaded_error', message:'Overloaded' } }) });
  }
  return Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve({ content:[{ text:'PLAN OK' }], usage:{ input_tokens:10, output_tokens:5 } }) });
}

function buildSandbox(scriptSrc) {
  const localStorage = makeLocalStorage(); const noop=()=>{}; const win={};
  const sandbox = {
    document: makeDocument(), localStorage, sessionStorage: makeLocalStorage(),
    console: { log:noop, warn:noop, error:noop, info:noop, debug:noop },
    fetch: function(){ return fetchImpl.apply(null, arguments); },
    setTimeout: (fn) => { try { fn(); } catch (e) {} return 0; },  // immediate: abort no-ops on stub, backoff resolves
    clearTimeout: noop, setInterval: ()=>0, clearInterval: noop,
    requestAnimationFrame: ()=>0, cancelAnimationFrame: noop, queueMicrotask: (fn)=>{try{fn();}catch(e){}},
    alert: noop, confirm: ()=>true, prompt: ()=>null,
    AbortController: (typeof globalThis.AbortController!=='undefined')?globalThis.AbortController:function(){this.signal={};this.abort=noop;},
    navigator:{userAgent:'node',onLine:true},
    location:{href:'http://localhost/bp.html',hostname:'localhost',search:'',hash:'',reload:noop}, history:{pushState:noop,replaceState:noop},
    crypto:(typeof globalThis.crypto!=='undefined')?globalThis.crypto:{getRandomValues:(a)=>a,randomUUID:()=>'0'},
    Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error, Map, Set, Promise, Symbol, Reflect, Proxy, parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
  };
  sandbox.window=win; sandbox.self=win; sandbox.globalThis=sandbox;
  win.localStorage=localStorage; win.location=sandbox.location; win.document=sandbox.document; win.fetch=sandbox.fetch; win.setTimeout=sandbox.setTimeout; win.addEventListener=noop;
  const context = vm.createContext(sandbox);
  const epilogue = `
;(function(){
  try { globalThis.__callBoo = callBoo; } catch(e){ globalThis.__e1 = String(e); }
  try { globalThis.__state = state; } catch(e){ globalThis.__e2 = String(e); }
  try { globalThis.__setShow = function(v){ currentShowCode = v; }; } catch(e){ globalThis.__e3 = String(e); }
  try { globalThis.__setToast = function(fn){ showToast = fn; }; } catch(e){ globalThis.__e4 = String(e); }
})();`;
  vm.runInContext(scriptSrc + '\n' + epilogue, context, { filename:'bp.html#inline', timeout:20000 });
  return sandbox;
}

let PASS=0, FAIL=0;
function ok(c,n){ if(c){console.log('PASS: '+n);PASS++;} else {console.log('FAIL: '+n);FAIL++;} }

async function main() {
  let sb;
  try { sb = buildSandbox(extractFirstInlineScript(fs.readFileSync(BP_PATH,'utf8'))); }
  catch(e){ console.error('FATAL: sandbox load failed:\n'+(e&&e.stack||e)); process.exit(2); }
  if (typeof sb.__callBoo !== 'function') { console.error('FATAL: callBoo not exposed'); process.exit(2); }
  const callBoo = sb.__callBoo, state = sb.__state;
  sb.__setShow('k12boss');
  state.recordings = [];
  const toasts = [];
  sb.__setToast(function(m){ toasts.push(String(m)); });
  const patience = () => toasts.filter(t => /Trying again for you in a few moments/.test(t));

  // 1. Two overloads then success → retried, recovered, patience note shown.
  api.calls = 0; api.overloads = 2; api.mode = 'overload'; toasts.length = 0;
  const r1 = await sb.__callBoo('Plan the season');
  ok(r1 === 'PLAN OK', 'overload-then-success: callBoo returns the eventual reply');
  ok(api.calls === 3, 'retried the right number of times (2 overloads + 1 success = 3 calls)');
  ok(patience().length >= 2, 'showed the "servers overloaded, trying again" note on each retry');
  ok(/Thank you for your patience/.test(patience()[0] || ''), 'note uses the requested wording');

  // 2. Success on first try → no retry, no note.
  api.calls = 0; api.overloads = 0; api.mode = 'overload'; toasts.length = 0;
  const r2 = await sb.__callBoo('Plan the season');
  ok(r2 === 'PLAN OK' && api.calls === 1, 'clean success does not retry');
  ok(patience().length === 0, 'no patience note when there was no overload');

  // 3. Persistent overload → gives up after MAX_TRIES with a clear message.
  api.calls = 0; api.overloads = 99; api.mode = 'overload'; toasts.length = 0;
  let threw = null;
  try { await sb.__callBoo('Plan the season'); } catch (e) { threw = e; }
  ok(!!threw, 'persistent overload eventually throws (does not hang or loop forever)');
  ok(api.calls === 4, 'gave up after MAX_TRIES (4) attempts');
  ok(threw && /overloaded/i.test(threw.message || ''), 'final error message names the overload');

  // 4. A real API error is NOT retried — surfaced on the first attempt.
  api.calls = 0; api.overloads = 0; api.mode = 'apierror'; toasts.length = 0;
  let threw2 = null;
  try { await sb.__callBoo('Plan the season'); } catch (e) { threw2 = e; }
  ok(!!threw2 && api.calls === 1, 'a non-transient API error is surfaced immediately (no retry)');

  console.log('\n' + PASS + ' passed, ' + FAIL + ' failed');
  process.exit(FAIL === 0 ? 0 : 1);
}
main().catch((e) => { console.error('FATAL: ' + (e && e.stack || e)); process.exit(2); });
