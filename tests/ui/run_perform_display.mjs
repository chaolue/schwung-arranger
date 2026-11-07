/* Perform's display: a "Perform" header with the key the song plays in at
 * its right (beside the battery), then Now: the song, one Sec line
 * with the section playing > the next one, the next song, and the time.
 * The key is the setlist's own for the song when it sets one, and a flat is
 * drawn as a small b (the face has capitals only). Its big view (jog click)
 * has the chords: the one playing, big, and its section; the next chord and
 * section with blocks counting the beats and bars to them; the key and
 * capo, the time and the next song. Pixels are read back from fill_rect and
 * compared with the face's own drawing of each expected line. The names are
 * the songs' own: one renamed since the setlist was saved shows (and the
 * setlist takes) its new name. */
import * as H from './host_mock.mjs';
import { fontPrint4x5, fontWidth4x5 } from './shared/param_pages/font4x5.mjs';
import * as BIG from './shared/param_pages/font_big_num.mjs';

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
/* A song whose chord is long: Bbm7b5. */
H.files.set(SONGS + "/l.json", JSON.stringify({ name: "Long", key: "Bb", tempo_bpm: 120, time_sig_num: 4, time_sig_den: 4,
    sections: [{ name: "Verse", clips: [{ source: "Grooves/beat.mid", name: "beat", start_bar: 0, end_bar: 2 }],
                 chords: [{ root: "A#", quality: "m7b5" }] }] }));
H.files.set(SETLISTS + "/f_gig.json", JSON.stringify({ id: "s6", name: "F Gig",
    songs: [{ id: "e6", name: "Long", path: SONGS + "/l.json", click_bars: 0 }] }));
/* Its click file, as if written already (the mock's binary writes fail). */
H.files.set("/data/UserData/UserLibrary/Arranger/.click-e5-0-4x240t240.mid", "MThd");
/* A setlist saved before Another Song was renamed (it was Old Name). */
H.files.set(SETLISTS + "/g_gig.json", JSON.stringify({ id: "s7", name: "G Gig", songs: [
    { id: "e1", name: "Yes He Lives", path: SONGS + "/a.json", click_bars: 0 },
    { id: "e2", name: "Old Name", path: SONGS + "/b.json", click_bars: 0 }] }));

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
const valueX = 2 + Math.max(fontWidth4x5("NOW:"), fontWidth4x5("SEC:"), fontWidth4x5("NEXT:")) + 4;
const M = await import('./ui_test.mjs');
const PLAY = 85;
/* A block at (x, y), w x h: solid, or just its outline. */
const solid = (x, y, w, h) => { for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) if (!fb[yy * W + xx]) return false; return true; };
const hollow = (x, y, w, h) => solid(x, y, w, 1) && solid(x, y + h - 1, w, 1) && !fb[(y + 2) * W + x + 3];
const lit = (x0, y0, x1, y1) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (fb[y * W + x]) return true; return false; };
/* `ch` in the big face at (x, y), at scale `s`. */
const bigAt = (x, y, ch, s = 1) => {
    const want = new Uint8Array(W * 64);
    BIG.fontPrint({ fillRect: (fx, fy, fw, fh) => { for (let yy = y + (fy - y) * s; yy < y + (fy - y) * s + fh * s; yy++) for (let xx = x + (fx - x) * s; xx < x + (fx - x) * s + fw * s; xx++) want[yy * W + xx] = 1; } }, x, y, ch, 1);
    for (let yy = y; yy < y + 11 * s; yy++) for (let xx = x; xx < x + BIG.fontWidth(ch) * s; xx++) if (want[yy * W + xx] !== fb[yy * W + xx]) return false;
    return true;
};
const big2At = (x, y, ch) => bigAt(x, y, ch, 2);
/* `text` in the small face doubled, at (x, y). */
function drawn2At(x, y, text) {
    const want = new Uint8Array(W * 64);
    fontPrint4x5({ fillRect: (fx, fy, fw, fh) => {
        for (let yy = y + (fy - y) * 2; yy < y + (fy - y) * 2 + fh * 2; yy++) for (let xx = x + (fx - x) * 2; xx < x + (fx - x) * 2 + fw * 2; xx++) want[yy * W + xx] = 1;
    } }, x, y, text, 1);
    for (let yy = y; yy < y + 10; yy++) for (let xx = x; xx < x + fontWidth4x5(text) * 2; xx++) if (want[yy * W + xx] !== fb[yy * W + xx]) return false;
    return true;
}

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
check(drawnAt(2, 12, "NOW:") && drawnAt(valueX, 12, "YES HE LIVES"), "Now: the song on the line below, lined up with the others");
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

