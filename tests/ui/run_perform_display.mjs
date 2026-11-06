/* Perform's display: the song in the header (beside the battery), then the
 * chords -- the one playing > the next, and the beats to it -- with the key
 * the song plays in at the right, one Sec line with the section playing >
 * the next one, the next song, and the time. The key is the setlist's own
 * for the song when it sets one, and a flat and minor's m are drawn small
 * (the face has capitals only). Pixels are read back from fill_rect and
 * compared with the face's own drawing of each expected line. */
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
/* The same song after a 2-bar count-in. */
H.files.set(SETLISTS + "/e_gig.json", JSON.stringify({ id: "s5", name: "E Gig",
    songs: [{ id: "e5", name: "Chords", path: SONGS + "/c.json", click_bars: 2 }] }));
/* Its click file, as if written already (the mock's binary writes fail). */
H.files.set("/data/UserData/UserLibrary/Arranger/.click-e5-0-4x240t240.mid", "MThd");

/* The engine, for playing: builds confirm at once, and the transport is at
 * `barFrac` while running. */
let gen = 0, sgen = 0, running = false, barFrac = 0, swaps = 0;
globalThis.host_module_get_param = (k) => k === "ui_poll" ? JSON.stringify({
    state: { primary_published_gen: gen, staging_published_gen: sgen, running, active_source: "primary" },
    transport: { running, bar: Math.floor(barFrac) + 1, bar_frac: barFrac, beat: 1, beat_progress: 0, swap_counter: swaps,
                 ticks_per_beat: 240, ticks_per_bar: 960, bpm: 120 } }) : null;
const onSet = (k, v) => {
    if (k === "song_json") gen++;
    if (k === "preload_song_json") sgen++;
    if (k === "play") running = true;
    if (k === "stop") running = false;
};
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
/* The chord line's row, and where its second chord starts, after "<first> > ". */
const R = 12;
const secondX = (first) => 2 + fontWidth4x5(first) + 1 + fontWidth4x5(" > ") + 1;
const valueX = 2 + Math.max(fontWidth4x5("SEC:"), fontWidth4x5("NEXT:")) + 4;

g.init();
tick(100);
jog(-8); jog(2); click();     /* Perform */
click();                      /* A Gig */
tick(30);

check(drawnAt(2, 1, "YES HE LIVES"), "the header is the song");
check(findOnRow(1, "PERFORM") < 0 && findOnRow(1, "KEY") < 0, "...no Perform title, no key there");
const keyX = findOnRow(R, "KEY B");
check(keyX > 40, "the line below has the key at its right: " + keyX);
/* The flat one gap after the B, ending the line. */
const flatX = keyX + fontWidth4x5("KEY B") + 1;
check(keyX > 0 && flatAt(flatX, R), "...Bb, its flat a small b (not BB)");
check(keyX > 0 && flatX + 2 === 126, "...right-aligned: " + (flatX + 2));
check(findOnRow(R, "YES HE LIVES") < 0, "the song is no longer on that line");
check(findOnRow(R, "NOW") < 0 && findOnRow(1, "NOW") < 0, "no Now: anywhere");
check(drawnAt(2, 23, "SEC:") && drawnAt(valueX, 23, "INTRO > VERSE"), "one Sec line: Intro > Verse");
check(findOnRow(34, "NSC") < 0, "no NSc line");
check(drawnAt(2, 34, "NEXT:") && drawnAt(valueX, 34, "ANOTHER SONG"), "the next song below it, its name lined up with the section's");
check(drawnAt(2, 45, "TIME:"), "the time line last");

/* A setlist that plays the song in D#: the header shows Eb. */
cc(BACK, 127); cc(BACK, 0); tick(5);
jog(-8); jog(2); click();     /* Perform */
jog(1); click();              /* B Gig */
tick(30);
const ebX = findOnRow(R, "KEY E");
check(ebX > 40 && flatAt(ebX + fontWidth4x5("KEY E") + 1, R), "the setlist's key for the song: Eb (" + ebX + ")");
check(findOnRow(R, "KEY B") < 0, "...not the song's own Bb");

/* ---- a song with chords: the chord and the next, before the key ---- */
cc(BACK, 127); cc(BACK, 0); tick(5);
jog(-8); jog(2); click();     /* Perform */
jog(2); click();              /* C Gig */
tick(30);
check(drawnAt(2, 1, "CHORDS"), "the header is the song (Chords)");
check(drawnAt(2, R, "C > A"), "stopped: the chord the song starts on > the next (C > A...)");
check(minorAt(secondX("C") + fontWidth4x5("A") + 1, R), "...Am, its m drawn small (not AM)");
check(findOnRow(R, "KEY C") > 40, "...the key still at the right");
check(findOnRow(R, " 4") < 0 && findOnRow(R, " 1") < 0, "...no beat count while stopped");

const PLAY = 85;
cc(PLAY, 127); cc(PLAY, 0); tick(20);
barFrac = 0.25; tick(10);    /* the Intro's first bar, beat 2 */
check(drawnAt(2, R, "C > A") && drawnAt(secondX("C") + fontWidth4x5("A") + 1 + 5 + 1, R, " 3"),
      "playing beat 2: C > Am 3 (beats to the change)");
