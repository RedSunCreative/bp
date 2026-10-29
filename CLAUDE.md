# Boo Producer — Claude Code Briefing

## Who I Am
Mark Caddell, Red Sun Creative Studio, Austin TX.
Boo Producer is the pre-production tool in the Boo Podcast Suite — episode planning, season arcs, guest research, topics, questions. It's Red Sun Creative's product for designing client podcasts and video, aimed eventually at clients too (lower production cost, richer shows, usable during recordings). Current client: **K12 Boss** podcast — "K-12 CS Education in a Post-Coding Era," hosts Karttikeya Mangalam (Kartik) + Matthew Callison (Matt), recorded on Riverside.fm. (Older notes and files say "Anno Coding" / `anno` — same hosts, same row 98; that name and code are gone from the app.)

## Delivery
BP is served via GitHub Pages. Local edits are invisible until pushed. Live URL (give it to Mark on its own line, never with punctuation after it — a trailing period breaks the link):

https://redsuncreative.github.io/bp/bp.html

**Every session with code changes:** `bash test_bp.sh` → `git commit` → `git push`. Never report work done without pushing.

## Login — show codes (no password)
Entered at the login screen; case-insensitive, **no spaces**. Defined in `SHOW_REGISTRY`.
| Code | Show | Supabase `builder_state` row |
|------|------|------|
| `k12boss` | K12 Boss — **live client data** | 98 |
| `k12bosstest1` | K12 Boss sandbox | 100 |
| `k12bosstest2` | K12 Boss sandbox | 101 |
| `lbv` | Little Big Voices: Mark's own show, streamed to YouTube. Placeholder for future BP use (row 97 not created yet) | 97 |

Use a test code for experiments — never row 98.

## The Boo Dialogue Philosophy

This is the most important thing in this codebase. Do not change it without understanding it.

**The pattern:** Boo leads with a hypothesis, then asks exactly ONE deepening question. It never dumps answers immediately. It makes the human think before it thinks.

The specific interaction that makes this work (from `findGuest()`):

> *"In 2 sentences, share your hypothesis for the ideal guest type — who they are professionally and the specific angle they bring to this episode. Then ask ONE specific question — something that would meaningfully change who you look for. Do not return candidate names yet."*

**Why this works:**
- It signals that Boo already has an opinion. The human is collaborating with an expert, not typing into a search box.
- The hypothesis is only 2 sentences — tight, confident, not hedged.
- ONE question forces Boo to identify the single most valuable unknown. Two questions is noise. Zero questions is a missed opportunity to learn from the human.
- "Do not return names yet" is critical. The moment names appear, the human stops thinking. The question becomes who, not what kind of person.

**The principle behind it:** The human should participate — think, wonder, redirect. Boo learns from the human before it commits to a direction. This is not a search tool. It is a thinking partner.

**Apply this pattern everywhere:**
- Episode intent → Boo reflects what it hears as the emotional core of the episode + one sharpening question
- Season arc → Boo names what the arc is really trying to prove + one question about what it hasn't accounted for
- Guest consideration → Boo asks what angle of this guest's work is most relevant to THIS episode, not just in general
- Any open-ended planning prompt → hypothesis first, one question, then results

**What breaks this:**
- Multiple questions in one turn (kills the rhythm, feels like a form)
- Boo being tentative ("I'm not sure but maybe...") — Boo is a seasoned floor director, not an intern
- Answering before asking (skips the collaboration, produces generic results)
- Questions that wouldn't change the output ("Do you want a big guest or a small guest?")

## Architecture
Single file: `bp.html`. No build step.
- `SHOW_REGISTRY` — show code → `{rowId, config}`. `SHOW_CONFIG` is populated from it at login (`submitShowCode()`); `getShowRow()` returns the active row id
- `state` / `episodeStore` — all episode data, keyed by episode number
- `activeEp()` — auto-initializes episode bucket, always use this
- `conversationLog` — per-episode array of `{role, text, rawText?, html?}`
  - `rawText`: original API text, used by `getConversationHistory()` so Boo's context stays clean
  - `html`: rendered HTML, used by restore code so guest cards re-render as cards after refresh
