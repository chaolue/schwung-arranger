/* Performance knobs and the Move Set check, driven through the real src/ui.js
 * (see run.mjs for how the harness is put together). Covers: mapping a knob
 * from Setlist Edit through the chain/component/parameter picker, a song
 * override, values restored when a song loads, turns saved into the current
 * song, a swapped module refusing to write, and the Move Set prompt. */
import * as H from './host_mock.mjs';

const SONGS = "/data/UserData/UserLibrary/Arranger/Songs";
const SETLISTS = "/data/UserData/UserLibrary/Arranger/Setlists";
const song = (name) => JSON.stringify({ name, tempo_bpm: 120, sections: [
    { name: "Verse", clips: [{ source: "Grooves/beat.mid", name: "beat" }] }] });
H.files.set(SONGS + "/a.json", song("Song A"));
H.files.set(SONGS + "/b.json", song("Song B"));
const GIG = SETLISTS + "/gig.json";
H.files.set(GIG, JSON.stringify({ id: "s1", name: "Gig", songs: [
    { id: "e1", name: "Song A", path: SONGS + "/a.json", click_bars: 0 },
    { id: "e2", name: "Song B", path: SONGS + "/b.json", click_bars: 0 }] }));

await import('./ui_test.mjs');
const g = globalThis;
const { MovePads } = await import('./shared/constants.mjs');
let failures = 0, passes = 0;
function check(cond, msg) { if (cond) passes++; else { failures++; console.log("FAIL: " + msg); } }
function cc(n, v) { g.onMidiMessageInternal([0xB0, n, v]); }
function tick(n = 1, ms = 23) { for (let i = 0; i < n; i++) { H.advance(ms); H.hostFrame(); g.tick(); } }
const JOG = 14, CLICK = 3, BACK = 51, DELETE = 119;
function jog(n) { for (let i = 0; i < Math.abs(n); i++) cc(JOG, n > 0 ? 1 : 127); tick(); }
/* What the next draw prints: Arranger draws on the tick after an input. */
function click() { H.printed.length = 0; cc(CLICK, 127); cc(CLICK, 0); tick(); }
function back() { H.printed.length = 0; cc(BACK, 127); cc(BACK, 0); tick(); }   /* Back acts on release */
function root(row) { jog(-8); jog(row); }   /* the root menu keeps its cursor */
function saved() { return JSON.parse(H.files.get(GIG)); }
function settle() { tick(Math.ceil(1700 / 23)); }         /* past KNOB_SAVE_DELAY_MS */
function lastWrite(slot, key) {
    for (let i = H.writes.length - 1; i >= 0; i--) if (H.writes[i][0] === slot && H.writes[i][1] === key) return H.writes[i][2];
    return undefined;
}

g.init();
tick(3);

/* Root -> Setlists -> Gig -> Setlist Edit -> (knobs). */
root(1); click();            /* Setlists */
jog(1); click();             /* Gig (row 0 is + New Setlist) */
jog(3); click();             /* Song A, Song B, (add song), (knobs) */
check(H.printed[0] === "1 \u2014" && H.printed.includes("5 \u2014"), "Setlist Edit > (knobs) lists the knobs: " + JSON.stringify(H.printed));

/* Knob 1 -> Chain 1 -> Synth -> Cutoff. Chain row 0 is None. */
click();
check(H.printed[0] === "None" && H.printed.includes("Dexed") && H.printed.includes("OB-Xd"),
      "chain list with each chain's synth: " + JSON.stringify(H.printed));
jog(1); click();
check(H.printed.some(t => t === "Synth") && H.printed.some(t => t === "FX 1"), "component list: Synth and FX 1");
click();
check(H.printed.some(t => t === "Cutoff") && !H.printed.some(t => t === "Sample"),
      "parameters from chain_params, without the non-numeric one");
click();                      /* Cutoff */
let sl = saved();
check(sl.knobs && sl.knobs[0] && sl.knobs[0].slot === 0 && sl.knobs[0].comp === "synth" &&
      sl.knobs[0].key === "cutoff" && sl.knobs[0].module === "dexed" && sl.knobs[0].value === "0.50",
      "knob 1 mapped and saved: " + JSON.stringify(sl.knobs && sl.knobs[0]));
check(sl.move_set && sl.move_set.uuid === "set-a" && sl.move_set.name === "Gig Set", "the Move Set is remembered");

/* Knob 2 -> Chain 1 -> FX 1 -> Mix. */
jog(1); click(); jog(1); click(); jog(1); click(); click();
sl = saved();
check(sl.knobs[1] && sl.knobs[1].comp === "fx1" && sl.knobs[1].key === "mix", "knob 2 mapped to FX 1 Mix");

