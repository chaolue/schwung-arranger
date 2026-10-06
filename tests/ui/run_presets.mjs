/* A knob mapped to a module's user presets ("My Presets"): the picker offers
 * them, a turn loads the next preset's whole state into "<comp>:state", and
 * the chosen preset is saved and restored like any knob value. */
import * as H from './host_mock.mjs';

const SONGS = "/data/UserData/UserLibrary/Arranger/Songs";
const SETLISTS = "/data/UserData/UserLibrary/Arranger/Setlists";
const PRESETS = "/data/UserData/schwung/presets/dexed";
H.files.set(SONGS + "/a.json", JSON.stringify({ name: "Song A", tempo_bpm: 120, sections: [
    { name: "Verse", clips: [{ source: "Grooves/beat.mid", name: "beat" }] }] }));
const GIG = SETLISTS + "/gig.json";
H.files.set(GIG, JSON.stringify({ id: "s1", name: "Gig", songs: [
    { id: "e1", name: "Song A", path: SONGS + "/a.json", click_bars: 0 }] }));
/* Two Dexed presets, out of name order on disk; one state an object, one a
 * raw string (Schwung stores either). */
H.files.set(PRESETS + "/warm.json", JSON.stringify({ name: "Warm", module: "dexed", version: 1, state: "raw-warm" }));
H.files.set(PRESETS + "/bright.json", JSON.stringify({ name: "Bright", module: "dexed", version: 1, state: { a: 1 } }));

await import('./ui_test.mjs');
const g = globalThis;
let failures = 0, passes = 0;
function check(cond, msg) { if (cond) passes++; else { failures++; console.log("FAIL: " + msg); } }
function cc(n, v) { g.onMidiMessageInternal([0xB0, n, v]); }
function tick(n = 1, ms = 23) { for (let i = 0; i < n; i++) { H.advance(ms); H.hostFrame(); g.tick(); } }
const JOG = 14, CLICK = 3, BACK = 51;
function jog(n) { for (let i = 0; i < Math.abs(n); i++) cc(JOG, n > 0 ? 1 : 127); tick(); }
function click() { H.printed.length = 0; cc(CLICK, 127); cc(CLICK, 0); tick(); }
function back() { H.printed.length = 0; cc(BACK, 127); cc(BACK, 0); tick(); }
function root(row) { jog(-8); jog(row); }
function saved() { return JSON.parse(H.files.get(GIG)); }
function lastWrite(slot, key) {
    for (let i = H.writes.length - 1; i >= 0; i--) if (H.writes[i][0] === slot && H.writes[i][1] === key) return H.writes[i][2];
    return undefined;
}

g.init();
tick(3);
root(1); click();            /* Setlists */
jog(1); click();             /* Gig */
jog(2); click();             /* Song A, (add song), (knobs) */
click();                     /* knob 1 -> chain list */
jog(1); click();             /* Chain 1 */
click();                     /* Synth (Dexed) */
check(H.printed[0] === "My Presets" && H.printed.includes("Cutoff"),
      "Dexed's parameters start with My Presets: " + JSON.stringify(H.printed));
click();                     /* My Presets */
let sl = saved();
check(sl.knobs && sl.knobs[0] && sl.knobs[0].key === "__user_preset" && sl.knobs[0].module === "dexed" &&
      sl.knobs[0].value === undefined, "knob 1 mapped to My Presets, nothing chosen yet: " + JSON.stringify(sl.knobs && sl.knobs[0]));
back(); back(); back();      /* Setlist Edit, Bank, Root */

/* Perform: nothing chosen, so nothing is loaded. A turn (two detents per
 * preset) loads the first by name, Bright, then the next, Warm. */
H.writes.length = 0;
root(2); click(); click();
tick(3);
check(lastWrite(0, "synth:state") === undefined, "no preset loaded with nothing chosen");
cc(71, 1); cc(71, 1); tick();
check(lastWrite(0, "synth:state") === '{"a":1}', "first turn loads Bright's state: " + lastWrite(0, "synth:state"));
check(H.printed.some(t => /Bright/.test(t)), "knob feedback names the preset: " + JSON.stringify(H.printed.slice(-3)));
cc(71, 1); cc(71, 1); tick();
check(lastWrite(0, "synth:state") === "raw-warm", "next loads Warm's raw state: " + lastWrite(0, "synth:state"));
cc(71, 1); cc(71, 1); tick();
check(lastWrite(0, "synth:state") === "raw-warm" && H.writes.filter(w => w[1] === "synth:state").length === 2,
      "past the last preset nothing more is loaded");
tick(Math.ceil(1700 / 23));
sl = saved();
check(sl.songs[0].knob_values && sl.songs[0].knob_values[0] && sl.songs[0].knob_values[0].value === "Warm",
      "the song saves Warm: " + JSON.stringify(sl.songs[0].knob_values));

console.log(`${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
