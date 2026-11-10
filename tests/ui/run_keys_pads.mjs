/* Pads and Keys through the real src/ui.js.
 *
 * Pads: on Track 4 in Song Builder, and Track 4 turns them on or off in
 * Perform (the click is Shift + Track 4 there); their settings and items show only what a
 * chord on the chord grid uses; the engine gets them as a third chord
 * instrument on their own route.
 *
 * Keys: Capture in Perform or Jam turns the pads into a keyboard -- the
 * engine gets the route, layout, key and octave and plays the pads itself;
 * here, the pads light as keys, a held note lights green on every pad that
 * plays it, Up/Down change
 * octave, and Keys end with Capture again or on leaving the screen. */
import * as H from './host_mock.mjs';

const SONGS = "/data/UserData/UserLibrary/Arranger/Songs";
const SETLISTS = "/data/UserData/UserLibrary/Arranger/Setlists";
const PATH = SONGS + "/p.json";
H.files.set(PATH, JSON.stringify({ name: "P", key: "D", tempo_bpm: 120, time_sig_num: 4, time_sig_den: 4,
    sections: [{ name: "Verse", clips: [{ source: "Grooves/beat.mid", name: "beat", start_bar: 0, end_bar: 2 }],
                 chords: [{ root: "D", quality: "maj" }] }] }));
H.files.set(SETLISTS + "/gig.json", JSON.stringify({ id: "s1", name: "Gig", knobs: [],
    songs: [{ id: "e1", name: "P", path: PATH, click_bars: 0 }] }));
const songList = [{ name: "P", path: PATH }];
globalThis.host_module_get_param = (k) => {
    if (k === "songs_json") return JSON.stringify({ count: songList.length, start: 0, items: songList });
    return null;
};

const M = await import('./ui_test.mjs');
const C = await import('./shared/constants.mjs');
const g = globalThis;
let failures = 0, passes = 0;
function check(cond, msg) { if (cond) passes++; else { failures++; console.log("FAIL: " + msg); } }
function cc(n, v) { g.onMidiMessageInternal([0xB0, n, v]); }
function tick(n = 1, ms = 23) { for (let i = 0; i < n; i++) { H.advance(ms); H.hostFrame(); g.tick(); } }
function jog(n) { for (let i = 0; i < Math.abs(n); i++) cc(C.MoveMainKnob, n > 0 ? 1 : 127); tick(); }
function press(n) { H.printed.length = 0; cc(n, 127); cc(n, 0); tick(2); }
const click = () => press(C.MoveMainButton);
const back = () => press(C.MoveBack);
const has = (pair) => M.footerHints().some(p => p[0] === pair[0] && p[1] === pair[1]);
const saved = () => JSON.parse(H.files.get(PATH));
const lastSet = (k) => { for (let i = H.dspSets.length - 1; i >= 0; i--) if (H.dspSets[i][0] === k) return H.dspSets[i][1]; return null; };
function menuText() {
    const seen = new Set();
    jog(-30);
    for (let i = 0; i < 20; i++) { H.printed.length = 0; jog(1); H.printed.forEach(t => seen.add(t)); }
    jog(-30);
    return [...seen].join("|");
}

g.init();
tick(3);

/* ---- Pads in Song Builder ---- */
jog(-8); click();              /* Song Bank */
jog(1); click();               /* P */
check(has(["T1", "CHORD"]), "Drum track: Track 1 goes to Chord");
press(C.MoveRow1);
check(has(["T1", "DRUM"]), "Chord track: Track 1 back to Drum (Pads are not on Track 1)");
press(C.MoveRow4);
check(has(["T4", "CLICK"]), "Track 4: the Pads track, Click next: " + JSON.stringify(M.footerHints()));
tick(12);
check(H.buttonLeds.get(C.MoveRow4) === 88, "Track 4 very dark teal: Pads off (" + H.buttonLeds.get(C.MoveRow4) + ")");
press(C.MoveMenu);             /* Pads settings: Enabled on (a click on its row) */
click();
let t = menuText();
check(/Octave/.test(t) && /Inversion/.test(t) && /Strum/.test(t) && /Velocity/.test(t) && /Chance/.test(t),
      "Pads settings: Octave, Inversion, Strum, Velocity, Chance: " + t);
check(!/Voicing/.test(t) && !/Follow Note/.test(t) && !/Pattern/.test(t) && !/Approach/.test(t) && !/Vel Follow/.test(t),
      "...and nothing a chord on the chord grid doesn't use");
