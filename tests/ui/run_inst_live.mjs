/* Song Builder's instrument pages while playing, against a mock engine that
 * confirms builds and reports itself running once played:
 *  - Play from Instrument Settings (and an item page) starts playback while
 *    stopped -- it used to send the song and never start it, because the
 *    build confirmation that starts playback was never read from there;
 *  - a setting changed while playing is sent live (inst<N>_live) -- built
 *    from the real song, with a temporary copy's sections renumbered -- and
 *    is still there after Stop (it used to go to the copy and be lost);
 *  - an item changed while playing is saved into its list and sent live. */
import * as H from './host_mock.mjs';

const SONGS = "/data/UserData/UserLibrary/Arranger/Songs";
const PATH = SONGS + "/p.json";
const sec = (name) => ({ name, clips: [{ source: "Grooves/beat.mid", name: "beat", start_bar: 0, end_bar: 2 }],
                        chords: [{ root: "D", quality: "maj" }] });
H.files.set(PATH, JSON.stringify({ name: "P", key: "D", tempo_bpm: 120, time_sig_num: 4, time_sig_den: 4,
    sections: [sec("Intro"), sec("Verse")],
    instruments: [{ enabled: true, octave: 2, voicing: "bass" }] }));

/* The mock engine: song_json publishes a new build; play runs it; stop stops. */
let gen = 0, running = false;
const g = globalThis;
g.host_module_get_param = (k) => {
    if (k === "songs_json") return JSON.stringify({ count: 1, start: 0, items: [{ name: "P", path: PATH }] });
    if (k === "ui_poll") return JSON.stringify({
        state: { primary_published_gen: gen, staging_published_gen: 0, running, active_source: "primary" },
        transport: { running, bar: 1, beat: 1, beat_progress: 0, ticks_per_beat: 240, ticks_per_bar: 960, bpm: 120 } });
    return null;
};
const sets = [];
const plainSet = g.host_module_set_param;
const onSet = (k, v) => {
    sets.push([k, v]);
    if (k === "song_json") gen++;
    if (k === "play") running = v === "1";
    if (k === "stop") running = false;
};
g.host_module_set_param = (k, v) => { onSet(k, v); return plainSet(k, v); };
g.host_module_set_param_blocking = (k, v) => { onSet(k, v); return true; };

const M = await import('./ui_test.mjs');
const C = await import('./shared/constants.mjs');
let failures = 0, passes = 0;
function check(cond, msg) { if (cond) passes++; else { failures++; console.log("FAIL: " + msg); } }
function cc(n, v) { g.onMidiMessageInternal([0xB0, n, v]); }
function tick(n = 1, ms = 23) { for (let i = 0; i < n; i++) { H.advance(ms); H.hostFrame(); g.tick(); } }
function jog(n) { for (let i = 0; i < Math.abs(n); i++) cc(C.MoveMainKnob, n > 0 ? 1 : 127); tick(); }
function press(n) { cc(n, 127); cc(n, 0); tick(3); }
const click = () => press(C.MoveMainButton);
const lastLive = (n) => { for (let i = sets.length - 1; i >= 0; i--) if (sets[i][0] === "inst" + n + "_live") return JSON.parse(sets[i][1])[0]; return null; };
const playSent = () => sets.some(s => s[0] === "play" && s[1] === "1");

g.init();
tick(3);
jog(-8); click();             /* Song Bank */
jog(1); click();              /* P */
press(C.MoveRow2);            /* Inst 1 */
press(C.MoveMenu);            /* Instrument Settings */

/* ---- Play from Instrument Settings, stopped ---- */
sets.length = 0;
press(C.MovePlay);
tick(10);
check(sets.some(s => s[0] === "song_json"), "Play sends the song");
check(playSent() && running, "...and starts it once the build is confirmed (it never did from here)");

/* ---- a setting changed while playing is heard live ---- */
sets.length = 0;
jog(-10); jog(1); click(); jog(2); click();   /* Octave 2 -> 4 */
tick(2);
let live = lastLive(1);
check(live && live.octave === 4 && live.enabled === true && Array.isArray(live.items),
      "Octave changed while playing: inst1_live carries octave 4: " + JSON.stringify(live));
check(!sets.some(s => s[0] === "song_json"), "...without rebuilding the song");
press(C.MovePlay);            /* Stop */
tick(5);
check(!running, "Play again stops");
press(C.MoveBack); press(C.MoveBack); tick(3);   /* out of the menu, out of the song: saved */
let song = JSON.parse(H.files.get(PATH));
check(song.instruments[0].octave === 4, "the change made while playing is saved (it used to be lost on Stop)");

/* ---- playing from the second section: items renumbered onto the copy ---- */
check(M.instrumentLiveJson({ name: "S", time_sig_num: 4, time_sig_den: 4, source_folder: "F",
        sections: [Object.assign(sec("A"), { inst: [[{ bar: 1, octave: 5 }]] }), Object.assign(sec("B"), { inst: [[{ bar: 0, octave: 1 }]] })],
        instruments: [{ enabled: true, octave: 2 }] }, 0, 1) ===
      JSON.stringify([JSON.parse(M.instrumentLiveJson({ name: "S", time_sig_num: 4, time_sig_den: 4, source_folder: "F",
        sections: [Object.assign(sec("B"), { inst: [[{ bar: 0, octave: 1 }]] })],
        instruments: [{ enabled: true, octave: 2 }] }, 0, 0))[0]]),
      "from section 2: the copy's section 0 is the song's section 1, and section 1's items are dropped");

/* ---- an item changed while playing ---- */
jog(1); click();              /* P */
press(C.MoveRow2);
jog(10); click();             /* + Add: a new item */
press(C.MovePlay); tick(10);  /* Play from the item page */
check(running, "Play from an item page starts playback");
sets.length = 0;
/* Bar Beat Sound Octave: Octave (row 3) from Default up to 6. */
jog(-20); jog(3); click(); jog(8); click();
tick(2);
live = lastLive(1);
const it = live && live.items.find(x => x.octave !== undefined);
check(it && it.octave === 6, "an item's Octave changed while playing is sent live: " + JSON.stringify(live && live.items));
press(C.MovePlay); tick(5);
press(C.MoveBack); press(C.MoveBack); tick(3);
song = JSON.parse(H.files.get(PATH));
check(((song.sections[0].inst || [])[0] || []).some(x => x.octave === 6), "the item is saved: " + JSON.stringify(song.sections[0].inst));

console.log(`${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