/* ---- a song renamed since the setlist was saved: its new name ---- */
cc(BACK, 127); cc(BACK, 0); tick(5);
jog(-8); jog(2); click();     /* Perform */
jog(6); click();              /* G Gig */
tick(30);
check(drawnAt(valueX, 34, "ANOTHER SONG") && findOnRow(34, "OLD NAME") < 0, "Next: the song's own name, not the setlist's old copy");
check(JSON.parse(H.files.get(SETLISTS + "/g_gig.json")).songs[1].name === "Another Song", "...and the setlist takes it");

/* ---- a song with chords: none on the usual display; in the big view, the
 * chord playing and the next, spelt for the key ---- */
cc(BACK, 127); cc(BACK, 0); tick(5);
jog(-8); jog(2); click();     /* Perform */
jog(2); click();              /* C Gig */
tick(30);
check(drawnAt(2, 1, "PERFORM") && drawnAt(valueX, 12, "CHORDS"), "the usual display: Perform, then the song");
check(!lit(valueX + fontWidth4x5("CHORDS") + 4, 12, 126, 16), "...and no chords beside it");
click(); tick(5);             /* the big view */
check(big2At(2, 2, "C") && big2At(67, 1, "A"), "big view, stopped: C, next A(m), its root doubled too");
cc(PLAY, 127); cc(PLAY, 0); tick(20);
barFrac = 2.5; tick(10);      /* the Verse's first bar */
check(big2At(2, 2, "F") && big2At(67, 1, "B"), "the Verse: F, next A#7 spelt as the key writes it, Bb7");
cc(PLAY, 127); cc(PLAY, 0); tick(10);
click(); tick(5);             /* back */

/* ---- a count-in: as the song takes over, the transport is still the
 * click's for a moment (at its end, bar 2) -- the count is the song's
 * start's, not bar 2's ---- */
cc(BACK, 127); cc(BACK, 0); tick(5);
jog(-8); jog(2); click();     /* Perform */
jog(4); click();              /* E Gig */
tick(30);
click(); tick(5);             /* the big view */
barFrac = 0;
cc(PLAY, 127); cc(PLAY, 0); tick(10);
barFrac = 1.97;               /* the click's last beat, until the UI's count-in timer moves on */
for (let i = 0; i < 400 && !drawn2At(2, 31, "INTRO"); i++) tick();
tick(2);
const beatBlocks = (n) => [0, 1, 2, 3].every(i => i < n ? solid(67 + i * 9, 25, 7, 5) : hollow(67 + i * 9, 25, 7, 5));
check(running && beatBlocks(4), "the song just started (the transport still the click's): 4 beats to Am, not bar 2's count");
check(drawn2At(2, 31, "INTRO") && drawnAt(67, 31, "VERSE"), "...and the Intro, not the Verse");
swaps++; barFrac = 0.05; tick(3);   /* the engine's swap shows */
check(beatBlocks(4), "the swap shows: still 4");
barFrac = 0.3; tick(3);
check(beatBlocks(3), "...then 3, from the song's own position");
cc(PLAY, 127); cc(PLAY, 0); tick(10);
click(); tick(5);             /* back */

/* ---- the big view (jog click): the chord playing big and its section on
 * the left; the next chord, blocks for its beats, the next section, blocks
 * for its bars on the right; the key and capo, the time and the next song
 * at the foot; no button hints ---- */
cc(BACK, 127); cc(BACK, 0); tick(5);
jog(-8); jog(2); click();     /* Perform */
jog(3); click();              /* D Gig: capo 2 */
tick(30);
click(); tick(5);             /* the big view */
check(M.footerHints() === null, "big view: no button hints");
check(big2At(2, 2, "B") && big2At(67, 1, "G"), "...capo 2: C shows as Bb, the next Am as Gm");
check(findOnRow(0, "NEXT") < 0, "...no Next label on the right");
/* The battery: its 9x5 body's left edge, and its 1x3 terminal 9 to the right. */
const batteryAt = (y, x0) => { for (let x = x0; x < 118; x++) if (solid(x, y, 1, 5) && solid(x + 9, y + 1, 1, 3) && !fb[y * W + x + 9]) return x; return -1; };
check(batteryAt(49, 40) > 50 && batteryAt(0, 105) < 0, "...the battery on the key line, left of the time, not at the top right: " + batteryAt(49, 40));
check(findOnRow(49, "KEY C  CAPO 2") === 2, "...the key and the capo at the foot");
check(drawnAt(1, 58, "NOW: CHORDS"), "...the song playing at the foot (no next song to take turns with)");
check(!solid(67, 25, 7, 5) && !solid(67, 37, 12, 4), "...stopped: no beat or bar blocks");
cc(PLAY, 127); cc(PLAY, 0); tick(20);
barFrac = 0.25; tick(10);     /* the Intro's first bar, beat 2: Gm (Am, capo 2) 3 beats away */
check(solid(67, 25, 7, 5) && solid(76, 25, 7, 5) && solid(85, 25, 7, 5) && hollow(94, 25, 7, 5),
      "playing: 3 of 4 beat blocks to the next chord");
