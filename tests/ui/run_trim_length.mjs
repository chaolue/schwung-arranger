/* Trim Clip's End reaches the clip's whole length -- the file's bars, as the
 * library scan found them in the clip's OWN folder -- however far the clip
 * was shortened. It used to look the length up only among the pads' clips
 * (the folder loaded there), so a clip from another folder fell back to its
 * stored end bar: once shortened, never lengthened again. */
import * as H from './host_mock.mjs';

const SONGS = "/data/UserData/UserLibrary/Arranger/Songs";
const MIX = SONGS + "/mix.json";
H.files.set(MIX, JSON.stringify({ name: "Mix", tempo_bpm: 120, time_sig_num: 4, time_sig_den: 4, source_folder: "Kits/Alpha",
    sections: [{ name: "Verse", clips: [
        /* From Charlie, its 4 bars shortened to 2. */
        { source: "Beat.mid", name: "Beat", source_folder: "Charlie", start_bar: 0, end_bar: 2 },
        /* From the song's own folder (on the pads), 8 bars shortened to 3. */
        { source: "Groove.mid", name: "Groove", start_bar: 0, end_bar: 3 }] }] }));
const folders = [{ name: "Alpha", category: "Kits" }, { name: "Charlie", category: "" }];
/* Alpha has a Beat.mid too, of another length: not the clip's. */
const clips = [[{ source: "Groove.mid", bars: 8 }, { source: "Beat.mid", bars: 1 }], [{ source: "Beat.mid", bars: 4 }]];
globalThis.host_module_get_param = (k) => {
    if (k === "songs_json") return JSON.stringify({ count: 1, start: 0, items: [{ name: "Mix", path: MIX }] });
    if (k === "folders_json") return JSON.stringify({ count: folders.length, start: 0, items: folders });
    const m = /^folder_clips_json_(\d+)$/.exec(k);
    if (m) return JSON.stringify(clips[+m[1]] || []);
    return null;
};

await import('./ui_test.mjs');
const g = globalThis;
const C = await import('./shared/constants.mjs');
let failures = 0, passes = 0;
function check(cond, msg) { if (cond) passes++; else { failures++; console.log("FAIL: " + msg); } }
function cc(n, v) { g.onMidiMessageInternal([0xB0, n, v]); }
function tick(n = 1, ms = 23) { for (let i = 0; i < n; i++) { H.advance(ms); H.hostFrame(); g.tick(); } }
function jog(n) { for (let i = 0; i < Math.abs(n); i++) cc(C.MoveMainKnob, n > 0 ? 1 : 127); tick(); }
function press(n) { cc(n, 127); cc(n, 0); tick(3); }
const click = () => press(C.MoveMainButton);
const shown = () => { H.printed.length = 0; tick(2); return H.printed; };

g.init();
tick(3);
jog(-8); click(); jog(1); click(); tick(5);   /* Song Bank, Mix */

/* Beat (from Charlie): End 2 of its 4 bars, and up to 4. */
click();                      /* Trim Clip */
check(shown().includes("2/4"), "Charlie's Beat: End 2/4 (its own folder's 4 bars, not Alpha's Beat or its end): " + JSON.stringify(H.printed));
jog(2); click(); jog(5); click();             /* End: up as far as it goes */
check(shown().includes("4/4"), "...lengthened back to 4: " + JSON.stringify(H.printed));
press(C.MoveBack);            /* commit */
jog(1);                       /* Groove */
click();
check(shown().includes("3/8"), "the song folder's Groove: End 3/8: " + JSON.stringify(H.printed));
jog(2); click(); jog(9); click();
check(shown().includes("8/8"), "...lengthened back to 8");
press(C.MoveBack);
press(C.MoveBack);            /* save */
const song = JSON.parse(H.files.get(MIX));
check(song.sections[0].clips[0].end_bar === 4 && song.sections[0].clips[1].end_bar === 8,
      "saved at their whole lengths: " + song.sections[0].clips.map(c => c.end_bar));

console.log(`trim length: ${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
