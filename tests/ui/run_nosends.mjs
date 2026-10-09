/* A Schwung without send buses: no Send A/B targets, and a chain's Settings
 * without send levels. */
import * as H from './host_mock.mjs';
H.setSendsServed(false);

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
root(1); click(); jog(1); click(); jog(3); click();
click(); jog(20);
check(H.printed.includes("Master FX") && !H.printed.includes("Send A") && !H.printed.includes("Send B"),
      "no Send rows: " + JSON.stringify(H.printed));
jog(-20); jog(2); click(); click();
check(H.printed.includes("Volume") && !H.printed.includes("Send A"), "chain Settings without sends: " + JSON.stringify(H.printed));

console.log(`${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
