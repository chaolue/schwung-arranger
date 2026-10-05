/* Chord helpers in src/ui.js: "No Chord" bars and the slash-bass choices,
 * through the real module's exports (no host interaction needed). */
await import('./host_mock.mjs');
const M = await import('./ui_test.mjs');
let failures = 0, passes = 0;
function check(cond, msg) { if (cond) passes++; else { failures++; console.log("FAIL: " + msg); } }

/* No Chord: labelled N.C., survives a key change, and reaches the engine as
 * {"none":true} -- not as a chord with a default root. */
check(M.chordLabel({ none: true }) === "N.C.", "No Chord is labelled N.C.");
check(JSON.stringify(M.transposeChord({ none: true }, 3)) === '{"none":true}', "transposing keeps No Chord");
const song = {
    name: "T", key: "D", tempo_bpm: 120, time_sig_num: 4, time_sig_den: 4, source_folder: "F",
    sections: [{ name: "A", clips: [{ source: "x.mid", start_bar: 0, end_bar: 4 }],
                 chords: [{ root: "D", quality: "maj" }, { none: true }, null, { root: "G", quality: "maj" }] }],
    instruments: []
};
const out = M.toEngineSongJson(song);
const chords = (typeof out === "string" ? JSON.parse(out) : out).sections[0].chords;
check(chords.length === 4, "four chord slots sent: " + JSON.stringify(chords));
check(JSON.stringify(chords[1]) === '{"none":true}', "No Chord sent as {none:true}: " + JSON.stringify(chords[1]));
check(chords[2] === null, "an empty bar stays null (it carries the No Chord)");
check(chords[0] && chords[0].root === "D" && chords[3] && chords[3].root === "G", "real chords unchanged");

/* Slash bass: the choices start at the key's tonic, not always C. */
check(M.bassNotesForKey("A#")[0] === "A#", "bass choices in A# start at A#");
check(M.bassNotesForKey("D").join(" ") === "D D# E F F# G G# A A# B C C#", "bass choices run chromatically up from the key");
check(M.bassNotesForKey("C")[0] === "C", "bass choices in C start at C");


/* Several chords in a bar: stored as an array with beats, a lone beat-1
 * chord as before; sent to the engine as an array with "beat"s. */
const sec2 = { name: "B", clips: [{ source: "x.mid", start_bar: 0, end_bar: 2 }], chords: [] };
M.setBarChords(sec2, 0, [{ root: "G", quality: "maj", beat: 3 }, { root: "D", quality: "maj" }]);
check(Array.isArray(sec2.chords[0]) && sec2.chords[0].length === 2, "two chords in a bar stored as an array");
const bc = M.barChords(sec2, 0);
check(bc[0].root === "D" && M.chordBeat(bc[0]) === 1 && bc[1].root === "G" && M.chordBeat(bc[1]) === 3,
      "barChords sorts by beat: " + JSON.stringify(bc));
M.setBarChords(sec2, 1, [{ root: "A", quality: "maj" }]);
check(!Array.isArray(sec2.chords[1]) && sec2.chords[1].root === "A" && sec2.chords[1].beat === undefined,
      "a lone beat-1 chord is stored plainly");
M.setBarChords(sec2, 1, [{ root: "A", quality: "maj", beat: 2.5, adv: true }]);
check(sec2.chords[1].length === 1 && sec2.chords[1][0].beat === 2.5 && sec2.chords[1][0].adv === true,
      "an Advanced chord keeps its half-beat and the flag: " + JSON.stringify(sec2.chords[1]));
M.setBarChords(sec2, 1, []);
check(sec2.chords[1] === undefined && M.barChords(sec2, 1).length === 0, "an empty list clears the bar");
const song2 = { name: "T", key: "D", tempo_bpm: 120, time_sig_num: 4, time_sig_den: 4, source_folder: "F",
                sections: [sec2], instruments: [] };
const out2 = M.toEngineSongJson(song2);
const ch2 = (typeof out2 === "string" ? JSON.parse(out2) : out2).sections[0].chords;
check(Array.isArray(ch2[0]) && ch2[0][0].root === "D" && ch2[0][0].beat === undefined &&
      ch2[0][1].root === "G" && ch2[0][1].beat === 3, "engine gets the bar as an array with beats: " + JSON.stringify(ch2[0]));
check(ch2[0][1].adv === undefined, "Advanced is an editing setting, not sent to the engine");
const tr = M.transposeChord(sec2.chords[0], 2);
check(Array.isArray(tr) && tr[0].root === "E" && tr[1].root === "A" && tr[1].beat === 3,
      "a key change transposes every chord in a bar and keeps beats: " + JSON.stringify(tr));

console.log(passes + " passed, " + failures + " failed");
process.exit(failures ? 1 : 0);