/* Knob 3 -> Master FX -> FX 2 (tapedelay) -> Feedback. Chain rows: None,
 * Chain 1-8, Master FX. */
jog(1); click(); jog(9);
click();
check(H.printed.includes("FX 2") && H.printed.some(t => /^ta/.test(t)) && !H.printed.includes("FX 1"),
      "Master FX lists its loaded positions: " + JSON.stringify(H.printed));
click();
check(H.printed.includes("Feedback"), "Master FX position's parameters: " + JSON.stringify(H.printed));
click();
sl = saved();
check(sl.knobs[2] && sl.knobs[2].slot === -1 && sl.knobs[2].comp === "fx2" && sl.knobs[2].key === "feedback" &&
      sl.knobs[2].module === "tapedelay" && sl.knobs[2].value === "0.40",
      "knob 3 mapped to Master FX 2 Feedback: " + JSON.stringify(sl.knobs[2]));
check(H.printed.includes("3 MFX Feedback"), "the row names Master FX: " + JSON.stringify(H.printed));
cc(73, 2); tick();
check(lastWrite(0, "master_fx:fx2:feedback") === "0.42", "turning knob 3 writes master_fx:fx2:feedback at slot 0: " + JSON.stringify(H.writes.slice(-2)));
jog(-2);

/* Turning knob 1 here sets the value the setlist restores, and is heard. */
cc(71, 5); tick();
check(lastWrite(0, "synth:cutoff") === "0.55", "turning knob 1 writes synth:cutoff 0.55 (got " + lastWrite(0, "synth:cutoff") + ")");
settle();
check(saved().knobs[0].value === "0.55", "...and saves it as the setlist's value");

/* Song B gets its own knob 1 (Chain 3 Wave) and turns knob 2 off. */
back();                       /* to Setlist Edit */
jog(-2); click();             /* Song B -> Transitions */
check(H.printed.includes("Knobs") && H.printed.some(t => /^Se/.test(t)), "Transitions has a Knobs row, inheriting: " + JSON.stringify(H.printed));
jog(3); click();              /* Knobs row */
check(H.printed.some(t => /^1 \(C1 Cutoff\)/.test(t)), "an inherited knob shows in parentheses: " + JSON.stringify(H.printed));
click(); jog(4); click();      /* Use Setlist, Off, Chain 1, 2, 3 */
click(); jog(1); click();      /* Synth -> Wave */
jog(1); click(); jog(1); click(); /* knob 2 -> Off */
sl = saved();
check(sl.songs[1].knobs[0] && sl.songs[1].knobs[0].slot === 2 && sl.songs[1].knobs[0].key === "wave",
      "song B overrides knob 1: " + JSON.stringify(sl.songs[1].knobs));
check(sl.songs[1].knobs[1] && sl.songs[1].knobs[1].off === true, "song B turns knob 2 off");
check(!sl.songs[0].knobs, "song A has no overrides");
check(H.printed.includes("1 C3 Wave") && H.printed.includes("2 Off"), "song B's rows show its overrides: " + JSON.stringify(H.printed));
back();
check(H.printed.includes("2 own"), "Transitions counts song B's overrides");
back(); back(); back();       /* Setlist Edit, Bank, Root */

/* Perform -> Gig. Song A loads and its knob values are restored. */
H.slots[0].comps.synth.values.cutoff = "0.10";
H.slots[0].comps.fx1.values.mix = "0.90";
H.writes.length = 0;
root(2); click(); click();
tick(3);
check(lastWrite(0, "synth:cutoff") === "0.55" && lastWrite(0, "fx1:mix") === "0.30",
      "song A restores cutoff 0.55 and mix 0.30: " + JSON.stringify(H.writes));

check(lastWrite(0, "master_fx:fx2:feedback") === "0.42", "song A restores the Master FX knob too");
H.printed.length = 0;
cc(73, 1); tick();
check(lastWrite(0, "master_fx:fx2:feedback") === "0.43" && H.printed.includes("MFX FX 2 tapedelay"),
      "Performance turn on the Master FX knob, overlay names it: " + JSON.stringify(H.printed.slice(-3)));

/* A turn in Performance is saved into the CURRENT song only. */
H.printed.length = 0;
cc(71, 3); tick();
check(lastWrite(0, "synth:cutoff") === "0.58", "Performance turn writes 0.58");
check(H.printed.some(t => /Cutoff 0\.58/.test(t)), "knob feedback shows name and value: " + JSON.stringify(H.printed.slice(-3)));
check(H.printed.includes("C1 Synth Dexed"), "knob feedback names the chain, component and module: " + JSON.stringify(H.printed.slice(-3)));
settle();
sl = saved();
check(sl.songs[0].knob_values && sl.songs[0].knob_values[0] &&
      sl.songs[0].knob_values[0].value === "0.58" && sl.knobs[0].value === "0.55",
      "saved in song A's values, setlist default untouched: " + JSON.stringify(sl.songs[0].knob_values));
