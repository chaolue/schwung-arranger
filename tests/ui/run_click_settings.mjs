/* Song Builder's Click Settings (Menu on the Click track): the song's own
 * Enabled, Volume and Accent/Normal notes, saved with the song.
 *  - a value the song doesn't set shows Options > Click's ("Options (...)");
 *    turning back to it clears the song's own;
 *  - the song's Volume goes with its song JSON (song_click_volume), so the
 *    engine's own click volume -- what a count-in plays at -- stays Options';
 *  - Enabled turns the click on or off now and saves it; opening the song
 *    (Song Builder) or switching to it (Perform) sets the click to it, and
 *    sends its notes and volume; Jam goes back to Options > Click's;
 *  - a locked song's settings are read-only (Enabled turns it on or off for
 *    now only). */
import * as H from './host_mock.mjs';

const SONGS = "/data/UserData/UserLibrary/Arranger/Songs";
const SETLISTS = "/data/UserData/UserLibrary/Arranger/Setlists";
const song = (name, extra) => JSON.stringify(Object.assign({ name, tempo_bpm: 120, time_sig_num: 4, time_sig_den: 4,
    sections: [{ name: "Verse", clips: [{ source: "Grooves/beat.mid", name: "beat", start_bar: 0, end_bar: 2 }],
                 chords: [{ root: "C", quality: "maj" }] }] }, extra || {}));
const PLAIN = SONGS + "/plain.json", OTHER = SONGS + "/other.json", LOCKED = SONGS + "/locked.json";
H.files.set(PLAIN, song("Plain"));
H.files.set(OTHER, song("Other", { click_settings: { enabled: false } }));
H.files.set(LOCKED, song("Locked", { locked: true, click_settings: { volume: 60 } }));
H.files.set(SETLISTS + "/gig.json", JSON.stringify({ id: "s1", name: "Gig", songs: [
    { id: "e1", name: "Plain", path: PLAIN, click_bars: 0 }] }));
const songList = [{ name: "Locked", path: LOCKED }, { name: "Other", path: OTHER }, { name: "Plain", path: PLAIN }];
globalThis.host_module_get_param = (k) => k === "songs_json" ? JSON.stringify({ count: songList.length, start: 0, items: songList }) : null;

const M = await import('./ui_test.mjs');
const g = globalThis;
const C = await import('./shared/constants.mjs');
let failures = 0, passes = 0;
function check(cond, msg) { if (cond) passes++; else { failures++; console.log("FAIL: " + msg); } }
function cc(n, v) { g.onMidiMessageInternal([0xB0, n, v]); }
function tick(n = 1, ms = 23) { for (let i = 0; i < n; i++) { H.advance(ms); H.hostFrame(); g.tick(); } }
function jog(n) { for (let i = 0; i < Math.abs(n); i++) cc(C.MoveMainKnob, n > 0 ? 1 : 127); tick(); }
function press(n) { H.printed.length = 0; cc(n, 127); cc(n, 0); tick(3); }
const click = () => press(C.MoveMainButton);
const shown = () => { H.printed.length = 0; tick(2); return H.printed; };
const lastSet = (k) => { for (let i = H.dspSets.length - 1; i >= 0; i--) if (H.dspSets[i][0] === k) return H.dspSets[i][1]; return null; };
const file = (p) => JSON.parse(H.files.get(p));
/* From Root: Song Bank row `row` (0 is + New Song). */
function openSong(row) { jog(-8); click(); jog(-5); jog(row); click(); tick(5); }
/* ...then the Click track's settings. */
function openClick(row) {
    openSong(row);
    press(C.MoveRow1);                          /* the Drum track (from any) */
    if (!M.footerHints().some(p => p[0] === "PAD")) press(C.MoveRow1);
    press(C.MoveRow4); press(C.MoveRow4);     /* Pads, then Click */
    press(C.MoveMenu);
}
/* Click Settings, Song Builder (saves), Song Bank: back to Root. */
const backToRoot = () => { press(C.MoveBack); press(C.MoveBack); press(C.MoveBack); };

g.init();
tick(3);

