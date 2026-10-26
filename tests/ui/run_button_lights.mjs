/* Back is lit on every screen it works on: Root, the Options sub-pages,
 * Song Builder's item and instrument pages (reached from the Inst, Pads and
 * Click tracks). A confirm box has a footer too, all three pairs of it
 * drawn. (The jog click has no light.) */
import * as H from './host_mock.mjs';
import { fontPrint4x5, fontWidth4x5 } from './shared/param_pages/font4x5.mjs';

const SONGS = "/data/UserData/UserLibrary/Arranger/Songs";
H.files.set(SONGS + "/c.json", JSON.stringify({ name: "Chorded", tempo_bpm: 120, time_sig_num: 4, time_sig_den: 4,
    sections: [{ name: "A", clips: [{ source: "Grooves/g.mid", name: "g", start_bar: 0, end_bar: 2 }],
                 chords: [{ root: "C", quality: "maj" }] }] }));
const songList = [{ name: "Chorded", path: SONGS + "/c.json" }];
globalThis.host_module_get_param = (k) => k === "songs_json" ? JSON.stringify({ count: 1, start: 0, items: songList }) : null;

const W = 128;
let fb = new Uint8Array(W * 64);
globalThis.clear_screen = () => { fb = new Uint8Array(W * 64); return true; };
globalThis.fill_rect = (x, y, w, h, c) => {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
        if (xx >= 0 && xx < W && yy >= 0 && yy < 64) fb[yy * W + xx] = c ? 1 : 0;
    }
    return true;
};

const M = await import('./ui_test.mjs');
const g = globalThis;
const C = await import('./shared/constants.mjs');
let failures = 0, passes = 0;
function check(cond, msg) { if (cond) passes++; else { failures++; console.log("FAIL: " + msg); } }
function cc(n, v) { g.onMidiMessageInternal([0xB0, n, v]); }
function tick(n = 1, ms = 23) { for (let i = 0; i < n; i++) { H.advance(ms); H.hostFrame(); g.tick(); } }
function jog(n) { for (let i = 0; i < Math.abs(n); i++) cc(C.MoveMainKnob, n > 0 ? 1 : 127); tick(); }
function press(n) { cc(n, 127); cc(n, 0); tick(10); }
const click = () => press(C.MoveMainButton);
const backLit = (where) => check((H.buttonLeds.get(C.MoveBack) || 0) > 0, where + ": Back lit");
/* Something drawn in the footer rows (56-63)? */
function footerDrawn() {
    for (let y = 56; y < 64; y++) for (let x = 0; x < W; x++) if (fb[y * W + x]) return true;
    return false;
}
/* `text` (white on black) somewhere on the footer's text row? */
function footerHas(text) {
    const tw = fontWidth4x5(text);
    for (let x = 0; x + tw <= W; x++) {
        const want = new Uint8Array(W * 64);
        fontPrint4x5({ fillRect: (fx, fy, fw, fh) => {
            for (let yy = fy; yy < fy + fh; yy++) for (let xx = fx; xx < fx + fw; xx++) want[yy * W + xx] = 1;
        } }, x, 58, text, 1);
        let ok = true;
        for (let yy = 58; yy < 63 && ok; yy++) for (let xx = x; xx < x + tw; xx++) {
            if (want[yy * W + xx] !== fb[yy * W + xx]) { ok = false; break; }
        }
        if (ok) return true;
    }
    return false;
}

g.init();
tick(10);
backLit("Root");

/* Options > Drums, Inst 1, Click, Keys. */
jog(-8); jog(4); click();
for (const [row, name] of [[0, "Drums"], [1, "Inst 1"], [4, "Click"], [5, "Keys"]]) {
    jog(-10); jog(row); click();
    backLit("Options > " + name);
    check(footerDrawn(), "Options > " + name + ": a footer");
    press(C.MoveBack);
}
press(C.MoveBack);

/* Song Builder: each item track's "+ Add" page and Instrument Settings. */
jog(-8); click(); jog(1); click();
for (const [btn, name] of [[C.MoveRow2, "Inst 1"], [C.MoveRow4, "Pads"], [C.MoveRow4, "Click"]]) {
    press(btn);
    jog(5); click();
    backLit(name + " item page");
    check(footerDrawn() && footerHas("SEL") && footerHas("EDIT") && footerHas("OUT"),
          name + " item page: JOG SEL, CLK EDIT, BACK OUT");
    press(C.MoveBack);
}
press(C.MoveRow2);
press(C.MoveMenu);
backLit("Inst 1 settings");
check(footerDrawn(), "Inst 1 settings: a footer");
press(C.MoveBack);
press(C.MoveBack);

/* A confirm box (deleting a song): its footer, every pair of it. */
jog(-8); jog(1);
press(C.MoveDelete);
check(JSON.stringify(M.footerHints()) === '[["JOG","SEL"],["CLK","PICK"],["BACK","OUT"]]', "a confirm box has hints: " + JSON.stringify(M.footerHints()));
check(footerHas("SEL") && footerHas("PICK") && footerHas("OUT"), "...all drawn: JOG SEL, CLK PICK, BACK OUT");
backLit("the confirm box");
press(C.MoveBack);
check(H.files.has(SONGS + "/c.json"), "Back cancels: the song is still there");

console.log(`button lights: ${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
