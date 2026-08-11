#!/usr/bin/env node
/*
 * test_planning_pin.js — the planning-context pin actually reaches Boo.
 *
 * The bar Mark set: "'The pin persists' isn't the bar; 'the pin changes the
 * output' is." So this drives the REAL callBoo in a vm sandbox with a capturing
 * fetch and asserts the pinned text is physically present in the request body's
 * system prompt during a Plan Season turn — and absent when nothing is pinned.
 *
 * Proves:
 *   1. BEHAVIORAL (headline): a pinned transcript's unique marker appears in the
 *      callBoo request during Plan Season, inside a cache_control'd leading block.
 *   2. Absence: with no pins, neither the marker nor the PINNED header is sent.
 *   3. buildSeasonPlanPrompt() points Boo at the PINNED PLANNING CONTEXT.
 *   4. pin / remove mutate the season-scoped store.
 *   5. The size cap is enforced (a pin that would blow the cap is refused).
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

// Capturing fetch: record the body of the Boo (proxy) call; stub Supabase.
const cap = { body: null };
function fetchImpl(url, opts) {
  const u = String(url);
  if (/builder_state|builder_transcripts/.test(u)) return Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve([]) });
  cap.body = (opts && opts.body) || null;
  return Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve({ content:[{ text:'PLAN OK' }], usage:{ input_tokens:10, output_tokens:5 } }) });
}

function buildSandbox(scriptSrc) {
  const localStorage = makeLocalStorage(); const noop=()=>{}; const win={};
  const sandbox = {
    document: makeDocument(), localStorage, sessionStorage: makeLocalStorage(),
    console: { log:noop, warn:noop, error:noop, info:noop, debug:noop },
    fetch: function(){ return fetchImpl.apply(null, arguments); },
    setTimeout: (fn) => { try { fn(); } catch (e) {} return 0; },
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
  try { globalThis.__setLoaded = function(v){ _supabaseLoaded = v; }; } catch(e){ globalThis.__e5 = String(e); }
  try { globalThis.__planPrompt = buildSeasonPlanPrompt; } catch(e){ globalThis.__e6 = String(e); }
  try { globalThis.__pin = pinToPlanningContext; } catch(e){ globalThis.__e7 = String(e); }
  try { globalThis.__removePin = removePlanningPin; } catch(e){ globalThis.__e8 = String(e); }
  try { globalThis.__pins = seasonPins; } catch(e){ globalThis.__e9 = String(e); }
  try { globalThis.__cap = _PLANNING_CAP; } catch(e){ globalThis.__e10 = String(e); }
  try { globalThis.__pinRec = pinRecordingTranscript; } catch(e){ globalThis.__e11 = String(e); }
  try { globalThis.__setTx = function(id,t){ _transcriptStore[id] = t; }; } catch(e){ globalThis.__e12 = String(e); }
})();`;
  vm.runInContext(scriptSrc + '\n' + epilogue, context, { filename:'bp.html#inline', timeout:20000 });
  return sandbox;
}

let PASS=0, FAIL=0;
function ok(c,n){ if(c){console.log('PASS: '+n);PASS++;} else {console.log('FAIL: '+n);FAIL++;} }
function sysText(body){ try{ const s=JSON.parse(body).system; return Array.isArray(s)?s.map(b=>b.text).join('\n'):String(s); }catch(e){ return ''; } }
function sysBlocks(body){ try{ const s=JSON.parse(body).system; return Array.isArray(s)?s:[{text:String(s)}]; }catch(e){ return []; } }

const MARKER = 'ZORP_PIN_MARKER_4417 — the new direction is workshop drops replace A Moment of Hope';

async function main() {
  let sb;
  try { sb = buildSandbox(extractFirstInlineScript(fs.readFileSync(BP_PATH,'utf8'))); }
  catch(e){ console.error('FATAL: sandbox load failed:\n'+(e&&e.stack||e)); process.exit(2); }
  for (const k of ['__callBoo','__state','__planPrompt','__pin','__removePin','__pins']) {
    if (typeof sb[k] !== 'function' && k !== '__state') { console.error('FATAL: '+k+' not exposed ('+sb['__e'+'?']+')'); process.exit(2); }
  }
  const state = sb.__state;
  sb.__setShow('k12boss');
  sb.__setToast(function(){});
  state.recordings = [];

  // ---- 1. BEHAVIORAL (headline): a pinned transcript reaches the Plan Season request ----
  const pins = sb.__pins();          // live array on state.seasons[0].planningContext
  pins.length = 0;
  pins.push({ id:'p1', label:'Planning meeting', text: MARKER });
  cap.body = null;
  await sb.__callBoo(sb.__planPrompt());
  const sent = sysText(cap.body);
  ok(cap.body !== null, 'Plan Season fired a request');
  ok(sent.indexOf(MARKER) !== -1, "HEADLINE: pinned content reaches the callBoo request during Plan Season");
  ok(sent.indexOf('===== PINNED PLANNING CONTEXT (the user pinned') !== -1, 'the pin block header is present in the request');
  const blocks = sysBlocks(cap.body);
  ok(Array.isArray(blocks) && blocks.length >= 2 && blocks[0].cache_control && blocks[0].cache_control.type === 'ephemeral',
     'the pin rides a cache_control:ephemeral leading block (cheap to re-send every turn)');
  ok((blocks[0].text || '').indexOf(MARKER) !== -1, 'the pinned text is in the CACHED block, not the volatile main prompt');

  // ---- 2. Absence: with nothing pinned, none of it is sent ----
  sb.__pins().length = 0;
  cap.body = null;
  await sb.__callBoo(sb.__planPrompt());
  const empty = sysText(cap.body);
  ok(empty.indexOf(MARKER) === -1, 'no marker sent when nothing is pinned');
  ok(empty.indexOf('===== PINNED PLANNING CONTEXT (the user pinned') === -1, 'no pin block sent when nothing is pinned (channel is opt-in)');

  // ---- 3. buildSeasonPlanPrompt points Boo at the pinned context ----
  ok(/PINNED PLANNING CONTEXT/.test(sb.__planPrompt()), 'buildSeasonPlanPrompt tells Boo to use the PINNED PLANNING CONTEXT');

  // ---- 4. pin / remove mutate the season-scoped store ----
  sb.__setLoaded(false);             // gate autoSave — we are testing the store, not the network
  sb.__pins().length = 0;
  const added = sb.__pin('some direction notes', 'Direction');
  ok(added === true && sb.__pins().length === 1, 'pinToPlanningContext adds a labeled pin');
  ok(sb.__pins()[0].label === 'Direction' && sb.__pins()[0].text === 'some direction notes', 'pin stores label + text');
  sb.__removePin(sb.__pins()[0].id);
  ok(sb.__pins().length === 0, 'removePlanningPin removes by id');

  // ---- 5. size cap is enforced ----
  sb.__pins().length = 0;
  const cap1 = sb.__cap;
  ok(cap1 === 150000, 'the char cap is the agreed 150,000');
  const big = 'x'.repeat(cap1 - 1000);
  ok(sb.__pin(big, 'big') === true && sb.__pins().length === 1, 'a pin under the cap is accepted');
  const over = 'y'.repeat(2000);     // 149000 + 2000 = 151000 > cap
  ok(sb.__pin(over, 'over') === false && sb.__pins().length === 1, 'a pin that would blow the cap is refused (not silently truncated)');

  // ---- 6. card-level: Pin transcript button pins a recording's FULL transcript by id (toggle) ----
  sb.__pins().length = 0;
  state.recordings = [{ id:'rec-1', guest:'Dora Palfi', tension:'candidate' }];
  const FULL = 'FULL_DORA_TRANSCRIPT_MARKER_88 ' + 'word '.repeat(80);
  sb.__setTx('rec-1', FULL);
  sb.__pinRec('rec-1');
  ok(sb.__pins().length === 1 && sb.__pins()[0].recId === 'rec-1', 'Pin transcript pins by recording id (card knows which)');
  ok(sb.__pins()[0].text === FULL.trim(), 'it pins the FULL transcript text, not the card summary');
  ok(/Dora Palfi/.test(sb.__pins()[0].label), 'the pin is labeled with the guest name');
  sb.__pinRec('rec-1');              // click again → toggle off
  ok(sb.__pins().length === 0, 'clicking Pin transcript again unpins (toggle)');

  // ---- 7. a card pin actually reaches Boo, keyed to its recId ----
  sb.__pins().length = 0;
  sb.__setTx('rec-1', FULL);
  sb.__pinRec('rec-1');
  sb.__setLoaded(true);
  cap.body = null;
  await sb.__callBoo(sb.__planPrompt());
  ok(sysText(cap.body).indexOf('FULL_DORA_TRANSCRIPT_MARKER_88') !== -1, 'a transcript pinned from its card reaches the callBoo request');

  console.log('\n' + PASS + ' passed, ' + FAIL + ' failed');
  process.exit(FAIL === 0 ? 0 : 1);
}
main().catch((e) => { console.error('FATAL: ' + (e && e.stack || e)); process.exit(2); });
