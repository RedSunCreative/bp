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


def norm_words(s):
    return re.sub(r'[^a-z0-9]+', ' ', s.lower()).split()


def parse_srt(path):
    """→ list of (norm_word, t_start, t_end): word times estimated evenly within each caption."""
    raw = open(path, encoding='utf-8').read().replace('\r', '')
    words = []
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
        text = re.sub(r"^[A-Z][A-Za-z.' -]{1,40}:\s+", '', text)     # drop "Speaker: "
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

    timed = {k: parse_srt(v) for k, v in srts.items()}
    out = bytearray(); cues = []; problems = []; clip_n = 0
    with tempfile.TemporaryDirectory() as tmp:
        for raw in open(a.script, encoding='utf-8').read().split('\n'):
            line = raw.strip()
            pos = len(out) / (RATE * CH * WIDTH)
            if line.startswith('## '):
                if out:
                    out += silence(SEG_GAP)
                cues.append(f'{mmss(len(out) / (RATE * CH * WIDTH))}  ── {line[3:]}')
                continue
            m = re.match(r'^(KARTIK|MATT):\s*(.*)$', line, re.I)
            if m:
                out += tts(m.group(2), VOICE[m.group(1).upper()], tmp) + silence(GAP)
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
                out += fade(pcm16_stereo_from_wav(wavs[wk], t0, t1)) + silence(GAP)
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
    print(f'preview: {a.out}\ncue sheet: {sheet}\ntotal: {mmss(total)} · clips included: {clip_n - len(problems)}/{clip_n}')
    for p in problems:
        print('  !', p)


if __name__ == '__main__':
    main()
