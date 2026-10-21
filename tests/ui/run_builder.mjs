/* Song Builder through the real src/ui.js (see run.mjs for the harness):
 * the footer names only what works on the selected row (Name on a section
 * row, Add on "+ Add", Menu where the click does nothing, nothing that a
 * locked song refuses), the Inst/Click tracks' "+ Add" needs a chord,
 * Track 2/3 turn an instrument on or off on its own track, and Copy
 * duplicates a setlist. */
import * as H from './host_mock.mjs';

const SONGS = "/data/UserData/UserLibrary/Arranger/Songs";
const SETLISTS = "/data/UserData/UserLibrary/Arranger/Setlists";
const song = (name, extra) => JSON.stringify(Object.assign({ name, tempo_bpm: 120, time_sig_num: 4, time_sig_den: 4,
    sections: [{ name: "Verse", clips: [{ source: "Grooves/beat.mid", name: "beat", start_bar: 0, end_bar: 2 }] }] }, extra || {}));
H.files.set(SONGS + "/plain.json", song("Plain"));
H.files.set(SONGS + "/locked.json", song("Locked", { locked: true }));
const sec = (name, bars, chords) => ({ name, clips: [{ source: "Grooves/beat.mid", name: "beat", start_bar: 0, end_bar: bars }], chords });
H.files.set(SONGS + "/chorded.json", song("Chorded", { sections: [
    { name: "A", clips: [1, 2, 3].map(n => ({ source: "Grooves/g" + n + ".mid", name: "g" + n, start_bar: 0, end_bar: 2 })),
      chords: [{ root: "C", quality: "maj" }] },
    { name: "B", clips: [1, 2].map(n => ({ source: "Grooves/g" + n + ".mid", name: "g" + n, start_bar: 0, end_bar: 1 })) }] }));
H.files.set(SONGS + "/multi.json", song("Multi", { sections: [
    sec("Chorus", 2, [{ root: "C", quality: "maj" }, { root: "G", quality: "maj" }]),
    sec("Verse", 2, [{ root: "A", quality: "min" }]),
    sec("Chorus 2", 1, [{ root: "F", quality: "maj" }])] }));
H.files.set(SETLISTS + "/gig.json", JSON.stringify({ id: "s1", name: "Gig", songs: [
    { id: "e1", name: "Plain", path: SONGS + "/plain.json", click_bars: 2 }], knobs: [] }));
/* The DSP's song list. */
const songList = [{ name: "Locked", path: SONGS + "/locked.json" }, { name: "Plain", path: SONGS + "/plain.json" },
                  { name: "Multi", path: SONGS + "/multi.json" }, { name: "Chorded", path: SONGS + "/chorded.json" },
                  { name: "Kit", path: SONGS + "/kit.json" }];
H.files.set(SONGS + "/kit.json", JSON.stringify({ name: "Kit", tempo_bpm: 120, time_sig_num: 4, time_sig_den: 4,
    source_folder: "VD/08 Indie/11 Disco",
    sections: [{ name: "Bridge", clips: [{ source: "10 Fill 3.mid", name: "10 Fill 3", start_bar: 0, end_bar: 1 }] }] }));
/* Two kits with a clip of the same name; the song's kit is the SECOND. */
const kits = [{ name: "03 Rumba", category: "VD/05 Latin" }, { name: "11 Disco", category: "VD/08 Indie" }];
globalThis.host_module_get_param = (k) => {
    if (k === "songs_json") return JSON.stringify({ count: songList.length, start: 0, items: songList });
    if (k === "folders_json") return JSON.stringify({ count: kits.length, start: 0, items: kits });
    if (/^folder_clips_json_[01]$/.test(k)) return JSON.stringify(["10 Fill 3.mid"]);
    return null;
};

const M = await import('./ui_test.mjs');
const g0 = globalThis;
const g = g0;
const C = await import('./shared/constants.mjs');
let failures = 0, passes = 0;
function check(cond, msg) { if (cond) passes++; else { failures++; console.log("FAIL: " + msg); } }
function cc(n, v) { g.onMidiMessageInternal([0xB0, n, v]); }
function tick(n = 1, ms = 23) { for (let i = 0; i < n; i++) { H.advance(ms); H.hostFrame(); g.tick(); } }
function jog(n) { for (let i = 0; i < Math.abs(n); i++) cc(C.MoveMainKnob, n > 0 ? 1 : 127); tick(); }
function press(n) { H.printed.length = 0; cc(n, 127); cc(n, 0); tick(); }
const click = () => press(C.MoveMainButton);
const back = () => press(C.MoveBack);
function root(row) { jog(-8); jog(row); }
const hints = () => JSON.stringify(M.footerHints());
const has = (pair) => M.footerHints().some(p => p[0] === pair[0] && p[1] === pair[1]);
const clk = () => { const p = M.footerHints().find(p => p[0] === "CLK"); return p ? p[1] : null; };
/* Track 1 steps Drum -> Chord -> Pads; each one's footer names the next. */
function goTrack(want) {
    const next = want === "chord" ? "PADS" : want === "pads" ? "DRUM" : "CHORD";
    for (let i = 0; i < 4 && !has(["T1", next]); i++) press(C.MoveRow1);
}