cc(72, 2); tick();
check(lastWrite(0, "fx1:mix") === "0.40", "knob 2 steps by the module's step (0.05): " + lastWrite(0, "fx1:mix"));

/* Song B (pad 1 while stopped): its override and the setlist's other knobs. */
H.writes.length = 0;
g.onMidiMessageInternal([0x90, MovePads[1], 100]); g.onMidiMessageInternal([0x80, MovePads[1], 0]);
tick(3);
check(lastWrite(2, "synth:wave") === "Saw" && lastWrite(0, "fx1:mix") === undefined,
      "song B restores its own knob 1 and not the knob it turned off: " + JSON.stringify(H.writes));
cc(71, 1); tick(); cc(71, 1); tick();
check(lastWrite(2, "synth:wave") === "Square", "song B knob 1 steps the enum to Square");
cc(72, 5); tick();
check(lastWrite(0, "fx1:mix") === undefined, "an Off knob writes nothing");

/* Back to song A: restores A's own saved value, not B's. */
H.writes.length = 0;
g.onMidiMessageInternal([0x90, MovePads[0], 100]); g.onMidiMessageInternal([0x80, MovePads[0], 0]);
tick(3);
check(lastWrite(0, "synth:cutoff") === "0.58", "song A restores its own 0.58");

/* A module swapped under a mapping: no writes, and the knob says so. */
H.slots[0].comps.synth.module = "minijv";
H.writes.length = 0;
g.onMidiMessageInternal([0x90, MovePads[1], 100]); tick();
g.onMidiMessageInternal([0x90, MovePads[0], 100]); tick(3);
H.printed.length = 0;
cc(71, 4); tick();
check(lastWrite(0, "synth:cutoff") === undefined, "a swapped module is never written");
check(H.printed.some(t => /not loaded/.test(t)), "...and the knob reads 'not loaded'");
H.slots[0].comps.synth.module = "dexed";
g.onMidiMessageInternal([0x90, MovePads[1], 100]); tick();
g.onMidiMessageInternal([0x90, MovePads[0], 100]); tick(3);

/* A chain view: what the user changes in Schwung's editor is NOT overwritten
 * on the way back, and the knob continues from it. */
cc(43, 127); tick(Math.ceil(600 / 23)); cc(43, 0); tick();
check(H.corun.target === 1 && H.corun.id === 0, "hold Track 1 opens chain 1 from Performance");
H.slots[0].comps.synth.values.cutoff = "0.20";      /* edited in the chain editor */
H.writes.length = 0;
H.hostEnd(); tick(3);                               /* Back at the editor's top */
check(lastWrite(0, "synth:cutoff") === undefined, "returning from the chain view writes nothing");
cc(71, 1); tick();
check(lastWrite(0, "synth:cutoff") === "0.21", "the knob continues from the editor's 0.20: " + lastWrite(0, "synth:cutoff"));

/* The Move Set changed while Arranger was suspended: asked on resume, and
 * Back leaves Performance for the setlist list. */
H.moveSet.uuid = "set-c"; H.moveSet.name = "Other";
H.printed.length = 0;
g.onResume(); tick(2);
check(H.printed.some(t => t.indexOf("Gig Set") >= 0) && H.printed.some(t => /Loaded: Other/.test(t)),
      "resume with another Set asks, naming the expected one");
back();
check(H.printed.includes("Gig"), "Back from that prompt returns to the setlist list: " + JSON.stringify(H.printed));
H.moveSet.uuid = "set-a"; H.moveSet.name = "Gig Set";
back();                        /* leave the list for the root menu */
settle();

/* Move Set check: a different Set names the expected one; Back stays out. */
H.moveSet.uuid = "set-b"; H.moveSet.name = "Practice";
root(2); click();             /* Perform */
click();                      /* Gig */
check(H.printed.some(t => t.indexOf("Gig Set") >= 0) && H.printed.some(t => /Loaded: Practice/.test(t)),
      "the prompt names the expected and the loaded Set: " + JSON.stringify(H.printed.slice(0, 12)));
H.writes.length = 0;
back();                       /* Back = cancel */
tick(3);
check(H.writes.length === 0 && saved().move_set.uuid === "set-a", "Back: nothing written, Set unchanged");
/* Continue adopts the loaded Set. */
click(); jog(1); click(); tick(3);
check(saved().move_set.uuid === "set-b", "Continue adopts the loaded Set");
check(H.writes.some(w => w[1] === "synth:cutoff"), "...and enters Performance (values restored)");

console.log(`${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
