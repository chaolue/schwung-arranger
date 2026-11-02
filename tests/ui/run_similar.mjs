/* Song Builder's Similar list and Record's list of the song's folders,
 * against a mock engine:
 *  - Shift+Record (or a clip's Edit > Find Similar) asks the engine for clips
 *    like the selected one -- by its folder's index and its file -- and lists
 *    the answer: name and score, the selected one's folder beneath;
 *  - Play hears the selected clip (from its own folder), again stops;
 *  - the click loads that clip's folder onto the pads (not the song's folder),
 *    at the page showing it, lit white;
 *  - Record lists the folders the song's clips come from, and Browse...,
 *    when there are two or more -- else opens the library at once; picking
 *    one makes it the song's folder, a clip from the old one keeping it. */
import * as H from './host_mock.mjs';

const SONGS = "/data/UserData/UserLibrary/Arranger/Songs";
const MIX = SONGS + "/mix.json", ONE = SONGS + "/one.json";
const clip = (source, extra) => Object.assign({ source, name: source.replace(".mid", ""), start_bar: 0, end_bar: 1 }, extra || {});
H.files.set(MIX, JSON.stringify({ name: "Mix", tempo_bpm: 120, time_sig_num: 4, time_sig_den: 4, source_folder: "Kits/Alpha",
    sections: [{ name: "Verse", clips: [clip("Verse.mid")] },
               { name: "Chorus", clips: [clip("Beat.mid", { source_folder: "Charlie" })] }] }));
H.files.set(ONE, JSON.stringify({ name: "One", tempo_bpm: 120, time_sig_num: 4, time_sig_den: 4, source_folder: "Kits/Alpha",
    sections: [{ name: "Verse", clips: [clip("Verse.mid"), clip("Chorus.mid")] }] }));
const songList = [{ name: "Mix", path: MIX }, { name: "One", path: ONE }];
const folders = [{ name: "Alpha", category: "Kits" }, { name: "Bravo", category: "Kits" }, { name: "Charlie", category: "" }];
const bravo = Array.from({ length: 20 }, (_, i) => "G" + String(i + 1).padStart(2, "0") + ".mid");
const folderClips = [["Verse.mid", "Chorus.mid", "Fill 1.mid"], bravo, ["Beat.mid"]];

/* The engine: builds confirm and play at once; a Similar request is
 * answered a few reads later. */
let request = null, answer = "", reads = 0, gen = 0, running = false;
const g = globalThis;
g.host_module_get_param = (k) => {
    if (k === "ui_poll") return JSON.stringify({
        state: { primary_published_gen: gen, staging_published_gen: 0, running, active_source: "primary" },
        transport: { running, bar: 1, beat: 1, beat_progress: 0, ticks_per_beat: 240, ticks_per_bar: 960, bpm: 120 } });
    if (k === "songs_json") return JSON.stringify({ count: songList.length, start: 0, items: songList });
    if (k === "folders_json") return JSON.stringify({ count: folders.length, start: 0, items: folders });
    const m = /^folder_clips_json_(\d+)$/.exec(k);
    if (m) return JSON.stringify(folderClips[+m[1]] || []);
    if (k === "similar_json") {
        if (request && ++reads > 2) {
            const id = +request.split("\t")[0];
            answer = JSON.stringify({ id, status: "ok", items: [{ f: 1, c: "G18.mid", b: 2, s: 93 }, { f: 2, c: "Beat.mid", b: 1, s: 71 }] });
        }
        return answer;
    }
    return null;
};
const plainSet = g.host_module_set_param_blocking;
const onSet = (k, v) => {
    if (k === "similar_find") { request = v; reads = 0; }
    if (k === "song_json") gen++;
    if (k === "play") running = v === "1";
    if (k === "stop") running = false;
};
g.host_module_set_param_blocking = (k, v, t) => { onSet(k, v); return plainSet(k, v, t); };
const plainSetNb = g.host_module_set_param;
g.host_module_set_param = (k, v) => { onSet(k, v); return plainSetNb(k, v); };

const M = await import('./ui_test.mjs');
const C = await import('./shared/constants.mjs');
let failures = 0, passes = 0;
function check(cond, msg) { if (cond) passes++; else { failures++; console.log("FAIL: " + msg); } }
function cc(n, v) { g.onMidiMessageInternal([0xB0, n, v]); }
function tick(n = 1, ms = 23) { for (let i = 0; i < n; i++) { H.advance(ms); H.hostFrame(); g.tick(); } }
function jog(n) { for (let i = 0; i < Math.abs(n); i++) cc(C.MoveMainKnob, n > 0 ? 1 : 127); tick(); }
function press(n) { cc(n, 127); cc(n, 0); tick(10); }
const click = () => press(C.MoveMainButton);
const shown = () => { H.printed.length = 0; tick(2); return H.printed.join("|"); };
const hints = () => JSON.stringify(M.footerHints());
const has = (pair) => M.footerHints().some(p => p[0] === pair[0] && p[1] === pair[1]);
const lastSet = (k) => { for (let i = H.dspSets.length - 1; i >= 0; i--) if (H.dspSets[i][0] === k) return H.dspSets[i][1]; return null; };
const whitePads = () => { let n = 0; for (let i = 0; i < 32; i++) if (H.padLeds.get(C.MovePad1 + i) === C.White) n++; return n; };
function shiftRecord() { cc(C.MoveShift, 127); tick(); check(has(["REC", "FIND"]), "Shift: REC FIND: " + hints()); cc(C.MoveRecord, 127); cc(C.MoveRecord, 0); cc(C.MoveShift, 0); tick(5); }
function openSong(row) { jog(-8); click(); jog(-5); jog(row); click(); tick(5); }

