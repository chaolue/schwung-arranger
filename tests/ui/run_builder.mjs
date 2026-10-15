/* Song Builder through the real src/ui.js (see run.mjs for the harness):
 * the footer names only what works on the selected row (Name on a section
 * row, Add on "+ Add", Menu where the click does nothing, nothing that a
 * locked song refuses), the Inst/Click tracks' "+ Add" needs a chord,
 * Track 2/3 turn an instrument on or off on its own track, and Copy
 * duplicates a setlist. */
import * as H from './host_mock.mjs';

const SONGS = "/data/UserData/UserLibrary/Arranger/Songs";
const SETLISTS = "/data/UserData/UserLibrary/Arranger/Setlists";
const song = (name, extra) => JSON.stringify(Object.assign({ name, tempo_bpm: 120, time_sig_num: 4, time_sig_den: 4,
    sections: [{ name: "Verse", clips: [{ source: "Grooves/beat.mid", name: "beat", start_bar: 0, end_bar: 2 }] }] }, extra || {}));
H.files.set(SONGS + "/plain.json", song("Plain"));
H.files.set(SONGS + "/locked.json", song("Locked", { locked: true }));
H.files.set(SETLISTS + "/gig.json", JSON.stringify({ id: "s1", name: "Gig", songs: [
    { id: "e1", name: "Plain", path: SONGS + "/plain.json", click_bars: 2 }], knobs: [] }));
/* The DSP's song list. */
const songList = [{ name: "Locked", path: SONGS + "/locked.json" }, { name: "Plain", path: SONGS + "/plain.json" }];
globalThis.host_module_get_param = (k) =>
    k === "songs_json" ? JSON.stringify({ count: songList.length, start: 0, items: songList }) : null;

const M = await import('./ui_test.mjs');
const g = globalThis;
const C = await import('./shared/constants.mjs');
let failures = 0, passes = 0;
function check(cond, msg) { if (cond) passes++; else { failures++; console.log("FAIL: " + msg); } }
function cc(n, v) { g.onMidiMessageInternal([0xB0, n, v]); }
function tick(n = 1, ms = 23) { for (let i = 0; i < n; i++) { H.advance(ms); H.hostFrame(); g.tick(); } }
function jog(n) { for (let i = 0; i < Math.abs(n); i++) cc(C.MoveMainKnob, n > 0 ? 1 : 127); tick(); }
function press(n) { H.printed.length = 0; cc(n, 127); cc(n, 0); tick(); }
const click = () => press(C.MoveMainButton);
const back = () => press(C.MoveBack);
function root(row) { jog(-8); jog(row); }
const hints = () => JSON.stringify(M.footerHints());
const has = (pair) => M.footerHints().some(p => p[0] === pair[0] && p[1] === pair[1]);
const clk = () => { const p = M.footerHints().find(p => p[0] === "CLK"); return p ? p[1] : null; };

g.init();
tick(3);

/* ---- an unlocked song with no chords ---- */
root(0); click();            /* Song Bank */
jog(2); click();             /* Plain (row 0 is + New Song) */
check(clk() === "TRIM" && has(["PAD", "ADD"]), "Drum track on a clip: CLK TRIM, PAD ADD: " + hints());
jog(-1);
check(clk() === "NAME", "Drum track on the section row: CLK NAME: " + hints());

press(C.MoveRow1);           /* Chord track; no chords: row 0 is + Add */
check(clk() === "ADD", "Chord track on + Add: CLK ADD: " + hints());
jog(-1);
check(clk() === "NAME", "Chord track on the section row: CLK NAME: " + hints());

press(C.MoveRow2);           /* Inst 1 */
check(H.printed.includes("(add chords first)") && !H.printed.includes("+ Add"),
      "no chords: Inst 1's + Add gives the reason instead: " + JSON.stringify(H.printed));
check(clk() === null && has(["MENU", "SET"]), "...and its footer offers Menu, not the click: " + hints());
click();
check(!H.printed.includes("Bar"), "the click opens no item page: " + JSON.stringify(H.printed));
press(C.MoveRow4);           /* Click track */
check(H.printed.includes("(add chords first)"), "the Click track's + Add too");

/* Track 2 on Inst 1 turns it on and off. */
press(C.MoveRow2);
check(has(["T2", "ON"]), "Inst 1 is off: T2 ON: " + hints());
press(C.MoveRow2);
check(has(["T2", "OFF"]), "Track 2 on its own track turns Inst 1 on: " + hints());
back();                       /* saves */
check(JSON.parse(H.files.get(SONGS + "/plain.json")).instruments[0].enabled === true, "...saved in the song");

/* ---- a locked song ---- */
jog(-1); click();             /* Locked */
const lockedDrum = M.footerHints();
check(clk() === null && !has(["PAD", "ADD"]) && has(["MENU", "SET"]),
      "locked, Drum track: no CLK or PAD ADD, Menu instead: " + hints());
press(C.MoveRow1);
check(clk() === null && has(["MENU", "SET"]), "locked, Chord track: Menu instead of the click: " + hints());
click();
check(!H.printed.some(t => /^Root/.test(t)), "locked: the click opens no chord page");
cc(C.MoveShift, 127); tick();
check(!has(["JOG", "MOVE"]), "locked: Shift offers no Jog Move: " + hints());
cc(C.MoveShift, 0); tick();
back();
back();

/* ---- Copy duplicates a setlist ---- */
root(1); click();            /* Setlists */
jog(1);
press(C.MoveCopy);
const copy = H.files.get(SETLISTS + "/Gig_copy.json");
check(!!copy, "Copy writes Gig copy: " + [...H.files.keys()].filter(k => k.startsWith(SETLISTS)).join(", "));
const c = copy ? JSON.parse(copy) : {};
check(c.name === "Gig copy" && c.id !== "s1" && c.songs && c.songs.length === 1 && c.songs[0].click_bars === 2,
      "the copy has the songs and their settings, a new id: " + copy);
press(C.MoveCopy);
check(!!H.files.get(SETLISTS + "/Gig_copy_2.json") || !!H.files.get(SETLISTS + "/Gig_copy_copy.json"),
      "copying again makes another: " + [...H.files.keys()].filter(k => k.startsWith(SETLISTS)).join(", "));

/* ---- Follow Note: with Bass voicing, up from Off jumps to the kick ---- */
check(M.stepFollowNote(0, 1, true) === 36 && M.stepFollowNote(0, 1, false) === 1, "Off +1: 36 for Bass, 1 for Chord");
check(M.stepFollowNote(36, -1, true) === 35 && M.stepFollowNote(0, 3, true) === 38, "steps normally from there");

console.log(`${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
