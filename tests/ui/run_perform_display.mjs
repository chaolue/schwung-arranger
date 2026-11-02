/* Perform's display: a "Perform" header with the key the song plays in at
 * its right (beside the battery), then the song (no "Now:"), one Sec line
 * with the section playing > the next one, the next song, and the time.
 * The key is the setlist's own for the song when it sets one, and a flat is
 * drawn as a small b (the face has capitals only). Pixels are read back from
 * fill_rect and compared with the face's own drawing of each expected line. */
import * as H from './host_mock.mjs';
import { fontPrint4x5, fontWidth4x5 } from './shared/param_pages/font4x5.mjs';

const SONGS = "/data/UserData/UserLibrary/Arranger/Songs";
const SETLISTS = "/data/UserData/UserLibrary/Arranger/Setlists";
const sec = (name) => ({ name, clips: [{ source: "Grooves/beat.mid", name: "beat" }] });
H.files.set(SONGS + "/a.json", JSON.stringify({ name: "Yes He Lives", key: "A#", tempo_bpm: 150,
    sections: [sec("Intro"), sec("Verse")] }));
H.files.set(SONGS + "/b.json", JSON.stringify({ name: "Another Song", key: "D", tempo_bpm: 120,
    sections: [sec("Verse")] }));
const songs = (key) => [
    Object.assign({ id: "e1", name: "Yes He Lives", path: SONGS + "/a.json", click_bars: 0 }, key ? { key } : {}),
    { id: "e2", name: "Another Song", path: SONGS + "/b.json", click_bars: 0 }];
H.files.set(SETLISTS + "/a_gig.json", JSON.stringify({ id: "s1", name: "A Gig", songs: songs(null) }));
H.files.set(SETLISTS + "/b_gig.json", JSON.stringify({ id: "s2", name: "B Gig", songs: songs("D#") }));
/* A song with chords: C > Am in the Intro, F > Bb7 in the Verse. */
H.files.set(SONGS + "/c.json", JSON.stringify({ name: "Chords", key: "C", tempo_bpm: 120, time_sig_num: 4, time_sig_den: 4,
    sections: [{ name: "Intro", clips: [{ source: "Grooves/beat.mid", name: "beat", start_bar: 0, end_bar: 2 }],
                 chords: [{ root: "C", quality: "maj" }, { root: "A", quality: "min" }] },
               { name: "Verse", clips: [{ source: "Grooves/beat.mid", name: "beat", start_bar: 0, end_bar: 2 }],
                 chords: [{ root: "F", quality: "maj" }, { root: "A#", quality: "7" }] }] }));
H.files.set(SETLISTS + "/c_gig.json", JSON.stringify({ id: "s3", name: "C Gig",
    songs: [{ id: "e3", name: "Chords", path: SONGS + "/c.json", click_bars: 0 }] }));
/* The same song, capo 2: the shapes are Bb's (C sounds from a Bb shape). */
H.files.set(SETLISTS + "/d_gig.json", JSON.stringify({ id: "s4", name: "D Gig",
    songs: [{ id: "e4", name: "Chords", path: SONGS + "/c.json", click_bars: 0, capo: 2 }] }));

/* The engine, for playing: builds confirm at once, and the transport is at
 * `barFrac` while running. */
let gen = 0, running = false, barFrac = 0;
globalThis.host_module_get_param = (k) => k === "ui_poll" ? JSON.stringify({
    state: { primary_published_gen: gen, staging_published_gen: 0, running, active_source: "primary" },
    transport: { running, bar: Math.floor(barFrac) + 1, bar_frac: barFrac, beat: 1, beat_progress: 0,
                 ticks_per_beat: 240, ticks_per_bar: 960, bpm: 120 } }) : null;
