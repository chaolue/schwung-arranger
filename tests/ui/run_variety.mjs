/* Inst 1/2 playing variety through the real menus: Instrument Settings
 * shows the rows that apply to the voicing (Pattern and Approach for Bass,
 * Strum for Chord, Pattern for Arp), Voicing steps Bass/Chord/Arp, and the
 * settings -- and an item's -- are saved in the song. */
import * as H from './host_mock.mjs';

const SONGS = "/data/UserData/UserLibrary/Arranger/Songs";
const PATH = SONGS + "/var.json";
H.files.set(PATH, JSON.stringify({ name: "Var", tempo_bpm: 120, time_sig_num: 4, time_sig_den: 4,
    sections: [{ name: "Verse", clips: [{ source: "Grooves/beat.mid", name: "beat", start_bar: 0, end_bar: 2 }],
                 chords: [{ root: "C", quality: "maj" }, { root: "G", quality: "maj" }] }],
    instruments: [{ enabled: true, octave: 2, voicing: "bass", follow_note: 36 }, { enabled: false, octave: 3, voicing: "chord" }] }));
const songList = [{ name: "Var", path: PATH }];
globalThis.host_module_get_param = (k) => {
    if (k === "songs_json") return JSON.stringify({ count: songList.length, start: 0, items: songList });
    return null;
};

await import('./ui_test.mjs');
const C = await import('./shared/constants.mjs');
const g = globalThis;
let failures = 0, passes = 0;
function check(cond, msg) { if (cond) passes++; else { failures++; console.log("FAIL: " + msg); } }
function cc(n, v) { g.onMidiMessageInternal([0xB0, n, v]); }
function tick(n = 1, ms = 23) { for (let i = 0; i < n; i++) { H.advance(ms); H.hostFrame(); g.tick(); } }
function jog(n) { for (let i = 0; i < Math.abs(n); i++) cc(C.MoveMainKnob, n > 0 ? 1 : 127); tick(); }
function press(n) { H.printed.length = 0; cc(n, 127); cc(n, 0); tick(); }
const click = () => press(C.MoveMainButton);
const back = () => press(C.MoveBack);
/* Every row label of the menu on screen: scroll through it, then back up. */
function menuText() {
    const seen = new Set();
    jog(-30);
    for (let i = 0; i < 20; i++) { H.printed.length = 0; jog(1); H.printed.forEach(t => seen.add(t)); }
    jog(-30);
    return [...seen].join("|");
}
const saved = () => JSON.parse(H.files.get(PATH));

g.init();
tick(3);
jog(-8); click();             /* Song Bank */
jog(1); click();              /* Var */
press(C.MoveRow2);            /* Inst 1 */
press(C.MoveMenu);            /* Instrument Settings */

let t = menuText();
check(/Pattern/.test(t) && /Approach/.test(t), "Bass: Pattern and Approach: " + t);
check(!/Strum/.test(t) && !/Inversion/.test(t), "Bass: no Strum, no Inversion");
check(/Vel Follow/.test(t) && /Chance/.test(t) && /100%/.test(t), "Vel Follow and Chance (100%) for any voicing");

/* Voicing (row 3): Bass -> Chord. */
jog(3); click(); jog(1); click();
t = menuText();
check(/Chord/.test(t) && /Strum/.test(t) && /Strum Dir/.test(t) && /Inversion/.test(t), "Chord: Strum, Strum Dir, Inversion: " + t);
check(!/Pattern/.test(t) && !/Approach/.test(t), "Chord: no Pattern or Approach");

/* Strum: row 5 for Chord (Enabled Octave Follow Voicing Inversion Strum). */
jog(5); click(); jog(6); click();
t = menuText();
check(/30ms/.test(t), "Strum turns in 5 ms steps: " + t);

/* Voicing -> Arp; Pattern (row 4) up to Random. */
jog(3); click(); jog(1); click();
t = menuText();
check(/Arp/.test(t) && /Pattern/.test(t) && /Up/.test(t), "Arp: a Pattern, Up by default: " + t);
check(!/Strum/.test(t) && !/Approach/.test(t), "Arp: no Strum or Approach");
jog(4); click(); jog(3); click();
/* Vel Follow toggles on a click; Chance (the last row) down to 50%. */
jog(30); jog(-1); click();    /* Vel Follow */
jog(1); click(); jog(-10); click();
t = menuText();
check(/Random/.test(t) && /50%/.test(t), "Random arp, Chance 50%: " + t);
check(!/Rate/.test(t), "Arp following the kick: no Rate (the hits are its rhythm)");
/* Follow Note (row 2) down to Off: the Arp runs at its Rate, 1/8 by default. */
jog(2); click(); jog(-40); click();
t = menuText();
check(/Rate/.test(t) && /1\/8/.test(t), "Follow Note Off: a Rate row, 1/8: " + t);
/* Rate (row 5, after Pattern) up two: 1/8T, 1/16. */
jog(5); click(); jog(2); click();
t = menuText();
check(/1\/16/.test(t), "Rate 1/16: " + t);

back(); back();               /* out of the menu, out of the song: saved */
const inst = saved().instruments[0];
check(inst.voicing === "arp" && inst.pattern === 3 && inst.strum === 30 && inst.vel_follow === true && inst.chance === 50 &&
      inst.follow_note === 0 && inst.arp_rate === 4,
      "saved: Arp, Random, Strum 30, Vel Follow, 50%, Follow Off, Rate 1/16: " + JSON.stringify(inst));

/* ---- An item: Pattern Up-Down and Chance 50% from bar 2 ---- */
jog(1); click();              /* Var again */
press(C.MoveRow2);
jog(5); click();              /* + Add: a new item */
/* Bar Beat Sound Octave Follow Voicing Pattern(6) Rate Inversion Gap Velocity VelFollow Chance(12) */
jog(6); click(); jog(3); click();
jog(6); click(); jog(10); click();
back(); back();
const items = (saved().sections[0].inst || [])[0] || [];
check(items.length === 1 && items[0].pattern === 2 && items[0].chance === 50,
      "the item's Pattern (Up-Down) and Chance are saved: " + JSON.stringify(items));

console.log(`${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
