/* src/ui.js's pure data-model helpers, through the real module (see
 * run.mjs for how the harness loads it): the play-from-section slice,
 * value cyclers and labels, song normalization, and Jam's chord-pad
 * mapping. Moved here from the untracked test/js suite; its checks of the
 * per-bar instrument model went with that model (instruments use section
 * items now -- see run_chords.mjs). */
await import('./host_mock.mjs');
const ui = await import('./ui_test.mjs');
const {
    toEngineSongJson, toUiSong, reindexInstrumentsForSectionSlice,
    cycleOptionalInt, inversionLabel, noteGapLabel,
    jamChordDegreeForPad, jamChordForDegree, chordDegreeInKey,
} = ui;

let failures = 0, passes = 0;
function CHECK(cond, msg) { if (cond) passes++; else { failures++; console.log("FAIL: " + msg); } }
function deepEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// ---------------------------------------------------------------------
// reindexInstrumentsForSectionSlice
// ---------------------------------------------------------------------
{
    const song = {
        sections: [{ name: "A" }, { name: "B" }, { name: "C" }, { name: "D" }],
        instruments: [{
            bars: [["a0"], ["b0"], ["c0"], ["d0"]],
            overrides: [
                { section: 0, bar: 1, octave: 5 },
                { section: 2, bar: 0, follow_note: 36 },
                { section: 3, bar: 2, voicing: "chord" },
            ],
        }],
    };
    song.sections = song.sections.slice(2);
    reindexInstrumentsForSectionSlice(song, 2);
    CHECK(deepEqual(song.instruments[0].bars, [["c0"], ["d0"]]),
          "reindexInstrumentsForSectionSlice: bars array sliced to match the sections slice");
    CHECK(song.instruments[0].overrides.length === 2,
          "reindexInstrumentsForSectionSlice: the override before the slice point (section 0) is dropped");
    CHECK(deepEqual(song.instruments[0].overrides[0], { section: 0, bar: 0, follow_note: 36 }),
          "reindexInstrumentsForSectionSlice: section 2 override reindexed to 0");
    CHECK(deepEqual(song.instruments[0].overrides[1], { section: 1, bar: 2, voicing: "chord" }),
          "reindexInstrumentsForSectionSlice: section 3 override reindexed to 1");
}
{
    // startSectionIndex <= 0 must be a no-op (nothing to reindex).
    const song = { instruments: [{ bars: [["x"]], overrides: [{ section: 0, bar: 0, octave: 1 }] }] };
    const before = JSON.stringify(song);
    reindexInstrumentsForSectionSlice(song, 0);
    CHECK(JSON.stringify(song) === before, "reindexInstrumentsForSectionSlice: startSectionIndex 0 is a no-op");
}

// ---------------------------------------------------------------------
// cycleOptionalInt
// ---------------------------------------------------------------------
{
    CHECK(cycleOptionalInt(null, 1, -1, 8) === -1, "cycleOptionalInt: from Default, +1 lands on min (-1)");
    CHECK(cycleOptionalInt(-1, 1, -1, 8) === 0, "cycleOptionalInt: min -1, +1 -> 0");
    CHECK(cycleOptionalInt(8, 1, -1, 8) === 8, "cycleOptionalInt: clamps at max (8)");
    CHECK(cycleOptionalInt(-1, -1, -1, 8) === null, "cycleOptionalInt: one step below min wraps to Default (null)");
    CHECK(cycleOptionalInt(null, -1, -1, 8) === null, "cycleOptionalInt: Default, -1 stays Default (clamped)");
    CHECK(cycleOptionalInt(0, 1, 0, 127) === 1, "cycleOptionalInt: min 0, +1 from 0 -> 1");
    CHECK(cycleOptionalInt(null, 1, 0, 127) === 0, "cycleOptionalInt: min 0, Default +1 -> 0");
}

// ---------------------------------------------------------------------
// inversionLabel / noteGapLabel display helpers
// ---------------------------------------------------------------------
{
    CHECK(inversionLabel(0) === "Root", "inversionLabel: 0 -> Root");
    CHECK(inversionLabel(1) === "1st Inv", "inversionLabel: 1 -> 1st Inv");
    CHECK(inversionLabel(3) === "3rd Inv", "inversionLabel: 3 -> 3rd Inv");
    CHECK(inversionLabel(4) === "Auto", "inversionLabel: 4 -> Auto (voice leading)");
    CHECK(inversionLabel(99) === "Auto", "inversionLabel: out-of-range clamps to the last option, doesn't crash");
    CHECK(chordDegreeInKey({ root: "B", quality: "min" }, "G") === 2, "chordDegreeInKey: Bm is iii in G");
    CHECK(chordDegreeInKey({ root: "F#", quality: "dim" }, "G") === 6, "chordDegreeInKey: F#dim is vii in G");
    CHECK(chordDegreeInKey({ root: "C#", quality: "maj" }, "C") === -1, "chordDegreeInKey: a root outside the key is -1");
    CHECK(inversionLabel(-5) === "Root", "inversionLabel: negative clamps to Root");

    CHECK(noteGapLabel(0) === "Off", "noteGapLabel: 0 -> Off");
    CHECK(noteGapLabel(0.25) === "1/4", "noteGapLabel: 0.25 -> 1/4");
    CHECK(noteGapLabel(1.0) === "1 beat", "noteGapLabel: 1.0 -> 1 beat");
}