g.init();
tick(3);

/* ---- an unlocked song with no chords ---- */
root(0); click();            /* Song Bank */
jog(2); click();             /* Plain (row 0 is + New Song) */
check(clk() === "TRIM" && has(["PAD", "ADD"]), "Drum track on a clip: CLK TRIM, PAD ADD: " + hints());
jog(-1);
check(clk() === "NAME", "Drum track on the section row: CLK NAME: " + hints());

press(C.MoveRow1);           /* Chord track; no chords: row 0 is + Add */
check(clk() === "ADD", "Chord track on + Add: CLK ADD: " + hints());
jog(-1);
check(clk() === "NAME", "Chord track on the section row: CLK NAME: " + hints());

press(C.MoveRow2);           /* Inst 1 */
check(H.printed.includes("(add chords first)") && !H.printed.includes("+ Add"),
      "no chords: Inst 1's + Add gives the reason instead: " + JSON.stringify(H.printed));
check(clk() === null && has(["MENU", "SET"]), "...and its footer offers Menu, not the click: " + hints());
click();
check(!H.printed.includes("Bar"), "the click opens no item page: " + JSON.stringify(H.printed));
press(C.MoveRow4);           /* Click track */
check(H.printed.includes("(add chords first)"), "the Click track's + Add too");

/* Track 2 on Inst 1 turns it on and off. */
press(C.MoveRow2);
check(has(["T2", "ON"]), "Inst 1 is off: T2 ON: " + hints());
press(C.MoveRow2);
check(has(["T2", "OFF"]), "Track 2 on its own track turns Inst 1 on: " + hints());
back();                       /* saves */
check(JSON.parse(H.files.get(SONGS + "/plain.json")).instruments[0].enabled === true, "...saved in the song");

/* ---- a locked song ---- */
jog(-1); click();             /* Locked */
const lockedDrum = M.footerHints();
check(clk() === null && !has(["PAD", "ADD"]) && has(["MENU", "SET"]),
      "locked, Drum track: no CLK or PAD ADD, Menu instead: " + hints());
press(C.MoveRow1);
check(clk() === null && has(["MENU", "SET"]), "locked, Chord track: Menu instead of the click: " + hints());
click();
check(!H.printed.some(t => /^Root/.test(t)), "locked: the click opens no chord page");
check(H.printed.some(t => /Song locked/.test(t)), "...and says the song is locked: " + JSON.stringify(H.printed));
/* Touching a knob or the jog (notes 0-9) is not an edit. */
tick(100);
H.printed.length = 0;
for (const n of [0, 3, 9]) { g.onMidiMessageInternal([0x90, n, 127]); tick(1); g.onMidiMessageInternal([0x80, n, 0]); tick(1); }
check(!H.printed.some(t => /Song locked/.test(t)), "locked: knob and jog touches say nothing: " + JSON.stringify(H.printed));
for (const [btn, name] of [[C.MoveDelete, "Delete"], [C.MoveCopy, "Copy"]]) {
    tick(100);                /* the last notice has gone */
    press(btn);
    check(H.printed.some(t => /Song locked/.test(t)), "locked: " + name + " says so at once: " + JSON.stringify(H.printed));
}
cc(C.MoveShift, 127); tick();
check(!has(["JOG", "MOVE"]), "locked: Shift offers no Jog Move: " + hints());
cc(C.MoveShift, 0); tick();
back();
/* Song Bank: Delete on the locked song says why it does nothing. */
tick(100);
jog(-8); jog(1);              /* Locked */
press(C.MoveDelete);
check(H.printed.some(t => /Song locked/.test(t)) && H.files.has(SONGS + "/locked.json"),
      "Song Bank: Delete on a locked song says it is locked, and deletes nothing: " + JSON.stringify(H.printed));
back();

/* ---- Copy duplicates a setlist ---- */
root(1); click();            /* Setlists */
jog(1);
press(C.MoveCopy);
const copy = H.files.get(SETLISTS + "/Gig_copy.json");
check(!!copy, "Copy writes Gig copy: " + [...H.files.keys()].filter(k => k.startsWith(SETLISTS)).join(", "));
const c = copy ? JSON.parse(copy) : {};
check(c.name === "Gig copy" && c.id !== "s1" && c.songs && c.songs.length === 1 && c.songs[0].click_bars === 2,
      "the copy has the songs and their settings, a new id: " + copy);
