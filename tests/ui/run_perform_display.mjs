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

console.log(`perform display: ${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