- `autoSave(reason, immediate)` — patches the active show's `builder_state` row (`getShowRow()`) via REST PATCH. Blocked until `_supabaseLoaded` is true (load gate — never write before load completes); backs up the prior snapshot before overwriting
- `backup_bp.sh [rowId]` — off-app, timestamped backup of a live row into `backups/` (gitignored); restore instructions are in the script header
- **Automatic backups:** `auto_backup_bp.sh` saves row 98 and the k12boss transcripts at login and every 2 hours, and discards copies identical to the previous one. It runs as the launchd job `net.redsuncreative.bp-backup`. macOS blocks background jobs from reading ~/Documents, so `install_auto_backup.sh` copies the scripts to `~/Library/Application Support/BooBackups/bp/bin`. Re-run the installer after editing either script. The backups and `auto_backup.log` are in `bp/backups/auto` (a link to that folder). Pruning only removes plain timestamped files; hand-named backups (`PRE-*`, `EOD-*`, …) are never deleted.
- Little Big Voices runs on **Boo Episode Builder (BEB)** and **Boo Show Manager (BSM)**, not BP; its data lives there. The `lbv` code in BP is a placeholder for using BP on LBV someday. Row 97 hasn't been created, and BP's save is a PATCH (it updates an existing row and does nothing when the row is missing), so create the row before using `lbv` for real.
- `triggerBooDirectly(displayText, apiPrompt)` — fires Boo without touching the chat input field. Use this for all button-triggered Boo interactions. The `displayText` is a short label shown in chat; `apiPrompt` is the full context sent to the API.
- `callBoo(prompt)` → `parseReply()` → `formatGuestSuggestions()` → `buildGuestCard()` — guest card pipeline. `callBoo` auto-retries transient API overloads

## Recordings, transcripts & pins (Season screen)
- Recordings are cards on the Season screen; transcripts are stored durably in Supabase (`hydrateTranscripts()`) so they travel across devices.
- Each card has three verbs, left to right:
  - **📄 Read** — `viewRecordingTranscript(id)`: full-screen read-only viewer for the human. Zero API calls, zero tokens.
  - **✦ Have Boo read this** — `booReadRecording(id)` / `loadTranscript(id)`: loads the transcript into Boo's context (prompt-cached; unload chip shown).
  - **📌 Pin transcript** — `pinRecordingTranscript(id)`: durable planning-context pin.
