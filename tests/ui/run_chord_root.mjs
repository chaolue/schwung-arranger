/* The chord page's Root row takes any root, in or out of the key: semitone
 * by semitone from the key's root (I bII ii bIII iii IV #IV V bVI vi bVII
 * vii°), then No Chord. A chord outside the key opens showing its own root
 * (it used to show as I), and one picked there is saved with a flat name. */
import * as H from './host_mock.mjs';

const SONGS = "/data/UserData/UserLibrary/Arranger/Songs";
const PATH = SONGS + "/c.json";
H.files.set(PATH, JSON.stringify({ name: "C", key: "C", tempo_bpm: 120, time_sig_num: 4, time_sig_den: 4,
    sections: [{ name: "Verse", clips: [{ source: "Grooves/beat.mid", name: "beat", start_bar: 0, end_bar: 2 }],
                 chords: [{ root: "Eb", quality: "maj" }] }] }));
globalThis.host_module_get_param = (k) => k === "songs_json"
    ? JSON.stringify({ count: 1, start: 0, items: [{ name: "C", path: PATH }] }) : null;

const M = await import('./ui_test.mjs');
const C = await import('./shared/constants.mjs');
const g = globalThis;
let failures = 0, passes = 0;
function check(cond, msg) { if (cond) passes++; else { failures++; console.log("FAIL: " + msg); } }
function cc(n, v) { g.onMidiMessageInternal([0xB0, n, v]); }
function tick(n = 1, ms = 23) { for (let i = 0; i < n; i++) { H.advance(ms); H.hostFrame(); g.tick(); } }
function jog(n) { for (let i = 0; i < Math.abs(n); i++) cc(C.MoveMainKnob, n > 0 ? 1 : 127); tick(); }
function press(n) { H.printed.length = 0; cc(n, 127); cc(n, 0); tick(2); }
const click = () => press(C.MoveMainButton);
const back = () => press(C.MoveBack);
/* A value as drawn: plain, or [bracketed] while being edited. */
const shown = (t) => H.printed.some(p => p === t || p === "[" + t + "]");

/* Names: the key's own notes as its chords name them, flat degrees with flats. */
check(M.chordRootName("C", 10) === "Bb" && M.chordRootName("C", 3) === "Eb" && M.chordRootName("C", 6) === "F#",
      "in C: bVII Bb, bIII Eb, #IV F#");
check(M.chordRootName("D", 10) === "C" && M.chordRootName("D", 1) === "Eb", "in D: bVII C, bII Eb");
check(M.chordRootName("G", 7) === "D" && M.chordRootName("F", 1) === "Gb", "in G: V D; in F: bII Gb");

g.init();
tick(3);
jog(-8); click();              /* Song Bank */
jog(1); click();               /* C */
press(C.MoveRow1);             /* Chord track */
jog(-5); jog(1);               /* the Eb chord (after the section row) */
click();
check(shown("bIII (Eb)"), "an Eb chord in C opens as bIII (Eb), not I: " + JSON.stringify(H.printed.slice(0, 6)));
back();                        /* unchanged: saved as it was */

jog(5); click();               /* + Add: a new chord, Root in edit */
check(shown("I (C)"), "a new chord starts on I (C)");
H.printed.length = 0;
jog(10); tick();               /* I -> bVII by semitones */
check(shown("bVII (Bb)") && shown("Major"), "ten steps up: bVII (Bb), Major: " + JSON.stringify(H.printed.slice(0, 6)));
H.printed.length = 0;
jog(-8); tick();
check(shown("ii (D)") && shown("Minor"), "back eight: ii (D), the key's minor: " + JSON.stringify(H.printed.slice(0, 6)));
/* Type (row 1) on ii: Minor up to Min7 Add4, m7(4). */
back();                        /* out of Root's edit */
jog(1); click();               /* Type, in edit */
H.printed.length = 0;
jog(19); tick();
check(shown("Min7 Add4"), "the Type row reaches Min7 Add4: " + JSON.stringify(H.printed.slice(0, 6)));
check(H.printed.some(p => p.includes("Dm7(4)")), "...shown as Dm7(4)");
back(); jog(-1); click();      /* back to Root, in edit */
jog(8); tick();                /* ii -> bVII (type resets to Major) */
back(); back();                /* out of edit; save the chord */
back();                        /* out of the song */
const chords = JSON.parse(H.files.get(PATH)).sections[0].chords;
const flat = JSON.stringify(chords);
check(/"root":"Eb","quality":"maj"/.test(flat), "the Eb chord kept: " + flat);
check(/"root":"Bb","quality":"maj"/.test(flat), "the new bVII saved as Bb major: " + flat);

console.log(`${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