g.init();
tick(3);
openSong(1);                  /* Mix */

/* ---- Shift+Record: clips like Verse ---- */
shiftRecord();
check(request && request.split("\t")[1] === "0" && request.split("\t")[2] === "Verse.mid",
      "asks for clips like Alpha's Verse.mid: " + JSON.stringify(request));
let screen = shown();
check(screen.includes("Searching"), "searching, until the engine answers: " + screen);
tick(12);
screen = shown();
check(screen.includes("G18") && screen.includes("93%") && screen.includes("Beat") && screen.includes("71%"),
      "the answer listed, with scores: " + screen);
check(screen.includes("in Bravo"), "...the selected one's folder beneath: " + screen);
check(hints() === '[["CLK","LOAD"],["PLAY","HEAR"]]', "footer: CLK LOAD, PLAY HEAR: " + hints());
check((H.buttonLeds.get(C.MoveBack) || 0) > 0, "Back lit");
jog(1);
check(shown().includes("in Charlie"), "jog: the next one's folder");
jog(-1);

/* Play hears it, from its own folder. */
press(C.MovePlay);
const prev = JSON.parse(lastSet("song_json") || "null");
const pc = prev && prev.sections[0].clips[0];
check(pc && pc.source === "G18.mid" && pc.source_folder === "Kits/Bravo", "Play previews G18 from Kits/Bravo: " + JSON.stringify(pc));
tick(5);
check(running, "...playing");
press(C.MovePlay);
check(lastSet("stop") === "1" && !running, "Play again stops");

/* The click: Bravo onto the pads, G18 white. */
click();
tick(10);
check(has(["PAD", "ADD"]), "back in Song Builder: " + hints());
check(whitePads() === 1, "one pad lit white: " + whitePads());
/* G18 is the 18th groove: the second page's second groove pad. */
check(H.padLeds.get(C.MovePad1 + 1) === C.White, "...G18's, on the page that shows it");
press(C.MoveDown);
check(whitePads() === 0, "the first page: no white pad");
press(C.MoveUp);
let song = (press(C.MoveBack), JSON.parse(H.files.get(MIX)));
check(song.source_folder === "Kits/Alpha", "the song's own folder is unchanged: " + song.source_folder);
click(); tick(5);              /* Mix again */

/* ---- a clip's Edit > Find Similar ---- */
click();                      /* Edit Verse */
jog(30);
check(has(["CLK", "FIND"]), "Edit's last row: CLK FIND: " + hints());
const before = request;
click();
check(request !== before && request.split("\t")[2] === "Verse.mid", "Find Similar asks again: " + JSON.stringify(request));
press(C.MoveBack);
check(has(["PAD", "ADD"]), "Back: Song Builder");

/* ---- Record: the song's folders, then Browse... ---- */
press(C.MoveRecord);
screen = shown();
check(screen.includes("Alpha") && screen.includes("Charlie") && screen.includes("Browse...") && !screen.includes("Bravo"),
      "Record lists the song's two folders and Browse...: " + screen);
jog(1); click();              /* Charlie */
check(has(["PAD", "ADD"]), "a folder: back in Song Builder");
press(C.MoveBack);
song = JSON.parse(H.files.get(MIX));
check(song.source_folder === "Charlie", "Charlie is the song's folder: " + song.source_folder);
check(song.sections[0].clips[0].source_folder === "Kits/Alpha", "...Verse keeps Alpha: " + JSON.stringify(song.sections[0].clips[0]));
check(!song.sections[1].clips[0].source_folder, "...Beat needs none now");
click(); tick(5);              /* Mix again */
press(C.MoveRecord);
jog(5); click();              /* Browse... */
screen = shown();
check(screen.includes("Kits >"), "Browse...: the library: " + screen);
press(C.MoveBack);
check(shown().includes("Browse..."), "Back: the song's folders again");
press(C.MoveBack);
check(has(["PAD", "ADD"]), "Back again: Song Builder");
press(C.MoveBack);

/* ---- a song from one folder: Record opens the library ---- */
jog(1); click(); tick(5);      /* One */
press(C.MoveRecord);
screen = shown();
check(screen.includes("Alpha") && !screen.includes("Browse..."), "one folder: straight to the library: " + screen);

console.log(`similar: ${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
