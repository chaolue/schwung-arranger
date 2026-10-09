/* Knob banks: Sample cycles 4 banks of 8 knob mappings in Perform and on the
 * Knobs screen; bank b's knob k is stored at b*8+k; each bank lights the
 * knobs with its own colour sweep at each knob's value. */
import * as H from './host_mock.mjs';

const SONGS = "/data/UserData/UserLibrary/Arranger/Songs";
const SETLISTS = "/data/UserData/UserLibrary/Arranger/Setlists";
H.files.set(SONGS + "/a.json", JSON.stringify({ name: "Song A", tempo_bpm: 120, sections: [
    { name: "Verse", clips: [{ source: "Grooves/beat.mid", name: "beat" }] }] }));
const GIG = SETLISTS + "/gig.json";
const knobs = [];
knobs[0] = { slot: 0, comp: "synth", key: "cutoff", module: "dexed", moduleName: "Dexed", label: "Cutoff", value: "1.00" };
knobs[8] = { slot: 0, comp: "synth", key: "wave", module: "dexed", moduleName: "Dexed", label: "Wave", value: "Sine" };
H.files.set(GIG, JSON.stringify({ id: "s1", name: "Gig", move_set: { uuid: "set-a", name: "Gig Set" }, knobs,
    songs: [{ id: "e1", name: "Song A", path: SONGS + "/a.json", click_bars: 0 }] }));

const ui = await import('./ui_test.mjs');
const g = globalThis;
let failures = 0, passes = 0;
function check(cond, msg) { if (cond) passes++; else { failures++; console.log("FAIL: " + msg); } }
function cc(n, v) { g.onMidiMessageInternal([0xB0, n, v]); }
function tick(n = 1, ms = 23) { for (let i = 0; i < n; i++) { H.advance(ms); H.hostFrame(); g.tick(); } }
const JOG = 14, CLICK = 3, BACK = 51, SAMPLE = 118;
function jog(n) { for (let i = 0; i < Math.abs(n); i++) cc(JOG, n > 0 ? 1 : 127); tick(); }
function click() { H.printed.length = 0; cc(CLICK, 127); cc(CLICK, 0); tick(); }
function back() { H.printed.length = 0; cc(BACK, 127); cc(BACK, 0); tick(); }
function lastWrite(slot, key) {
    for (let i = H.writes.length - 1; i >= 0; i--) if (H.writes[i][0] === slot && H.writes[i][1] === key) return H.writes[i][2];
    return undefined;
}

g.init();
tick(3);
/* Perform -> Gig: bank 1's knob 1 is Cutoff (restored to 1.00), and bank 2's
 * Wave is restored too (every bank's values are restored). */
H.writes.length = 0;
jog(-8); jog(2); click(); click();
tick(20);
check(lastWrite(0, "synth:cutoff") === "1.00" && lastWrite(0, "synth:wave") === "Sine",
      "song load restores every bank's knobs: " + JSON.stringify(H.writes));
tick(20);
check(H.knobLeds[0] === 120, "bank 1 (neutral sweep): knob 1 at max is White 120 (" + H.knobLeds[0] + ")");
check(H.knobLeds[1] === 0, "unmapped knob 2 is off (" + H.knobLeds[1] + ")");
cc(71, 127); tick();          /* knob 1 down */
check(lastWrite(0, "synth:cutoff") === "0.99", "bank 1: knob 1 turns Cutoff: " + lastWrite(0, "synth:cutoff"));

/* Sample -> bank 2: knob 1 is Wave, lit along the rainbow sweep. */
cc(SAMPLE, 127); cc(SAMPLE, 0); tick(20);
check(H.knobLeds[0] === 33, "bank 2 (rainbow sweep): Wave at Sine (first of 3) is Blue 33 (" + H.knobLeds[0] + ")");
cc(71, 1); cc(71, 1); tick();
check(lastWrite(0, "synth:wave") === "Saw", "bank 2: knob 1 steps Wave to Saw: " + lastWrite(0, "synth:wave"));
tick(20);
check(H.knobLeds[0] === 11, "Wave at Saw (middle) is Neon Green 11 (" + H.knobLeds[0] + ")");
/* Sample x3 more -> back to bank 1. */
for (let n = 0; n < 3; n++) { cc(SAMPLE, 127); cc(SAMPLE, 0); tick(); }
tick(20);
check(H.knobLeds[0] === 122 || H.knobLeds[0] === 120, "round to bank 1 again: neutral sweep (" + H.knobLeds[0] + ")");
tick(Math.ceil(1700 / 23));
const sl = JSON.parse(H.files.get(GIG));
check(sl.songs[0].knob_values && sl.songs[0].knob_values[8] && sl.songs[0].knob_values[8].value === "Saw",
      "bank 2's turn saved at index 8: " + JSON.stringify(sl.songs[0].knob_values));

/* Knobs screen (Setlist Edit > (knobs)): Sample shows bank 2's mappings
 * (the header names the bank, in the header font the mock does not record). */
back(); tick(3);
jog(-8); jog(1); click();     /* Setlists */
jog(1); click();              /* Gig */
jog(2); click();              /* Song A, (add song), (knobs) */
check(H.printed.some(t => /C1 Cutoff/.test(t)), "Knobs screen opens on bank 1: " + JSON.stringify(H.printed));
H.printed.length = 0; cc(SAMPLE, 127); cc(SAMPLE, 0); tick();
check(H.printed.some(t => /C1 Wave/.test(t)) && !H.printed.some(t => /Cutoff/.test(t)),
      "Sample: bank 2's mappings: " + JSON.stringify(H.printed));

/* The Knobs screen's footer names Sample's bank switch. */
check(JSON.stringify(ui.footerHints()) === '[["CLK","OPEN"],["SMPL","BANK"]]', "footer: CLK OPEN, SMPL BANK: " + JSON.stringify(ui.footerHints()));

console.log(`${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
