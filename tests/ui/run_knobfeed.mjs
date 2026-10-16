/* With Schwung's param change feed, Perform follows a mapped parameter changed
 * elsewhere from the feed -- every tick, with no reads -- and only reads back
 * when the feed reports it lost changes. (run_knobsync.mjs is the same without
 * a feed, where Perform polls.) */
import * as H from './host_mock.mjs';
H.enableFeed();

const SONGS = "/data/UserData/UserLibrary/Arranger/Songs";
const SETLISTS = "/data/UserData/UserLibrary/Arranger/Setlists";
H.files.set(SONGS + "/a.json", JSON.stringify({ name: "Song A", tempo_bpm: 120, sections: [
    { name: "Verse", clips: [{ source: "Grooves/beat.mid", name: "beat" }] }] }));
const GIG = SETLISTS + "/gig.json";
const knobs = [];
knobs[0] = { slot: 0, comp: "synth", key: "cutoff", module: "dexed", moduleName: "Dexed", label: "Cutoff", value: "0.50" };
knobs[1] = { slot: 0, comp: "settings", key: "slot:volume", module: "settings", moduleName: "", label: "Volume", value: "1.0000" };
knobs[9] = { slot: -1, comp: "fx2", key: "feedback", module: "tapedelay", moduleName: "tapedelay", label: "Feedback", value: "0.40" };
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
const synth = H.slots[0].comps.synth.values;
const reads = (key) => H.paramLog.filter(e => e[0] === "get" && e[2] === key).length;
/* Another client (the Remote UI) sets a parameter. */
function remote(slot, key, value, set) { set(); H.feedPush(slot, key, value); }

g.init();
tick(3);
jog(-8); jog(2); click();     /* Perform */
click();                      /* Gig */
tick(10);
check(synth.cutoff === "0.50", "song A's cutoff restored: " + synth.cutoff);

/* Steady state: the feed is followed and nothing is read back. */
const before = reads("synth:cutoff") + reads("master_fx:fx2:feedback");
H.printed.length = 0;
tick(80);
check(reads("synth:cutoff") + reads("master_fx:fx2:feedback") === before, "no reads while following the feed");
check(!H.printed.some(t => /Cutoff|Feedback/.test(t)), "its own restore (in the feed too) shows nothing: " + JSON.stringify(H.printed));

/* The Remote UI moves cutoff: shown on the very next tick, from the feed. */
remote(0, "synth:cutoff", "0.80", () => { synth.cutoff = "0.80"; });
H.printed.length = 0;
tick(1);
check(H.printed.some(t => /Cutoff 0\.80/.test(t)), "shown on the next tick: " + JSON.stringify(H.printed.slice(-3)));
tick(80);
let sv = saved().songs[0].knob_values;
check(sv && sv[0] && sv[0].value === "0.80", "saved as song A's value: " + JSON.stringify(sv));

/* A drag: every step, each on its own tick. */
let seen = 0;
for (const v of ["0.81", "0.82", "0.83", "0.84"]) {
    remote(0, "synth:cutoff", v, () => { synth.cutoff = v; });
    H.printed.length = 0; tick(1);
    if (H.printed.some(t => t.indexOf("Cutoff " + v) >= 0)) seen++;
}
check(seen === 4, "a drag is followed tick by tick (" + seen + "/4)");

/* Another chain's parameter of the same name is not this knob's. */
H.printed.length = 0;
H.feedPush(2, "synth:cutoff", "0.10");
tick(2);
check(!H.printed.some(t => /Cutoff 0\.10/.test(t)), "chain 3's cutoff is not chain 1's");

/* A Master FX knob (bank 2) follows its key whatever slot the client used. */
H.masterFx.fx2.values.feedback = "0.70";
H.feedPush(0, "master_fx:fx2:feedback", "0.70");
H.printed.length = 0;
tick(1);
check(H.printed.some(t => /^B2 MFX FX 2/.test(t)) && H.printed.some(t => /Feedback 0\.70/.test(t)),
      "a Master FX knob in bank 2, with its bank: " + JSON.stringify(H.printed.slice(-3)));

/* A chain's Settings name the chain by its slot's name. */
H.slotNames[0] = "Bass";
H.feedPush(0, "slot:volume", "0.80");
H.printed.length = 0;
tick(1);
check(H.printed.includes("C1 Bass - Settings") && H.printed.some(t => /Volume 0\.80/.test(t)),
      "C1 <slot name> - Settings / Volume: " + JSON.stringify(H.printed.slice(-3)));
H.slotNames[0] = "A Very Long Preset Name For Chain One";
H.feedPush(0, "slot:volume", "0.70");
H.printed.length = 0;
tick(1);
const line = H.printed.find(t => /^C1 /.test(t)) || "";
check(/\.\. - Settings$/.test(line) && line.length * 6 <= 130, "a long name is shortened, keeping \"- Settings\": " + line);
H.slotNames[0] = "";
H.feedPush(0, "slot:volume", "0.60");
H.printed.length = 0;
tick(1);
check(H.printed.includes("C1 Settings"), "no name: C1 Settings, as before: " + JSON.stringify(H.printed.slice(-3)));
tick(100);

/* Lost changes: every mapped knob is read back once. */
tick(100);
synth.cutoff = "0.33";        /* changed, and the feed lost it */
H.feedLose();
const r0 = reads("synth:cutoff");
H.printed.length = 0;
tick(40);
check(reads("synth:cutoff") > r0 && H.printed.some(t => /Cutoff 0\.33/.test(t)),
      "after a loss the knobs are read back and the change found: " + JSON.stringify(H.printed.slice(-3)));

console.log(`${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
