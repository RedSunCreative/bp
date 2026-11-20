#!/usr/bin/env python3
"""
xml_export.py — turn an edit script into a DaVinci Resolve timeline (FCPXML).

Same cut points as preview_audio.py (Otter SRT word times + small cushions), placed on a
timeline in episode order:
  - each CLIP references the guest's stereo-mix WAV in place (nothing is copied), cut at the
    script's IN/OUT words, with a marker naming the clip's purpose;
  - each block of host lines becomes a labelled placeholder WAV (stand-in voice) where the real
    recording goes — replace it in Resolve once Matt and Kartik record.
Writes FCPXML 1.9 (media-rep) and 1.8 (asset src) copies: Resolve versions differ in which
they accept. Times are frame-aligned to the timeline rate (default 30 fps).

Usage:
  python3 xml_export.py SCRIPT.txt --srt "Guest=path.srt" --wav "Guest=path.wav" --outdir DIR [--max-items N] [--fps 30]
Read-only on all inputs; writes only into --outdir.
"""
import argparse, os, re, subprocess, urllib.parse, wave
from fractions import Fraction
import preview_audio as pa


def wav_info(path):
    """(duration s, channels, sample rate) for any audio/video file macOS can read (16/24-bit WAV, MP4…)."""
    try:
        with wave.open(path, 'rb') as w:
            return w.getnframes() / w.getframerate(), w.getnchannels(), w.getframerate()
    except wave.Error:
        info = subprocess.run(['afinfo', path], capture_output=True, text=True, check=True).stdout
        ch, rate = re.search(r'Data format:\s+(\d+) ch,\s+(\d+) Hz', info).groups()
        dur = float(re.search(r'estimated duration: ([\d.]+)', info).group(1))
        return dur, int(ch), int(rate)


def frames(sec, fps):
    return int(round(sec * fps))


def t(frm, fps):
    """Rational FCPXML time for a frame count at fps (e.g. 451/30s)."""
    f = Fraction(frm, fps)
    return f'{f.numerator}/{f.denominator}s' if f.denominator != 1 else f'{f.numerator}s'


def file_url(path):
    return 'file://' + urllib.parse.quote(os.path.abspath(path))


def role_of(label):
    """'Matt (Host)' → 'Matt Host': FCPXML sub-role that Resolve shows as the track name."""
    return re.sub(r'[()]', '', label).strip()


def esc(s):
    return (str(s).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace('"', '&quot;'))


