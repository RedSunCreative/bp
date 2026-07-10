#!/usr/bin/env node
/*
 * test_savepath.js — the save-path hardening (incident 2026-07: silent save loss).
 *
 * Drives the REAL autoSave from bp.html in a vm sandbox with a controllable fake
 * Supabase (PATCH can be made to reject). Proves:
 *   1. A successful PATCH marks synced (no false failure).
 *   2. A non-2xx response is NOT treated as success — it flips _unsynced=true and
 *      does NOT update the server (the exact silent-loss bug).
 *   3. A later successful save recovers (unsynced clears) — the retry path.
 *   4. An oversized rollback history is trimmed under budget so the body isn't
 *      rejected (what was making the writes fail in the first place).
 *
 * setTimeout invokes callbacks < 1000ms immediately (so the autosave body runs)
 * but DEFERS >= 1000ms (so the 15s retry doesn't recurse infinitely in-test).
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
function makeLocalStorage() {
  const map = new Map();
  return { getItem:(k)=>(map.has(String(k))?map.get(String(k)):null), setItem:(k,v)=>{map.set(String(k),String(v));}, removeItem:(k)=>{map.delete(String(k));}, clear:()=>map.clear(), key:(i)=>Array.from(map.keys())[i]??null, get length(){return map.size;} };
}

// Controllable fake Supabase. PATCH: fails while failCount>0 (HTTP 413), else writes.
const server = { data:null, history:[], patches:0, failCount:0, lastBody:null };
function fetchImpl(url, opts) {
  const u = String(url), method = (opts && opts.method) || 'GET';
  if (/claude-proxy/.test(u)) return Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve({ content:[{ text:'' }] }) });
  if (/builder_state/.test(u)) {
    if (method === 'PATCH') {
      server.patches++;
      try { server.lastBody = JSON.parse(opts.body); } catch (e) {}
      if (server.failCount > 0) {
        server.failCount--;
        return Promise.resolve({ ok:false, status:413, text:()=>Promise.resolve('Payload Too Large'), json:()=>Promise.resolve({}) });
      }
      try { const b = JSON.parse(opts.body); server.data = b.data; if (b.history) server.history = b.history; } catch (e) {}
      return Promise.resolve({ ok:true, status:200, text:()=>Promise.resolve(''), json:()=>Promise.resolve({}) });
    }
    return Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve([{ data:server.data, history:server.history }]) });
  }
  return Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve({}) });
}

function buildSandbox(scriptSrc) {
  const localStorage = makeLocalStorage(); const noop=()=>{}; const win={};
  const sandbox = {
    document: makeDocument(), localStorage, sessionStorage: makeLocalStorage(),
    console: { log:noop, warn:noop, error:noop, info:noop, debug:noop },
    fetch: function(){ return fetchImpl.apply(null, arguments); },
    // Run immediate work (< 1s) but DEFER the 15s retry so the test doesn't recurse.
    setTimeout: (fn, ms) => { if (typeof ms === 'number' && ms >= 1000) return 0; try { fn(); } catch (e) {} return 0; },
    clearTimeout: noop, setInterval: ()=>0, clearInterval: noop,
    requestAnimationFrame: ()=>0, cancelAnimationFrame: noop, queueMicrotask: (fn)=>{try{fn();}catch(e){}},
    alert: noop, confirm: ()=>true, prompt: ()=>null,
    atob:(s)=>Buffer.from(String(s),'base64').toString('binary'), btoa:(s)=>Buffer.from(String(s),'binary').toString('base64'),
    URL:{createObjectURL:()=>'blob:stub',revokeObjectURL:noop}, Blob:function(){}, FileReader:function(){},
    navigator:{userAgent:'node',clipboard:{writeText:()=>Promise.resolve()},onLine:true},
    location:{href:'http://localhost/bp.html',hostname:'localhost',search:'',hash:'',reload:noop}, history:{pushState:noop,replaceState:noop},
    crypto:(typeof globalThis.crypto!=='undefined')?globalThis.crypto:{getRandomValues:(a)=>a,randomUUID:()=>'0'},
    Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error, Map, Set, Promise, Symbol, Reflect, Proxy, parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
  };
  sandbox.window=win; sandbox.self=win; sandbox.globalThis=sandbox;
  win.localStorage=localStorage; win.location=sandbox.location; win.document=sandbox.document; win.fetch=sandbox.fetch; win.setTimeout=sandbox.setTimeout; win.addEventListener=noop;
  const context = vm.createContext(sandbox);
  const epilogue = `
;(function(){
  try { globalThis.__autoSave = autoSave; } catch(e){}
  try { globalThis.__state = state; } catch(e){}
  try { globalThis.__setLoaded = function(v){ _supabaseLoaded = v; }; } catch(e){}
  try { globalThis.__setLastSnap = function(v){ _lastSavedSnap = v; }; } catch(e){}
  try { globalThis.__getUnsynced = function(){ return _unsynced; }; } catch(e){}
  try { globalThis.__setHistory = function(v){ sessionHistory = v; }; } catch(e){}
})();`;
  vm.runInContext(scriptSrc + '\n' + epilogue, context, { filename:'bp.html#inline', timeout:20000 });
  return sandbox;
}

const flush = () => new Promise((r) => setImmediate(r));
async function settle() { for (let i = 0; i < 12; i++) await flush(); }
let PASS=0, FAIL=0;
function ok(c,n){ if(c){console.log('PASS: '+n);PASS++;} else {console.log('FAIL: '+n);FAIL++;} }

function makeFull(state) {
  state.seasons = [{ number:1, seasonBrief:'X'.repeat(2000), episodes:[{ number:1 }, { number:2 }] }];
  state.currentSeason = state.seasons[0];
  state.currentEpisode = state.seasons[0].episodes[0];
  state.guestRepo = [{ name:'Kip' }];
}

async function main() {
  let sb;
  try { sb = buildSandbox(extractFirstInlineScript(fs.readFileSync(BP_PATH,'utf8'))); }
  catch(e){ console.error('FATAL: sandbox load failed:\n'+(e&&e.stack||e)); process.exit(2); }
  const autoSave = sb.__autoSave, state = sb.__state;
  if (typeof autoSave !== 'function' || !state || typeof sb.__getUnsynced !== 'function') {
    console.error('FATAL: autoSave/_unsynced not exposed — fix not present?'); process.exit(2);
  }

  // 1. Success → synced.
  sb.__setLoaded(true); sb.__setLastSnap(null); makeFull(state);
  server.data = null; server.patches = 0; server.failCount = 0;
  autoSave('ok-save', true); await settle();
  ok(server.patches === 1 && server.data && sb.__getUnsynced() === false, 'successful PATCH marks synced (not a false failure)');

  // 2. Non-2xx is NOT a false success — flips unsynced, does not update the server.
  sb.__setLoaded(true); sb.__setLastSnap(null); makeFull(state);
  server.data = null; server.patches = 0; server.failCount = 99; // reject everything
  autoSave('rejected-save', true); await settle();
  ok(server.patches >= 1, 'a PATCH was attempted');
  ok(sb.__getUnsynced() === true, 'HTTP error flips _unsynced=true (no silent false "saved")');
  ok(server.data === null, 'rejected save did NOT update the server row');

  // 3. A later successful save recovers (the retry path clears unsynced).
  server.failCount = 0;                    // server healthy again
  autoSave('recovery-save', true); await settle();
  ok(sb.__getUnsynced() === false, 'a later successful save clears the unsynced state');
  ok(server.data !== null, 'recovery save lands on the server');

  // 4. Oversized rollback history is trimmed under budget before the PATCH.
  sb.__setLoaded(true); sb.__setLastSnap(null); makeFull(state);
  const huge = [];
  for (let i = 0; i < 10; i++) huge.push({ savedAt: 't' + i, snap: { blob: 'X'.repeat(400000) } }); // ~4MB
  sb.__setHistory(huge);
  server.data = null; server.patches = 0; server.failCount = 0; server.lastBody = null;
  autoSave('big-history', true); await settle();
  ok(!!server.lastBody && Array.isArray(server.lastBody.history), 'PATCH body carries a history array');
  const histBytes = JSON.stringify(server.lastBody.history).length;
  ok(histBytes <= 2500000, 'oversized history trimmed under the ~2.5MB budget (was ~4MB) — body no longer rejected');
  ok(server.lastBody.history.length >= 1 && server.lastBody.history.length < 10, 'trim drops oldest points but keeps recent ones');

  console.log('\n' + PASS + ' passed, ' + FAIL + ' failed');
  process.exit(FAIL === 0 ? 0 : 1);
}
main().catch((e) => { console.error('FATAL: ' + (e && e.stack || e)); process.exit(2); });
