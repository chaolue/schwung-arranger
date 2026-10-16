/* Perform follows a mapped parameter changed elsewhere (the Remote UI,
 * Schwung's editor): the knob takes the new value for the current song, the
 * setlist is saved, and the feedback shows it -- naming the bank when the
 * knob is in another one. Its own writes are not mistaken for one. */
import * as H from './host_mock.mjs';

const SONGS = "/data/UserData/UserLibrary/Arranger/Songs";
const SETLISTS = "/data/UserData/UserLibrary/Arranger/Setlists";
const song = (name) => JSON.stringify({ name, tempo_bpm: 120, sections: [
    { name: "Verse", clips: [{ source: "Grooves/beat.mid", name: "beat" }] }] });
H.files.set(SONGS + "/a.json", song("Song A"));
const GIG = SETLISTS + "/gig.json";
const knobs = [];
knobs[0] = { slot: 0, comp: "synth", key: "cutoff", module: "dexed", moduleName: "Dexed", label: "Cutoff", value: "0.50" };
knobs[9] = { slot: 0, comp: "fx1", key: "mix", module: "freeverb", moduleName: "Freeverb", label: "Mix", value: "0.30" };
H.files.set(GIG, JSON.stringify({ id: "s1", name: "Gig", move_set: { uuid: "set-a", name: "Gig Set" }, knobs,
    songs: [{ id: "e1", name: "Song A", path: SONGS + "/a.json", click_bars: 0 }] }));

await import('./ui_test.mjs');
const g = globalThis;
let failures = 0, passes = 0;
function check(cond, msg) { if (cond) passes++; else { failures++; console.log("FAIL: " + msg); } }
function cc(n, v) { g.onMidiMessageInternal([0xB0, n, v]); }
function tick(n = 1, ms = 23) { for (let i = 0; i < n; i++) { H.advance(ms); H.hostFrame(); g.tick(); } }
const JOG = 14, CLICK = 3;
function jog(n) { for (let i = 0; i < Math.abs(n); i++) cc(JOG, n > 0 ? 1 : 127); tick(); }
function click() { H.printed.length = 0; cc(CLICK, 127); cc(CLICK, 0); tick(); }
const saved = () => JSON.parse(H.files.get(GIG));
const synth = H.slots[0].comps.synth.values, fx = H.slots[0].comps.fx1.values;

g.init();
tick(3);
jog(-8); jog(2); click();     /* Perform */
click();                      /* Gig */
tick(10);
check(synth.cutoff === "0.50" && fx.mix === "0.30", "song A's values restored: " + synth.cutoff + " " + fx.mix);

/* Our own restore is not a change: nothing shows, nothing saved. */
H.printed.length = 0;
tick(40);
check(!H.printed.some(t => /Cutoff|Mix/.test(t)), "no feedback for the values it set itself: " + JSON.stringify(H.printed));
check(!saved().songs[0].knob_values, "nothing saved for them");

/* The Remote UI moves cutoff (knob 1, this bank). */
synth.cutoff = "0.8000";
H.printed.length = 0;
tick(20);
check(H.printed.some(t => /Cutoff 0\.80/.test(t)) && H.printed.includes("C1 Synth Dexed"),
      "the feedback shows the new value: " + JSON.stringify(H.printed.slice(-4)));
tick(80);
let sv = saved().songs[0].knob_values;
check(sv && sv[0] && sv[0].value === "0.8000", "saved as song A's value: " + JSON.stringify(sv));

/* A drag: once its first step is seen, each next one is followed quickly. */
synth.cutoff = "0.81"; tick(15);
let seen = 0;
for (const v of ["0.82", "0.85", "0.88"]) {
    synth.cutoff = v; H.printed.length = 0; tick(3);
    if (H.printed.some(t => t.indexOf("Cutoff " + v) >= 0)) seen++;
}
check(seen === 3, "a drag is followed step by step (" + seen + "/3)");

/* Then a turn of Move's knob 1 carries on from there. */
H.writes.length = 0;
cc(71, 2); tick(2);
check(synth.cutoff === "0.90", "the next turn steps from the outside value: " + synth.cutoff);

/* Bank 2's knob 1 (Mix) changed elsewhere: shown, naming its bank. */
tick(100);
fx.mix = "0.60";
H.printed.length = 0;
tick(25);
check(H.printed.some(t => /^B2 C1 FX 1/.test(t)) && H.printed.some(t => /Mix 0\.60/.test(t)),
      "another bank's knob is shown with its bank: " + JSON.stringify(H.printed.slice(-4)));
tick(80);
sv = saved().songs[0].knob_values;
check(sv && sv[9] && sv[9].value === "0.60", "and saved: " + JSON.stringify(sv));

console.log(`${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