// ---------------------------------------------------------------------
// toEngineSongJson / toUiSong: instrument fields that survive
// ---------------------------------------------------------------------
{
    const uiSong = {
        source_folder: "Song 13 4-4 120 BPM", name: "RoundTrip", tempo_bpm: 120,
        time_sig_num: 4, time_sig_den: 4, key: "C",
        sections: [{ id: "sec-1", name: "A", clips: [{ source: "Grooves/x.mid", start_bar: 0, end_bar: 1 }],
                     chords: [{ root: "C", quality: "maj", bass: "" }] }],
        instruments: [{ enabled: true, octave: 4, follow_note: 36, voicing: "chord", inversion: 2, note_gap: 0.5 }],
    };
    const engineJson = JSON.parse(toEngineSongJson(uiSong));
    CHECK(engineJson.instruments[0].inversion === 2 && engineJson.instruments[0].note_gap === 0.5,
          "toEngineSongJson: inversion and note gap reach the wire JSON");
    const backToUi = toUiSong(JSON.parse(JSON.stringify(uiSong)));
    CHECK(backToUi.instruments[0].inversion === 2 && backToUi.instruments[0].follow_note === 36,
          "toUiSong: instrument settings survive normalization");
    /* An old saved song with no instruments field must not throw. */
    const legacy = toUiSong({ name: "Old", sections: [] });
    CHECK(Array.isArray(legacy.instruments) && legacy.instruments.length === 0,
          "toUiSong: a song with no instruments field at all normalizes to an empty array, no crash");
}

// ---------------------------------------------------------------------
// Jam chord-pad mapping (jamChordDegreeForPad / jamChordForDegree)
// ---------------------------------------------------------------------
{
    // Column 0, bottom to top (row 0-3) -> degrees 0-3; column 1, bottom to
    // top -> degrees 4-6 then the 8th ("octave root") pad at row 3.
    CHECK(jamChordDegreeForPad(0, 0) === 0 && jamChordDegreeForPad(3, 0) === 3,
          "jamChordDegreeForPad: column 0 spans degrees 0-3 bottom to top");
    CHECK(jamChordDegreeForPad(0, 1) === 4 && jamChordDegreeForPad(2, 1) === 6,
          "jamChordDegreeForPad: column 1 rows 0-2 are degrees 4-6");
    CHECK(jamChordDegreeForPad(3, 1) === 7,
          "jamChordDegreeForPad: column 1 row 3 (top) is the 8th/octave-root pad, degree 7");

    // jamKey defaults to "C" (module load default) -- degree 0 is the tonic
    // triad, degree 7 is the same triad with an octave-shift instead of a
    // 3rd/6th degree chord.
    const tonic = jamChordForDegree(0);
    CHECK(tonic.root === "C" && tonic.quality === "maj" && tonic.shift === 0,
          "jamChordForDegree: degree 0 is the tonic major triad with no octave shift");
    const octaveRoot = jamChordForDegree(7);
    CHECK(octaveRoot.root === "C" && octaveRoot.quality === "maj" && octaveRoot.shift === 1,
          "jamChordForDegree: degree 7 repeats the tonic triad with shift=1 (+12 semitones), not a new degree");
    const dominant = jamChordForDegree(4);
    CHECK(dominant.root === "G" && dominant.quality === "maj" && dominant.shift === 0,
          "jamChordForDegree: degree 4 is the dominant (V) major triad");
    const leadingTone = jamChordForDegree(6);
    CHECK(leadingTone.root === "B" && leadingTone.quality === "dim" && leadingTone.shift === 0,
          "jamChordForDegree: degree 6 is the diminished vii° triad");

    // Outside C, degrees whose root wraps past C must go up an octave so the
    // pads keep climbing instead of dropping below the tonic.
    const gShifts = [0, 1, 2, 3, 4, 5, 6, 7].map(d => jamChordForDegree(d, "G").shift).join(",");
    CHECK(gShifts === "0,0,0,1,1,1,1,1",
          "jamChordForDegree: in G, C/D/E/F# (degrees 3-6) and the octave root are shifted up (got " + gShifts + ")");
    const PCS = { C: 0, "C#": 1, D: 2, "D#": 3, E: 4, F: 5, "F#": 6, G: 7, "G#": 8, A: 9, "A#": 10, B: 11 };
    const badKeys = Object.keys(PCS).filter(k => {
        const pitches = [0, 1, 2, 3, 4, 5, 6, 7].map(d => {
            const c = jamChordForDegree(d, k);
            return PCS[c.root] + 12 * c.shift;
        });
        return pitches.some((p, i) => i > 0 && p <= pitches[i - 1]) || pitches[7] - pitches[0] !== 12;
    });
    CHECK(badKeys.length === 0,
          "jamChordForDegree: in every key the 8 pads climb in pitch, ending an octave above the root (failing: " + badKeys.join(" ") + ")");
}

console.log(`${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
