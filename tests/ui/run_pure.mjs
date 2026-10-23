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

/* A clip with no folder is backfilled only when that is unambiguous: never
 * when the song's own folder holds a clip of that name (My Lighthouse's
 * Chorus played another kit's "06 4th Cym"), nor when several others do. */
{
    const { clipFolderBackfill } = ui;
    const map = { "06 4th Cym": ["VD/01 Ragtime/03 St Louis", "VD/08 Indie/11 Disco"], "07 4th Perc": ["VD/08 Indie/11 Disco"],
                  "Only Here": ["VD/02 Jazz/04 Swing"], "Twice": ["VD/a", "VD/b"] };
    CHECK(clipFolderBackfill(map, "06 4th Cym", "VD/08 Indie/11 Disco") === "", "a name the song's folder holds keeps no folder");
    CHECK(clipFolderBackfill(map, "06 4th Cym", "11 Disco") === "", "...also when the song names its folder the old short way");
    CHECK(clipFolderBackfill(map, "Only Here", "VD/08 Indie/11 Disco") === "VD/02 Jazz/04 Swing", "a clip only another folder holds gets that folder");
    CHECK(clipFolderBackfill(map, "Twice", "VD/08 Indie/11 Disco") === "", "ambiguous between other folders: no guess");
    CHECK(clipFolderBackfill(map, "Unknown", "VD/x") === "", "unknown: nothing");
}

/* Instrument velocity: the track's (100 for a song saved before it was a
 * setting) and an item's, both reaching the engine. */
{
    const { toEngineSongJson, instrumentVelocity } = ui;
    const vsong = { name: "V", key: "C", time_sig_num: 4, time_sig_den: 4, source_folder: "F",
        sections: [{ name: "A", clips: [{ source: "x.mid", start_bar: 0, end_bar: 2 }], chords: [{ root: "C", quality: "maj" }],
                     inst: [[{ bar: 1, beat: 3, velocity: 120 }], []] }],
        instruments: [{ enabled: true, octave: 3, velocity: 80 }, { enabled: true, octave: 3 }] };
    const out = toEngineSongJson(vsong);
    const ej = typeof out === "string" ? JSON.parse(out) : out;
    CHECK(ej.instruments[0].velocity === 80, "the track's velocity reaches the engine: " + ej.instruments[0].velocity);
    CHECK(ej.instruments[1].velocity === 100, "a track without one: 100, as every note was before");
    CHECK(ej.instruments[0].items.some(it => it.velocity === 120 && it.beat === 3), "an item's velocity, with its beat: " + JSON.stringify(ej.instruments[0].items));
    CHECK(instrumentVelocity({ velocity: 300 }) === 100 && instrumentVelocity(null) === 100, "out of range or none: 100");
}

/* Playing variety: the track's settings and an item's reach the engine,
 * with defaults for a song saved before they existed. */
{
    const { toEngineSongJson, instVariety, stepVoicing, patternLabel } = ui;
    const vsong = { name: "V", key: "C", time_sig_num: 4, time_sig_den: 4, source_folder: "F",
        sections: [{ name: "A", clips: [{ source: "x.mid", start_bar: 0, end_bar: 2 }], chords: [{ root: "C", quality: "maj" }],
                     inst: [[{ bar: 1, pattern: 2, chance: 40, vel_follow: false }], [{ bar: 0, voicing: "arp", strum: 0 }]] }],
        instruments: [{ enabled: true, octave: 2, pattern: 1, approach: 3, vel_follow: true, chance: 75 },
                      { enabled: true, octave: 3, voicing: "chord", strum: 30, strum_dir: 2 }] };
    const ej = JSON.parse(toEngineSongJson(vsong));
    const i0 = ej.instruments[0], i1 = ej.instruments[1];
    CHECK(i0.pattern === 1 && i0.approach === 3 && i0.vel_follow === true && i0.chance === 75,
        "inst 1's pattern, approach, vel follow and chance reach the engine: " + JSON.stringify(i0));
    CHECK(i0.strum === 0 && i0.strum_dir === 0, "unset fields go as their defaults");
    CHECK(i1.voicing === "chord" && i1.strum === 30 && i1.strum_dir === 2 && i1.chance === 100 && i1.vel_follow === false,
        "inst 2's strum, and defaults for the rest: " + JSON.stringify(i1));
    const it0 = i0.items[0], it1 = i1.items[0];
    CHECK(it0.pattern === 2 && it0.chance === 40 && it0.vel_follow === false, "an item's variety fields, false included: " + JSON.stringify(it0));
    CHECK(it1.voicing === "arp" && it1.strum === 0, "an item's Arp voicing and Strum Off: " + JSON.stringify(it1));
    const d = instVariety({});
    CHECK(d.pattern === 0 && d.approach === 0 && d.strum === 0 && d.strum_dir === 0 && d.chance === 100 && d.vel_follow === false,
        "a song from before: plain playing");
    CHECK(instVariety({ chance: 0, pattern: 12, strum: 500 }).chance === 100 && instVariety({ pattern: 12 }).pattern === 0 &&
        instVariety({ strum: 500 }).strum === 0, "out-of-range values fall back to the defaults");
    CHECK(stepVoicing("bass", 1) === "chord" && stepVoicing("chord", 1) === "arp" && stepVoicing("arp", 1) === "arp" &&
        stepVoicing("bass", -1) === "bass", "voicing steps Bass, Chord, Arp");
    CHECK(patternLabel("bass", 1) === "1-5" && patternLabel("arp", 3) === "Random", "pattern names follow the voicing");
    CHECK(d.arp_rate === 2 && instVariety({ arp_rate: 5 }).arp_rate === 2 && instVariety({ arp_rate: 6 }).arp_rate === 6,
        "Arp Rate: 1/8 by default, only the offered rates");
    CHECK(i0.arp_rate === 2, "the Arp Rate reaches the engine: " + i0.arp_rate);
    CHECK(d.arp_range === 1 && d.arp_vel === 0, "Arp Range 1 octave and Vel Range off by default");
    CHECK(patternLabel("bass", 7) === "1-3-5-6-b7" && patternLabel("arp", 9) === "1-5-8-10" && patternLabel("bass", 9) === "1",
        "the pattern names; an Arp-only pattern on Bass reads 1 (the root), as it plays");
}

console.log(`${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
