#!/usr/bin/env node
/*
 * test_edit_script.js — Boo's episode edit scripts (✦ Script → WRITE-SCRIPT → streamed writer).
 *
 * Drives the REAL bp.html code in a vm sandbox. Proves:
 *   1. Action buttons survive serialization: buildActions() turns actions into onclick SOURCE,
 *      so a captured variable is lost. _actionCall bakes the argument in — the serialized
 *      onclick, evaluated on its own, calls the right function with the right value (numbers,
 *      names with spaces and apostrophes). The per-guest LOAD-TRANSCRIPT button is fixed too.
 *   2. WRITE-SCRIPT: E<n> is stripped from chat and becomes a one-tap "Write the E<n> script"
 *      button whose serialized onclick calls writeEpisodeScript(n).
 *   3. Clip verification: exact clips verify ✓ with a ≈timecode; reworded clips are flagged;
 *      invented clips are "missing"; a clip filed under the wrong guest is flagged; an
 *      unreadable CLIP line is surfaced, not dropped.
 *   4. The script request: Opus model, streaming, adaptive thinking, no sampling params,
 *      pinned direction + transcripts in a cache_control'd leading block, ends on a user turn.
 *   5. streamScriptCall assembles text from SSE split at arbitrary byte boundaries; a stream cut
 *      off before message_stop, an error event, and a refusal all THROW (nothing half-saved).
 *   6. Saving is non-destructive: every version is kept; replacing the current script waits on
 *      the data-mutation confirmation, and a cancel leaves the current script untouched.
 *   7. callBoo tells Boo about edit scripts / WRITE-SCRIPT, and carries the saved script.
 *   8. Rendering escapes everything (a script line can't inject HTML).
 *   9. Season plumbing the scripting flow depends on: a real 0 episode count stays 0 (no phantom
 *      8 Plot-Mountain episodes sent to Boo); + Add episode on a freshly loaded (split) season
 *      creates E1 and the Season view sees it; Boo gets no beat labels before a shape is chosen;
 *      an episode created as {} still has a chat log.
 *  11. Found by the live sandbox run: Boo's ORIGINAL reply (rawText) is kept in his history (an
 *      addMsg wrapper dropped it since the port); the writer leaves room for thinking (Opus
 *      once spent the whole budget thinking and wrote nothing) and an EMPTY result is an error,
 *      never saved; a directive-only reply still renders a sentence.
 *  12. Story shapes: every season shape in Boo's SHAPE LIBRARY can be drawn (registry + prompt
 *      can't drift); SEASON-ARC: becomes a "Use this arc" button; applying it places each episode
 *      on its planned beat (not even slices), adds missing slots, keeps existing titles, and the
 *      curve lands Kartik's season BELOW its opening height; cancel changes nothing.
 *  13. Readability (Mark: "I can't tell what's from the recording and what needs recording";
 *      the checks were "cumbersome"): host lines are marked 🎙 RECORD, clips ▶ FROM INTERVIEW;
 *      an overview counts what to record vs clips; CONFIRMs become ONE numbered checklist grouped
 *      by who checks, with tick-boxes that save; a recording sheet holds only the host lines with
 *      cues; the text downloads carry the same; Boo's one question is about intent.
 *  14. A live failure ("cut off after 0 characters", no clue why): the error now reports
 *      seconds, HTTP status, server events and the last event; a connection that drops before
 *      any script text retries once automatically (free); a drop mid-writing is not retried.
 *  15. The 400-second wall (live E2: all 8 transcripts + long context made Opus plan past the
 *      proxy's limit): WRITE-SCRIPT names the episode's recordings; the writer sends only those
 *      full transcripts (ALL for host episodes); a long drop is NOT auto-retried (already billed)
 *      and the user is told plainly the server's time ran out.
 *  16. Share document (Mark: "sloppy… how would I even copy and share"): a traditional script —
 *      title block, numbered segments, SPEAKER in caps once per run of lines, clips as IN/OUT
 *      cues with ≈time, editor notes in [brackets], open questions on a final page grouped by
 *      who checks; no verification badges; everything escaped.
 *  10. The pre-interview script detector no longer hijacks prose: a reply that DISCUSSES an
 *      episode's opening and outro stays a chat reply and leaves the script field untouched;
 *      a real STEP-3 script with OPENING / OUTRO headings still routes to the teleprompter.
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

// Fetch: capture the proxy body; a test can install a streaming responder.
const cap = { body: null, stream: null };
function sseBody(chunks) {
  const enc = new TextEncoder(); let i = 0;
  return { getReader(){ return { read(){ return Promise.resolve(i < chunks.length ? { done:false, value: enc.encode(chunks[i++]) } : { done:true, value: undefined }); } }; } };
}
function fetchImpl(url, opts) {
  const u = String(url);
  if (/builder_state|builder_transcripts/.test(u)) return Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve([]), text:()=>Promise.resolve('[]') });
  cap.body = (opts && opts.body) || null;
  if (cap.queue && cap.queue.length) { cap.calls = (cap.calls || 0) + 1; return Promise.resolve({ ok:true, status:200, body: sseBody(cap.queue.shift()), text:()=>Promise.resolve('') }); }
  if (cap.stream) return Promise.resolve({ ok:true, status:200, body: sseBody(cap.stream), text:()=>Promise.resolve('') });
  return Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve({ content:[{ text:'OK' }], usage:{ input_tokens:10, output_tokens:5 } }) });
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
    AbortController: globalThis.AbortController, TextDecoder: globalThis.TextDecoder, TextEncoder: globalThis.TextEncoder,
    Blob: function(){}, URL: { createObjectURL: ()=>'blob:x', revokeObjectURL: noop },
    navigator:{userAgent:'node',onLine:true},
    location:{href:'http://localhost/bp.html',hostname:'localhost',search:'',hash:'',reload:noop}, history:{pushState:noop,replaceState:noop},
    crypto: globalThis.crypto,
    Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error, Map, Set, Promise, Symbol, Reflect, Proxy, Function, parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
  };
  sandbox.window=win; sandbox.self=win; sandbox.globalThis=sandbox;
  win.localStorage=localStorage; win.location=sandbox.location; win.document=sandbox.document; win.fetch=sandbox.fetch; win.setTimeout=sandbox.setTimeout; win.addEventListener=noop;
  const context = vm.createContext(sandbox);
  const expose = ['callBoo','state','episodeStore','parseReply','buildReplyActions','buildActions','_actionCall',
    'verifyEditScript','locateClip','renderEditScriptHtml','buildEditScriptRequestBody','streamScriptCall',
    'saveEditScript','buildEpisodeScriptKickoff','buildCurrentEditScriptContext','activeEp','dataMutationProtocol','buildTranscriptLoadActions',
    'addEpisodeToSeason','epCountOf','seasonEpisodeCount','isScriptHeading','addMsg','getConversationHistory','writeEpisodeScript',
    'STORY_SHAPES','parseSeasonArc','applySeasonArc','getEpArcBeat','renderShapeStrip','activeStoryShape','activeStoryShapeId','beatKey',
    'parseConfirm','editScriptOverview','buildRecordingSheet','buildEditScriptText','buildRecordingSheetText','toggleConfirmCheck','buildEditScriptSystemPrompt','resolveScriptSources','buildShareScriptHtml'];
  const epilogue = '\n;(function(){\n'
    + expose.map(n => '  try { globalThis.__' + n + ' = ' + n + '; } catch(e){ globalThis.__err_' + n + ' = String(e); }').join('\n')
    + '\n  try { globalThis.__setShow = function(v){ currentShowCode = v; }; } catch(e){}\n'
    + '  try { globalThis.__setToast = function(fn){ showToast = fn; }; } catch(e){}\n'
    + '  try { globalThis.__setLoaded = function(v){ _supabaseLoaded = v; }; } catch(e){}\n'
    + '  try { globalThis.__setTx = function(id,t){ _transcriptStore[id] = t; }; } catch(e){}\n'
    + '  try { globalThis.__setActiveTx = function(a){ _activeTranscriptIds = a; }; } catch(e){}\n'
    + '  try { globalThis.__getPendingLoads = function(){ return _pendingLoadTargets; }; } catch(e){}\n'
    + '})();';
  vm.runInContext(scriptSrc + epilogue, context, { filename:'bp.html#inline', timeout:20000 });
  return sandbox;
}

let PASS=0, FAIL=0, FINISHED=false;
// A step that awaits a promise nobody resolves (e.g. a confirmation) makes Node exit 0 mid-test.
// That must never read as a pass.
process.on('exit', () => { if (!FINISHED) { console.log('FAIL: test did not run to completion (a step hung awaiting a promise)'); process.exitCode = 1; } });
function ok(c,n){ if(c){console.log('PASS: '+n);PASS++;} else {console.log('FAIL: '+n);FAIL++;} }

// Fake transcripts in Riverside's shape: speaker (mm:ss.ms) blocks, passages repeated.
const TX_DOM = [
  'Dr. Matthew Callison (00:02.894)', 'Three, two, one.', '',
  'Dominick Sanders (24:56.034)',
  "Some of those individuals that you know wanted to be entrepreneurs or do all these other things, they have the heart for it, they have the mind for it, but they just weren't great coders. Yeah. And it was like syntax or bust almost in certain situations.", '',
  'Dr. Kartik Mangalam (29:41.088)',
  "Like who like who's at the table when you're making those things. The ones that are the farthest from the opportunity are not the ones at the table when they are designing these different tools.", '',
].join('\n');
const TX_JIG = [
  'Jigar Patel (55:24.63)',
  "And all of these tools require internet access, right? So looping back, if kids don't have internet access, they can't access these AI tools.", '',
  'Kartik Mangalam (56:10.318)',
  "Like we were forgotten, we were forgotten. Well we're not doing any we're not changing anything, we're just repeating that with AI.", '',
].join('\n');

function evalOnclick(sb, html) {
  const m = String(html).match(/onclick="([^"]*)"/);
  if (!m) return 'NO_ONCLICK';
  try { vm.runInContext(m[1], sb); return 'OK'; } catch (e) { return 'THREW: ' + e.message; }
}

async function main() {
  let sb;
  try { sb = buildSandbox(extractFirstInlineScript(fs.readFileSync(BP_PATH,'utf8'))); }
  catch(e){ console.error('FATAL: sandbox load failed:\n'+(e&&e.stack||e)); process.exit(2); }
  for (const k of ['__parseReply','__verifyEditScript','__buildEditScriptRequestBody','__streamScriptCall','__saveEditScript','___actionCall','__buildActions']) {
    if (typeof sb[k] !== 'function') { console.error('FATAL: ' + k + ' not exposed (' + (sb['__err_' + k.slice(2)] || '?') + ')'); process.exit(2); }
  }
  const state = sb.__state;
  sb.__setShow('k12boss'); sb.__setToast(function(){}); sb.__setLoaded(false);
  state.recordings = [
    { id:'r-dom', guest:'Dominick Sanders', title:'Director', quotes:[] },
    { id:'r-jig', guest:'Jigar Patel', title:'Director', quotes:[] },
  ];
  sb.__setTx('r-dom', TX_DOM); sb.__setTx('r-jig', TX_JIG);

  // ---- 1. Serialized action buttons keep their argument ----
  const calls = [];
  vm.runInContext('booReadRecordingByName = function(n){ __calls.push(["load", n]); }; writeEpisodeScript = function(n){ __calls.push(["write", n]); };', Object.assign(sb, { __calls: calls }));
  const h1 = sb.__buildActions([{ label:'x', action: sb.___actionCall('writeEpisodeScript', 2) }]);
  ok(evalOnclick(sb, h1) === 'OK' && calls.some(c => c[0] === 'write' && c[1] === 2), 'serialized _actionCall onclick calls writeEpisodeScript(2) with no closure');
  const h2 = sb.__buildActions([{ label:'x', action: sb.___actionCall('booReadRecordingByName', "Dr. O'Brien \"Ace\" Fudge") }]);
  ok(evalOnclick(sb, h2) === 'OK' && calls.some(c => c[0] === 'load' && c[1] === "Dr. O'Brien \"Ace\" Fudge"), 'names with apostrophes and double quotes survive the onclick attribute intact');
  // The per-guest LOAD-TRANSCRIPT button (previously captured n → threw "n is not defined")
  sb.__setActiveTx([]);
  sb.__parseReply('Read this one first.\nLOAD-TRANSCRIPT: Jigar Patel');
  const loadHtml = sb.__buildActions(sb.__buildTranscriptLoadActions());
  calls.length = 0;
  ok(evalOnclick(sb, loadHtml) === 'OK' && calls.some(c => c[0] === 'load' && c[1] === 'Jigar Patel'), "per-guest 'Load transcript' button now works when clicked (was: n is not defined)");

  // ---- 2. WRITE-SCRIPT directive → one-tap button, stripped from chat ----
  const cleaned = sb.__parseReply('Here is my read.\nWRITE-SCRIPT: E2');
  ok(String(cleaned).indexOf('WRITE-SCRIPT') === -1, 'WRITE-SCRIPT directive is stripped from the visible reply');
  const acts = sb.__buildReplyActions();
  ok(Array.isArray(acts) && acts.some(a => /Write the E2 script/.test(a.label)), 'a "Write the E2 script" button is offered');
  calls.length = 0;
  ok(evalOnclick(sb, sb.__buildActions(acts.filter(a => /Write/.test(a.label)))) === 'OK' && calls.some(c => c[0] === 'write' && c[1] === 2), 'clicking it (serialized) calls writeEpisodeScript(2)');
  sb.__parseReply('Just a normal reply.');
  ok(sb.__buildReplyActions() === null, 'no button when Boo did not emit the directive');
  sb.__parseReply('WRITE-SCRIPT: S1-E3');
  ok((sb.__buildReplyActions() || []).some(a => /E3/.test(a.label)), 'accepts the S1-E3 form too');

  // ---- 3. Clip verification ----
  const SCRIPT = [
    '# S1-E2 · The Promise and the People It Forgets',
    'SHAPE: Frame Narrative — question, guest, sharper question',
    '## 1 · COLD OPEN · ~1',
    'CLIP: Dominick Sanders | FROM "they have the heart for it, they have the mind for it" | TO "it was like syntax or bust almost in certain situations." | the gate',
    'KARTIK: Syntax or bust. <b>That</b> was the deal.',
    'CLIP: Dominick Sanders | FROM "they have the passion for it and the brains for it" | TO "syntax or bust almost in certain situations." | reworded opening',
    'CLIP: Dominick Sanders | FROM "every child in america deserves a quantum computer by friday" | TO "and that is my final answer to everyone" | invented',
    'CLIP: Dominick Sanders | FROM "Like we were forgotten, we were forgotten." | TO "we\'re just repeating that with AI." | wrong guest',
    'CLIP: Jigar Patel FROM no pipes here',
    'CLIP: Dominick Sanders | FROM "they have the heart for it, they have the soul for it" | TO "syntax or bust almost in certain situations." | drifted opening',
    'CONFIRM: Matt\'s title before recording',
    'NOTE: music sting',
  ].join('\n');
  const chk = sb.__verifyEditScript(SCRIPT);
  const byJob = j => chk.clips.find(c => c.job === j);
  ok(chk.clips.length === 6, 'found all 6 CLIP lines (including the malformed one)');
  ok(byJob('the gate') && byJob('the gate').status === 'ok', 'exact clip verifies ✓');
  ok(byJob('the gate') && byJob('the gate').startTc === '24:56', 'verified clip is located at ≈24:56 (from the transcript, not from Boo)');
  ok(byJob('reworded opening') && byJob('reworded opening').status !== 'ok', 'a reworded opening is NOT passed as verified');
  ok(byJob('invented') && byJob('invented').status === 'missing', 'invented words are reported as not found in any transcript');
  const drift = byJob('drifted opening');
  ok(drift && drift.status === 'partial' && drift.fromExact === false && drift.startTc === '24:56', 'an opening that matches then drifts is flagged ⚠ (partial), still located at ≈24:56');
  const wg = byJob('wrong guest');
  ok(wg && wg.status === 'partial' && wg.wrongGuest && /Jigar/.test(wg.recGuest), "words found only in another guest's transcript are flagged as the wrong guest");
  ok(chk.clips.some(c => c.malformed && c.status === 'unreadable') && chk.counts.unreadable === 1 && chk.counts.missing === 2, 'an unreadable CLIP line is surfaced as unreadable (not counted as "not found")');
  ok(chk.confirms === 1 && chk.segments === 1, 'counts CONFIRM lines and segments');

  // ---- 8. Rendering escapes ----
  const html = sb.__renderEditScriptHtml(SCRIPT, chk);
  ok(html.indexOf('<b>That</b>') === -1 && html.indexOf('&lt;b&gt;That&lt;/b&gt;') !== -1, 'script text is escaped — a line cannot inject HTML');
  ok(/✓ 1 clip verified/.test(html) && /not found in any transcript/.test(html), 'summary pills report verified and not-found counts');
  // Transcripts still loading (one recording has none yet): never a false "not found".
  state.recordings.push({ id: 'r-late', guest: 'Late Loader', title: '', quotes: [] });
  const pend = sb.__verifyEditScript(SCRIPT);
  const pendHtml = sb.__renderEditScriptHtml(SCRIPT, pend);
  ok(pend.pending === true && pend.counts.missing === 0 && pend.clips.filter(c => !c.malformed).every(c => c.status === 'pending'), 'while transcripts are still loading, clips are "pending", not "not found"');
  ok(/still loading/.test(pendHtml) && !/not found in any transcript/.test(pendHtml) && !/✕ not found/.test(pendHtml), 'the view says "still loading", never "not found", until transcripts arrive');
  state.recordings.pop();
  ok(sb.__verifyEditScript(SCRIPT).counts.ok === chk.counts.ok, 'once every transcript is in, clips verify normally again');

  // ---- 4. The script request body ----
  sb.__setActiveTx(['r-dom', 'r-jig']);
  const pins = (state.seasons[0] || (state.seasons[0] = {})).planningContext = [{ id:'p1', label:'Direction', text:'PIN_MARKER_7781 E2 opens on liberation' }];
  const body = sb.__buildEditScriptRequestBody(2);
  ok(body.model === 'claude-opus-5-5', 'script writer uses claude-opus-5-5');
  ok(body.stream === true && body.max_tokens >= 16000, 'request streams with room for a full script');
  ok(body.thinking && body.thinking.type === 'adaptive', 'adaptive thinking');
  ok(!('temperature' in body) && !('top_p' in body) && !('top_k' in body), 'no sampling params (rejected by current API)');
  ok(Array.isArray(body.system) && body.system[0].cache_control && body.system[0].cache_control.type === 'ephemeral', 'leading system block is cache_control:ephemeral');
  ok(body.system[0].text.indexOf('PIN_MARKER_7781') !== -1 && body.system[0].text.indexOf('syntax or bust') !== -1, 'pinned direction and full transcripts ride the cached block');
  ok(/CLIP: <guest name/.test(body.system[1].text) && /character-for-character/.test(body.system[1].text), 'system prompt carries the strict FORMAT and CLIP RULES');
  const last = body.messages[body.messages.length - 1];
  ok(last && last.role === 'user' && /S1-E2/.test(last.content), 'conversation ends on the user instruction to write S1-E2');
  ok(/exactly ONE question/.test(sb.__buildEpisodeScriptKickoff(2)) && /Do not write the script/.test(sb.__buildEpisodeScriptKickoff(2)), 'kickoff follows the dialogue pattern (hypothesis, ONE question, withhold)');
  pins.length = 0;

  // ---- 5. Streaming ----
  const ev = (o) => 'event: x\ndata: ' + JSON.stringify(o) + '\n\n';
  const full = ev({ type:'message_start', message:{ usage:{ input_tokens: 100, cache_read_input_tokens: 5000 } } })
    + ev({ type:'content_block_start', index:0, content_block:{ type:'thinking', thinking:'' } })
    + ev({ type:'content_block_delta', index:1, delta:{ type:'text_delta', text:'# S1-E2 · Title\n' } })
    + ev({ type:'content_block_delta', index:1, delta:{ type:'text_delta', text:'KARTIK: Hello.' } })
    + ev({ type:'message_delta', delta:{ stop_reason:'end_turn' }, usage:{ output_tokens: 42 } })
    + ev({ type:'message_stop' });
  const pieces = []; for (let i = 0; i < full.length; i += 37) pieces.push(full.slice(i, i + 37)); // split mid-event
  cap.stream = pieces;
  const progress = [];
  const r = await sb.__streamScriptCall({ stream: true }, (t, phase) => progress.push(phase));
  ok(r.text === '# S1-E2 · Title\nKARTIK: Hello.', 'text assembled from SSE split at arbitrary boundaries');
  ok(r.usage.output_tokens === 42 && r.usage.cache_read_input_tokens === 5000 && r.stopReason === 'end_turn', 'usage + stop reason captured');
  ok(progress[0] === 'thinking' && progress.indexOf('writing') !== -1, 'progress reports thinking, then writing');
  async function throws(chunks) { cap.stream = chunks; try { await sb.__streamScriptCall({}, null); return false; } catch (e) { return e.message; } }
  const cut = await throws([ev({ type:'content_block_delta', delta:{ type:'text_delta', text:'half a scri' } })]);
  ok(cut && /cut off/.test(cut), 'a stream cut off before message_stop throws (nothing half-saved)');
  ok(!!(await throws([ev({ type:'error', error:{ message:'Overloaded' } })])), 'a stream error event throws');
  ok(!!(await throws([ev({ type:'message_delta', delta:{ stop_reason:'refusal' } }), ev({ type:'message_stop' })])), 'a refusal throws');
  cap.stream = null;

  // ---- 6. Non-destructive save ----
  const ep = sb.__episodeStore[2] = {};
  await sb.__saveEditScript(2, 'VERSION ONE', { counts:{ ok:1 }, segments:1, confirms:0 });
  ok(ep.editScript && ep.editScript.text === 'VERSION ONE', 'first script becomes the current script');
  ok(ep.editScriptVersions.length === 1, 'and is kept in the version history');
  const p = sb.__saveEditScript(2, 'VERSION TWO', { counts:{ ok:1 }, segments:1, confirms:0 });
  await new Promise(res => setImmediate(res));
  ok(sb.__dataMutationProtocol.hasPending(), 'replacing an existing script waits for confirmation (data-mutation protocol)');
  sb.__dataMutationProtocol.confirmOperation(false);
  const applied = await p;
  ok(applied === false && ep.editScript.text === 'VERSION ONE', 'cancel leaves the current script untouched');
  ok(ep.editScriptVersions.length === 2 && ep.editScriptVersions[1].text === 'VERSION TWO', 'the new version is still kept (nothing lost)');
  const p2 = sb.__saveEditScript(2, 'VERSION THREE', { counts:{}, segments:0, confirms:0 });
  await new Promise(res => setImmediate(res));
  sb.__dataMutationProtocol.confirmOperation(true);
  await p2;
  ok(ep.editScript.text === 'VERSION THREE', 'confirm replaces the current script');

  // ---- 7. callBoo knows about edit scripts and carries the saved one ----
  state.currentEpisode = { number: 2, title: '' };
  cap.body = null;
  await sb.__callBoo('How does the cold open feel?');
  const sys = (() => { try { const s = JSON.parse(cap.body).system; return Array.isArray(s) ? s.map(b => b.text).join('\n') : String(s); } catch (e) { return ''; } })();
  ok(/EPISODE EDIT SCRIPTS/.test(sys) && /WRITE-SCRIPT: E<episode number>/.test(sys), 'callBoo explains edit scripts and the WRITE-SCRIPT directive');
  ok(sys.indexOf('CURRENT EDIT SCRIPT') !== -1 && sys.indexOf('VERSION THREE') !== -1, "the episode's saved script rides along so Boo can critique it");

  // ---- 9. Season plumbing ----
  ok(sb.__epCountOf({ episodeCount: 0 }) === 0 && sb.__epCountOf({}) === 8 && sb.__epCountOf({ episodeCount: 3 }) === 3, 'epCountOf: a real 0 stays 0; unset falls back to 8');
  // A freshly loaded season: currentSeason and seasons[0] are separate objects with 0 episodes.
  const s0 = { number: 1, theme: '', episodes: [], episodeOrder: [], episodeCount: 0, storyShape: 'plot-mountain', storyShapeChosen: false, planningContext: [] };
  state.seasons = [s0];
  state.currentSeason = JSON.parse(JSON.stringify(s0));
  sb.__addEpisodeToSeason();
  ok(s0.episodes.length === 1 && s0.episodes[0].number === 1, '+ Add episode on a 0-episode season creates E1 (was E9)');
  ok(state.currentSeason.episodeCount === 1 && sb.__seasonEpisodeCount() === 1, 'the Season view (reads currentSeason) sees the new episode');
  sb.__addEpisodeToSeason(); sb.__addEpisodeToSeason();
  ok(s0.episodes.map(e => e.number).join(',') === '1,2,3' && state.currentSeason.episodeCount === 3, 'three adds give E1, E2, E3');
  state.currentEpisode = { number: 1, title: '' };
  sb.__episodeStore[1] = {};
  cap.body = null;
  await sb.__callBoo('hello');
  const sys9 = (() => { try { const x = JSON.parse(cap.body).system; return Array.isArray(x) ? x.map(b => b.text).join('\n') : String(x); } catch (e) { return ''; } })();
  ok(cap.body !== null, 'callBoo works on an episode that was created as {} (chat log is ensured)');
  ok(!/S1-E4/.test(sys9) && /S1-E3/.test(sys9), 'Boo is told about exactly the 3 real episodes — no phantom E4–E8');
  ok(!/\[(Exposition|Rising Action|Climax|Resolution|Conflict|Denouement)\]/.test(sys9) && /not mapped yet/.test(sys9), 'no Plot Mountain beat labels before a shape is chosen');
  state.currentSeason.episodeCount = 0; s0.episodeCount = 0; s0.episodes = []; state.currentSeason.episodes = [];
  cap.body = null;
  await sb.__callBoo('hello');
  const sys0 = (() => { try { const x = JSON.parse(cap.body).system; return Array.isArray(x) ? x.map(b => b.text).join('\n') : String(x); } catch (e) { return ''; } })();
  ok(!/S1-E\d+[^\n]*\n  Guest:/.test(sys0) && !/S1-E8/.test(sys0), 'with 0 episodes, Boo is not told about 8 phantom episodes (empty arc list)');

  // ---- 10. Script detector: headings, not prose ----
  state.currentEpisode = { number: 5, title: '' };
  sb.__episodeStore[5] = { conversationLog: [], script: 'ORIGINAL PRE-INTERVIEW SCRIPT' };
  const prose = 'The opening has to earn the barbershop story, and the outro should hand the listener the Syntax Gate project.\n\nOpening with an equity voice sets the moral center. What do you want the outro to leave them feeling?';
  const outProse = sb.__parseReply(prose);
  ok(sb.__episodeStore[5].script === 'ORIGINAL PRE-INTERVIEW SCRIPT', "prose mentioning 'opening' and 'outro' does NOT overwrite the episode's script field");
  ok(String(outProse).indexOf('Script ready!') === -1 && String(outProse).indexOf('barbershop story') !== -1, 'that prose renders as a normal chat reply');
  const real = 'OPENING\nWelcome to K12 Boss.\n\nGUEST INTRO\nOur guest today...\n\nQUESTIONS\n1. What is barbershop computing?\n\nOUTRO\nThanks for listening.';
  const outReal = sb.__parseReply(real);
  ok(String(outReal).indexOf('Script ready!') !== -1 && sb.__episodeStore[5].script === real, 'a real script with OPENING/OUTRO headings still routes to the teleprompter');
  ok(sb.__isScriptHeading('## Opening (0:00)', 'OPENING') && sb.__isScriptHeading('**OUTRO**', 'OUTRO') && !sb.__isScriptHeading('Opening with an equity voice sets the moral center before anything descends.', 'OPENING'), 'heading forms accepted; a prose sentence is not a heading');

  // ---- 11. Fixes from the live sandbox run ----
  state.currentEpisode = { number: 6, title: '' };
  sb.__episodeStore[6] = { conversationLog: [] };
  sb.__addMsg('boo', 'shown to the user', null, 'RAW ORIGINAL REPLY\nWRITE-SCRIPT: E6');
  const lastEntry = sb.__episodeStore[6].conversationLog.slice(-1)[0];
  ok(lastEntry && lastEntry.rawText === 'RAW ORIGINAL REPLY\nWRITE-SCRIPT: E6', "Boo's original reply (rawText) is stored — the addMsg wrapper no longer drops it");
  const hist = sb.__getConversationHistory();
  ok(hist.length && hist[hist.length - 1].content === 'RAW ORIGINAL REPLY\nWRITE-SCRIPT: E6', 'and that original is what Boo re-reads next turn');
  const b2 = sb.__buildEditScriptRequestBody(6);
  ok(b2.max_tokens >= 48000 && b2.output_config && b2.output_config.effort === 'medium', 'writer budget leaves room for thinking (max_tokens ≥ 48k, effort medium)');
  // An all-thinking, no-text result must not be saved.
  sb.__episodeStore[6].editScript = { text: 'KEEP ME', createdAt: 'x' };
  cap.stream = [ev({ type:'message_start', message:{ usage:{ input_tokens: 10 } } }),
    ev({ type:'content_block_start', index:0, content_block:{ type:'thinking', thinking:'' } }),
    ev({ type:'message_delta', delta:{ stop_reason:'max_tokens' }, usage:{ output_tokens: 64000 } }), ev({ type:'message_stop' })];
  const logLenBefore = sb.__episodeStore[6].conversationLog.length;
  await sb.__writeEpisodeScript(6);
  cap.stream = null;
  ok(sb.__episodeStore[6].editScript.text === 'KEEP ME' && !(sb.__episodeStore[6].editScriptVersions || []).length, 'an empty (all-thinking) result is NOT saved and does not touch the current script');
  const errMsg = sb.__episodeStore[6].conversationLog.slice(logLenBefore).map(m => m.text).join(' ');
  ok(/whole budget planning/.test(errMsg) && /Nothing was saved/.test(errMsg), 'the user is told plainly what happened and that nothing was saved');
  const dirOnly = sb.__parseReply('WRITE-SCRIPT: E6');
  ok(String(dirOnly).trim().length > 0 && /write E6/.test(dirOnly), 'a directive-only reply renders a sentence, not an empty bubble');

  // ---- 12. Story shapes ----
  const SH = sb.__STORY_SHAPES;
  state.currentEpisode = { number: 1, title: '' };
  cap.body = null; await sb.__callBoo('shape check');
  const sysS = (() => { try { const x = JSON.parse(cap.body).system; return Array.isArray(x) ? x.map(b => b.text).join('\n') : String(x); } catch (e) { return ''; } })();
  const LIB = { 'THE MOUNTAIN': 'plot-mountain', 'THE QUESTION': 'the-question', 'THE BRAID': 'the-braid', 'THE DESCENT & RETURN': 'descent-return', 'THE TURN': 'the-turn', 'VIGNETTES-ON-A-SPINE': 'vignettes' };
  const libNames = (sysS.match(/^- ([A-Z][A-Z &-]+) — beats:/gm) || []).map(l => l.replace(/^- /, '').replace(/ — beats:$/, ''));
  const seasonLib = libNames.filter(n => n !== 'THE PRESSURE COOKER');
  ok(seasonLib.length >= 6 && seasonLib.every(n => LIB[n] && SH[LIB[n]]), "every season shape in Boo's SHAPE LIBRARY has a drawable registry entry (" + seasonLib.join(', ') + ')');
  const libBeats = n => { const m = sysS.match(new RegExp('^- ' + n.replace(/[&-]/g, '\\$&') + ' — beats: (.*?)\\. Best', 'm')); return m ? m[1].split(' → ').length : -1; };
  ok(seasonLib.filter(n => n !== 'THE MOUNTAIN').every(n => libBeats(n) === SH[LIB[n]].beats.length), 'each drawn shape has the same number of beats Boo describes');
  ok(SH.kartik && /Kartik/.test(sysS) && sysS.indexOf("kartik (Kartik's Recipe): height, floor, climb") !== -1, "Kartik's variant is drawable and its exact keys are in Boo's prompt");
  ok(/SEASON-ARC: <shape id>/.test(sysS), 'Boo is told how to put the arc on screen');

  const ARC = 'SEASON-ARC: kartik | E1=height "The Ceiling Is Gone", E2=height, E3=floor, E4=floor "I Helped Write the Curriculum", E5=floor, E6=climb, E7=climb, E8=climb, E9=climb, E10=climb "Up But Not All the Way"';
  ok(!sb.__parseSeasonArc(ARC).error, 'a valid SEASON-ARC parses');
  ok(/unknown shape/.test(sb.__parseSeasonArc('SEASON-ARC: freytag | E1=height').error || ''), 'an unknown shape is rejected');
  ok(/beats not in/.test(sb.__parseSeasonArc('SEASON-ARC: kartik | E1=height, E2=climax').error || ''), 'a beat that is not in the shape is rejected');

  // Fresh 3-episode season, as in the sandbox.
  const s1 = { number: 1, theme: '', episodes: [{ number: 1, title: 'Existing E1 title' }, { number: 2, title: '' }, { number: 3, title: '' }], episodeOrder: [], episodeCount: 3, storyShape: 'plot-mountain', storyShapeChosen: false, planningContext: [] };
  state.seasons = [s1]; state.currentSeason = JSON.parse(JSON.stringify(s1));
  const vis = sb.__parseReply('Here is the arc.\n' + ARC);
  ok(String(vis).indexOf('SEASON-ARC') === -1, 'the SEASON-ARC directive is stripped from chat');
  const arcBtn = (sb.__buildReplyActions() || []).find(a => /Use this arc/.test(a.label));
  ok(!!arcBtn, 'a "Use this arc" button is offered');
  const seen = [];
  vm.runInContext('applySeasonArc = function(x){ __seenArc.push(x); };', Object.assign(sb, { __seenArc: seen }));
  ok(evalOnclick(sb, sb.__buildActions([arcBtn])) === 'OK' && seen[0] === ARC, 'clicking it (serialized) passes the exact directive, titles with quotes intact');
  vm.runInContext('applySeasonArc = __applySeasonArc;', sb);

  sb.confirm = () => false;
  ok(sb.__applySeasonArc(ARC) === false && s1.episodeCount === 3 && !s1.episodeBeats && sb.__activeStoryShapeId() === 'plot-mountain', 'cancel changes nothing');
  sb.confirm = () => true;
  ok(sb.__applySeasonArc(ARC) === true, 'confirm applies the arc');
  ok(s1.episodeCount === 10 && s1.episodes.length === 10 && state.currentSeason.episodeCount === 10, 'missing slots E4–E10 are added (and the Season view sees them)');
  ok(s1.episodes[0].title === 'Existing E1 title' && s1.episodes[3].title === 'I Helped Write the Curriculum' && s1.episodes[9].title === 'Up But Not All the Way', 'existing titles kept; empty ones filled from the arc');
  ok(sb.__activeStoryShapeId() === 'kartik' && state.currentSeason.storyShapeChosen === true, "the season's shape is now Kartik's Recipe, marked chosen");
  const lbl = n => sb.__getEpArcBeat(n).label;
  ok(lbl(1) === 'The Height' && lbl(2) === 'The Height' && lbl(3) === 'All the Way Down' && lbl(5) === 'All the Way Down' && lbl(6) === 'Up, Not All the Way' && lbl(10) === 'Up, Not All the Way', 'each episode sits on its PLANNED beat (E2 still on the height, E3–E5 at the floor) — not even slices');
  const f = n => sb.__activeStoryShape().beats.find(b => b.label === lbl(n)).fortune;
  ok(f(10) < f(1) && f(10) > f(4), 'the curve lands E10 below the opening height and above the floor');
  const strip = sb.__renderShapeStrip(sb.__activeStoryShape(), 10);
  ok(/All the Way Down<br><span[^>]*>Eps 3–5/.test(strip) && /The Height<br><span[^>]*>Eps 1–2/.test(strip), 'the arc pills show the planned ranges (Eps 1–2, Eps 3–5)');

  // A placement that does NOT coincide with the shape's even slices (Kartik's 2/3/5 split happens
  // to match them) — proves episodes follow the saved arc, not the slicing.
  ok(sb.__applySeasonArc('SEASON-ARC: kartik | E1=height, E2=height, E3=height, E4=floor, E5=floor, E6=floor, E7=floor, E8=climb, E9=climb, E10=climb') === true
     && lbl(3) === 'The Height' && lbl(7) === 'All the Way Down' && lbl(8) === 'Up, Not All the Way', 'placement follows the saved arc even where it differs from even slicing (E3 height, E7 floor)');

  // ---- 13. Readability: record vs interview, one checklist, recording sheet ----
  ok(sb.__parseConfirm('CONFIRM: Kartik — check your bio').who === 'Kartik' && sb.__parseConfirm('CONFIRM: Kartik — check your bio').text === 'check your bio', 'an explicit owner tag is parsed');
  ok(sb.__parseConfirm('CONFIRM: Matt only keeps his line if true').who === 'Matt', 'a host as the subject owns the check');
  ok(sb.__parseConfirm("CONFIRM: Kartik's line says Sabba worked at Apple.").who === 'Mark', "\"Kartik's line says…\" is a fact check for the producer, not Kartik");
  const RS = ['# S1-E1 · Test', '## 1 · OPEN · ~1', 'KARTIK: Opening line one.', 'CONFIRM: Kartik — his bio as spoken.',
    'CLIP: Dominick Sanders | FROM "they have the heart for it, they have the mind for it" | TO "it was like syntax or bust almost in certain situations." | the gate',
    'MATT: After the clip, Matt speaks.', 'NOTE: music sting', 'CONFIRM: Dominick says first-ever; check with him.', 'MATT: Closing line.'].join('\n');
  sb.__episodeStore[7] = { conversationLog: [], editScript: { text: RS, createdAt: '2026-10-29T00:00:00Z' } };
  const ovw = sb.__editScriptOverview(RS);
  ok(ovw.hostLines === 3 && ovw.hosts.Kartik.lines === 1 && ovw.hosts.Matt.lines === 2 && ovw.clips === 1, 'overview counts lines to record per host vs interview clips');
  ok(ovw.confirms.length === 2 && ovw.confirms[0].who === 'Kartik' && ovw.confirms[1].who === 'Mark' && ovw.confirms[0].n === 1, 'checks are numbered and owned');
  const rh = sb.__renderEditScriptHtml(RS, null, { epNum: 7, interactive: true });
  ok((rh.match(/<span class="es-rec">🎙 RECORD<\/span>/g) || []).length === 3 && /▶ FROM INTERVIEW · Dominick Sanders/.test(rh), 'every host line (3) is labeled RECORD; clips say FROM INTERVIEW');
  ok(/TO RECORD<\/b> — 3 host lines/.test(rh) && /FROM INTERVIEWS<\/b> — 1 clip/.test(rh), 'the overview tells what to record vs what comes from interviews');
  ok(/BEFORE RECORDING — 2 checks/.test(rh) && (rh.match(/⚑ check #\d/g) || []).length === 2 && rh.indexOf('⚑ CONFIRM —') === -1, 'checks are gathered into one checklist; inline they shrink to ⚑ markers');
  const boxHtml = (rh.match(/<input type="checkbox"[^>]*>/) || [''])[0];
  const seenChk = [];
  vm.runInContext('toggleConfirmCheck = function(n, id){ __seenChk.push([n, id]); };', Object.assign(sb, { __seenChk: seenChk }));
  const onc = (boxHtml.match(/onclick="([^"]*)"/) || [])[1];
  try { vm.runInContext(onc, sb); } catch (e) {}
  ok(seenChk.length === 1 && seenChk[0][0] === 7 && /^c[0-9a-z]+$/.test(seenChk[0][1]), 'a tick-box click calls toggleConfirmCheck(episode, check id)');
  vm.runInContext('toggleConfirmCheck = __toggleConfirmCheck;', sb);
  sb.__toggleConfirmCheck(7, ovw.confirms[0].id);
  ok(sb.__episodeStore[7].editScript.checked[ovw.confirms[0].id] === true, 'ticking a check saves it on the script');
  ok(/BEFORE RECORDING — 2 checks · 1 done/.test(sb.__renderEditScriptHtml(RS, null, { epNum: 7, interactive: true })), 'the checklist shows progress after a reload');
  sb.__toggleConfirmCheck(7, ovw.confirms[0].id);
  ok(!sb.__episodeStore[7].editScript.checked[ovw.confirms[0].id], 'ticking again un-ticks');
  const sheet = sb.__buildRecordingSheet(RS);
  ok(sheet.length === 3 && sheet.map(r => r.who).join(',') === 'KARTIK,MATT,MATT', 'the recording sheet holds only the host lines, in order');
  ok(sheet[1].cue === 'after ▶ Dominick Sanders — the gate' && sheet[0].cue === '' && sheet[2].cue === '', 'a line right after a clip carries a cue for what plays before it');
  const st = sb.__buildEditScriptText(RS), rst = sb.__buildRecordingSheetText(RS);
  ok(/BEFORE RECORDING — 2 checks/.test(st) && /\[RECORD\] KARTIK: Opening line one\./.test(st) && /\[FROM INTERVIEW\] CLIP:/.test(st), 'the script download carries the checklist and RECORD / FROM INTERVIEW marks');
  ok(/RECORDING SHEET — 3 lines/.test(rst) && rst.indexOf('CLIP:') === -1 && rst.indexOf('NOTE:') === -1 && /\(after ▶ Dominick Sanders/.test(rst), 'the recording-sheet download is host lines + cues only');
  ok(/CONFIRM: <Kartik\|Matt\|Mark> —/.test(sb.__buildEditScriptSystemPrompt(2)) && /Keep CONFIRMs few/.test(sb.__buildEditScriptSystemPrompt(2)), 'the writer is told to tag who checks each CONFIRM and keep them few');
  ok(/ONE question about INTENT/.test(sb.__buildEpisodeScriptKickoff(2)) && /Logistics are NOT the question/.test(sb.__buildEpisodeScriptKickoff(2)), "Boo's one question is about intent, not logistics");

  // ---- 14. Dropped connections: diagnostics + one free retry ----
  const FULL = [ev({ type:'message_start', message:{ usage:{ input_tokens: 5 } } }), ev({ type:'content_block_delta', index:1, delta:{ type:'text_delta', text:'# S1-E8 · Retry\nKARTIK: It worked.' } }),
    ev({ type:'message_delta', delta:{ stop_reason:'end_turn' }, usage:{ output_tokens: 9 } }), ev({ type:'message_stop' })];
  const DROP0 = [ev({ type:'message_start', message:{ usage:{} } }), ev({ type:'content_block_start', index:0, content_block:{ type:'thinking', thinking:'' } })];
  cap.queue = [DROP0.slice()];
  let diag = '';
  try { await sb.__streamScriptCall({}, null); } catch (e) { diag = e.message; }
  ok(/cut off after 0 characters \(\d+s, HTTP 200, 2 server events, last: content_block_start\)/.test(diag), 'a cut-off reports seconds, HTTP status, server events and the last event');
  state.currentEpisode = { number: 8, title: '' };
  sb.__episodeStore[8] = { conversationLog: [] };
  cap.calls = 0; cap.queue = [DROP0.slice(), FULL.slice()];
  await sb.__writeEpisodeScript(8);
  ok(cap.calls === 2 && sb.__episodeStore[8].editScript && /It worked/.test(sb.__episodeStore[8].editScript.text), 'a drop before any writing retries once automatically and succeeds');
  const DROPMID = [ev({ type:'message_start', message:{ usage:{} } }), ev({ type:'content_block_delta', index:1, delta:{ type:'text_delta', text:'# S1-E9 · half a scr' } })];
  sb.__episodeStore[9] = { conversationLog: [] }; state.currentEpisode = { number: 9, title: '' };
  cap.calls = 0; cap.queue = [DROPMID.slice(), FULL.slice()];
  await sb.__writeEpisodeScript(9);
  ok(cap.calls === 1 && !sb.__episodeStore[9].editScript, 'a drop after writing started is NOT retried (that would cost a second full run) and nothing is saved');
  const msg9 = sb.__episodeStore[9].conversationLog.slice(-1)[0].text;
  ok(/cut off after 20 characters/.test(msg9) && /Nothing was saved/.test(msg9), 'the user sees the diagnostic and that nothing was saved');
  cap.queue = null;

  // ---- 15. Scoped sources + the 400-second wall ----
  sb.__parseReply('Ready.\nWRITE-SCRIPT: E2 | Dominick Sanders');
  const sBtn = (sb.__buildReplyActions() || []).find(a => /Write the E2 script/.test(a.label));
  const seenW = [];
  vm.runInContext('writeEpisodeScript = function(n, src){ __seenW.push([n, src]); };', Object.assign(sb, { __seenW: seenW }));
  ok(sBtn && evalOnclick(sb, sb.__buildActions([sBtn])) === 'OK' && seenW[0] && seenW[0][0] === 2 && seenW[0][1] === 'Dominick Sanders', 'WRITE-SCRIPT names the recordings; the button passes them to the writer');
  vm.runInContext('writeEpisodeScript = __writeEpisodeScript;', sb);
  sb.__parseReply('WRITE-SCRIPT: E1');
  ok(((sb.__buildReplyActions() || [])[0] || {}).label && /ALL/.test(String((sb.__buildReplyActions() || [])[0].action)), 'no names means ALL (host episodes)');
  const bDom = sb.__buildEditScriptRequestBody(2, 'Dominick Sanders');
  ok(bDom.system[0].text.indexOf('syntax or bust') !== -1 && bDom.system[0].text.indexOf('we were forgotten') === -1, "only Dominick's full transcript is sent for E2");
  ok(/only for: Dominick Sanders/.test(bDom.messages[bDom.messages.length - 1].content) && /never quote them/.test(bDom.messages[bDom.messages.length - 1].content) && /not in the materials I was given/.test(bDom.messages[bDom.messages.length - 1].content), 'the writer is told whose transcripts it has, not to quote the others, and never to call an unseen guest detail "unsupported"');
  const bAll = sb.__buildEditScriptRequestBody(1, 'ALL');
  ok(bAll.system[0].text.indexOf('syntax or bust') !== -1 && bAll.system[0].text.indexOf('we were forgotten') !== -1, 'ALL sends every transcript');
  ok(sb.__resolveScriptSources('Nobody Real').all === true && sb.__resolveScriptSources('Jigar Patel, Dominick Sanders').recs.length === 2, 'unknown names fall back to ALL; a list resolves each name');
  ok(/WRITE-SCRIPT: E2 \| <guest names, or ALL>/.test(sb.__buildEpisodeScriptKickoff(2)), 'the kickoff tells Boo to name the recordings');
  // A drop at the 400-second wall: no auto-retry (already billed), plain explanation.
  let wallCalls = 0;
  vm.runInContext('__realStream = streamScriptCall; streamScriptCall = function(){ __wall(); var e = new Error("the connection was cut off after 0 characters (400s, HTTP 200, 15 server events, last: ping)"); e.cutOff = true; e.chars = 0; e.elapsed = 400; return Promise.reject(e); };', Object.assign(sb, { __wall: () => wallCalls++ }));
  sb.__episodeStore[10] = { conversationLog: [] }; state.currentEpisode = { number: 10, title: '' };
  await sb.__writeEpisodeScript(10, 'Dominick Sanders');
  vm.runInContext('streamScriptCall = __realStream;', sb);
  const wallMsg = sb.__episodeStore[10].conversationLog.slice(-1)[0].text;
  ok(wallCalls === 1, 'a drop after minutes of planning is NOT retried automatically (it was already billed)');
  ok(/ran out of time planning/.test(wallMsg) && /6½ minutes/.test(wallMsg) && /Nothing was saved/.test(wallMsg), 'the user is told plainly the server time ran out, and nothing was saved');

  // ---- 16. Share document ----
  const SH_TXT = ['# S1-E7 · The <Promise>', 'SHAPE: Holding the height', 'JOB: Open the guest arc', 'RUNTIME: 42', '## 1 · COLD OPEN · ~0.5', 'NOTE: No music under the clip.',
    'CLIP: Dominick Sanders | FROM "they have the heart for it, they have the mind for it" | TO "it was like syntax or bust almost in certain situations." | the gate',
    '## 2 · INTRO · ~2.5', 'MATT: Line one.', 'CONFIRM: Mark — check his title.', 'MATT: Line two.', 'KARTIK: Kartik speaks.', 'CONFIRM: Kartik — your bio as spoken.'].join('\n');
  sb.__episodeStore[11] = { conversationLog: [], editScript: { text: SH_TXT, createdAt: '2026-10-29T12:00:00Z' } };
  const share = sb.__buildShareScriptHtml(11);
  ok(/Season 1 · Episode 11/.test(share) && share.indexOf('The &lt;Promise&gt;') !== -1 && share.indexOf('<Promise>') === -1, 'title block present; the title is escaped');
  ok(/1\. COLD OPEN/.test(share) && /2\. INTRO/.test(share) && /~0\.5 min/.test(share), 'numbered segments with timing');
  ok((share.match(/>MATT<\/p>/g) || []).length === 1 && (share.match(/>KARTIK<\/p>/g) || []).length === 1 && /Line one\./.test(share) && /Line two\./.test(share), 'speaker name once per run of lines, in caps, script-style (a hidden check between lines does not repeat the name)');
  ok(/▶ CLIP 1 — DOMINICK SANDERS \(interview\)/.test(share) && /<b>IN:<\/b> “they have the heart/.test(share) && /<b>OUT:<\/b>/.test(share) && /≈ 24:56/.test(share), 'clips are IN/OUT cue blocks with ≈time');
  ok(/\[No music under the clip\.\]/.test(share), 'editor notes in [brackets]');
  ok(share.indexOf('check his title') > share.indexOf('Before recording — open questions') && share.indexOf('Before recording') > share.indexOf('Kartik speaks'), 'open questions are gathered on a final page, not inline');
  ok(!/✓ found|⚠ check|verified/.test(share), 'no verification badges in the shared document');
  ok(sb.__buildShareScriptHtml(999) === '', 'no script, no document');

  FINISHED = true;
  console.log('\n' + PASS + ' passed, ' + FAIL + ' failed');
  process.exit(FAIL ? 1 : 0);
}
main().catch(e => { console.error('FATAL: ' + (e && e.stack || e)); process.exit(2); });