const onSet = (k, v) => { if (k === "song_json") gen++; if (k === "play") running = true; if (k === "stop") running = false; };
for (const f of ["host_module_set_param", "host_module_set_param_blocking"]) {
    const plain = globalThis[f];
    globalThis[f] = (k, v, t) => { onSet(k, v); return plain(k, v, t); };
}

await import('./ui_test.mjs');
const g = globalThis;
let failures = 0, passes = 0;
function check(cond, msg) { if (cond) passes++; else { failures++; console.log("FAIL: " + msg); } }
function cc(n, v) { g.onMidiMessageInternal([0xB0, n, v]); }
function tick(n = 1, ms = 23) { for (let i = 0; i < n; i++) { H.advance(ms); H.hostFrame(); g.tick(); } }
const JOG = 14, CLICK = 3, BACK = 51;
function jog(n) { for (let i = 0; i < Math.abs(n); i++) cc(JOG, n > 0 ? 1 : 127); tick(); }
function click() { cc(CLICK, 127); cc(CLICK, 0); tick(); }

const W = 128;
let fb = new Uint8Array(W * 64);
g.clear_screen = () => { fb = new Uint8Array(W * 64); return true; };
g.fill_rect = (x, y, w, h, c) => {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
        if (xx >= 0 && xx < W && yy >= 0 && yy < 64) fb[yy * W + xx] = c ? 1 : 0;
    }
    return true;
};
g.host_battery = () => ({ level: 60, source: "xmos", flags: 0 });

/* `text` (as the face draws it, capitals) at (x, y)? */
function drawnAt(x, y, text) {
    const want = new Uint8Array(W * 64);
    fontPrint4x5({ fillRect: (fx, fy, fw, fh) => {
        for (let yy = fy; yy < fy + fh; yy++) for (let xx = fx; xx < fx + fw; xx++) want[yy * W + xx] = 1;
    } }, x, y, text, 1);
    const w = fontWidth4x5(text);
    for (let yy = y; yy < y + 5; yy++) for (let xx = x; xx < x + w; xx++) {
        if (want[yy * W + xx] !== fb[yy * W + xx]) return false;
    }
    return true;
}
/* Where on row `y` `text` is drawn, or -1. */
function findOnRow(y, text) {
    for (let x = 0; x < W; x++) if (drawnAt(x, y, text)) return x;
    return -1;
}
const FLAT = ["#..", "#..", "###", "#.#", "###"];
const flatAt = (x, y) => FLAT.every((row, r) => [...row].every((c, i) => fb[(y + r) * W + x + i] === (c === "#" ? 1 : 0)));
const MINOR = [".....", ".....", "##.#.", "#.#.#", "#.#.#"];
const minorAt = (x, y) => MINOR.every((row, r) => [...row].every((c, i) => fb[(y + r) * W + x + i] === (c === "#" ? 1 : 0)));
/* Where the header's second chord starts, after "<first> > ". */
const secondX = (first) => 2 + fontWidth4x5(first) + 1 + fontWidth4x5(" > ") + 1;
const valueX = 2 + Math.max(fontWidth4x5("SEC:"), fontWidth4x5("NEXT:")) + 4;

g.init();
tick(100);
jog(-8); jog(2); click();     /* Perform */
click();                      /* A Gig */
tick(30);

check(drawnAt(2, 1, "PERFORM"), "the header says Perform");
const keyX = findOnRow(1, "KEY B");
check(keyX > 40, "the header's right has the key: " + keyX);
/* The flat one gap after the B; the battery icon from column 116. */
const flatX = keyX + fontWidth4x5("KEY B") + 1;
check(keyX > 0 && flatAt(flatX, 1), "...Bb, its flat a small b (not BB)");
check(keyX > 0 && flatX + 3 < 116, "...left of the battery");
check(drawnAt(2, 12, "YES HE LIVES"), "the song on the line below, with no Now:");
check(findOnRow(12, "NOW") < 0 && findOnRow(1, "NOW") < 0, "no Now: anywhere");
check(drawnAt(2, 23, "SEC:") && drawnAt(valueX, 23, "INTRO > VERSE"), "one Sec line: Intro > Verse");
check(findOnRow(34, "NSC") < 0, "no NSc line");
check(drawnAt(2, 34, "NEXT:") && drawnAt(valueX, 34, "ANOTHER SONG"), "the next song below it, its name lined up with the section's");
check(drawnAt(2, 45, "TIME:"), "the time line last");

