#!/usr/bin/env python3
"""
preview_audio.py — hear an edit script before anyone records or edits anything.

Builds a rough-cut audio preview of an episode from its edit script:
  - each CLIP is cut from the interview's stereo-mix WAV at the script's IN/OUT words,
    timed from the clean (Otter) SRT — word times estimated within each caption — with a
    small cushion at both ends and a short fade so cuts don't click;
  - each KARTIK / MATT line is read by a stand-in macOS voice (placeholders until the hosts
    record), a different voice per host;
  - segments are separated by a short pause. NOTE / CONFIRM lines are skipped.
The same in/out points are what the DaVinci XML will use, so this also rehearses the edit.

Usage:
  python3 preview_audio.py SCRIPT.txt --srt "Guest Name=path.srt" --wav "Guest Name=path.wav" \
      [--srt ... --wav ...] --out ~/Desktop/E2-preview.m4a

Writes the .m4a plus a cue sheet (.txt) listing where each segment and clip starts in the preview.
Read-only on every input file. Needs only macOS built-ins (say, afconvert) and Python 3.
"""
import argparse, audioop, os, re, subprocess, sys, tempfile, wave

RATE, WIDTH, CH = 48000, 2, 2           # preview format: 48 kHz, 16-bit, stereo
VOICE = {'KARTIK': 'Eddy (English (US))', 'MATT': 'Reed (English (US))'}
PRE, POST, FADE = 0.25, 0.35, 0.02      # cushion before/after a clip, fade length (s)
GAP, SEG_GAP = 0.35, 1.0                # pauses between items / segments (s)
TARGET_DB, CEIL_DB = -20.0, -1.5        # leveled speech average / peak ceiling (dBFS)


def norm_words(s):
    return re.sub(r'[^a-z0-9]+', ' ', s.lower()).split()


def parse_srt(path):
    """→ list of (norm_word, t_start, t_end): word times estimated evenly within each caption."""
    raw = open(path, encoding='utf-8').read().replace('\r', '')
    words = []
    caps = parse_srt.caps = []
    speaker = ''
    for block in raw.split('\n\n'):
        lines = [l.strip() for l in block.split('\n') if l.strip()]
        ti = next((i for i, l in enumerate(lines) if '-->' in l), None)
        if ti is None:
            continue
        a, b = [x.strip() for x in lines[ti].split('-->')]
        def secs(t):
            h, m, s = t.split(':'); s, ms = re.split('[,.]', s)
            return int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000
        t0, t1 = secs(a), secs(b)
        text = ' '.join(lines[ti + 1:])
        sp = re.match(r"^([A-Z][A-Za-z.' -]{1,40}):\s+(.*)$", text)
        if sp:
            speaker, text = sp.group(1), sp.group(2)                # "Speaker: " starts a turn
        caps.append({'t0': t0, 't1': t1, 'who': speaker, 'text': text})
        ws = norm_words(text)
        for i, w in enumerate(ws):
            ws_t0 = t0 + (t1 - t0) * i / len(ws)
            words.append((w, ws_t0, t0 + (t1 - t0) * (i + 1) / len(ws)))
    return words


def find(words, phrase, start=0, from_end=False):
    """Index of the phrase's first (or last) word; tries shorter runs if the full one misses."""
    p = norm_words(phrase)
    seq = [w[0] for w in words]
    for k in range(len(p), 3, -1):
        run = p[-k:] if from_end else p[:k]
        for i in range(start, len(seq) - k + 1):
            if seq[i:i + k] == run:
                return (i + k - 1) if from_end else i
    return -1


def pcm16_stereo_from_wav(path, t0, t1):
    with wave.open(path, 'rb') as w:
        rate, width, ch = w.getframerate(), w.getsampwidth(), w.getnchannels()
        t0 = max(0.0, t0); t1 = min(w.getnframes() / rate, t1)
        w.setpos(int(t0 * rate))
        data = w.readframes(int((t1 - t0) * rate))
    if width != 2:
        data = audioop.lin2lin(data, width, 2)
    if ch == 1:
        data = audioop.tostereo(data, 2, 1, 1)
    if rate != RATE:
        data, _ = audioop.ratecv(data, 2, 2, rate, RATE, None)
    return data


