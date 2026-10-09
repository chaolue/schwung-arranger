/* Knob targets beyond a chain's modules: Send A/B's FX positions and a send's
 * Return level, and a chain's Settings (volume, pan, mute, solo, send levels),
 * mapped through the Setlist Edit picker and written on a turn. */
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
root(1); click();            /* Setlists */
jog(1); click();             /* Gig */
jog(3); click();             /* (knobs) */

/* Chain rows: None, Chain 1-8, Master FX, Send A, Send B. */
click(); H.printed.length = 0; jog(11);
check(H.printed.includes("Master FX") && H.printed.includes("Send A") && H.printed.includes("Send B"),
      "the chain list offers Send A and Send B after Master FX: " + JSON.stringify(H.printed));
jog(-1);

/* Knob 1 -> Send A -> FX 1 (cloudseed) -> Size. */
click();
check(H.printed.includes("FX 1") && H.printed.includes("cloudseed") && H.printed.includes("Settings"),
      "Send A lists its loaded position and Settings: " + JSON.stringify(H.printed));
click();
check(H.printed.includes("Size"), "the send position's parameters: " + JSON.stringify(H.printed));
click();
let sl = saved();
check(sl.knobs[0] && sl.knobs[0].slot === -2 && sl.knobs[0].comp === "fx1" && sl.knobs[0].key === "size" &&
      sl.knobs[0].module === "cloudseed" && sl.knobs[0].value === "0.70",
      "knob 1 mapped to Send A FX 1 Size: " + JSON.stringify(sl.knobs[0]));
check(H.printed.includes("1 SndA Size"), "the row names Send A: " + JSON.stringify(H.printed));
cc(71, 3); tick();
check(lastWrite(0, "send1:fx1:size") === "0.73", "turning knob 1 writes send1:fx1:size at slot 0: " + JSON.stringify(H.writes.slice(-2)));

/* Knob 2 -> Send B (no FX loaded) -> Settings -> Return. */
jog(1); click(); jog(11); click();
check(H.printed[0] === "Settings" && !H.printed.includes("FX 1"), "an empty Send B still has Settings: " + JSON.stringify(H.printed));
click();
check(H.printed.includes("Return"), "a send's Settings: Return: " + JSON.stringify(H.printed));
click();
sl = saved();
check(sl.knobs[1] && sl.knobs[1].slot === -3 && sl.knobs[1].comp === "settings" && sl.knobs[1].key === "send2:return" &&
      sl.knobs[1].value === "90", "knob 2 mapped to Send B Return: " + JSON.stringify(sl.knobs[1]));
cc(72, 4); tick();
check(lastWrite(0, "send2:return") === "94", "turning knob 2 writes send2:return: " + JSON.stringify(H.writes.slice(-2)));

/* Knob 3 -> Chain 2 -> Settings -> Volume; knob 4 -> Chain 2 -> Settings -> Send A. */
jog(1); click(); jog(2); click();
check(H.printed[0] === "Settings", "an empty chain lists Settings: " + JSON.stringify(H.printed));
click();
check(["Volume", "Pan", "Mute", "Solo", "Send A"].every(t => H.printed.includes(t)),
      "a chain's Settings: " + JSON.stringify(H.printed));
H.printed.length = 0; jog(5);
check(H.printed.includes("Send B"), "...and Send B: " + JSON.stringify(H.printed));
jog(-5); click();
sl = saved();
check(sl.knobs[2] && sl.knobs[2].slot === 1 && sl.knobs[2].comp === "settings" && sl.knobs[2].key === "slot:volume" &&
      sl.knobs[2].value === "1.0000", "knob 3 mapped to Chain 2 Volume: " + JSON.stringify(sl.knobs[2]));
check(H.printed.includes("3 C2 Volume"), "the row names it: " + JSON.stringify(H.printed));
cc(73, 5); tick();
check(lastWrite(1, "slot:volume") === "1.05", "turning knob 3 writes slot:volume at chain 2's slot: " + JSON.stringify(H.writes.slice(-2)));
jog(1); click(); jog(2); click(); click(); jog(4); click();
sl = saved();
check(sl.knobs[3] && sl.knobs[3].key === "buses:main_send1" && sl.knobs[3].slot === 1, "knob 4 mapped to Chain 2 Send A: " + JSON.stringify(sl.knobs[3]));
cc(74, 10); tick();
check(lastWrite(1, "buses:main_send1") === "10", "turning knob 4 writes buses:main_send1: " + JSON.stringify(H.writes.slice(-2)));

/* Knob 5 -> Chain 2 -> Settings -> Mute: an Off/On switch. */
jog(1); click(); jog(2); click(); click(); jog(2); click();
cc(75, 2); tick();
check(lastWrite(1, "slot:muted") === "1", "turning knob 5 mutes chain 2: " + JSON.stringify(H.writes.slice(-2)));

console.log(`${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