barFrac = 1.5; tick(10);     /* the Intro's second bar, beat 3 */
check(drawnAt(2, R, "A") && minorAt(2 + fontWidth4x5("A") + 1, R), "playing bar 2: Am first: " + running);
const afterAm = 2 + fontWidth4x5("A") + 1 + 5 + 1;
check(drawnAt(afterAm, R, " > F 2"), "...then the next section's first chord, F, 2 beats away");
barFrac = 2.5; tick(10);     /* the Verse's first bar */
const bbFlatX = secondX("F") + fontWidth4x5("B") + 1;
check(drawnAt(2, R, "F > B") && flatAt(bbFlatX, R) && drawnAt(bbFlatX + 4, R, "7"),
      "the Verse: F > A#7, as the key spells it: Bb7, its flat small");
check(drawnAt(bbFlatX + 4, R, "7 2"), "...2 beats away");
cc(PLAY, 127); cc(PLAY, 0); tick(10);

/* ---- capo 2: the chords as Bb shapes, the key as it sounds ---- */
cc(BACK, 127); cc(BACK, 0); tick(5);
jog(-8); jog(2); click();     /* Perform */
jog(3); click();              /* D Gig */
tick(30);
check(drawnAt(2, R, "B") && flatAt(2 + fontWidth4x5("B") + 1, R), "capo 2: C shows as Bb");
const gX = 2 + fontWidth4x5("B") + 1 + 3 + 1 + fontWidth4x5(" > ") + 1;
check(drawnAt(gX, R, "G") && minorAt(gX + fontWidth4x5("G") + 1, R), "...and Am as Gm");
check(findOnRow(R, "KEY C") > 40, "...the key still the one it sounds in (C)");

/* ---- a count-in: as the song takes over, the transport is still the
 * click's for a moment (at its end, bar 2) -- the count is the song's
 * start's, not bar 2's ---- */
cc(BACK, 127); cc(BACK, 0); tick(5);
jog(-8); jog(2); click();     /* Perform */
jog(4); click();              /* E Gig */
tick(30);
barFrac = 0;
cc(PLAY, 127); cc(PLAY, 0); tick(10);
barFrac = 1.97;               /* the click's last beat, until the UI's count-in timer moves on */
for (let i = 0; i < 400 && findOnRow(23, "CLICK") >= 0; i++) tick();
tick(2);
check(running && drawnAt(2, R, "C > A") && drawnAt(secondX("C") + fontWidth4x5("A") + 1 + 5 + 1, R, " 4"),
      "the song just started (the transport still the click's): C > Am 4, not bar 2's count");
check(drawnAt(2, 23, "SEC:") && drawnAt(valueX, 23, "INTRO > VERSE"), "...and the Intro, not the Verse");
swaps++; barFrac = 0.05; tick(3);   /* the engine's swap shows */
check(drawnAt(secondX("C") + fontWidth4x5("A") + 1 + 5 + 1, R, " 4"), "the swap shows: still 4");
barFrac = 0.3; tick(3);
check(drawnAt(secondX("C") + fontWidth4x5("A") + 1 + 5 + 1, R, " 3"), "...then 3, from the song's own position");
cc(PLAY, 127); cc(PLAY, 0); tick(10);

/* ---- the big view (jog click): the chord playing big and its section on
 * the left; the next chord, blocks for its beats, the next section, blocks
 * for its bars on the right; the key and capo, the time and the next song
 * at the foot; no button hints ---- */
const M = await import('./ui_test.mjs');
/* A block at (x, y), w x h: solid, or just its outline. */
const solid = (x, y, w, h) => { for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) if (!fb[yy * W + xx]) return false; return true; };
const hollow = (x, y, w, h) => solid(x, y, w, 1) && solid(x, y + h - 1, w, 1) && !fb[(y + 2) * W + x + 3];
cc(BACK, 127); cc(BACK, 0); tick(5);
jog(-8); jog(2); click();     /* Perform */
jog(3); click();              /* D Gig: capo 2 */
tick(30);
click(); tick(5);             /* the big view */
check(M.footerHints() === null, "big view: no button hints");
check(drawnAt(67, 0, "NEXT"), "...Next at the top of the right half");
check(solid(118, 0, 1, 5) && solid(125, 1, 1, 3), "...the battery beside it");
check(findOnRow(49, "KEY C  CAPO 2") === 2, "...the key and the capo at the foot");
check(drawnAt(1, 58, "NEXT:"), "...the next song, as Next:");
check(!solid(67, 23, 7, 5) && !solid(67, 39, 12, 4), "...stopped: no beat or bar blocks");
cc(PLAY, 127); cc(PLAY, 0); tick(20);
barFrac = 0.25; tick(10);     /* the Intro's first bar, beat 2: Gm (Am, capo 2) 3 beats away */
check(solid(67, 23, 7, 5) && solid(76, 23, 7, 5) && solid(85, 23, 7, 5) && hollow(94, 23, 7, 5),
      "playing: 3 of 4 beat blocks to the next chord");
check(solid(67, 39, 12, 4) && solid(81, 39, 12, 4), "...and the Intro's 2 bars to the Verse, both left");
check(drawnAt(2, 31, "I") && drawnAt(67, 32, "VERSE"), "...Intro big on the left, the Verse next");
barFrac = 1.5; tick(10);      /* bar 2, beat 3: 2 beats to the Verse's F (Eb) */
check(solid(67, 23, 7, 5) && solid(76, 23, 7, 5) && hollow(85, 23, 7, 5), "bar 2 beat 3: 2 beats left");
check(solid(67, 39, 12, 4) && hollow(81, 39, 12, 4), "...1 bar left");
cc(PLAY, 127); cc(PLAY, 0); tick(10);
click(); tick(5);             /* back */
check(drawnAt(2, 1, "CHORDS") && M.footerHints() !== null, "jog click again: the usual display and its hints");

console.log(`perform display: ${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
