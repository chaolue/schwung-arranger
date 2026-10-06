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


/* Inst items: old per-bar mutes/overrides (indexed by section number) turn
 * into section items that sound the same. */
const old = {
    name: "O", key: "C", time_sig_num: 4, time_sig_den: 4, source_folder: "F",
    sections: [{ name: "A", clips: [{ source: "x.mid", start_bar: 0, end_bar: 4 }] },
               { name: "B", clips: [{ source: "x.mid", start_bar: 0, end_bar: 4 }] }],
    instruments: [
        { enabled: true, octave: 3, bars: [[true, false, false, true], []],
          overrides: [{ section: 0, bar: 3, octave: 5 }, { section: 1, bar: 0, voicing: "chord" }] },
        { enabled: true, octave: 3, bars: [], overrides: [] }
    ]
};
const ui = M.toUiSong(old);
check(JSON.stringify(ui.sections[0].inst[0]) === '[{"bar":1,"mute":true},{"bar":3,"octave":5},{"bar":4}]',
      "section A: muted bars 2-3, octave 5 on bar 4, then defaults: " + JSON.stringify(ui.sections[0].inst[0]));
check(JSON.stringify(ui.sections[1].inst[0]) === '[{"bar":0,"voicing":"chord"},{"bar":1}]',
      "section B: chord voicing on bar 1 only: " + JSON.stringify(ui.sections[1].inst[0]));
check(ui.instruments[0].bars.length === 0 && ui.instruments[0].overrides.length === 0, "old per-bar data cleared");
check(!ui.sections[0].inst[1] || ui.sections[0].inst[1].length === 0, "Inst 2 had nothing: no items");
const again = M.toUiSong(JSON.parse(JSON.stringify(ui)));
check(JSON.stringify(again.sections[0].inst) === JSON.stringify(ui.sections[0].inst), "items survive a save/load round trip");

/* The engine gets each instrument's items with section numbers, and the
 * Click track's items as click_items. */
ui.sections[1].click = [{ bar: 2, volume: 40 }, { bar: 3, beat: 2.5, adv: true, volume: 0 }];
const eng = JSON.parse(M.toEngineSongJson(ui));
check(JSON.stringify(eng.instruments[0].items) ===
      '[{"section":0,"bar":1,"mute":true},{"section":0,"bar":3,"octave":5},{"section":0,"bar":4},{"section":1,"bar":0,"voicing":"chord"},{"section":1,"bar":1}]',
      "engine items: " + JSON.stringify(eng.instruments[0].items));
check(Array.isArray(eng.instruments[1].items) && eng.instruments[1].items.length === 0, "Inst 2 sends an empty item list");
check(JSON.stringify(eng.click_items) === '[{"section":1,"bar":2,"volume":40},{"section":1,"bar":3,"volume":0,"beat":2.5}]',
      "engine click_items: " + JSON.stringify(eng.click_items));


/* Merge (Mute) and split (Shift+Mute) sections. */
const ms = {
    name: "M", key: "D", time_sig_num: 4, time_sig_den: 4, source_folder: "F",
    sections: [
        { name: "A", clips: [{ source: "x.mid", start_bar: 0, end_bar: 2 }],
          chords: [{ root: "D", quality: "maj" }, { root: "G", quality: "maj" }],
          inst: [[{ bar: 1, octave: 5 }], []], click: [{ bar: 0, volume: 50 }] },
        { name: "B", clips: [{ source: "z.mid", start_bar: 0, end_bar: 2 }],
          chords: [null, { root: "E", quality: "min" }] }
    ],
    instruments: [{ enabled: true }, { enabled: true }]
};
check(M.mergeSectionWithNext(ms, 0) === true && ms.sections.length === 1, "merge leaves one section");
const m0 = ms.sections[0];
check(m0.clips.length === 2 && m0.name === "A", "merged clips, first name kept");
check(JSON.stringify(m0.chords) === '[{"root":"D","quality":"maj"},{"root":"G","quality":"maj"},{"none":true},{"root":"E","quality":"min"}]',
      "B's chords follow A's, with a No Chord at the join (B started silent): " + JSON.stringify(m0.chords));
check(JSON.stringify(m0.inst[0]) === '[{"bar":1,"octave":5},{"bar":2}]', "Inst: back to defaults at the join: " + JSON.stringify(m0.inst[0]));
check(JSON.stringify(m0.click) === '[{"bar":0,"volume":50},{"volume":100,"bar":2}]', "Click: default volume at the join: " + JSON.stringify(m0.click));
check(M.splitSectionAt(ms, 0, 0) === false, "can't split at the first clip");
check(M.splitSectionAt(ms, 0, 1) === true && ms.sections.length === 2, "split at the 2nd clip");
check(ms.sections[1].name === "A 2" && ms.sections[1].clips[0].source === "z.mid", "new section after, named like a duplicate");
check(JSON.stringify(ms.sections[0].chords) === '[{"root":"D","quality":"maj"},{"root":"G","quality":"maj"}]' &&
      JSON.stringify(ms.sections[1].chords) === '[{"none":true},{"root":"E","quality":"min"}]',
      "chords split at the clip: " + JSON.stringify(ms.sections.map(x => x.chords)));
check(JSON.stringify(ms.sections[1].inst[0]) === '[{"bar":0}]' && JSON.stringify(ms.sections[1].click) === '[{"volume":100,"bar":0}]',
      "items from the split point moved: " + JSON.stringify([ms.sections[1].inst, ms.sections[1].click]));
/* A chord sounding at the split carries into the new section. */
const sp = { name: "S", key: "D", time_sig_num: 4, time_sig_den: 4, source_folder: "F", instruments: [],
    sections: [{ name: "V", clips: [{ source: "a.mid", start_bar: 0, end_bar: 2 }, { source: "b.mid", start_bar: 0, end_bar: 2 }],
                 chords: [{ root: "D", quality: "maj" }], inst: [[{ bar: 0, mute: true }], []] }] };
M.splitSectionAt(sp, 0, 1);
check(JSON.stringify(sp.sections[1].chords) === '[{"root":"D","quality":"maj"}]', "the sounding chord carries over: " + JSON.stringify(sp.sections[1].chords));
check(JSON.stringify(sp.sections[1].inst[0]) === '[{"bar":0,"mute":true}]', "so do the Inst settings in effect: " + JSON.stringify(sp.sections[1].inst[0]));

console.log(passes + " passed, " + failures + " failed");
process.exit(failures ? 1 : 0);
