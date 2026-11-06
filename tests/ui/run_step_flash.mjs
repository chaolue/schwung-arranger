/* Perform's step LEDs flash each bar's beats in time -- 6 a bar in 6/8 --
 * from the first bar on. The transport here runs in real (mock) time: a 6/8
 * song whose transport counts six beats a bar (ticks_per_beat 120 of a
 * 720-tick bar). The first bar flashed twelve times: until a whole bar had
 * played, the step flash guessed the transport counted 6/8 in three
 * dotted-quarter beats and split each beat in two. */
import * as H from './host_mock.mjs';

const SONGS = "/data/UserData/UserLibrary/Arranger/Songs";
const SETLISTS = "/data/UserData/UserLibrary/Arranger/Setlists";
H.files.set(SONGS + "/s.json", JSON.stringify({ name: "Six", key: "D", tempo_bpm: 120, time_sig_num: 6, time_sig_den: 8,
    sections: [{ name: "Verse", clips: [{ source: "Grooves/beat.mid", name: "beat", start_bar: 0, end_bar: 4 }] }] }));
H.files.set(SETLISTS + "/a.json", JSON.stringify({ id: "s", name: "Gig",
    songs: [{ id: "e1", name: "Six", path: SONGS + "/s.json", click_bars: 0 }] }));

/* The engine: builds confirm at once; once playing, the transport follows
 * the clock -- six eighths to the bar, 500 ms each, counted as six beats
 * (or, with BEATS 3, as three dotted-quarter beats of 1000 ms). */
let BEATS = 6, BEAT_MS = 500;
let gen = 0, running = false, startMs = 0;
globalThis.host_module_get_param = (k) => {
    if (k !== "ui_poll") return null;
    const beats = running ? (H.clock - startMs) / BEAT_MS : 0;
    const bar = Math.floor(beats / BEATS), beat = Math.floor(beats % BEATS);
    return JSON.stringify({
        state: { primary_published_gen: gen, staging_published_gen: 0, running, active_source: "primary" },
        transport: { running, bar: bar + 1, beat: beat + 1, beat_progress: beats % 1, bar_frac: beats / BEATS,
                     swap_counter: 0, time_sig_num: 6, time_sig_den: 8, ticks_per_beat: 720 / BEATS, ticks_per_bar: 720,
                     bpm: 60000 / BEAT_MS } });
};
for (const f of ["host_module_set_param", "host_module_set_param_blocking"]) {
    const plain = globalThis[f];
    globalThis[f] = (k, v, t) => {
        if (k === "song_json") gen++;
        if (k === "play") { running = true; startMs = H.clock; }
        if (k === "stop") running = false;
        return plain(k, v, t);
    };
}

await import('./ui_test.mjs');
const g = globalThis;
const C = await import('./shared/constants.mjs');
let failures = 0, passes = 0;
function check(cond, msg) { if (cond) passes++; else { failures++; console.log("FAIL: " + msg); } }
function cc(n, v) { g.onMidiMessageInternal([0xB0, n, v]); }
function tick(n = 1, ms = 23) { for (let i = 0; i < n; i++) { H.advance(ms); H.hostFrame(); g.tick(); } }
function jog(n) { for (let i = 0; i < Math.abs(n); i++) cc(C.MoveMainKnob, n > 0 ? 1 : 127); tick(); }
const click = () => { cc(C.MoveMainButton, 127); cc(C.MoveMainButton, 0); tick(); };

g.init();
tick(50);
jog(-8); jog(2); click();     /* Perform */
click();                      /* Gig */
tick(30);
cc(C.MovePlay, 127); cc(C.MovePlay, 0);
tick(3);
check(running, "playing");

/* Count each bar's step lighting white (off -> white), bar by bar. */
function countFlashes() {
    const flashes = [0, 0, 0];
    const was = [false, false, false];
    const barMs = BEAT_MS * BEATS;
    while (H.clock - startMs < barMs * 3 - 30) {
        tick();
        const bar = Math.floor((H.clock - startMs) / barMs);
        for (let b = 0; b < 3; b++) {
            const on = H.padLeds.get(C.MoveStep1 + b) === C.White;
            if (on && !was[b] && b === bar) flashes[b]++;
            was[b] = on;
        }
    }
    return flashes;
}
let f = countFlashes();
check(f[0] === 6, "bar 1 flashes its 6 beats: " + f[0]);
check(f[1] === 6, "bar 2 flashes 6: " + f[1]);
check(f[2] === 6, "bar 3 flashes 6: " + f[2]);
cc(C.MovePlay, 127); cc(C.MovePlay, 0); tick(20);

/* A transport counting 6/8 as three dotted-quarter beats: each split in two,
 * still six flashes a bar. */
BEATS = 3; BEAT_MS = 1000;
cc(C.MovePlay, 127); cc(C.MovePlay, 0);
tick(3);
check(running, "playing again");
f = countFlashes();
check(f[0] === 6 && f[1] === 6 && f[2] === 6, "counted in dotted quarters: 6 a bar too: " + f.join(","));
cc(C.MovePlay, 127); cc(C.MovePlay, 0); tick(5);

console.log(`step flash: ${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
