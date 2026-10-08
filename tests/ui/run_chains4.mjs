/* A Schwung with 4 chain slots (releases up to 1.7.3): chains 5-8 are not
 * offered. A Track tap under a chain view stays on that Track's chain, and
 * the knob picker lists Chain 1-4 only. */
import * as H from './host_mock.mjs';
H.setSlotCount(4);
const SETLISTS = "/data/UserData/UserLibrary/Arranger/Setlists";
H.files.set(SETLISTS + "/gig.json", JSON.stringify({ id: "s1", name: "Gig", songs: [] }));

await import('./ui_test.mjs');
const g = globalThis;
let failures = 0, passes = 0;
function check(cond, msg) { if (cond) passes++; else { failures++; console.log("FAIL: " + msg); } }
function cc(n, v) { g.onMidiMessageInternal([0xB0, n, v]); }
function tick(n = 1, ms = 23) { for (let i = 0; i < n; i++) { H.advance(ms); H.hostFrame(); g.tick(); } }
function hold(ccNum, ms = 600) { cc(ccNum, 127); tick(Math.ceil(ms / 23)); cc(ccNum, 0); tick(); }
function tap(ccNum) { cc(ccNum, 127); tick(2); cc(ccNum, 0); tick(); }
const TR1 = 43, JOG = 14, CLICK = 3;
function jog(n) { for (let i = 0; i < Math.abs(n); i++) cc(JOG, n > 0 ? 1 : 127); tick(); }
function click() { H.printed.length = 0; cc(CLICK, 127); cc(CLICK, 0); tick(); }

g.init();
tick(5);
hold(TR1);
check(H.corun.target === 1 && H.corun.id === 0, "hold Track 1: chain 1");
tap(TR1);
check(H.corun.target === 1 && H.corun.id === 0, "tap Track 1 again stays on chain 1 (no chain 5 here): " + H.corun.id);
hold(TR1);
check(H.corun.target === 0, "hold Track 1 closes");

/* Root -> Setlists -> Gig -> (knobs) -> knob 1: the chain list. */
jog(-8); jog(1); click();
jog(1); click();
jog(1); click();
click();
check(H.printed.includes("Chain 4") && !H.printed.includes("Chain 5"), "the knob picker lists Chain 1-4: " + JSON.stringify(H.printed));
H.printed.length = 0; jog(8);
check(H.printed.includes("Master FX") && H.printed.includes("Chain 4") && !H.printed.includes("Chain 5"),
      "...then Master FX, no Chain 5: " + JSON.stringify(H.printed));

console.log(`${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
