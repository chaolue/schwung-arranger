/* Under a chain view (Schwung's slot/chain, send or Master FX editor, held
 * open from a Track or Menu hold) Arranger's screen is hidden, so the buttons
 * that act on it must do nothing and go dark: Delete on the Song Bank once
 * deleted a song nobody could see. Play, the Track buttons and Menu keep
 * working; in Song Builder the pads (which add clips) are dropped too. */
import * as H from './host_mock.mjs';

const SONGS = "/data/UserData/UserLibrary/Arranger/Songs";
const songJson = (name) => JSON.stringify({ name, tempo_bpm: 120, time_sig_num: 4, time_sig_den: 4,
    sections: [{ name: "Verse", clips: [{ source: "Grooves/beat.mid", name: "beat", start_bar: 0, end_bar: 2 }] }] });
H.files.set(SONGS + "/a.json", songJson("A"));
H.files.set(SONGS + "/b.json", songJson("B"));
const songList = [{ name: "A", path: SONGS + "/a.json" }, { name: "B", path: SONGS + "/b.json" }];
globalThis.host_module_get_param = (k) => {
    if (k === "songs_json") return JSON.stringify({ count: songList.length, start: 0, items: songList });
    if (k === "folders_json") return JSON.stringify({ count: 1, start: 0, items: [{ name: "Kit", category: "" }] });
    if (/^folder_clips_json_/.test(k)) return JSON.stringify(["01 Groove.mid", "02 Groove.mid"]);
    return null;
};

await import('./ui_test.mjs');
const C = await import('./shared/constants.mjs');
const g = globalThis;
let failures = 0, passes = 0;
function check(cond, msg) { if (cond) passes++; else { failures++; console.log("FAIL: " + msg); } }
function cc(n, v) { g.onMidiMessageInternal([0xB0, n, v]); }
function tick(n = 1, ms = 23) { for (let i = 0; i < n; i++) { H.advance(ms); H.hostFrame(); g.tick(); } }
function jog(n) { for (let i = 0; i < Math.abs(n); i++) cc(C.MoveMainKnob, n > 0 ? 1 : 127); tick(); }
function press(n) { cc(n, 127); cc(n, 0); tick(2); }
function hold(n) { cc(n, 127); tick(Math.ceil(600 / 23)); cc(n, 0); tick(); }
const songFiles = () => [...H.files.keys()].filter(k => k.startsWith(SONGS + "/") && k.endsWith(".json")).length;
const lit = (n) => (H.buttonLeds.get(n) || 0) !== 0;

g.init();
tick(3);
jog(-8); press(C.MoveMainButton);    /* Song Bank */
jog(1); press(C.MoveMainButton);     /* song A: Song Builder, Drum track */
tick(20);                            /* its pads loaded */

/* ---- Song Builder: a pad tap adds a clip; not under a chain view ---- */
hold(C.MoveRow2);
check(H.corun.target === 1, "chain view over Song Builder");
const pad = C.MovePads[0];
g.onMidiMessageInternal([0x90, pad, 100]); tick();   /* a tap under it... */
g.onMidiMessageInternal([0x80, pad, 0]); tick();
g.onMidiMessageInternal([0x90, pad, 100]); tick();   /* ...and a pad pressed under it */
hold(C.MoveRow2);                                    /* closed while that pad is held */
g.onMidiMessageInternal([0x80, pad, 0]); tick();
press(C.MoveBack); tick(3);                          /* out of the song (saved): Song Bank */
const saved = JSON.parse(H.files.get(SONGS + "/a.json"));
check(saved.sections[0].clips.length === 1, "the pads added no clip: " + saved.sections[0].clips.length);

/* ---- Song Bank under a chain view ---- */
tick(3);
check(lit(C.MoveDelete) && lit(C.MoveCopy), "Song Bank on a song: Delete and Copy lit");
const nSongs = songFiles();
hold(C.MoveRow1);
check(H.corun.target === 1, "Track 1 hold: chain view open");
tick(2);
check(!lit(C.MoveDelete) && !lit(C.MoveCopy) && !lit(C.MoveLoop) && !lit(C.MoveUndo),
      "under it: Delete, Copy, Loop, Undo dark");
press(C.MoveCopy);
check(songFiles() === nSongs, "Copy made no song (" + songFiles() + " files)");
for (const b of [C.MoveDelete, C.MoveLoop, C.MoveUndo, C.MoveMute, C.MoveCapture, C.MoveRecord,
                 C.MoveUp, C.MoveDown, C.MoveLeft, C.MoveRight]) press(b);
hold(C.MoveRow1);
check(H.corun.target === 0, "Track 1 hold again: closed");
tick(3);
H.printed.length = 0;
tick(1);
/* The Delete confirm prints the song's name in quotes. */
check(!H.printed.some(t => /"A"/.test(t)), "Delete opened no confirm: " + JSON.stringify(H.printed.slice(0, 6)));
check(lit(C.MoveDelete) && lit(C.MoveCopy), "back on the Song Bank: Delete and Copy lit again");
press(C.MoveCopy);
check(songFiles() === nSongs + 1, "Copy works once the view is closed");

console.log(`${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
