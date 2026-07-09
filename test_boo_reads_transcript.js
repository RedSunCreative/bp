#!/usr/bin/env node
/*
 * test_boo_reads_transcript.js — proves Boo actually RECEIVES full transcripts.
 *
 * Storing transcripts wasn't enough: Boo's chat prompt only got the summary
 * cards, so he truthfully said he couldn't read transcripts. booReadRecording()
 * loads a recording's FULL text into _activeTranscriptIds, and callBoo() must
 * then embed that verbatim text in the system prompt it sends to the model.
 *
 * This drives the REAL callBoo() in a vm sandbox with a fetch stub that CAPTURES
 * the request body, and asserts:
 *   1. With no active transcript, the prompt has NO focused-transcript block.
 *   2. With an active transcript, the prompt DOES contain the block header AND
 *      the verbatim transcript text AND the guest name.
 *   3. loadTranscript backs it (cache), so the text Boo sees is the real text.
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
function buildSandbox(scriptSrc, fetchImpl) {
  const localStorage = makeLocalStorage(); const noop=()=>{}; const fakeWindow={};
  const sandbox = {
    document: makeDocument(), localStorage, sessionStorage: makeLocalStorage(),
    console: { log:noop, warn:noop, error:noop, info:noop, debug:noop },
    fetch: fetchImpl,
    setTimeout: ()=>0, clearTimeout: noop, setInterval: ()=>0, clearInterval: noop,
    requestAnimationFrame: ()=>0, cancelAnimationFrame: noop, queueMicrotask: fn=>{try{fn();}catch(e){}},
    alert: noop, confirm: ()=>true, prompt: ()=>null,
    AbortController: (typeof globalThis.AbortController!=='undefined')?globalThis.AbortController:function(){this.signal={};this.abort=noop;},
    navigator: { userAgent:'node-test', onLine:true },
    location: { href:'http://localhost/bp.html', hostname:'localhost', search:'', hash:'', reload:noop },
    history: { pushState:noop, replaceState:noop },
    crypto: (typeof globalThis.crypto!=='undefined')?globalThis.crypto:{ getRandomValues:a=>a, randomUUID:()=>'0' },
    Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error, Map, Set, Promise, Symbol, Reflect, Proxy,
    parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
  };
  sandbox.window=fakeWindow; sandbox.self=fakeWindow; sandbox.globalThis=sandbox;
  fakeWindow.localStorage=localStorage; fakeWindow.location=sandbox.location; fakeWindow.navigator=sandbox.navigator;
  fakeWindow.document=sandbox.document; fakeWindow.fetch=fetchImpl; fakeWindow.addEventListener=noop;
  const context = vm.createContext(sandbox);
  const epilogue = `
;(function(){
  try { globalThis.__callBoo = callBoo; } catch(e){ globalThis.__e1 = String(e); }
  try { globalThis.__state = state; } catch(e){ globalThis.__e2 = String(e); }
  try { globalThis.__setActive = function(a){ _activeTranscriptIds = a; }; } catch(e){ globalThis.__e3 = String(e); }
  try { globalThis.__setTx = function(id,t){ _transcriptStore[id] = t; }; } catch(e){ globalThis.__e4 = String(e); }
  try { globalThis.__setLoaded = function(v){ _supabaseLoaded = v; }; } catch(e){ globalThis.__e5 = String(e); }
  try { globalThis.__setShow = function(v){ currentShowCode = v; }; } catch(e){ globalThis.__e6 = String(e); }
})();`;
  vm.runInContext(scriptSrc + '\n' + epilogue, context, { filename:'bp.html#inline', timeout:20000 });
  return sandbox;
}

let PASS=0, FAIL=0;
function ok(c,n){ if(c){console.log('PASS: '+n);PASS++;} else {console.log('FAIL: '+n);FAIL++;} }

const TX = 'BARBERSHOP COMPUTING is where it started [05:01]. Access does not equal equity [39:58]. UNIQUE_MARKER_9x7.';

async function main() {
  let captured = null;
  const fetchImpl = (url, opts) => {
    if (opts && opts.body) { try { captured = JSON.parse(opts.body); } catch(e) {} }
    return Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve({ content:[{ text:'ok' }] }), text:()=>Promise.resolve('') });
  };
  let sb;
  try { sb = buildSandbox(extractFirstInlineScript(fs.readFileSync(BP_PATH,'utf8')), fetchImpl); }
  catch(e){ console.error('FATAL: sandbox load failed:\n'+(e&&e.stack||e)); process.exit(2); }
  const errs = ['__e1','__e2','__e3','__e4','__e5','__e6'].filter(k=>sb[k]);
  if (errs.length || typeof sb.__callBoo!=='function') {
    console.error('FATAL: could not expose callBoo internals: '+errs.map(k=>k+'='+sb[k]).join('; ')); process.exit(2);
  }
  const callBoo=sb.__callBoo, state=sb.__state;
  sb.__setShow('k12boss'); sb.__setLoaded(true);
  state.recordings = [{ id:'r1', guest:'Dominick Sanders', shape:'Redemption', tension:'Access is not equity.' }];
  sb.__setTx('r1', TX);

  // 1. No active transcript → no focused block, and card summary still present.
  sb.__setActive([]);
  captured = null;
  await callBoo('hi');
  ok(!!captured && typeof captured.system === 'string', 'callBoo sent a system prompt');
  ok(captured.system.indexOf('READ THESE DIRECTLY') === -1, 'no active transcript → no FOCUSED TRANSCRIPTS block injected');
  ok(captured.system.indexOf('UNIQUE_MARKER_9x7') === -1, 'no active transcript → verbatim text NOT in prompt');
  ok(captured.system.indexOf('Dominick Sanders') !== -1, 'card summary (guest name) still travels every turn');

  // 2. Active transcript → full verbatim text embedded, with header + guest name.
  sb.__setActive(['r1']);
  captured = null;
  await callBoo('read Dominick');
  ok(captured.system.indexOf('READ THESE DIRECTLY') !== -1, 'active transcript → FOCUSED TRANSCRIPTS block present');
  ok(captured.system.indexOf('UNIQUE_MARKER_9x7') !== -1, 'active transcript → verbatim transcript text embedded in prompt');
  ok(captured.system.indexOf('[05:01]') !== -1, 'active transcript → timecodes preserved for Boo to cite');
  ok(captured.system.indexOf('FULL TRANSCRIPT: Dominick Sanders') !== -1, 'active transcript → labeled with the guest name');
  ok(/READ THESE DIRECTLY/i.test(captured.system), 'active transcript → instruction telling Boo he can read them');

  // 3. Missing cache entry is skipped gracefully (no crash, no empty block noise).
  sb.__setActive(['does-not-exist']);
  captured = null;
  await callBoo('read ghost');
  ok(captured.system.indexOf('READ THESE DIRECTLY') === -1, 'active id with no cached transcript → no block (skipped safely)');

  console.log('\n' + PASS + ' passed, ' + FAIL + ' failed');
  process.exit(FAIL === 0 ? 0 : 1);
}
main().catch(e=>{ console.error('FATAL: '+(e&&e.stack||e)); process.exit(2); });