back();
tick(12);
check(H.buttonLeds.get(C.MoveRow4) === 12, "Pads on (Enabled in its settings): Track 4 teal (" + H.buttonLeds.get(C.MoveRow4) + ")");
jog(5); click();               /* + Add: an item */
t = menuText();
check(/Sound/.test(t) && /Inversion/.test(t) && !/Voicing/.test(t) && !/Follow Note/.test(t),
      "a Pads item: Sound, Inversion..., no Voicing or Follow Note: " + t);
back();                        /* commits the item */
back();                        /* out of the song: saved */
let song = saved();
check(song.instruments[2] && song.instruments[2].enabled === true && song.instruments[2].voicing === "chord",
      "saved: Pads on, a chord: " + JSON.stringify(song.instruments[2]));
check(Array.isArray(song.sections[0].inst) && (song.sections[0].inst[2] || []).length === 1,
      "the Pads item is saved as the section's third instrument: " + JSON.stringify(song.sections[0].inst));
const eng = JSON.parse(M.toEngineSongJson(Object.assign({ source_folder: "F" }, song)));
const p3 = eng.instruments[2];
check(p3 && p3.voicing === "chord" && p3.follow_note === 0 && p3.enabled === true && p3.output === "schwung" && p3.channel === 4,
      "the engine gets Pads as a third chord instrument on its route: " + JSON.stringify(p3));

/* ---- the Click: on Track 4 again, on/off in its Click Settings ---- */
jog(1); click();               /* P again */
press(C.MoveRow4); if (!has(["T4", "PADS"])) press(C.MoveRow4);
check(has(["T4", "PADS"]), "the Click track on Track 4: " + JSON.stringify(M.footerHints()));
press(C.MoveMenu);             /* Click Settings */
t = menuText();
check(/Enabled/.test(t) && /Off/.test(t), "Click Settings: Enabled, Off: " + t);
jog(-30); click();             /* the first row: Enabled */
t = menuText();
check(H.dspSets.some(x => x[0] === "click_enabled" && x[1] === "1"), "Enabled: click on");
back(); back();

/* ---- Keys in Perform ---- */
jog(-8); back();               /* Song Bank -> root */
jog(-8); jog(2); click();      /* Perform */
click();                       /* Gig */
tick(5);
check(H.buttonLeds.get(C.MoveCapture) === C.WhiteLedDim, "Perform: Capture lit dim (Keys available)");
H.dspSets.length = 0;
press(C.MoveCapture);
check(lastSet("keys_on") === "1", "Capture: Keys on");
check(lastSet("keys_root") === "2" && lastSet("keys_octave") === "3" && lastSet("keys_layout") === "0" &&
      lastSet("keys_output") === "schwung" && lastSet("keys_channel") === "1",
      "the engine gets the song's key (D), octave 3, In Key 4ths, Schwung 1: " + JSON.stringify(H.dspSets));
tick(3);
check(H.buttonLeds.get(C.MoveCapture) === 127, "Capture bright (full white) while Keys are on: " + H.buttonLeds.get(C.MoveCapture));
check(H.padLeds.get(C.MovePads[0]) === C.AzureBlue && H.padLeds.get(C.MovePads[7]) === C.AzureBlue &&
      H.padLeds.get(C.MovePads[1]) === C.White, "the pads light as keys: D (root) blue, E white, D an octave up blue");
g.onMidiMessageInternal([0x90, C.MovePads[1], 100]); tick();
check(H.padLeds.get(C.MovePads[1]) === 126, "a held key lights green");
g.onMidiMessageInternal([0x80, C.MovePads[1], 0]); tick();
check(H.padLeds.get(C.MovePads[1]) === C.White, "released, it goes back");
/* In Key 4ths: a row up is three scale steps on, so G is both pad 3 and
 * pad 8 (the row above's first pad). Holding either lights both. */
check(M.keysPadNote(0, 0, 2, 3, 3) === M.keysPadNote(0, 0, 2, 3, 8), "pads 3 and 8 play the same note");
g.onMidiMessageInternal([0x90, C.MovePads[3], 100]); tick();
check(H.padLeds.get(C.MovePads[3]) === 126 && H.padLeds.get(C.MovePads[8]) === 126,
      "a held key lights every pad with its note: " + H.padLeds.get(C.MovePads[3]) + "/" + H.padLeds.get(C.MovePads[8]));
check(H.padLeds.get(C.MovePads[1]) === C.White, "...and no other");
g.onMidiMessageInternal([0x90, C.MovePads[8], 100]); tick();
g.onMidiMessageInternal([0x80, C.MovePads[3], 0]); tick();
check(H.padLeds.get(C.MovePads[3]) === 126 && H.padLeds.get(C.MovePads[8]) === 126,
      "with the note still held on pad 8, both stay green");