/* ---- a song with none of its own ---- */
openClick(3);                 /* Plain */
let rows = shown();
check(rows.includes("Enabled") && rows.includes("Off") && rows.includes("Volume") && rows.includes("Options (100%)"),
      "Click Settings: Enabled Off, Volume as Options': " + JSON.stringify(rows));
check(JSON.stringify(M.footerHints()) === '[["JOG","SEL"],["CLK","EDIT"],["BACK","OUT"]]', "footer: " + JSON.stringify(M.footerHints()));
check((H.buttonLeds.get(C.MoveBack) || 0) > 0, "Back lit");

click();                      /* Enabled: on */
check(lastSet("click_enabled") === "1" && shown().includes("On"), "Enabled: the click on now");
jog(1); click(); jog(-4);     /* Volume: 80 */
check(lastSet("song_click_volume") === "80", "Volume 80 sent as the playing song's: " + lastSet("song_click_volume"));
click();
jog(1); click(); jog(1); click();   /* Accent Note: 77 */
check(lastSet("click_accent_note") === "77", "Accent Note 77 sent");
backToRoot();
let cs = file(PLAIN).click_settings;
check(cs && cs.enabled === true && cs.volume === 80 && cs.accent_note === 77 && cs.normal_note === undefined,
      "saved with the song, only what it sets: " + JSON.stringify(cs));

/* Back to Options' volume clears the song's own. */
openClick(3);
jog(1); click(); jog(4); click();
backToRoot();
cs = file(PLAIN).click_settings;
check(cs && cs.volume === undefined && cs.enabled === true, "Volume back at Options' 100%: the song's own cleared: " + JSON.stringify(cs));

/* ---- opening a song sets the click to it ---- */
openSong(2);                  /* Other: saved Off */
check(lastSet("click_enabled") === "0" && lastSet("click_accent_note") === "76", "Other: the click off, Options' accent note");
press(C.MoveBack); press(C.MoveBack);
openSong(3);                  /* Plain */
check(lastSet("click_enabled") === "1" && lastSet("click_accent_note") === "77", "Plain: the click on, its accent note");

/* ---- Song Settings' Click row: the same saved On/Off ---- */
press(C.MoveRow1);            /* the Drum track */
if (!M.footerHints().some(p => p[0] === "PAD")) press(C.MoveRow1);
press(C.MoveMenu);            /* Song Settings */
jog(6); click();              /* Click */
check(lastSet("click_enabled") === "0", "Song Settings' Click row: off now");
press(C.MoveBack); press(C.MoveBack); press(C.MoveBack);
check(file(PLAIN).click_settings.enabled === false, "...and saved");

/* ---- a locked song: read-only, Enabled only for now ---- */
openClick(1);                 /* Locked */
check(shown().includes("60%"), "Locked: its own volume shown");
check(lastSet("click_volume") === "100", "...the engine's click volume stays Options' (a count-in plays at it)");
check(JSON.parse(M.toEngineSongJson(Object.assign({ source_folder: "" }, file(LOCKED), { click_settings: { volume: 60 } }))).song_click_volume === 60,
      "...the song's own goes with its song JSON");
check(JSON.parse(M.toEngineSongJson(Object.assign({ source_folder: "" }, file(OTHER)))).song_click_volume === -1, "...none for a song without");
jog(1); click(); jog(1);      /* Volume: refused, the jog moves on */
check(lastSet("song_click_volume") !== "65", "...Volume doesn't edit");
jog(-5); click();             /* Enabled */
check(lastSet("click_enabled") === "1", "...Enabled turns it on now");
backToRoot();
check(file(LOCKED).click_settings.enabled === undefined, "...but saves nothing: " + JSON.stringify(file(LOCKED).click_settings));

/* ---- Perform: switching to the song sets it; Jam: Options' ---- */
jog(-8); jog(2); click();     /* Perform */
click(); tick(10);            /* Gig: Plain */
check(lastSet("click_enabled") === "0" && lastSet("click_accent_note") === "77", "Perform: Plain's click (off) and accent note");
press(C.MoveBack); tick(5); press(C.MoveBack);
jog(-8); jog(3); click(); tick(5);   /* Jam */
check(lastSet("click_accent_note") === "76" && lastSet("click_volume") === "100", "Jam: Options > Click's notes and volume");

console.log(`click settings: ${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
