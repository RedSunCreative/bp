#!/usr/bin/env python3
"""Tests for host_takes.find_restarts and xml_export multitrack output (synthetic media, no client data)."""
import os, re, subprocess, sys, tempfile, wave, struct
import xml.dom.minidom as minidom
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import host_takes as ht, xml_export as xe

fails = 0
def check(name, cond):
    global fails
    print(('PASS ' if cond else 'FAIL ') + name)
    fails += (not cond)

# 1. restart detection
w = ht._norm("the cat sat on the mat and then the cat sat on the mat today")
r = ht.find_restarts(w)
check('restart found', len(r) == 1 and r[0][2] == 'the cat sat on')
check('restart cut keeps clean pass', ' '.join(w[:r[0][0]] + w[r[0][1]:]) == 'the cat sat on the mat today')
check('no false restart in normal speech', ht.find_restarts(ht._norm("here is the part i can't stop thinking about today")) == [])

# 2. multitrack export: 2 per-person tracks, names, roles, lanes, sync
d = tempfile.mkdtemp()
def tone(path, secs):
    with wave.open(path, 'wb') as f:
        f.setnchannels(1); f.setsampwidth(2); f.setframerate(48000)
        f.writeframes(b''.join(struct.pack('<h', 3000 if (i // 4800) % 2 else 0) for i in range(48000 * secs)))
mix, a, b = (os.path.join(d, n) for n in ('mix.wav', 'a.wav', 'b.wav'))
for p in (mix, a, b): tone(p, 20)
srt = os.path.join(d, 'g.srt')
open(srt, 'w').write("1\n00:00:01,000 --> 00:00:05,000\nGuest: alpha bravo charlie delta\n\n2\n00:00:06,000 --> 00:00:10,000\nGuest: echo foxtrot golf hotel\n")
script = os.path.join(d, 'E9.txt')
open(script, 'w').write('## 1 · THE INTERVIEW · ~1\nCLIP: Test Guest | FROM "alpha bravo charlie delta" | TO "echo foxtrot golf hotel" | test\n')
items, problems, written, total = xe.build(script, {'Test Guest': srt}, {'Test Guest': mix}, d, 24,
                                         tracks={mix: [['Guest', a, 0.0], ['Host (Interview)', b, -0.03]]})
x = open(written[0]).read()
check('no problems', problems == [])
check('valid XML', bool(minidom.parseString(x)))
check('one clip per person', x.count('lane="1"') == 1 and x.count('lane="2"') == 1)
check('speaker roles', 'audioRole="dialogue.Guest"' in x and 'audioRole="dialogue.Host Interview"' in x)
check('clips named by speaker', 'name="Guest · ' in x and 'name="Host (Interview) · ' in x)
st = re.findall(r'lane="\d" name="[^"]*" offset="0s" start="([^"]+)" duration="([^"]+)"', x)
check('same duration on both tracks (in sync)', len(st) == 2 and st[0][1] == st[1][1])

print(f'\n{fails} failed' if fails else '\nall passed')
sys.exit(1 if fails else 0)
