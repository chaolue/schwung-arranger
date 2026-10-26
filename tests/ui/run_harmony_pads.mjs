/* Song Builder's pads on the Chord, Inst and Pads tracks, against a mock
 * engine that confirms builds and runs once played:
 *  - the left half holds roots (the key's own first, then the others), the
 *    right half chord types (Chord track) or item variations (Inst, Pads);
 *  - a pad plays one bar of what it holds -- a one-section song with that
 *    chord, only the track's instrument, drums and click silenced -- and
 *    selects it (lit white); the drums and click come back afterwards;
 *  - with a pad selected a step adds it to the bar: on beat 1, or halfway
 *    when beat 1 has something else; pressed again it takes it out;
 *  - while the song plays a pad only selects. */
import * as H from './host_mock.mjs';

const SONGS = "/data/UserData/UserLibrary/Arranger/Songs";
const PATH = SONGS + "/h.json";
H.files.set(PATH, JSON.stringify({ name: "H", key: "C", tempo_bpm: 120, time_sig_num: 4, time_sig_den: 4,
    sections: [{ name: "A", clips: [{ source: "Grooves/beat.mid", name: "beat", start_bar: 0, end_bar: 4 }],
                 chords: [{ root: "C", quality: "maj" }] }],
    instruments: [{ enabled: false, octave: 2, voicing: "bass", follow_note: 36 }] }));

let gen = 0, running = false;
const g = globalThis;
g.host_module_get_param = (k) => {
    if (k === "songs_json") return JSON.stringify({ count: 1, start: 0, items: [{ name: "H", path: PATH }] });
    if (k === "ui_poll") return JSON.stringify({
        state: { primary_published_gen: gen, staging_published_gen: 0, running, active_source: "primary" },
        transport: { running, bar: 1, beat: 1, beat_progress: 0, ticks_per_beat: 240, ticks_per_bar: 960, bpm: 120 } });
    return null;
};
const sets = [];
const plainSet = g.host_module_set_param;
const onSet = (k, v) => {
    sets.push([k, v]);
    if (k === "song_json") gen++;
    if (k === "play") running = v === "1";
    if (k === "stop") running = false;
};
g.host_module_set_param = (k, v) => { onSet(k, v); return plainSet(k, v); };
g.host_module_set_param_blocking = (k, v) => { onSet(k, v); return true; };

const M = await import('./ui_test.mjs');
const C = await import('./shared/constants.mjs');
let failures = 0, passes = 0;
function check(cond, msg) { if (cond) passes++; else { failures++; console.log("FAIL: " + msg); } }
function cc(n, v) { g.onMidiMessageInternal([0xB0, n, v]); }
function tick(n = 1, ms = 23) { for (let i = 0; i < n; i++) { H.advance(ms); H.hostFrame(); g.tick(); } }
function jog(n) { for (let i = 0; i < Math.abs(n); i++) cc(C.MoveMainKnob, n > 0 ? 1 : 127); tick(); }
function press(n) { cc(n, 127); cc(n, 0); tick(3); }
function note(n) { g.onMidiMessageInternal([0x90, n, 100]); g.onMidiMessageInternal([0x80, n, 0]); tick(10); }
const pad = (row, col) => note(C.MovePad1 + row * 8 + col);
const step = (s) => note(C.MoveStep1 + s);
const padLed = (row, col) => H.padLeds.get(C.MovePad1 + row * 8 + col);
const click = () => press(C.MoveMainButton);
const has = (pair) => M.footerHints().some(p => p[0] === pair[0] && p[1] === pair[1]);
/* The last song sent to the engine, and the drum/click switches since `from`. */
const lastSong = () => { for (let i = sets.length - 1; i >= 0; i--) if (sets[i][0] === "song_json") return JSON.parse(sets[i][1]); return null; };
const lastSet = (k) => { for (let i = sets.length - 1; i >= 0; i--) if (sets[i][0] === k) return sets[i][1]; return null; };
/* Save (Back) and read the song, then open it again on `track`'s button. */
function saved(trackPresses) {
    press(C.MoveBack);
    const song = JSON.parse(H.files.get(PATH));
    click();
    for (const b of trackPresses) press(b);
    return song;
}

g.init();
tick(3);
jog(-8); click();             /* Song Bank */
jog(1); click();              /* H */
press(C.MoveRow1);            /* the Chord track */
tick(5);

/* ---- the Chord track's pads ---- */
check(padLed(0, 0) === C.AzureBlue && padLed(1, 2) === C.AzureBlue, "I and vii° in the track colour: " + padLed(0, 0));
check(padLed(2, 0) === 96 && padLed(3, 0) === 96, "bII and bVII dimmer (out of the key): " + padLed(2, 0));
check(padLed(1, 3) === C.DarkGrey, "No Chord grey");
check(padLed(3, 1) === C.Black, "unused pads dark");
check(padLed(0, 4) === 26 && padLed(3, 7) === 26, "the right half: chord types");
check(has(["PAD", "PICK"]), "footer: PAD PICK: " + JSON.stringify(M.footerHints()));

