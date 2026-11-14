/* The Linux tool end to end (linux/arranger.mjs + the engine host): a small
 * library and song are written to a temp folder, the song is played to a
 * file standing in for the MIDI output, and the bytes are checked.
 *
 *   node tests/linux/run.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TOOL = path.join(REPO, 'linux/arranger.mjs');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'arranger-linux-'));
let failures = 0;
function CHECK(cond, msg) { if (cond) console.log('ok: ' + msg); else { failures++; console.log('FAIL: ' + msg); } }

/* ---- a library: one song folder, 4/4, kick 1+3, snare 2+4, hats in 8ths ---- */
function vlq(v) { const b = [v & 0x7f]; v >>>= 7; while (v > 0) { b.unshift((v & 0x7f) | 0x80); v >>>= 7; } return b; }
function drumClip(bars) {
    const ppq = 480, ev = [];
    const hit = (t, n, v) => { ev.push([t, 0x99, n, v]); ev.push([t + 60, 0x89, n, 0]); };
    for (let b = 0; b < bars; b++) {
        const o = b * 4 * ppq;
        for (let i = 0; i < 8; i++) hit(o + i * ppq / 2, 42, 80);
        hit(o, 36, 110); hit(o + 2 * ppq, 36, 100); hit(o + ppq, 38, 105); hit(o + 3 * ppq, 38, 105);
    }
    ev.sort((a, b) => a[0] - b[0]);
    const tr = []; let last = 0;
    for (const [t, s, n, v] of ev) { tr.push(...vlq(t - last), s, n, v); last = t; }
    tr.push(...vlq(bars * 4 * ppq - last), 0xff, 0x2f, 0);
    return Buffer.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, ppq >> 8, ppq & 255,
        0x4d, 0x54, 0x72, 0x6b, 0, 0, (tr.length >> 8) & 255, tr.length & 255, ...tr]);
}
const folder = 'Test Pack/Song 01 4-4 120 BPM';
fs.mkdirSync(path.join(home, 'MidiLibrary', folder, 'Grooves'), { recursive: true });
fs.writeFileSync(path.join(home, 'MidiLibrary', folder, 'Grooves/120 Verse.mid'), drumClip(2));
fs.mkdirSync(path.join(home, 'Songs'));
fs.writeFileSync(path.join(home, 'Songs/Demo.json'), JSON.stringify({
    name: 'Demo', source_folder: folder, tempo_bpm: 300, time_sig_num: 4, time_sig_den: 4, key: 'C',
    sections: [
        { name: 'Verse', clips: [{ source: 'Grooves/120 Verse.mid', start_bar: 0, end_bar: 2 }],
          chords: [{ root: 'C', quality: 'maj' }, { root: 'A', quality: 'min' }] },
        { name: 'Chorus', clips: [{ source: 'Grooves/120 Verse.mid', start_bar: 0, end_bar: 1 }],
          chords: [{ root: 'F', quality: 'maj' }] },
    ],
    /* A bass on channel 2 (this tool's Inst 1 channel), with each kick. */
    instruments: [{ enabled: true, voicing: 'bass', octave: 2, follow_note: 36 }],
}));

function run(...args) {
    return spawnSync(process.execPath, [TOOL, '--home', home, ...args], { encoding: 'utf8', timeout: 60000 });
}

/* ---- the tests ---- */
let r = run('songs');
CHECK(r.status === 0 && r.stdout.trim() === 'Demo', 'songs lists the song');

r = run('show', 'demo');
CHECK(r.status === 0 && r.stdout.includes('chords: C | Am') && r.stdout.includes('2. Chorus'), 'show prints sections and chords');

const out = path.join(home, 'out.bin');
r = run('play', 'Demo', '--port', out);
CHECK(r.status === 0, 'play runs to the song\'s end and exits' + (r.status ? ': ' + r.stderr : ''));
const bytes = fs.existsSync(out) ? fs.readFileSync(out) : Buffer.alloc(0);
const msgs = [];
for (let i = 0; i < bytes.length;) {
    const s = bytes[i];
    const n = s >= 0xf8 ? 1 : ((s & 0xf0) === 0xc0 || (s & 0xf0) === 0xd0) ? 2 : 3;
    msgs.push([...bytes.subarray(i, i + n)]);
    i += n;
}
const on = (ch) => msgs.filter(m => m[0] === (0x90 | (ch - 1)) && m[2] > 0);
const off = (ch) => msgs.filter(m => m[0] === (0x80 | (ch - 1)) || (m[0] === (0x90 | (ch - 1)) && m[2] === 0));
/* 3 bars: 8 hats + 2 kicks + 2 snares each. */
CHECK(on(10).length === 36, 'drums: 36 note-ons on channel 10 (got ' + on(10).length + ')');
CHECK(off(10).length === on(10).length, 'drums: every note-on has its note-off');
CHECK(on(2).map(m => m[1]).join(',') === '36,36,45,45,41,41', 'bass: C C A A F F on channel 2 (got ' + on(2).map(m => m[1]).join(',') + ')');
CHECK(off(2).length === on(2).length, 'bass: every note-on has its note-off');
CHECK(msgs.some(m => m[0] === 0xb9 && m[1] === 123), 'All Notes Off is sent on exit');
CHECK(!msgs.some(m => m[0] >= 0xf8), 'no MIDI clock unless asked for');

/* From the second section only. */
fs.rmSync(out);
r = run('play', 'Demo', '--port', out, '--section', '2');
const b2 = fs.readFileSync(out);
const bass2 = [];
for (let i = 0; i + 2 < b2.length; i += 3) if (b2[i] === 0x91 && b2[i + 2] > 0) bass2.push(b2[i + 1]);
CHECK(r.status === 0 && bass2.join(',') === '41,41', '--section 2 plays the Chorus alone (got ' + bass2.join(',') + ')');

r = run('play', 'Nope');
CHECK(r.status !== 0 && r.stderr.includes('no song'), 'an unknown song is an error');

fs.rmSync(home, { recursive: true, force: true });
console.log(failures ? failures + ' failure(s)' : 'linux: all passed');
process.exit(failures ? 1 : 0);
