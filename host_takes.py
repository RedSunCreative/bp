#!/usr/bin/env python3
"""
host_takes.py — turn a Riverside host session (transcript .txt + the session's audio) into
exact clip ranges for chosen takes.

Riverside transcripts give each turn a START time only ("Host (06:50.391)" then the text).
This module finds where the speech actually starts and stops in the audio, so a turn can be
cut cleanly without word-level timing:
  - start: the first speech after the transcript's stamp (with a small cushion)
  - end:   the last speech before the next turn's stamp (with a small cushion)
  - mid-turn cuts ("to_before" / "from_at" a phrase): the phrase's position is estimated
    from its word position across the turn's speech, then SNAPPED to the nearest pause.
    Snapped cuts are flagged "check" in the note so a human listens to them.

Plan format (JSON): {"SECTION NAME": [ {"turn": "mm:ss.mmm", "to_before": "...", "from_at": "...",
                                       "note": "..."}, ... ], ...}
Read-only on all inputs.
"""
import array, math, re, wave

PRE, POST = 0.15, 0.30          # cushions (s)
HOP = 0.02                      # envelope resolution (s)
SPEECH_DB, QUIET_DB = -40.0, -45.0


def parse_riverside(path):
    """→ list of {'who', 't', 'text'} in time order."""
    raw = open(path, encoding='utf-8').read().replace('\r', '')
    turns = []
    for m in re.finditer(r'^([A-Za-z][\w .\'-]*?) \((\d+):(\d+(?:\.\d+)?)\)\n(.*?)(?=^[A-Za-z][\w .\'-]*? \(\d+:\d+(?:\.\d+)?\)\n|\Z)', raw, re.M | re.S):
        turns.append({'who': m.group(1), 't': int(m.group(2)) * 60 + float(m.group(3)),
                      'text': ' '.join(m.group(4).split())})
    return sorted(turns, key=lambda x: x['t'])


def envelope(path):
    """→ (list of dBFS per HOP, duration s). Works for 16-bit mono/stereo WAV."""
    w = wave.open(path, 'rb')
    sr, ch, n = w.getframerate(), w.getnchannels(), w.getnframes()
    if w.getsampwidth() != 2:
        raise ValueError('host_takes needs a 16-bit WAV')
    a = array.array('h', w.readframes(n))
    hop = int(sr * HOP) * ch
    db = []
    for i in range(0, len(a) - hop, hop):
        s = a[i:i + hop:4]
        e = math.sqrt(sum(x * x for x in s) / max(1, len(s)))
        db.append(20 * math.log10(e / 32768 + 1e-9))
    return db, n / sr


def _norm(s):
    return re.sub(r'[^a-z0-9]+', ' ', s.lower()).split()


def _find_phrase(words, phrase):
    p = _norm(phrase)
    for i in range(len(words) - len(p) + 1):
        if words[i:i + len(p)] == p:
            return i
    raise ValueError(f'phrase not found in turn: "{phrase}"')