press(C.MoveCopy);
check(!!H.files.get(SETLISTS + "/Gig_copy_2.json") || !!H.files.get(SETLISTS + "/Gig_copy_copy.json"),
      "copying again makes another: " + [...H.files.keys()].filter(k => k.startsWith(SETLISTS)).join(", "));

back();                       /* to the root */

/* ---- renaming a section: the section names, or Custom for the keyboard ---- */
const TE = await import('./shared/text_entry.mjs');
root(0); click(); jog(-8); jog(3); click();   /* Multi, section 1 (Chorus) */
jog(-1); click();             /* the section row */
check(H.printed.includes("Chorus") && !H.printed.includes("Custom..."),
      "rename opens at the section's own name: " + JSON.stringify(H.printed));
H.printed.length = 0; jog(-20);
check(H.printed.includes("Custom...") && H.printed.includes("Intro"), "Custom first, then the names: " + JSON.stringify(H.printed));
jog(3); click();              /* Custom, Intro, Verse, Prechorus */
check(!TE.isTextEntryActive(), "a name from the list needs no keyboard");
back();                       /* saves */
let multi = JSON.parse(H.files.get(SONGS + "/multi.json"));
check(multi.sections[0].name === "Prechorus", "renamed from the list: " + multi.sections.map(s => s.name));
jog(-8); jog(3); click();     /* Back went to the Song Bank: Multi again */
jog(-1); click(); jog(-20); click();          /* Custom... */
check(TE.isTextEntryActive(), "Custom opens the keyboard");
back(); tick(3);
check(!TE.isTextEntryActive(), "Back closes it");
back();                       /* to the Song Bank */

/* ---- Loop copies a track's section to its same-named sections ---- */
H.files.set(SONGS + "/multi.json", song("Multi", { sections: [
    sec("Chorus", 2, [{ root: "C", quality: "maj" }, { root: "G", quality: "maj" }]),
    sec("Verse", 2, [{ root: "A", quality: "min" }]),
    sec("Chorus 2", 1, [{ root: "F", quality: "maj" }])] }));
jog(-8); jog(3); click();
press(C.MoveRow1);            /* Chord track, section 1 (Chorus) */
press(C.MoveLoop);
/* Rows: the action, then Verse (-), Chorus 2 (Yes: same-named, ticked). */
const rowsSeen = H.printed.slice();
check(rowsSeen.includes("Copy to 1 section") && rowsSeen.includes("Chorus 2") && rowsSeen.includes("Verse"),
      "Loop lists the other sections, the same-named one ticked: " + JSON.stringify(rowsSeen));
check(rowsSeen[rowsSeen.indexOf("Chorus 2") + 1] === "Yes" && rowsSeen[rowsSeen.indexOf("Verse") + 1] === "-",
      "Chorus 2 ticked, Verse not: " + JSON.stringify(rowsSeen));
click();                      /* Copy to 1 section */
back();
multi = JSON.parse(H.files.get(SONGS + "/multi.json"));
const ch = (i) => JSON.stringify((multi.sections[i].chords || []).filter(Boolean).map(c => c.root));
check(ch(2) === '["C"]', "Chorus 2 (1 bar) gets the Chorus's first bar: " + ch(2));
check(ch(1) === '["A"]', "Verse is untouched: " + ch(1));

/* A differently named section can be ticked too. */
H.files.set(SONGS + "/multi.json", song("Multi", { sections: [
    sec("Chorus", 2, [{ root: "C", quality: "maj" }, { root: "G", quality: "maj" }]),
    sec("Verse", 2, [{ root: "A", quality: "min" }]),
    sec("Chorus 2", 1, [{ root: "F", quality: "maj" }])] }));
jog(-8); jog(3); click();
goTrack("chord");
press(C.MoveLoop);
jog(1); click();              /* tick Verse */
jog(1); click();              /* untick Chorus 2 */
H.printed.length = 0; jog(-8);
check(H.printed.includes("Copy to 1 section"), "ticking Verse and unticking Chorus 2: still 1: " + JSON.stringify(H.printed));
click();
back();
multi = JSON.parse(H.files.get(SONGS + "/multi.json"));
check(ch(1) === '["C","G"]' && ch(2) === '["F"]', "Verse gets the chords, Chorus 2 keeps its own: " + ch(1) + " " + ch(2));
/* Back leaves without copying. */
H.files.set(SONGS + "/multi.json", song("Multi", { sections: [
    sec("Chorus", 2, [{ root: "C", quality: "maj" }, { root: "G", quality: "maj" }]),
    sec("Verse", 2, [{ root: "A", quality: "min" }]),
    sec("Chorus 2", 1, [{ root: "F", quality: "maj" }])] }));
