/* A Perform knob on a module's own presets (sf2: a ui_hierarchy level whose
 * list_param is "preset", named by preset_name) shows the preset's name, not
 * its number -- on a touch, and as it is turned, including a fast turn past
 * a preset (the name read then is of the one it landed on, never filed
 * under the one it passed). */
import * as H from './host_mock.mjs';

const SONGS = "/data/UserData/UserLibrary/Arranger/Songs";
const SETLISTS = "/data/UserData/UserLibrary/Arranger/Setlists";
H.files.set(SONGS + "/a.json", JSON.stringify({ name: "Song A", tempo_bpm: 120, sections: [
    { name: "Verse", clips: [{ source: "Grooves/beat.mid", name: "beat" }] }] }));
const knobs = [];
knobs[0] = { slot: 3, comp: "synth", key: "preset", module: "sf2", moduleName: "", label: "Preset", value: "0" };
H.files.set(SETLISTS + "/gig.json", JSON.stringify({ id: "s1", name: "Gig", move_set: { uuid: "set-a", name: "Gig Set" }, knobs,
    songs: [{ id: "e1", name: "Song A", path: SONGS + "/a.json", click_bars: 0 }] }));

await import('./ui_test.mjs');
const g = globalThis;
let failures = 0, passes = 0;
function check(cond, msg) { if (cond) passes++; else { failures++; console.log("FAIL: " + msg); } }
function cc(n, v) { g.onMidiMessageInternal([0xB0, n, v]); }
function tick(n = 1, ms = 23) { for (let i = 0; i < n; i++) { H.advance(ms); H.hostFrame(); g.tick(); } }
const JOG = 14, CLICK = 3;
function jog(n) { for (let i = 0; i < Math.abs(n); i++) cc(JOG, n > 0 ? 1 : 127); tick(); }
function click() { cc(CLICK, 127); cc(CLICK, 0); tick(); }
const sf2 = H.slots[3].comps.synth.values;
const shown = (t) => H.printed.some(p => p.includes(t));

g.init();
tick(3);
jog(-8); jog(2); click();     /* Perform */
click();                      /* Gig */
tick(10);
check(sf2.preset === "0", "the song restores preset 0");

/* Touch: the loaded preset by name. */
H.printed.length = 0;
g.onMidiMessageInternal([0x90, 0, 127]); tick(2);
check(shown("Preset Grand Piano"), "touching the knob names the preset: " + JSON.stringify(H.printed.slice(-3)));
check(!H.printed.some(p => /Preset 0\b/.test(p)), "...not its number");
g.onMidiMessageInternal([0x80, 0, 0]); tick();

/* Turn one detent: preset 1, Strings. */
cc(71, 1); tick(3);
check(sf2.preset === "1", "the turn loads preset 1");
H.printed.length = 0;
tick(2);
check(shown("Preset Strings"), "the popup names it: " + JSON.stringify(H.printed.slice(-3)));

/* Two detents in one tick: it lands on 2 without a name for 1 being read
 * from the module while 2 is loaded. */
cc(71, 127); tick(25);      /* back to 0 (cached) */
cc(71, 1); cc(71, 1); tick(25);
check(sf2.preset === "2", "a fast turn lands on preset 2");
H.printed.length = 0;
tick(2);
check(shown("Drawbar Organ"), "and names it: " + JSON.stringify(H.printed.slice(-3)));
cc(71, 127); tick(25);
H.printed.length = 0;
tick(2);
check(shown("Preset Strings"), "preset 1 still reads Strings (never Organ): " + JSON.stringify(H.printed.slice(-3)));

console.log(`${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