pad(1, 1);                    /* vi */
let s = lastSong();
check(s && s.sections.length === 1 && s.sections[0].chords[0].root === "A" && s.sections[0].chords[0].quality === "min",
      "vi plays a bar of Am: " + JSON.stringify(s && s.sections[0].chords));
check(s && s.sections[0].clips.length === 1 && s.sections[0].clips[0].end_bar === 1, "...over one drum bar");
check(s && s.instruments[2].enabled && !s.instruments[0].enabled, "...on the Pads, no instrument being on");
check(lastSet("drum_enabled") === "0" && lastSet("click_enabled") === "0", "...drums and click silenced");
check(padLed(1, 1) === C.White, "vi selected: white");
check(has(["STEP", "ADD"]), "footer: STEP ADD: " + JSON.stringify(M.footerHints()));
running = false; tick(5);    /* the bar ends */
check(lastSet("drum_enabled") === "1" && lastSet("click_enabled") === "0" /* the click was off */,
      "after the preview the drums are back: " + lastSet("drum_enabled"));

step(1);                      /* bar 2: empty */
step(0);                      /* bar 1: has C on beat 1 */
let song = saved([C.MoveRow1, C.MoveRow1]);
let ch = song.sections[0].chords;
check(ch[1] && ch[1].root === "A" && ch[1].quality === "min" && !ch[1].beat, "an empty bar gets Am on beat 1: " + JSON.stringify(ch[1]));
check(Array.isArray(ch[0]) && ch[0][0].root === "C" && ch[0][1].root === "A" && ch[0][1].beat === 3,
      "a bar with C on beat 1 gets Am halfway (beat 3): " + JSON.stringify(ch[0]));

pad(1, 1);                    /* vi again */
pad(0, 4);                    /* Major: A */
check(lastSong().sections[0].chords[0].quality === "maj" && padLed(0, 4) === C.White, "a type pad changes the selected root's type");
step(1);                      /* bar 2 has Am on beat 1: A goes halfway */
pad(1, 1);                    /* Am */
step(0);                      /* bar 1 has Am: out it comes */
song = saved([C.MoveRow1, C.MoveRow1]);
ch = song.sections[0].chords;
check(Array.isArray(ch[1]) && ch[1][1].root === "A" && ch[1][1].quality === "maj" && ch[1][1].beat === 3,
      "A joins bar 2 halfway: " + JSON.stringify(ch[1]));
check(ch[0] && !Array.isArray(ch[0]) && ch[0].root === "C", "the same chord's step takes it out: " + JSON.stringify(ch[0]));

/* ---- the Inst 1 track: variations ---- */
press(C.MoveRow2);
tick(5);
check(padLed(0, 4) === 9 && padLed(2, 4) === C.AzureBlue && padLed(3, 7) === 20, "bass, chord and arp variations");
check(padLed(1, 3) === C.Black, "no No Chord pad here");
check(has(["PAD", "PICK"]), "nothing picked on Inst 1: PAD PICK");
pad(0, 5);                    /* Bass 1-5 */
s = lastSong();
const it = s && s.instruments[0].items;
check(s && s.instruments[0].enabled && !s.instruments[2].enabled, "the preview plays Inst 1 alone (it is off in the song)");
check(it && it.length === 1 && it[0].voicing === "bass" && it[0].pattern === 1, "...as Bass 1-5: " + JSON.stringify(it));
check(s && s.sections[0].chords[0].root === "C", "...over the chord at the selected bar (C)");
check(s && s.instruments[0].follow_note === 36 && s.sections[0].clips[0].source.indexOf("beat") >= 0,
      "...following the section's own kick");
running = false; tick(5);
pad(1, 0);                    /* V: preview over G instead */
check(lastSong().sections[0].chords[0].root === "G" && lastSong().instruments[0].items[0].pattern === 1, "a root pad: the same item over G");
running = false; tick(5);
step(2);                      /* bar 3 */
step(3); step(3);             /* bar 4: added, then taken out */
song = saved([C.MoveRow2]);
let items = song.sections[0].inst[0];
check(items.length === 1 && items[0].bar === 2 && items[0].voicing === "bass" && items[0].pattern === 1 && !items[0].beat,
      "Bass 1-5 added to bar 3 only: " + JSON.stringify(items));

/* ---- the Pads track: inversion x strum ---- */
press(C.MoveRow4);
tick(5);
pad(1, 5);                    /* Root, Strum Up */
s = lastSong();
check(s && s.instruments[2].items[0].inversion === 0 && s.instruments[2].items[0].strum > 0 && s.instruments[2].items[0].strum_dir === 0,
      "Pads: Root, Strum Up: " + JSON.stringify(s && s.instruments[2].items));
running = false; tick(5);

/* ---- while the song plays, a pad only selects ---- */
press(C.MovePlay);
tick(10);
check(running, "playing");
const n = sets.filter(x => x[0] === "song_json").length;
pad(0, 6);                    /* 1st Inv, no strum */
check(sets.filter(x => x[0] === "song_json").length === n && padLed(0, 6) === C.White, "a pad while playing selects, no preview");
press(C.MovePlay);
tick(5);

console.log(`harmony pads: ${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