/* A setlist that plays the song in D#: the header shows Eb. */
cc(BACK, 127); cc(BACK, 0); tick(5);
jog(-8); jog(2); click();     /* Perform */
jog(1); click();              /* B Gig */
tick(30);
const ebX = findOnRow(1, "KEY E");
check(ebX > 40 && flatAt(ebX + fontWidth4x5("KEY E") + 1, 1), "the setlist's key for the song: Eb (" + ebX + ")");
check(findOnRow(1, "KEY B") < 0, "...not the song's own Bb");

/* ---- a song with chords: the header shows the chord and the next ---- */
cc(BACK, 127); cc(BACK, 0); tick(5);
jog(-8); jog(2); click();     /* Perform */
jog(2); click();              /* C Gig */
tick(30);
check(findOnRow(1, "PERFORM") < 0, "with chords, no Perform title");
check(drawnAt(2, 1, "C > A"), "stopped: the chord the song starts on > the next (C > A...)");
check(minorAt(secondX("C") + fontWidth4x5("A") + 1, 1), "...Am, its m drawn small (not AM)");
check(findOnRow(1, "KEY C") > 40, "...the key still at the right");
check(findOnRow(1, " 4") < 0 && findOnRow(1, " 1") < 0, "...no beat count while stopped");

const PLAY = 85;
cc(PLAY, 127); cc(PLAY, 0); tick(20);
barFrac = 0.25; tick(10);    /* the Intro's first bar, beat 2 */
check(drawnAt(2, 1, "C > A") && drawnAt(secondX("C") + fontWidth4x5("A") + 1 + 5 + 1, 1, " 3"),
      "playing beat 2: C > Am 3 (beats to the change)");
barFrac = 1.5; tick(10);     /* the Intro's second bar, beat 3 */
check(drawnAt(2, 1, "A") && minorAt(2 + fontWidth4x5("A") + 1, 1), "playing bar 2: Am first: " + running);
const afterAm = 2 + fontWidth4x5("A") + 1 + 5 + 1;
check(drawnAt(afterAm, 1, " > F 2"), "...then the next section's first chord, F, 2 beats away");
barFrac = 2.5; tick(10);     /* the Verse's first bar */
const bbFlatX = secondX("F") + fontWidth4x5("B") + 1;
check(drawnAt(2, 1, "F > B") && flatAt(bbFlatX, 1) && drawnAt(bbFlatX + 4, 1, "7"),
      "the Verse: F > A#7, as the key spells it: Bb7, its flat small");
check(drawnAt(bbFlatX + 4, 1, "7 2"), "...2 beats away");
cc(PLAY, 127); cc(PLAY, 0); tick(10);

/* ---- capo 2: the chords as Bb shapes, the key as it sounds ---- */
cc(BACK, 127); cc(BACK, 0); tick(5);
jog(-8); jog(2); click();     /* Perform */
jog(3); click();              /* D Gig */
tick(30);
check(drawnAt(2, 1, "B") && flatAt(2 + fontWidth4x5("B") + 1, 1), "capo 2: C shows as Bb");
const gX = 2 + fontWidth4x5("B") + 1 + 3 + 1 + fontWidth4x5(" > ") + 1;
check(drawnAt(gX, 1, "G") && minorAt(gX + fontWidth4x5("G") + 1, 1), "...and Am as Gm");
check(findOnRow(1, "KEY C") > 40, "...the key still the one it sounds in (C)");

console.log(`perform display: ${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
