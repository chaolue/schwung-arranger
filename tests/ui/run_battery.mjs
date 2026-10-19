/* The battery: Schwung's host_battery() level drawn at the right of the
 * header on the root and Perform screens, and a popup once when it falls to
 * 10%. Pixels are read back from the fill_rect calls (the header and Perform
 * text are drawn through it too). */
import * as H from './host_mock.mjs';

const SONGS = "/data/UserData/UserLibrary/Arranger/Songs";
const SETLISTS = "/data/UserData/UserLibrary/Arranger/Setlists";
H.files.set(SONGS + "/a.json", JSON.stringify({ name: "A Song With Quite A Long Name", tempo_bpm: 120, sections: [
    { name: "Verse", clips: [{ source: "Grooves/beat.mid", name: "beat" }] }] }));
H.files.set(SETLISTS + "/gig.json", JSON.stringify({ id: "s1", name: "Gig",
    songs: [{ id: "e1", name: "A Song With Quite A Long Name", path: SONGS + "/a.json", click_bars: 0 }] }));

await import('./ui_test.mjs');
const g = globalThis;
let failures = 0, passes = 0;
function check(cond, msg) { if (cond) passes++; else { failures++; console.log("FAIL: " + msg); } }
function cc(n, v) { g.onMidiMessageInternal([0xB0, n, v]); }
function tick(n = 1, ms = 23) { for (let i = 0; i < n; i++) { H.advance(ms); H.hostFrame(); g.tick(); } }
const JOG = 14, CLICK = 3;
function jog(n) { for (let i = 0; i < Math.abs(n); i++) cc(JOG, n > 0 ? 1 : 127); tick(); }
function click() { cc(CLICK, 127); cc(CLICK, 0); tick(); }

/* A 128x64 frame from fill_rect; cleared with the screen. */
const W = 128;
let fb = new Uint8Array(W * 64);
g.clear_screen = () => { fb = new Uint8Array(W * 64); return true; };
g.fill_rect = (x, y, w, h, c) => {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
        if (xx >= 0 && xx < W && yy >= 0 && yy < 64) fb[yy * W + xx] = c ? 1 : 0;
    }
    return true;
};
const px = (x, y) => fb[y * W + x];
function litIn(x0, x1, y0, y1) {
    let n = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) n += px(x, y);
    return n;
}
/* The icon's pixels, as drawn for `level` with its right edge at column 125. */
function iconMatches(level, y) {
    const x0 = 116;
    for (let x = x0; x < x0 + 9; x++) if (!px(x, y) || !px(x, y + 4)) return false;
    for (let yy = y; yy < y + 5; yy++) if (!px(x0, yy) || !px(x0 + 8, yy)) return false;
    if (!px(x0 + 9, y + 2) || px(x0 + 9, y)) return false;
    const fill = level <= 0 ? 0 : Math.max(1, Math.round(level * 7 / 100));
    for (let x = x0 + 1; x < x0 + 8; x++) if (px(x, y + 2) !== (x < x0 + 1 + fill ? 1 : 0)) return false;
    return true;
}
let battery = null;
const popupShown = (t) => H.printed.some(s => s.includes(t));

/* ---- Older Schwung: no host_battery, nothing drawn ---- */
g.init();
tick(5);
check(litIn(110, 127, 1, 5) === 0 || !iconMatches(0, 1), "no battery without host_battery()");
const noBatteryHeader = fb.slice(0, W * 7);

/* ---- A level: the badge at the right of the root header ---- */
g.host_battery = () => battery;
battery = { level: 25, source: "xmos", flags: 0x21 };
tick(100);   /* past the 2 s poll */
check(iconMatches(25, 1), "root header draws the battery icon at 25%");
/* The icon alone -- no percentage -- with clear columns between the
 * version text and it. */
const versionLit = litIn(80, 109, 1, 5);
check(versionLit > 0, "the version text is still drawn: " + versionLit);
check(litIn(110, 115, 1, 5) === 0, "no percentage: clear columns between the version and the icon");
check(!popupShown("Low battery"), "no warning at 25%");

/* A different level redraws the fill. */
battery = { level: 100, source: "xmos", flags: 0x21 };
tick(100);
check(iconMatches(100, 1), "a full battery fills the icon");

/* ---- Unknown again: the header goes back to what it was ---- */
battery = null;
tick(100);
check(fb.slice(0, W * 7).every((v, i) => v === noBatteryHeader[i]), "no level: the header is drawn as before");

/* ---- The low-battery popup: once at 10%, re-armed above 12% ---- */
H.printed.length = 0;
battery = { level: 11, source: "xmos", flags: 0 };
tick(100);
check(!popupShown("Low battery"), "no warning at 11%");
battery = { level: 10, source: "xmos", flags: 0 };
tick(100);
check(popupShown("Low battery"), "a warning at 10%");
check(H.printed.some(s => s.includes("10%")), "the warning says how much is left");
tick(400);   /* the popup times out */
H.printed.length = 0;
battery = { level: 9, source: "xmos", flags: 0 };
tick(100);
check(!popupShown("Low battery"), "not repeated at 9%");
battery = { level: 11, source: "xmos", flags: 0 };
tick(100);
battery = { level: 10, source: "xmos", flags: 0 };
tick(100);
check(!popupShown("Low battery"), "not repeated after wavering to 11%");
battery = { level: 12, source: "xmos", flags: 0 };
tick(100);
battery = { level: 8, source: "xmos", flags: 0 };
tick(100);
check(popupShown("Low battery"), "warned again after recovering to 12%");
tick(400);
H.printed.length = 0;

/* Charging (only Move's log says): no warning. */
battery = { level: 50, source: "log", charging: true };
tick(100);
H.printed.length = 0;
battery = { level: 5, source: "log", charging: true };
tick(100);
check(!popupShown("Low battery"), "no warning while the log says it is charging");
check(iconMatches(5, 1), "the log's level is drawn the same way");

/* ---- Low: the icon blinks; charging, it does not ---- */
function blinkFrames(n) {
    let on = 0, off = 0, stray = 0;
    for (let i = 0; i < n; i++) {
        tick();
        if (iconMatches(battery.level, 1)) on++;
        else if (litIn(116, 125, 1, 5) === 0) off++;
        else stray++;
    }
    return { on, off, stray };
}
let f = blinkFrames(80);
check(f.on > 0 && f.off === 0 && f.stray === 0, "charging at 5%: steady, no blink " + JSON.stringify(f));
battery = { level: 8, source: "xmos", flags: 0 };
tick(100);
f = blinkFrames(80);   /* ~1.8 s: three or four half-periods */
check(f.on > 10 && f.off > 10 && f.stray === 0, "at 8% the icon blinks " + JSON.stringify(f));
battery = { level: 11, source: "xmos", flags: 0 };
tick(100);
f = blinkFrames(80);
check(f.on === 80, "at 11% it is steady again " + JSON.stringify(f));

/* ---- Perform: the badge on the top line ---- */
battery = { level: 60, source: "xmos", flags: 0x21 };
tick(100);
jog(-8); jog(2); click();     /* Perform */
click();                      /* Gig */
tick(20);
check(iconMatches(60, 1), "Perform draws the battery on its top line");
/* The song name is cut short of the icon, not drawn through it, and gets
 * all the room the icon leaves. */
check(litIn(113, 115, 1, 5) === 0, "the song name stops short of the battery");
check(litIn(100, 112, 1, 5) > 0, "the song name runs up to the icon");

console.log(`battery: ${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
