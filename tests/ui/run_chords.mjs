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

console.log(passes + " passed, " + failures + " failed");
process.exit(failures ? 1 : 0);