jog(-8); jog(3); click();
goTrack("chord");
press(C.MoveLoop); jog(1); click(); back(); back();
multi = JSON.parse(H.files.get(SONGS + "/multi.json"));
check(ch(1) === '["A"]' && ch(2) === '["F"]', "Back copies nothing: " + ch(1) + " " + ch(2));
const S = { sections: [sec("Chorus", 2, []), sec("chorus 3", 1, []), sec("Bridge", 1, [])] };
check(JSON.stringify(M.sameNamedSections(S, 0)) === "[1]", "same-named ignores case and the number");

/* ---- deleting a drum clip in a section with chords leaves a placeholder ---- */
jog(-8); jog(4); click();     /* Chorded, section A */
goTrack("drum");
jog(-8); jog(2);              /* clip 2 */
press(C.MoveDelete);
check(H.printed.includes("(empty)") && H.printed.includes("g3"), "Delete leaves (empty) in its place: " + JSON.stringify(H.printed));
check(has(["PAD", "FILL"]) && clk() === null, "on it, pads fill it and the click has nothing to trim: " + hints());
press(C.MoveDelete);
check(!H.printed.includes("(empty)") && H.printed.includes("g3"), "Delete on the placeholder removes it: " + JSON.stringify(H.printed));
press(C.MoveRight);           /* section B: no chords */
jog(1); press(C.MoveDelete);
check(!H.printed.includes("(empty)"), "without chords or items, Delete removes the clip as before: " + JSON.stringify(H.printed));
back();
let chorded = JSON.parse(H.files.get(SONGS + "/chorded.json"));
check(chorded.sections[0].clips.length === 2 && chorded.sections[1].clips.length === 1, "saved: " +
      chorded.sections.map(s => s.clips.length));

/* The engine gets a silent file at least as long as the placeholder. */
const OS = await import('./os_mock.mjs');
OS.captureWrites(true);
const ph = { placeholder: true, source: "", name: "(empty)", start_bar: 0, end_bar: 2 };
const engOut = M.toEngineSongJson({ name: "P", time_sig_num: 4, time_sig_den: 4, source_folder: "F",
    sections: [{ name: "A", clips: [ph], chords: [] }] });
const eng = typeof engOut === "string" ? JSON.parse(engOut) : engOut;
const c0 = eng.sections[0].clips[0];
check(/\/\.placeholders\/silence_3_4-4\.mid$/.test(c0.source) && c0.end_bar === 2 && !c0.source_folder,
      "a placeholder is sent as the silent file, keeping its bars: " + JSON.stringify(c0));
const bytes = OS.written.get(c0.source) || [];
/* MThd(14) MTrk(8), then a note-off at 3 bars * 960 = 2880 (VLQ 0x96 0x40), end of track. */
check(JSON.stringify(bytes.slice(22)) === JSON.stringify([0x96, 0x40, 0x80, 0, 0, 0, 0xFF, 0x2F, 0]) && bytes[13] === 240,
      "the silent file: one note-off on its last tick, division 240: " + JSON.stringify(bytes));
OS.captureWrites(false);
check(M.toUiSong({ name: "P", sections: [{ name: "A", clips: [ph] }] }).sections[0].clips[0].placeholder === true,
      "a placeholder survives loading");

/* ---- a clip added from a pad comes from the folder the pads show ---- */
jog(-8); jog(5); click();     /* Kit (folder 11 Disco, the library's 2nd) */
goTrack("drum");
const pads = (await import('./shared/constants.mjs')).MovePads;
for (let p = 0; p < 32; p++) {   /* the first pad with a clip: tap it */
    g.onMidiMessageInternal([0x90, pads[p], 100]); tick(1);
    g.onMidiMessageInternal([0x80, pads[p], 0]); tick(1);
}
back();
const kit = JSON.parse(H.files.get(SONGS + "/kit.json"));
const added = kit.sections[0].clips.slice(1);
check(added.length > 0, "a pad added a clip: " + JSON.stringify(kit.sections[0].clips.map(c => c.source)));
check(added.every(c => !c.source_folder || c.source_folder === "VD/08 Indie/11 Disco"),
      "it comes from the song's own kit, not Rumba's same-named clip: " + JSON.stringify(added.map(c => c.source_folder || "(song's)")));
check(!kit.sections[0].clips[0].source_folder, "the original clip still has the song's folder");

/* ---- Follow Note: with Bass voicing, up from Off jumps to the kick ---- */
check(M.stepFollowNote(0, 1, true) === 36 && M.stepFollowNote(0, 1, false) === 1, "Off +1: 36 for Bass, 1 for Chord");
check(M.stepFollowNote(36, -1, true) === 35 && M.stepFollowNote(0, 3, true) === 38, "steps normally from there");

console.log(`${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