def fade(data):
    n = int(FADE * RATE) * CH * WIDTH
    if len(data) < 2 * n:
        return data
    head = bytearray(data[:n]); tail = bytearray(data[-n:])
    frames = n // (CH * WIDTH)
    for i in range(frames):
        g_in, g_out = i / frames, 1 - i / frames
        for c in range(CH):
            o = (i * CH + c) * WIDTH
            v = int.from_bytes(head[o:o + 2], 'little', signed=True)
            head[o:o + 2] = int(v * g_in).to_bytes(2, 'little', signed=True)
            v = int.from_bytes(tail[o:o + 2], 'little', signed=True)
            tail[o:o + 2] = int(v * g_out).to_bytes(2, 'little', signed=True)
    return bytes(head) + data[n:-n] + bytes(tail)


def level(data):
    """Bring a piece to normal speech level and keep peaks under the ceiling (no distortion).
    The stereo mixes were recorded very low (speech around -43 dBFS), so the preview was hard
    to hear. Gain is set from the RMS of the active (non-silent) 10 ms chunks; a chunk-level
    limiter (instant attack, ~80 ms release) holds every peak under CEIL_DB."""
    import math
    step = int(0.01 * RATE) * CH * WIDTH
    chunks = [data[i:i + step] for i in range(0, len(data), step)]
    active = [audioop.rms(c, WIDTH) for c in chunks if c and audioop.rms(c, WIDTH) > 32768 * 10 ** (-60 / 20)]
    if not active:
        return data
    rms = math.sqrt(sum(r * r for r in active) / len(active))
    gain = 10 ** ((TARGET_DB - 20 * math.log10(rms / 32768)) / 20)
    ceil = 32767 * 10 ** (CEIL_DB / 20)
    release = 10 ** (6 / 20 / 8)          # recover ~6 dB per 80 ms
    g, out = gain, []
    for c in chunks:
        if not c:
            continue
        pk = audioop.max(c, WIDTH) or 1
        g = min(g * release, gain)
        if pk * g > ceil:
            g = ceil / pk
        out.append(audioop.mul(c, WIDTH, g))
    return b''.join(out)


def silence(sec):
    return b'\x00' * (int(sec * RATE) * CH * WIDTH)


def tts(text, voice, tmp):
    out = os.path.join(tmp, 'tts.wav')
    subprocess.run(['say', '-v', voice, '-o', out, '--file-format=WAVE', '--data-format=LEI16@48000', text], check=True)
    with wave.open(out, 'rb') as w:
        data = w.readframes(w.getnframes())
    return audioop.tostereo(data, 2, 1, 1)