check(solid(67, 37, 12, 4) && solid(81, 37, 12, 4), "...and the Intro's 2 bars to the Verse, both left");
check(drawnAt(2, 31, "I") && drawnAt(67, 31, "VERSE"), "...Intro big on the left, the Verse next");
barFrac = 1.5; tick(10);      /* bar 2, beat 3: 2 beats to the Verse's F (Eb) */
check(solid(67, 25, 7, 5) && solid(76, 25, 7, 5) && hollow(85, 25, 7, 5), "bar 2 beat 3: 2 beats left");
check(solid(67, 37, 12, 4) && hollow(81, 37, 12, 4), "...1 bar left");
cc(PLAY, 127); cc(PLAY, 0); tick(10);
click(); tick(5);             /* back */
check(drawnAt(2, 1, "PERFORM") && M.footerHints() !== null, "jog click again: the usual display and its hints");

/* A long chord keeps its root big and wraps the rest beside it: Bbm7b5's
 * B at double size, m7 over b5. */
cc(BACK, 127); cc(BACK, 0); tick(5);
jog(-8); jog(2); click();     /* Perform */
jog(5); click();              /* F Gig */
tick(30);
click(); tick(5);             /* the big view */
check(big2At(2, 2, "B"), "Bbm7b5: the B at double size");
check(lit(30, 2, 60, 11) && lit(30, 14, 60, 23), "...the rest in two lines beside it (m7, b5)");
check(!lit(2, 25, 60, 30), "...nothing below the chord's height");

/* The big view's foot: Now: the song (left) and Next: the next one (right)
 * in turn, 3 s each. */
cc(BACK, 127); cc(BACK, 0); tick(5);
jog(-8); jog(2); click();     /* Perform */
jog(-8); click(); tick(30);   /* A Gig: Yes He Lives, then Another Song (the big view still on) */
const phase = (p) => { while (Math.floor(H.clock / 3000) % 2 !== p) tick(); tick(2); };
phase(0);
check(drawnAt(1, 58, "NOW: YES HE LIVES"), "big view foot: Now: the song, left");
phase(1);
const nx = findOnRow(58, "NEXT: ANOTHER SONG");
check(nx > 0 && nx + fontWidth4x5("NEXT: ANOTHER SONG") === 127 && findOnRow(58, "NOW:") < 0, "...then Next: the next song, right-aligned: " + nx);
/* A knob touched: its overlay takes the foot's two lines (below the rule),
 * in their small face; the rest of the view stays. */
g.onMidiMessageInternal([0x90, 0, 127]); tick(5);            /* touch knob 1 (unassigned) */
check(drawnAt(2, 49, "BANK 1 KNOB 1") && drawnAt(2, 58, "UNASSIGNED"), "a knob touched: its overlay on the foot's two lines");
check(solid(0, 45, W, 1) && findOnRow(58, "NEXT:") < 0 && findOnRow(49, "KEY") < 0, "...below the rule, in place of the key and songs");
check(drawn2At(2, 31, "INTRO"), "...the section (and the chords) still in view");
g.onMidiMessageInternal([0x90, 0, 0]); tick(100);            /* released, and the overlay's time out */
check(findOnRow(49, "KEY") === 2, "released: the key line back");

/* The big view's section: always doubled, shortened to fit the left half
 * (58 px), its number kept. */
const short = (n) => M.perfSectionShort(n, 58);
check(short("Chorus") === "CHORUS" && short("Intro 2") === "INTRO 2", "a name that fits stays whole");
check(short("Chorus 2") === "CHOR 2" && short("Prechorus 2") === "PRE 2" && short("Outro 2") === "OUT 2",
      "known names shorten their own way, the number kept: " + [short("Chorus 2"), short("Prechorus 2"), short("Outro 2")]);
check(short("Instrumental") === "INSTR" && short("Down Bridge") === "DN BR", "...a long one, and two words");
check(short("Section 3") === "SCTN 3", "an unknown word: its consonants: " + short("Section 3"));
check(["Verse 12", "Down Chorus 2", "Instrumental 2", "Big Finish 2"].every(n => fontWidth4x5(short(n)) * 2 <= 58),
      "...every result fits doubled");

console.log(`perform display: ${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