def build(script, srts, wavs, outdir, fps=30, max_items=None, host_wav=None, host_segments=None, tracks=None):
    """host_segments: {SECTION: [ {src0, src1, who, note} ]} from host_takes.resolve — real host takes
    from host_wav replace the stand-in voice for that section's host block."""
    host_segments = {k.upper(): v for k, v in (host_segments or {}).items()}
    # tracks: {mix path: [[label, per-person file, offset s], ...]} — each cut is placed on every
    # per-person track of its source, same span (+offset), one lane per label, so each voice gets
    # its own fader. Sources without an entry stay on their mix.
    tracks = tracks or {}
    labels = []
    for lst in tracks.values():
        for lab, _, _ in lst:
            if lab not in labels:
                labels.append(lab)
    os.makedirs(outdir, exist_ok=True)
    timed = {k: pa.parse_srt(v) for k, v in srts.items()}

    def key(name, table):
        last = name.split()[-1].lower()
        return next((k for k in table if k.lower() == name.lower() or k.split()[-1].lower() == last), None)

    items, host_block, seg = [], [], ''

    def flush_host():
        if not host_block:
            return
        real = host_segments.get(seg.strip().upper())
        if real is not None and host_wav:
            for k, r in enumerate(real, 1):
                items.append({'kind': 'host', 'name': f'{seg} · {r["who"]} {k}/{len(real)}', 'path': host_wav,
                              'src0': r['src0'], 'src1': r['src1'],
                              'note': f'{r["who"]} @ {r["turn"]} (Riverside)' + (f' · {r["note"]}' if r['note'] else '')})
            host_block.clear()
            return
        n = sum(1 for i in items if i['kind'] == 'host') + 1
        name = f'HOSTS RECORD {n:02d} — {seg or "host lines"}'
        path = os.path.join(outdir, re.sub(r'[^A-Za-z0-9 ._-]+', '', name)[:80] + '.wav')
        text = ' '.join(l for _, l in host_block)
        tmp = path + '.tmp.wav'
        subprocess.run(['say', '-v', pa.VOICE['MATT'], '-o', tmp, '--file-format=WAVE', '--data-format=LEI16@48000', text], check=True)
        with wave.open(tmp, 'rb') as w:
            mono = w.readframes(w.getnframes())
        import audioop
        stereo = pa.level(audioop.tostereo(mono, 2, 1, 1))
        with wave.open(path, 'wb') as w:
            w.setnchannels(2); w.setsampwidth(2); w.setframerate(48000); w.writeframes(stereo)
        os.remove(tmp)
        dur = len(stereo) / (48000 * 4)
        items.append({'kind': 'host', 'name': name, 'path': path, 'src0': 0.0, 'src1': dur,
                      'note': 'Placeholder (stand-in voice). Replace with the real recording: ' + ' / '.join(f'{w}: {l[:60]}' for w, l in host_block[:3]) + (' …' if len(host_block) > 3 else '')})
        host_block.clear()

    problems = []
    for raw in open(script, encoding='utf-8').read().split('\n'):
        line = raw.strip()
        if line.startswith('## '):
            flush_host(); seg = line[3:].split('·')[1].strip() if '·' in line else line[3:]
            continue
        m = re.match(r'^(KARTIK|MATT):\s*(.*)$', line, re.I)
        if m:
            host_block.append((m.group(1).capitalize(), m.group(2)))
            continue
        m = re.match(r'^CLIP:\s*(.+?)\s*\|\s*FROM\s*["“](.+?)["”]\s*\|\s*TO\s*["“](.+?)["”]\s*(?:\|\s*(.*))?$', line, re.I)
        if m:
            flush_host()
            guest, frm, to, job = m.group(1), m.group(2), m.group(3), (m.group(4) or '')
            sk, wk = key(guest, timed), key(guest, wavs)
            n = sum(1 for i in items if i['kind'] == 'clip') + 1
            if not sk or not wk:
                problems.append(f'clip {n} ({guest}): no SRT/WAV given'); continue
            words = timed[sk]
            i = pa.find(words, frm)
            j = pa.find(words, to, max(i, 0), from_end=True) if i >= 0 else -1
            if i < 0 or j < 0 or j < i:
                problems.append(f'clip {n} ({guest}): IN/OUT words not found'); continue
            items.append({'kind': 'clip', 'name': f'Clip {n} · {seg}', 'path': wavs[wk], 'guest': guest,
                          'src0': max(0.0, words[i][1] - pa.PRE), 'src1': words[j][2] + pa.POST, 'note': job or seg})
        if max_items and len(items) >= max_items:
            break
    if not (max_items and len(items) >= max_items):
        flush_host()
    if max_items:
        items = items[:max_items]

    # resources: one asset per distinct media file
    assets = {}
    def add_asset(path):
        if path not in assets:
            dur, ch, rate = wav_info(path)
            assets[path] = {'id': f'r{len(assets) + 2}', 'name': os.path.splitext(os.path.basename(path))[0].strip(), 'dur': dur, 'ch': ch, 'rate': rate}
    for it in items:
        for _, path, _ in tracks.get(it['path'], [(None, it['path'], 0.0)]):
            add_asset(path)

    def doc(version):
        res = [f'<format id="r1" name="FFVideoFormat1080p{fps}" frameDuration="{t(1, fps)}" width="1920" height="1080"/>']
        for path, a in assets.items():
            common = f'id="{a["id"]}" name="{esc(a["name"])}" start="0s" duration="{t(frames(a["dur"], fps), fps)}" hasAudio="1" hasVideo="0" audioSources="1" audioChannels="{a["ch"]}" audioRate="{a["rate"]}"'
            if version == '1.9':
                res.append(f'<asset {common}><media-rep kind="original-media" src="{esc(file_url(path))}"/></asset>')
            else:
                res.append(f'<asset {common} src="{esc(file_url(path))}"/>')
        spine, offset = [], 0
        for it in items:
            if it['path'] in tracks:
                d = max(1, frames(it['src1'], fps) - frames(it['src0'], fps))
                kids = []
                for k, (lab, path, off) in enumerate(tracks[it['path']]):
                    a, s0 = assets[path], max(0, frames(it['src0'] + off, fps))
                    mk = f'<marker start="{t(s0, fps)}" duration="{t(1, fps)}" value="{esc(it["note"][:200])}"/>' if k == 0 else ''
                    kids.append(f'<asset-clip ref="{a["id"]}" lane="{labels.index(lab) + 1}" name="{esc(lab)} · {esc(it["name"])}" offset="0s" start="{t(s0, fps)}" duration="{t(d, fps)}" srcEnable="audio" audioRole="dialogue.{esc(role_of(lab))}">{mk}</asset-clip>')
                spine.append(f'<gap name="{esc(it["name"])}" offset="{t(offset, fps)}" start="0s" duration="{t(d, fps)}">' + ''.join(kids) + '</gap>')
                offset += d
                continue
            a = assets[it['path']]
            s0, s1 = frames(it['src0'], fps), frames(it['src1'], fps)
            d = max(1, s1 - s0)
            spine.append(f'<asset-clip ref="{a["id"]}" name="{esc(it["name"])}" offset="{t(offset, fps)}" start="{t(s0, fps)}" duration="{t(d, fps)}" audioRole="dialogue">'
                         f'<marker start="{t(s0, fps)}" duration="{t(1, fps)}" value="{esc(it["note"][:200])}"/></asset-clip>')
            offset += d
        total = offset
        return ('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n'
                f'<fcpxml version="{version}">\n<resources>\n  ' + '\n  '.join(res) + '\n</resources>\n'
                f'<library>\n<event name="K12 Boss">\n<project name="{esc(os.path.splitext(os.path.basename(script))[0])}">\n'
                f'<sequence format="r1" duration="{t(total, fps)}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">\n<spine>\n  '
                + '\n  '.join(spine) + '\n</spine>\n</sequence>\n</project>\n</event>\n</library>\n</fcpxml>\n'), total

    base = os.path.splitext(os.path.basename(script))[0]
    written = []
    for v in ('1.9', '1.8'):
        xml, total = doc(v)
        p = os.path.join(outdir, f'{base} — FCPXML {v}.fcpxml')
        open(p, 'w', encoding='utf-8').write(xml)
        written.append(p)
    return items, problems, written, total / fps


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('script'); ap.add_argument('--srt', action='append', default=[]); ap.add_argument('--wav', action='append', default=[])
    ap.add_argument('--outdir', required=True); ap.add_argument('--fps', type=int, default=30); ap.add_argument('--max-items', type=int)
    ap.add_argument('--host-wav', help='host session audio (Riverside clock)'); ap.add_argument('--host-transcript', help='Riverside transcript .txt of that session')
    ap.add_argument('--host-plan', help='JSON: {SECTION: [{turn, to_before?, from_at?, note?}]}')
    ap.add_argument('--tracks', help='JSON: {mix path: [[label, per-person file, offset s], ...]} — one track per person')
    a = ap.parse_args()
    import json
    host_segments, hp = None, []
    if a.host_plan:
        import json, host_takes as ht
        db, dur = ht.envelope(a.host_wav)
        host_segments, hp = ht.resolve(json.load(open(a.host_plan)), ht.parse_riverside(a.host_transcript), db, dur)
    items, problems, written, total = build(a.script, dict(x.split('=', 1) for x in a.srt), dict(x.split('=', 1) for x in a.wav), a.outdir, a.fps, a.max_items, a.host_wav, host_segments,
                                            json.load(open(a.tracks)) if a.tracks else None)
    problems = hp + problems
    for it in items:
        print(f'{it["kind"]:5} {pa.mmss(it["src0"])}–{pa.mmss(it["src1"])}  {it["name"]}' + ('   ⚠ ' + it['note'] if 'listen to it' in it.get('note', '') else ''))
    for p in problems:
        print('  !', p)
    print('timeline length', pa.mmss(total))
    for w in written:
        print('wrote', w)


if __name__ == '__main__':
    main()