def mmss(sec):
    return '%d:%02d' % (int(sec) // 60, int(sec) % 60)


def hms(sec):
    sec = max(0, sec)
    h, m, s = int(sec // 3600), int(sec % 3600 // 60), sec % 60
    return (f'{h}:{m:02d}:{s:04.1f}' if h else f'{m}:{s:04.1f}')


def write_edit_list(path, script_name, rows, captions, total):
    """A readable edit decision list: every piece in episode order, where each clip comes from in
    the recording, and — between clips — exactly what is removed, who is speaking, and why."""
    import html
    E = html.escape
    def removed(guest_key, a, b):
        caps = [c for c in captions[guest_key] if c['t0'] >= a - 0.05 and c['t0'] < b - 0.05]
        who = []
        for c in caps:
            if c['who'] and c['who'] not in who:
                who.append(c['who'])
        text = ' '.join(c['text'] for c in caps).split()
        snippet = ' '.join(text[:16]) + (' … ' + ' '.join(text[-8:]) if len(text) > 24 else (' ' + ' '.join(text[16:]) if len(text) > 16 else ''))
        return who, snippet.strip()
    out_rows, kept, cut_total, host_total = [], 0.0, 0.0, 0.0
    clips = [r for r in rows if r['kind'] == 'clip']
    order = sorted(clips, key=lambda r: r['src0'])
    main_clips = [c for c in clips if c['seg'] and 'COLD OPEN' not in c['seg'].upper()] or clips
    first_main = min(main_clips, key=lambda r: r['src0']) if main_clips else None
    prev_clip = None
    for r in rows:
        if r['kind'] == 'seg':
            out_rows.append(f'<tr class="seg"><td colspan="5">{E(r["name"])}</td></tr>')
        elif r['kind'] == 'host':
            host_total += r['dur']
            out_rows.append(f'<tr class="host"><td>{mmss(r["pos"])}</td><td><span class="tag rec">🎙 Hosts record</span></td><td>—</td><td>{mmss(r["dur"])}</td>'
                            f'<td>{r["lines"]} line{"s" if r["lines"] != 1 else ""} ({", ".join(sorted(r["who"]))}) — starts “{E(" ".join(r["first"].split()[:12]))}…”</td></tr>')
        else:
            if r is first_main and r['src0'] > 1:
                who, snip = removed(r['sk'], 0, r['src0'])
                cut_total += r['src0']
                out_rows.append(f'<tr class="cut"><td></td><td><span class="tag cut">✂ Removed</span></td><td>0:00.0 – {hms(r["src0"])}</td><td>{mmss(r["src0"])}</td>'
                                f'<td>Everything before the interview: setup and any intro read on tape ({E(", ".join(who))})<br><span class="snip">“{E(snip)}”</span></td></tr>')
            elif prev_clip and prev_clip['sk'] == r['sk'] and r['src0'] > prev_clip['src1'] + 0.5 and 'COLD OPEN' not in (prev_clip['seg'] or '').upper():
                a, b = prev_clip['src1'], r['src0']
                who, snip = removed(r['sk'], a, b)
                cut_total += b - a
                why = ''
                if r['cut']:
                    why = E(r['cut'][0]) + (f' — <b>{E(r["cut"][2])}</b>' if len(r['cut']) > 2 else '')
                out_rows.append(f'<tr class="cut"><td></td><td><span class="tag cut">✂ Removed</span></td><td>{hms(a)} – {hms(b)}</td><td>{mmss(b - a)}</td>'
                                f'<td>{why or "Gap between clips"} <span class="who">({E(", ".join(who))})</span><br><span class="snip">“{E(snip)}”</span></td></tr>')
            kept += r['src1'] - r['src0']
            out_rows.append(f'<tr class="clip"><td>{mmss(r["pos"])}</td><td><span class="tag clip">▶ Clip {r["n"]}</span><br><span class="who">{E(r["guest"])}</span></td>'
                            f'<td>{hms(r["src0"])} – {hms(r["src1"])}</td><td>{mmss(r["src1"] - r["src0"])}</td>'
                            f'<td><b>{E(r["job"])}</b><br><span class="snip">IN “{E(r["from"])}” … OUT “{E(r["to"])}”</span></td></tr>')
            prev_clip = r
    last = max(clips, key=lambda r: r['src1']) if clips else None
    if last:
        end = captions[last['sk']][-1]['t1'] if captions[last['sk']] else last['src1']
        if end > last['src1'] + 1:
            who, snip = removed(last['sk'], last['src1'], end + 1)
            cut_total += end - last['src1']
            out_rows.append(f'<tr class="cut"><td></td><td><span class="tag cut">✂ Removed</span></td><td>{hms(last["src1"])} – {hms(end)}</td><td>{mmss(end - last["src1"])}</td>'
                            f'<td>Everything after the last answer: goodbyes and wrap ({E(", ".join(who))})<br><span class="snip">“{E(snip)}”</span></td></tr>')
    css = ("body{font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:#1c1c1c;background:#fafaf8;margin:0;padding:32px}"
           ".wrap{max-width:1100px;margin:0 auto;background:#fff;padding:36px 40px;border-radius:6px;box-shadow:0 1px 3px rgba(0,0,0,.08),0 8px 24px rgba(0,0,0,.06)}"
           "h1{font-size:22px;margin:0 0 4px}.sub{color:#6f6f6b;font-size:13px;margin:0 0 18px}"
           ".stats{display:flex;gap:12px;margin:0 0 22px}.stat{flex:1;border:1px solid #e4e3de;background:#f6f5f1;padding:10px 14px}"
           ".stat b{display:block;font-size:20px;margin-top:2px}.stat span{font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#6f6f6b}"
           "table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#6f6f6b;border-bottom:1.5px solid #1c1c1c;padding:6px 8px}"
           "td{vertical-align:top;padding:8px;border-bottom:1px solid #eeede8}td:nth-child(1),td:nth-child(3),td:nth-child(4){white-space:nowrap;font-variant-numeric:tabular-nums}"
           "tr.seg td{font-weight:700;letter-spacing:.8px;text-transform:uppercase;font-size:12px;padding-top:18px;border-bottom:1.5px solid #1c1c1c}"
           "tr.cut td{color:#8a8a85;background:#fbfaf7}tr.cut .snip{text-decoration:line-through;text-decoration-color:#c9c7bf}"
           ".tag{font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase}.tag.clip{color:#0f6f86}.tag.rec{color:#a07a00}.tag.cut{color:#b3412d}"
           ".who{color:#6f6f6b;font-size:12px}.snip{color:#555;font-size:12px}")
    stats = (f'<div class="stats"><div class="stat"><span>Episode length</span><b>{mmss(total)}</b></div>'
             f'<div class="stat"><span>Kept from the interview</span><b>{mmss(kept)}</b></div>'
             f'<div class="stat"><span>Removed</span><b>{mmss(cut_total)}</b></div>'
             f'<div class="stat"><span>Hosts record</span><b>{mmss(host_total)}</b></div></div>')
    with open(path, 'w', encoding='utf-8') as f:
        f.write(f'<!DOCTYPE html><html><head><meta charset="utf-8"><title>Edit list — {E(script_name)}</title><style>{css}</style></head><body><div class="wrap">'
                f'<h1>Edit list</h1><p class="sub">{E(script_name)} · times are from the stereo-mix recording (≈ within a few tenths of a second; each clip has a small cushion at both ends). '
                f'Episode time = where it lands in the preview.</p>{stats}'
                f'<table><tr><th>Episode time</th><th>What</th><th>From the recording</th><th>Length</th><th>Details</th></tr>{"".join(out_rows)}</table></div></body></html>')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('script')
    ap.add_argument('--srt', action='append', default=[], help='"Guest Name=path.srt"')
    ap.add_argument('--wav', action='append', default=[], help='"Guest Name=path.wav"')
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    srts = dict(x.split('=', 1) for x in a.srt)
    wavs = dict(x.split('=', 1) for x in a.wav)

    def guest_key(name, table):
        last = name.split()[-1].lower()
        for k in table:
            if k.lower() == name.lower() or k.split()[-1].lower() == last:
                return k
        return None

    timed, captions = {}, {}
    for k, v in srts.items():
        timed[k] = parse_srt(v); captions[k] = parse_srt.caps
    out = bytearray(); cues = []; problems = []; clip_n = 0
    rows = []; pending_cut = None; seg_name = ''
    def here():
        return len(out) / (RATE * CH * WIDTH)
    with tempfile.TemporaryDirectory() as tmp:
        for raw in open(a.script, encoding='utf-8').read().split('\n'):
            line = raw.strip()
            pos = len(out) / (RATE * CH * WIDTH)
            if line.startswith('## '):
                if out:
                    out += silence(SEG_GAP)
                seg_name = line[3:]
                cues.append(f'{mmss(here())}  ── {seg_name}')
                rows.append({'kind': 'seg', 'name': seg_name, 'pos': here()})
                continue
            m = re.match(r'^CUT:\s*(.*)$', line, re.I)
            if m:
                pending_cut = [x.strip() for x in m.group(1).split('|')]
                continue
            m = re.match(r'^(KARTIK|MATT):\s*(.*)$', line, re.I)
            if m:
                start = here()
                out += level(tts(m.group(2), VOICE[m.group(1).upper()], tmp)) + silence(GAP)
                if rows and rows[-1]['kind'] == 'host':
                    rows[-1]['lines'] += 1; rows[-1]['words'] += len(m.group(2).split()); rows[-1]['dur'] = here() - rows[-1]['pos']
                    rows[-1]['who'].add(m.group(1).capitalize())
                else:
                    rows.append({'kind': 'host', 'pos': start, 'lines': 1, 'words': len(m.group(2).split()), 'dur': here() - start, 'who': {m.group(1).capitalize()}, 'first': m.group(2)})
                continue
            m = re.match(r'^CLIP:\s*(.+?)\s*\|\s*FROM\s*["“](.+?)["”]\s*\|\s*TO\s*["“](.+?)["”]\s*(?:\|\s*(.*))?$', line, re.I)
            if m:
                clip_n += 1
                guest, frm, to, job = m.group(1), m.group(2), m.group(3), (m.group(4) or '')
                sk, wk = guest_key(guest, timed), guest_key(guest, wavs)
                if not sk or not wk:
                    problems.append(f'clip {clip_n} ({guest}): no SRT/WAV given for this guest — left out')
                    continue
                words = timed[sk]
                i = find(words, frm)
                j = find(words, to, max(i, 0), from_end=True) if i >= 0 else -1
                if i < 0 or j < 0 or j < i:
                    problems.append(f'clip {clip_n} ({guest}): IN/OUT words not found in the clean transcript — left out')
                    continue
                t0, t1 = words[i][1] - PRE, words[j][2] + POST
                cues.append(f'{mmss(pos)}     ▶ clip {clip_n} · {guest} · source {mmss(t0)}–{mmss(t1)} ({t1 - t0:.0f}s) · {job}')
                out += fade(level(pcm16_stereo_from_wav(wavs[wk], t0, t1))) + silence(GAP)
                rows.append({'kind': 'clip', 'n': clip_n, 'guest': guest, 'sk': sk, 'src0': t0, 'src1': t1, 'pos': pos, 'from': frm, 'to': to, 'job': job, 'cut': pending_cut, 'seg': seg_name})
                pending_cut = None
        wav_tmp = os.path.join(tmp, 'preview.wav')
        with wave.open(wav_tmp, 'wb') as w:
            w.setnchannels(CH); w.setsampwidth(WIDTH); w.setframerate(RATE); w.writeframes(bytes(out))
        subprocess.run(['afconvert', '-f', 'm4af', '-d', 'aac', '-b', '128000', wav_tmp, a.out], check=True)
    total = len(out) / (RATE * CH * WIDTH)
    sheet = os.path.splitext(a.out)[0] + ' — cue sheet.txt'
    with open(sheet, 'w') as f:
        f.write(f'Preview of {os.path.basename(a.script)} — total {mmss(total)}\n')
        f.write('Host lines are stand-in voices (Kartik = Eddy, Matt = Reed). Clips are the real interview audio.\n\n')
        f.write('\n'.join(cues) + '\n')
        if problems:
            f.write('\nNOT INCLUDED:\n' + '\n'.join(problems) + '\n')
    edl = os.path.splitext(a.out)[0] + ' — edit list.html'
    write_edit_list(edl, os.path.basename(a.script), rows, captions, total)
    print(f'edit list: {edl}')
    import math
    print(f'level: speech ~{TARGET_DB:.0f} dBFS average, peaks held under {CEIL_DB} dBFS')
    print(f'preview: {a.out}\ncue sheet: {sheet}\ntotal: {mmss(total)} · clips included: {clip_n - len(problems)}/{clip_n}')
    for p in problems:
        print('  !', p)


if __name__ == '__main__':
    main()