g.onMidiMessageInternal([0x80, C.MovePads[8], 0]); tick();
check(H.padLeds.get(C.MovePads[3]) === C.White && H.padLeds.get(C.MovePads[8]) === C.White,
      "all released: both go back (" + H.padLeds.get(C.MovePads[3]) + "/" + H.padLeds.get(C.MovePads[8]) + ")");
press(C.MoveUp);
check(lastSet("keys_octave") === "4", "Up: octave 4");
press(C.MoveDown); press(C.MoveDown);
check(lastSet("keys_octave") === "2", "Down twice: octave 2");
press(C.MoveCapture);
check(lastSet("keys_on") === "0", "Capture again: Keys off");
tick(3);
check(H.padLeds.get(C.MovePads[0]) !== C.AzureBlue || H.padLeds.get(C.MovePads[1]) !== C.White,
      "the pads are the sections again");
press(C.MoveCapture);
check(lastSet("keys_octave") === "3", "Keys start again at the Options octave (3)");
back();                        /* leave Perform with Keys on */
tick(2);
check(lastSet("keys_on") === "0", "leaving Perform ends Keys");

/* ---- Pads live in Perform: Track 4 (the click is Shift + Track 4) ---- */
jog(-8); jog(2); click(); click(); tick(5);
check(H.buttonLeds.get(C.MoveRow4) === 12, "Perform: Track 4 teal, the song's Pads on (" + H.buttonLeds.get(C.MoveRow4) + ")");
H.dspSets.length = 0;
press(C.MoveRow4); tick(5);
check(lastSet("inst3_enabled") === "0" && lastSet("drum_enabled") === null && lastSet("click_enabled") === null,
      "Track 4 in Perform: Pads off, drums and click untouched");
check(!H.buttonLeds.get(C.MoveRow4), "...Track 4 dark (" + H.buttonLeds.get(C.MoveRow4) + ")");
press(C.MoveRow4); tick(5);
check(lastSet("inst3_enabled") === "1", "Track 4 again: Pads on");
H.dspSets.length = 0;
cc(C.MoveShift, 127); tick(5);
check(H.buttonLeds.get(C.MoveRow4) === 3 || !H.buttonLeds.get(C.MoveRow4),
      "Shift held: Track 4 shows the click (" + H.buttonLeds.get(C.MoveRow4) + ")");
press(C.MoveRow4); tick(5);
const clickNow = lastSet("click_enabled");
check(clickNow !== null && lastSet("inst3_enabled") === null, "Shift + Track 4: the click (" + clickNow + "), Pads untouched");
check(H.buttonLeds.get(C.MoveRow4) === (clickNow === "1" ? 3 : 0) || (clickNow === "0" && !H.buttonLeds.get(C.MoveRow4)),
      "...lit as the click (" + H.buttonLeds.get(C.MoveRow4) + ")");
cc(C.MoveShift, 0); tick(5);
check(H.buttonLeds.get(C.MoveRow4) === 12, "Shift released: Track 4 teal again (" + H.buttonLeds.get(C.MoveRow4) + ")");
back();

/* ---- Pads in Jam, on Track 4 (the click was there) ---- */
H.files.set("/data/UserData/UserLibrary/Arranger/MidiLibrary/.placeholder", "");
/* ---- the layouts match the engine's ---- */
check(M.keysPadNote(0, 0, 2, 3, 0) === 50 && M.keysPadNote(0, 0, 2, 3, 8) === 55 && M.keysPadNote(0, 0, 2, 3, 16) === 61,
      "In Key 4ths in D: D3, G3 a row up, C#4 two up");
check(M.keysPadNote(3, 0, 2, 3, 9) === 56 && M.keysPadNote(5, 0, 0, 3, 8) === 56 && M.keysPadNote(1, 0, 0, 3, 8) === 52,
      "Chromatic 4ths, Chromatic Seq and In Key 3rds");
check(M.keysPadNote(0, 5, 9, 3, 5) === 69, "Min Pent wraps by its own length (A3 up five steps: A4)");

/* ---- Options > Keys ---- */
jog(-8); jog(4); click();      /* Options */
jog(5); click();               /* Keys (Drums Inst1 Inst2 Pads Click Keys) */
t = menuText();
check(/Layout/.test(t) && /In Key 4ths/.test(t) && /Scale/.test(t) && /Major/.test(t), "Options > Keys: Layout, Scale: " + t);
jog(2); click(); jog(3); click();   /* Layout -> Chrom 4ths */
const cfgRaw = [...H.files.entries()].filter(([k]) => /config\.json$|settings\.json$/.test(k)).map(([, v]) => v);
check(cfgRaw.some(v => { try { return JSON.parse(v).keys_layout === 3; } catch (e) { return false; } }),
      "saved: keys_layout 3");

console.log(`${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
