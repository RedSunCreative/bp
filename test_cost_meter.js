#!/usr/bin/env node
/*
 * test_cost_meter.js — the approximate session cost meter (trackUsage).
 *
 * Proves against the REAL trackUsage in a vm sandbox:
 *   1. Real usage is priced correctly (input/output/cache-write/cache-read).
 *   2. Cache reads are ~1/10th of input — so caching visibly lowers spend.
 *   3. Costs accumulate across turns.
 *   4. Without usage, it falls back to a ~4-chars/token estimate.
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
  const store = { innerHTML:'', value:'', textContent:'', className:'', checked:false, style:{}, dataset:{}, children:[] };
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
  try { globalThis.__track = trackUsage; } catch(e){ globalThis.__e1 = String(e); }
  try { globalThis.__getCost = function(){ return _sessionCostUSD; }; } catch(e){ globalThis.__e2 = String(e); }
  try { globalThis.__setCost = function(v){ _sessionCostUSD = v; }; } catch(e){ globalThis.__e3 = String(e); }
})();`;
  vm.runInContext(scriptSrc + '\n' + epilogue, context, { filename:'bp.html#inline', timeout:20000 });
  return sandbox;
}

let PASS=0, FAIL=0;
function ok(c,n){ if(c){console.log('PASS: '+n);PASS++;} else {console.log('FAIL: '+n);FAIL++;} }
function approx(a,b){ return Math.abs(a-b) < 1e-6; }

function main() {
  let sb;
  try { sb = buildSandbox(extractFirstInlineScript(fs.readFileSync(BP_PATH,'utf8'))); }
  catch(e){ console.error('FATAL: sandbox load failed:\n'+(e&&e.stack||e)); process.exit(2); }
  const errs = ['__e1','__e2','__e3'].filter(k=>sb[k]);
  if (errs.length || typeof sb.__track !== 'function') {
    console.error('FATAL: could not expose cost internals: '+errs.map(k=>k+'='+sb[k]).join('; ')); process.exit(2);
  }
  const track=sb.__track, getCost=sb.__getCost, setCost=sb.__setCost;

  // 1. Real usage priced correctly. 1M input tokens @ $3/M = $3.00.
  setCost(0); track({ usage: { input_tokens: 1000000, output_tokens: 0 } }, 0, '');
  ok(approx(getCost(), 3.00), '1M input tokens priced at $3.00');
  setCost(0); track({ usage: { output_tokens: 1000000 } }, 0, '');
  ok(approx(getCost(), 15.00), '1M output tokens priced at $15.00');
  setCost(0); track({ usage: { cache_creation_input_tokens: 1000000 } }, 0, '');
  ok(approx(getCost(), 3.75), '1M cache-write tokens priced at $3.75 (1.25x input)');

  // 2. Cache read is ~1/10th of input — the whole point of caching.
  setCost(0); track({ usage: { cache_read_input_tokens: 1000000 } }, 0, '');
  ok(approx(getCost(), 0.30), '1M cache-read tokens priced at $0.30 (0.1x input)');

  // A realistic loaded-transcript follow-up: 170k cached-read + 3k fresh input + 500 output.
  setCost(0);
  const cachedTurn = track({ usage: { cache_read_input_tokens: 170000, input_tokens: 3000, output_tokens: 500 } }, 0, '');
  const fullTurn   = (170000 * 3 + 3000 * 3 + 500 * 15) / 1e6; // same turn if NOT cached
  ok(cachedTurn < fullTurn * 0.25, 'a cached transcript turn costs far less than the uncached equivalent');

  // 3. Costs accumulate across turns.
  setCost(0);
  track({ usage: { input_tokens: 500000 } }, 0, '');  // $1.50
  track({ usage: { input_tokens: 500000 } }, 0, '');  // +$1.50
  ok(approx(getCost(), 3.00), 'costs accumulate across turns');

  // 4. Fallback estimate when the proxy returns no usage (~4 chars/token).
  setCost(0); track({}, 4000, 'x'.repeat(400)); // ~1000 in + ~100 out tokens
  ok(approx(getCost(), (1000 * 3 + 100 * 15) / 1e6), 'no-usage fallback estimates from char counts (~4 chars/token)');

  console.log('\n' + PASS + ' passed, ' + FAIL + ' failed');
  process.exit(FAIL === 0 ? 0 : 1);
}
main();
