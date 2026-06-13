# Boo Producer — Claude Code Briefing

## Who I Am
Mark Caddell, Red Sun Creative Studio, Austin TX.
Boo Producer is the pre-production tool in the Boo Podcast Suite — episode planning, season arcs, guest research, topics, questions. Current client: Anno Coding podcast (Matt + Kartik). Demo: 2026-06-14.

## Delivery
BP is served via GitHub Pages (`redsuncreative.github.io/bp/bp.html`). Local edits are invisible until pushed.
**Every session with code changes:** `bash test_bp.sh` → `git commit` → `git push`. Never report work done without pushing.

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
- `SHOW_CONFIG` — show identity (name, hosts, format, etc.) at top of script
- `state` / `episodeStore` — all episode data, keyed by episode number
- `activeEp()` — auto-initializes episode bucket, always use this
- `conversationLog` — per-episode array of `{role, text, rawText?, html?}`
  - `rawText`: original API text, used by `getConversationHistory()` so Boo's context stays clean
  - `html`: rendered HTML, used by restore code so guest cards re-render as cards after refresh
- `autoSave(reason)` — patches Supabase row 98 via REST PATCH
- `triggerBooDirectly(displayText, apiPrompt)` — fires Boo without touching the chat input field. Use this for all button-triggered Boo interactions. The `displayText` is a short label shown in chat; `apiPrompt` is the full context sent to the API.
- `callBoo(prompt)` → `parseReply()` → `formatGuestSuggestions()` → `buildGuestCard()` — guest card pipeline

## Guest Card Format
Boo returns pipe-delimited lines: `NAME | Title, Org | 2–3 sentence bio + unique angle | Topic 1, Topic 2 | Tier: Spotlight/Rising/Discovery, LinkedIn: ..., YouTube: ..., Substack: ..., Instagram: ...`

Tiers: Spotlight (T1 — high platform), Rising (T2 — building momentum), Discovery (T3 — diamond in the rough, the one no one else is booking).

## Important
- `Claude Console API Key.rtf` is in the project folder — never commit it
- Do not change the Anno Coding `SHOW_CONFIG` content until after the demo
- Fixes to the guest card format or system prompt: always check how `formatGuestSuggestions()` parses the result before changing the prompt