def resolve(plan, turns, db, dur):
    """→ ({section: [ {'src0','src1','who','note','check'} ]}, problems)"""
    def fr(t):
        return max(0, min(len(db) - 1, int(t / HOP)))

    def tm(i):
        return i * HOP

    out, problems = {}, []
    for section, picks in plan.items():
        segs = []
        for p in picks:
            t = _ts(p['turn'])
            k = next((i for i, x in enumerate(turns) if abs(x['t'] - t) < 0.01), None)
            if k is None:
                problems.append(f'{section}: no turn at {p["turn"]}'); continue
            turn = turns[k]
            nxt = turns[k + 1]['t'] if k + 1 < len(turns) else dur
            prev = turns[k - 1]['t'] if k > 0 else 0.0
            # speech start: first loud frame at/after the stamp (search from stamp-0.3)
            i0 = next((i for i in range(fr(t - 0.3), fr(nxt)) if db[i] > SPEECH_DB), fr(t))
            # speech end: last loud frame before the next stamp
            i1 = next((i for i in range(fr(nxt) - 1, i0, -1) if db[i] > SPEECH_DB), fr(nxt))
            s0 = max(prev, tm(i0) - PRE)
            s1 = min(nxt, tm(i1) + POST)
            check = []
            words = _norm(turn['text'])
            active = [i for i in range(i0, i1 + 1) if db[i] > QUIET_DB]

            def at_word(wi):
                return tm(active[min(len(active) - 1, int(len(active) * wi / max(1, len(words))))])

            def snap(t_est):
                # nearest pause (>= 0.2 s below QUIET_DB) within ±2.5 s; cut in its middle
                best = None
                i, lo, hi = fr(t_est - 2.5), fr(t_est - 2.5), fr(t_est + 2.5)
                while i < hi:
                    if db[i] < QUIET_DB:
                        j = i
                        while j < hi and db[j] < QUIET_DB:
                            j += 1
                        if (j - i) * HOP >= 0.2:
                            mid = tm((i + j) // 2)
                            if best is None or abs(mid - t_est) < abs(best[0] - t_est):
                                best = (mid, (j - i) * HOP)
                        i = j
                    i += 1
                return best

            for key, side in (('from_at', 0), ('to_before', 1)):
                if not p.get(key):
                    continue
                try:
                    wi = _find_phrase(words, p[key])
                except ValueError as e:
                    problems.append(f'{section} {p["turn"]}: {e}'); continue
                est = at_word(wi)
                sn = snap(est)
                if sn is None:
                    problems.append(f'{section} {p["turn"]}: no pause near "{p[key]}" (≈{est:.1f}s)'); continue
                if side == 0:
                    s0 = sn[0]
                else:
                    s1 = sn[0]
                check.append(f'{"starts at" if side == 0 else "ends before"} "{p[key][:40]}" — cut snapped to a {sn[1]:.2f}s pause, listen to it')
            # In-turn restarts: a false start is cut out, the clean restart is kept.
            pieces = [(s0, s1)]
            if p.get('restarts', True):
                lo_w = _find_phrase(words, p['from_at']) if p.get('from_at') else 0
                hi_w = _find_phrase(words, p['to_before']) if p.get('to_before') else len(words)
                for a, b, phrase in find_restarts(words[lo_w:hi_w]):
                    c0, c1 = snap(at_word(lo_w + a)), snap(at_word(lo_w + b))
                    if not c0 or not c1 or c1[0] <= c0[0]:
                        problems.append(f'{section} {p["turn"]}: restart at "{phrase}" found but no clean pause to cut on, fix by hand')
                        continue
                    new = []
                    for x0, x1 in pieces:
                        if x0 < c0[0] < c1[0] < x1:
                            new += [(x0, c0[0]), (c1[0], x1)]
                        else:
                            new.append((x0, x1))
                    pieces = new
                    check.append(f'restart cut: false start before "{phrase}" removed ({c1[0] - c0[0]:.1f}s), listen to it')
            note = ' · '.join(filter(None, [p.get('note', ''), *check]))
            for x0, x1 in pieces:
                segs.append({'src0': x0, 'src1': x1, 'who': turn['who'], 'turn': p['turn'], 'note': note, 'check': bool(check)})
        out[section] = segs
    return out, problems


def find_restarts(words, n=4, max_gap=40):
    """Restarts inside one turn: a phrase of >= n words said, then said again within max_gap words.
    → list of (start of false start, start of clean restart, phrase), non-overlapping, in order.
    'the cat sat on the mat. and then, the cat sat on the mat today'
    → cut from the first 'the cat sat on' to the second, keeping the clean pass."""
    out, i = [], 0
    while i <= len(words) - n:
        hit = None
        for j in range(i + n, min(len(words) - n, i + max_gap) + 1):
            if words[j:j + n] == words[i:i + n]:
                hit = j
                break
        if hit is not None:
            out.append((i, hit, ' '.join(words[i:i + n])))
            i = hit
        else:
            i += 1
    return out


def _ts(s):
    m, sec = s.split(':')
    return int(m) * 60 + float(sec)
