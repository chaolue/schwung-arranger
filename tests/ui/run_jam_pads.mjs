/* Jam's Track 4 is the Pads (it was the click): on/off, routed as Options >
 * Pads, its light teal while on, the chord pads shown with it alone, and
 * Shift + Track 4 opening its live settings -- Octave, Inversion, Note Gap,
 * no Follow Note or Voicing (the Pads are always a chord). */
import * as H from './host_mock.mjs';

globalThis.host_module_get_param = (k) => {
    if (k === "folders_json") return JSON.stringify({ count: 1, start: 0, items: [{ name: "Rock", category: "" }] });
    if (k === "songs_json") return JSON.stringify({ count: 0, start: 0, items: [] });
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
function press(n) { H.printed.length = 0; cc(n, 127); cc(n, 0); tick(3); }
const lastSet = (k) => { for (let i = H.dspSets.length - 1; i >= 0; i--) if (H.dspSets[i][0] === k) return H.dspSets[i][1]; return null; };

g.init();
tick(3);
jog(-8); jog(3); press(C.MoveMainButton);   /* Jam: the folder picker */
press(C.MoveMainButton);                     /* Rock */
tick(10);
check(lastSet("jam_inst3_enabled") === "0", "entering Jam: Pads off");
check(H.buttonLeds.get(C.MoveRow4) === 0 || H.buttonLeds.get(C.MoveRow4) === undefined, "Track 4 dark");

H.dspSets.length = 0;
press(C.MoveRow4);
tick(10);
check(lastSet("jam_inst3_enabled") === "1", "Track 4: Pads on");
check(lastSet("jam_inst3_output") === "external" && lastSet("jam_inst3_channel") === "0" && lastSet("jam_inst3_voicing") === "chord" &&
      lastSet("jam_inst3_octave") === "4" && lastSet("jam_inst3_follow_note") === "0",
      "routed as Options > Pads (External 1), a chord at octave 4: " + JSON.stringify(H.dspSets));
check(!H.dspSets.some(x => x[0] === "click_enabled"), "the click is not touched");
check(H.buttonLeds.get(C.MoveRow4) === 12, "Track 4 teal while on (" + H.buttonLeds.get(C.MoveRow4) + ")");

/* Shift + Track 4: the Pads' live settings. */
cc(C.MoveShift, 127); press(C.MoveRow4); cc(C.MoveShift, 0); tick();
const seen = new Set();
for (let i = 0; i < 6; i++) { H.printed.length = 0; jog(1); H.printed.forEach(t => seen.add(t)); }
const t = [...seen].join("|");
check(/Octave/.test(t) && /Inversion/.test(t) && /Note Gap/.test(t), "Pads (Jam): Octave, Inversion, Note Gap: " + t);
check(!/Follow Note/.test(t) && !/Voicing/.test(t), "...no Follow Note or Voicing");
check(lastSet("jam_inst3_enabled") === "1", "opening the settings left the Pads on");
press(C.MoveBack);
H.dspSets.length = 0;
press(C.MoveRow4);
check(lastSet("jam_inst3_enabled") === "0", "Track 4 again: Pads off");

console.log(`${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