- **Planning-context pins** (`seasonPins()`, `pinToPlanningContext()`, `pinFromChat()`) are season-scoped and ride every Boo turn. Cap: `_PLANNING_CAP` = 150,000 chars.
- Boo should prompt to load a transcript rather than bluff from the card; it can emit one-tap LOAD-TRANSCRIPT buttons.
- **Plan Season** runs the interrogation methodology over already-recorded material. Each season shape (e.g. THE QUESTION, Kartik's height→down→partial-up variant) has its own beat vocabulary — don't default to Freytag.
- A session cost meter shows approximate spend.

## Edit scripts (Season screen → ✦ Script)
An **edit script** is the assembly plan for a *finished* episode: host lines Kartik and Matt record, interleaved with verbatim guest clips cut from the recorded interviews. It's different from the pre-interview `script` field (live-interview questions). The flow follows the Boo Dialogue Pattern:
1. **✦ Script** on a season row → `startEpisodeScript(n)` loads every transcript, then Boo gives a 2-sentence hypothesis and ONE question. He writes nothing yet.
2. When Boo has the direction, he emits `WRITE-SCRIPT: E<n>` → `parseReply` turns it into a one-tap **Write the E<n> script** button (`buildReplyActions`).
3. `writeEpisodeScript(n)` streams a dedicated long-form call (`SCRIPT_MODEL` = `claude-opus-5-5`, adaptive thinking, through the proxy's streaming passthrough) in a strict line format: `KARTIK:` / `MATT:` / `CLIP: Guest | FROM "…" | TO "…" | job` / `NOTE:` / `CONFIRM:`.
4. `verifyEditScript()` finds every CLIP's FROM/TO in the transcripts and marks it ✓ found / ⚠ check / ✕ not found, flagging wrong-guest attributions. **Boo never supplies timecodes.** The app derives a ≈timecode from the nearest Riverside stamp. These are approximate, because the Riverside transcripts repeat passages and mislabel speakers.
5. Saved to `episodeStore[n].editScript`. Every version is appended to `editScriptVersions` (last 5). Replacing a saved script goes through `dataMutationProtocol` (type "proceed"). 📄 on the row / `viewEditScript(n)` shows it full-screen; `downloadEditScript(n)` saves a .txt with verification marks.
6. **Readability:** host lines are marked **🎙 RECORD** (Kartik/Matt record these) and clips **▶ FROM INTERVIEW** (cut from the recordings). An overview counts the lines to record (with minutes) and the clips. CONFIRMs are gathered into one numbered **Before recording** checklist, grouped by who checks: `CONFIRM: <Kartik|Matt|Mark> — …`, or inferred via `parseConfirm`. Ticks save to `editScript.checked`. **🎙 Recording sheet** (`viewRecordingSheet`) shows only the host lines, with "after ▶ clip" cues; both views have .txt downloads.
7. Until every transcript has loaded (`transcriptsReady()`), clips show **pending** rather than "not found", and the view re-checks itself once they arrive. An unreadable CLIP line is counted as unreadable, not as "not found".
8. **400-second limit:** the Supabase proxy closes any connection at exactly 400s (measured). A live E2 with all 8 transcripts (736 KB), the 24k-character pin and a long chat made Opus plan past it and produce nothing. So `WRITE-SCRIPT: E<n> | <guest names or ALL>` names the episode's recordings, and the writer sends only those full transcripts (`resolveScriptSources`; everyone else as cards). E2 went to 138 KB. The auto-retry applies only to drops in the first 60s; a long drop was already billed. A drop near 400s tells the user plainly that the server's time ran out.
9. Boo's one kickoff question must be about **intent** (what the listener should feel or understand). Logistics go into placeholders and CONFIRM lines.
Next milestone: a DaVinci XML export built from the verified clips, timed from DaVinci-generated SRTs of the exact WAVs.

## Story shapes (Season screen arc)
- `STORY_SHAPES` holds every season shape in Boo's SHAPE LIBRARY: Plot Mountain (= THE MOUNTAIN), Man in Hole, Kartik's Recipe (`kartik`), Descent & Return, The Question, The Braid, The Turn, and Vignettes. Each beat has a `key` and a `fortune` (its height on the curve). A test fails if Boo's prompt names a season shape the screen can't draw.
- Boo hands an agreed arc to the screen with `SEASON-ARC: <shape id> | E1=<beat key> "Title", …`. The shape ids and beat keys in his prompt are generated from `STORY_SHAPES` by `buildShapeKeysForPrompt()`. The directive becomes a **Use this arc** button. `applySeasonArc()` shows exactly what will change and asks first. It places each episode via `season.episodeBeats`, adds missing slots, and fills only empty titles.
- `beatAt()` places an episode by its saved beat when an arc exists, and by the shape's even spans otherwise.

**Action buttons:** `buildActions` serializes each action to onclick *source*, so an action must never capture a variable. Use `_actionCall('fnName', arg)`, which bakes the argument in.

## Guest Card Format
Boo returns pipe-delimited lines: `NAME | Title, Org | 2–3 sentence bio + unique angle | Topic 1, Topic 2 | Tier: Spotlight/Rising/Discovery, LinkedIn: ..., YouTube: ..., Substack: ..., Instagram: ...`

Tiers: Spotlight (T1 — high platform), Rising (T2 — building momentum), Discovery (T3 — diamond in the rough, the one no one else is booking).

## Auth — current state and roadmap
Current: show-code login at `submitShowCode()` (codes in the Login section above). Per-user identity is a `userPrefs` object (`{name, gmail}`) stored in `localStorage` under `boo_user_prefs`. A nudge toast fires on login if Gmail is not set. localStorage is fragile (wiped by browser clear-data).

**Next auth milestone (when commercializing):** Supabase Auth with Google OAuth.
- One "Sign in with Google" button replaces or supplements the show-code flow
- Supabase gets name + email automatically — no form
- JWT persists properly; user preferences stored server-side keyed by user ID
- Access can be restricted by email domain or allow-list
- Directly solves Gmail `authuser` (you already know which Google account they used)
- SHOW_REGISTRY mapping would shift from show-code → Google user ID / email domain

## Important
- `Claude Console API Key.rtf` is in the project folder — never commit it
- Fixes to the guest card format or system prompt: always check how `formatGuestSuggestions()` parses the result before changing the prompt
- **Keep this file current.** When a commit changes login codes, rows, URLs, the client, or adds a major feature, update this file in the same commit. If anything here contradicts the code, trust the code, tell Mark, and fix this file.
