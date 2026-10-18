/* A setlist's own key, tempo and section order for a song (Setlist Edit >
 * a song > Key / Tempo / Sections), through the real src/ui.js: the screens
 * that set them, what Perform then plays, and that the song file itself is
 * never changed. */
import * as H from './host_mock.mjs';

const SONGS = "/data/UserData/UserLibrary/Arranger/Songs";
const SETLISTS = "/data/UserData/UserLibrary/Arranger/Setlists";
const clip = { source: "Grooves/beat.mid", name: "beat", start_bar: 0, end_bar: 1 };
const SONG = JSON.stringify({ name: "Song A", key: "C", tempo_bpm: 120, time_sig_num: 4, time_sig_den: 4, sections: [
    { name: "Verse", clips: [clip], chords: [{ root: "C", quality: "maj" }] },
    { name: "Chorus", clips: [clip], chords: [{ root: "F", quality: "maj" }] },
    { name: "Bridge", clips: [clip], chords: [{ root: "G", quality: "maj" }] }] });
H.files.set(SONGS + "/a.json", SONG);
const GIG = SETLISTS + "/gig.json";
H.files.set(GIG, JSON.stringify({ id: "s1", name: "Gig", move_set: { uuid: "set-a", name: "Gig Set" },
    songs: [{ id: "e1", name: "Song A", path: SONGS + "/a.json", click_bars: 0 }] }));

const M = await import('./ui_test.mjs');
const g = globalThis;
const C = await import('./shared/constants.mjs');
let failures = 0, passes = 0;
function check(cond, msg) { if (cond) passes++; else { failures++; console.log("FAIL: " + msg); } }
function cc(n, v) { g.onMidiMessageInternal([0xB0, n, v]); }
function tick(n = 1, ms = 23) { for (let i = 0; i < n; i++) { H.advance(ms); H.hostFrame(); g.tick(); } }
function jog(n) { for (let i = 0; i < Math.abs(n); i++) cc(C.MoveMainKnob, n > 0 ? 1 : 127); tick(); }
function press(n) { H.printed.length = 0; cc(n, 127); cc(n, 0); tick(); }
const click = () => press(C.MoveMainButton);
const back = () => press(C.MoveBack);
const entry = () => JSON.parse(H.files.get(GIG)).songs[0];
const order = () => (entry().sections || []).map(r => r.name).join(",");

g.init();
tick(3);
jog(-8); jog(1); click();     /* Setlists */
jog(1); click();              /* Gig */
click();                      /* Song A -> its settings */
check(H.printed.includes("Key") && H.printed.includes("Song (C)") && H.printed.includes("Song (120)"),
      "Key and Tempo rows show the song's own: " + JSON.stringify(H.printed));

/* Key: D, then back to C, which is the song's own again (no edit). */
jog(3); click(); jog(2);
check(entry().key === "D", "Key D saved: " + JSON.stringify(entry()));
jog(-2);
check(entry().key === undefined, "back at the song's key there is no edit: " + JSON.stringify(entry()));
jog(5);
check(entry().key === "F", "Key F");
click();
/* Tempo: 132. */
jog(1); click(); jog(12); click();
check(entry().tempo_bpm === 132, "Tempo 132 saved: " + JSON.stringify(entry()));

/* Sections: Verse, Chorus, Bridge. */
jog(1); click();
check(H.printed.includes("Verse") && H.printed.includes("Chorus") && H.printed.includes("+ Add") && !H.printed.includes("Reset to Song"),
      "the song's order, + Add, and no Reset yet: " + JSON.stringify(H.printed));
jog(1); press(C.MoveCopy);    /* repeat the Chorus */
check(order() === "Verse,Chorus,Chorus,Bridge", "Copy repeats it: " + order());
jog(1); press(C.MoveDelete);  /* (on the repeat) next row: leave out the Bridge */
check(order() === "Verse,Chorus,Chorus", "Delete leaves it out: " + order());
jog(-1); cc(C.MoveShift, 127); jog(-1); cc(C.MoveShift, 0); tick();   /* the first Chorus up */
check(order() === "Chorus,Verse,Chorus", "Shift + jog moves it: " + order());
jog(8); jog(-1); click();     /* + Add (the row before Reset) */
check(H.printed.includes("Bridge"), "+ Add lists the song's sections: " + JSON.stringify(H.printed));
jog(2); click();              /* Bridge */
check(order() === "Chorus,Verse,Chorus,Bridge", "+ Add puts it after the selected one: " + order());
check(JSON.stringify(entry().sections.map(r => r.i)) === "[1,0,1,2]", "stored by index and name: " + JSON.stringify(entry().sections));
check(H.files.get(SONGS + "/a.json") === SONG, "the song file is untouched");
back(); back(); back(); back();   /* settings, Setlist Edit, Bank, Root */

/* The pure part: the song as the setlist plays it. */
const song = JSON.parse(SONG);
const ed = M.applySetlistEdits(song, entry());
check(ed.sections.map(s => s.name).join(",") === "Chorus,Verse,Chorus,Bridge" && ed.tempo_bpm === 132 && ed.key === "F",
      "applySetlistEdits: order, tempo, key: " + ed.sections.map(s => s.name) + " " + ed.tempo_bpm + " " + ed.key);
check(ed.sections[0].chords[0].root === "A#" && ed.sections[1].chords[0].root === "F",
      "chords transposed C -> F: " + JSON.stringify(ed.sections.map(s => s.chords[0].root)));
check(song.sections[0].name === "Verse" && song.tempo_bpm === 120, "the song given is not changed");
const moved = JSON.parse(SONG); moved.sections.reverse();      /* the song was edited since */
check(M.applySetlistEdits(moved, entry()).sections.map(s => s.name).join(",") === "Chorus,Verse,Chorus,Bridge",
      "a reference whose index moved is found again by name");
check(M.applySetlistEdits(song, { path: "x" }) === song, "no edits: the song itself");

/* Perform plays the setlist's version. */
H.dspSets.length = 0;
jog(-8); jog(2); click(); click();   /* Perform -> Gig */
cc(C.MovePlay, 127); cc(C.MovePlay, 0); tick(10);
const sent = H.dspSets.filter(([k]) => k === "song_json").map(([, v]) => JSON.parse(v)).pop();
check(sent && sent.sections.map(s => s.name).join(",") === "Chorus,Verse,Chorus,Bridge" && sent.tempo_bpm === 132 && sent.key === "F",
      "Perform sends the setlist's version: " + (sent ? sent.sections.map(s => s.name) + " " + sent.tempo_bpm + " " + sent.key : "nothing"));
cc(C.MovePlay, 127); cc(C.MovePlay, 0); tick(3);
back();
check(H.files.get(SONGS + "/a.json") === SONG, "after Perform the song file is still untouched");

console.log(`${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
