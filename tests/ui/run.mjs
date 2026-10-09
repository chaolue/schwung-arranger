/* Chain view (Schwung co-run) behaviour, driven through the real src/ui.js.
 *
 * scripts/test.sh copies ui.js next to this file with its imports pointed at a
 * Schwung checkout's src/shared, so the shared modules are the real ones and
 * only the host is mocked (host_mock.mjs). The mock follows upstream
 * shadow_ui.c / shadow_ui.js, including the one ordering fact the design
 * leans on: shadow_ui re-primes the chain editor at the top of its frame when
 * a session's slot changes, which clobbers an overlay opened too early. A
 * model is not the device -- this pins the logic, not the hardware. */
import * as H from './host_mock.mjs';
await import('./ui_test.mjs');
const g = globalThis;
let failures = 0, passes = 0;
function check(cond, msg) { if (cond) passes++; else { failures++; console.log("FAIL: " + msg); } }
function cc(n, v) { g.onMidiMessageInternal([0xB0, n, v]); }
function note(n, v) { g.onMidiMessageInternal([v ? 0x90 : 0x80, n, v]); }
function tick(n = 1, ms = 23) { for (let i = 0; i < n; i++) { H.advance(ms); H.hostFrame(); g.tick(); } }
function hold(ccNum, ms = 600) { cc(ccNum, 127); tick(Math.ceil(ms / 23)); cc(ccNum, 0); tick(); }
function tap(ccNum) { cc(ccNum, 127); tick(2); cc(ccNum, 0); tick(); }
const TR1 = 43, TR2 = 42, TR3 = 41, TR4 = 40, MENU = 50, BACK = 51, JOG = 14, CLICK = 3, SHIFT = 49;
const SURFACE = g.CORUN_GRP_OLED | g.CORUN_GRP_KNOBS | g.CORUN_GRP_JOG | g.CORUN_GRP_TOUCH | g.CORUN_GRP_BACK;

g.init();
tick(5);

/* 1. Hold Track 2 opens chain 2 in co-run, ceding the editor surface, OWN_BACK. */
H.log.length = 0;
hold(TR2);
const b = H.log.find(e => e[0] === "begin_cede");
check(b && b[1] === 1 && b[2] === 1 && b[3] === SURFACE && b[4] === g.CORUN_F_OWN_BACK,
      "hold Track 2 -> begin_cede(CHAIN_EDIT, 1, surface, OWN_BACK): " + JSON.stringify(b));
check(H.corun.target === 1 && H.corun.id === 1, "session up on chain 2");
check((H.corun.keep & g.CORUN_GRP_PADS) && (H.corun.keep & g.CORUN_GRP_TRACK_BUTTONS) &&
      (H.corun.keep & g.CORUN_GRP_MENU) && !(H.corun.keep & g.CORUN_GRP_JOG),
      "Arranger keeps pads/track/menu, cedes jog");

/* 2. The release of the hold did not replay a tap; ceded edges never reach Arranger. */
const before = H.dspSets.length;
cc(CLICK, 0); cc(BACK, 0); note(3, 0); note(3, 127); cc(JOG, 1); cc(72, 1);
check(H.dspSets.length === before, "ceded edges swallowed during a chain view");
/* Jog turns and clicks under the editor must not move Arranger's root menu:
 * after closing, a click on the root's first row opens the Folder List. */
for (let i = 0; i < 6; i++) { cc(JOG, 1); cc(CLICK, 127); cc(CLICK, 0); }
tick();

/* 3. Holding the same Track again closes; Arranger repaints. */
H.log.length = 0;
hold(TR2);
check(H.log.some(e => e[0] === "end") && H.corun.target === 0, "hold Track 2 again closes the view");

/* 4. Host-driven exit (Back at the editor's top) is noticed. */
hold(TR1);
check(H.corun.target === 1 && H.corun.id === 0, "chain 1 open");
H.hostEnd(); tick();
H.log.length = 0;
hold(TR1);
check(H.log.some(e => e[0] === "begin_cede" && e[2] === 0), "after a host exit, holding Track 1 opens again (state was reset)");

/* 5. Switching chains while one is open. */
H.log.length = 0;
hold(TR4);
check(H.corun.id === 3 && !H.log.some(e => e[0] === "end"), "hold Track 4 switches to chain 4 without ending");

/* 6. Menu tap under a chain view closes it. */
tap(MENU);
check(H.corun.target === 0, "Menu tap closes the chain view");

/* 7. Master FX from Arranger: session on lastChainSlot, overlay next tick. */
H.log.length = 0;
cc(MENU, 127); tick(Math.ceil(600 / 23));
const openIdx = H.log.findIndex(e => e[0] === "open");
const beginIdx = H.log.findIndex(e => e[0] === "begin_cede");
check(beginIdx >= 0 && openIdx > beginIdx, "Master FX: begin_cede then open: " + JSON.stringify(H.log));
check(H.corun.overlay === "master_fx" && H.corun.keep === SURFACE, "overlay keeps the editor surface");
tick(3);
check(H.ui.view === "master_fx", "shadow_ui still shows Master FX after priming (got " + H.ui.view + ")");
cc(MENU, 0); tick();
check(H.corun.overlay === "master_fx", "Menu release after the hold does not close it");

/* 8. Back at Master FX root (shadow_ui closes the overlay) -> back to Arranger. */
H.hostBackAtOverlayRoot(); tick();
check(H.corun.target === 0, "closing the overlay ends the session");

/* 9. Master FX -> hold the Track of the hosting chain: fresh session next tick. */
cc(MENU, 127); tick(30); cc(MENU, 0); tick();
check(H.corun.overlay === "master_fx", "Master FX up again");
const host = H.corun.id;
H.log.length = 0;
hold([TR1, TR2, TR3, TR4][host]);
tick(2);
check(H.corun.target === 1 && H.corun.id === host && H.corun.overlay === null &&
      H.log.some(e => e[0] === "end") && H.log.filter(e => e[0] === "begin_cede").length === 1,
      "MFX -> same chain re-opens via a fresh session: " + JSON.stringify(H.log));
tick(2);
check(H.ui.view === "chain_edit", "...and shadow_ui shows that chain's editor (got " + H.ui.view + ")");
/* ...and to another chain directly. */
cc(MENU, 127); tick(30); cc(MENU, 0); tick();
const other = (H.corun.id + 1) % 4;
H.log.length = 0;
hold([TR1, TR2, TR3, TR4][other]);
check(H.corun.id === other && H.corun.overlay === null && !H.log.some(e => e[0] === "end") &&
      H.log[0][0] === "close", "MFX -> other chain closes the overlay and re-targets");
tick(2);
check(H.ui.view === "chain_edit", "...and shadow_ui shows the other chain's editor (got " + H.ui.view + ")");
/* Holding Menu over the overlay toggles back out. */
cc(MENU, 127); tick(30); cc(MENU, 0); tick();
check(H.corun.overlay === "master_fx", "MFX opened over an existing chain view");
cc(MENU, 127); tick(30); cc(MENU, 0); tick();
check(H.corun.target === 0, "hold Menu again closes Master FX");

/* 10. No co-run API: a notice, no throw, no stuck state. */
H.setApi(false);
H.printed.length = 0;
hold(TR1);
check(H.corun.target === 0, "no API: nothing opens");
check(H.printed.includes("Needs newer Schwung"), "no API: the notice is drawn");
tick(Math.ceil(3100 / 23));
H.printed.length = 0;
tick(Math.ceil(400 / 23));   /* the root menu marquee redraws at least this often */
check(H.printed.length > 0 && !H.printed.includes("Needs newer Schwung"), "the notice expires");
cc(MENU, 127); tick(30); cc(MENU, 0); tick();
H.setApi(true, false);
cc(MENU, 127); tick(30); cc(MENU, 0); tick();
check(H.corun.target === 0, "no master_fx entry: no session left behind");
H.setApi(true, true);

/* 11. Taps still reach Arranger's views (replayed on release). Options > Chains. */
// Navigate root -> Options: root list index 4 (see handleRootInput).
for (let i = 0; i < 4; i++) { g.onMidiMessageInternal([0xB0, JOG, 1]); }
tick();
cc(CLICK, 127); cc(CLICK, 0); tick();
// Options list: Drums, Inst 1, Inst 2, Click, Chains -> Chains is row 4.
for (let i = 0; i < 4; i++) g.onMidiMessageInternal([0xB0, JOG, 1]);
tick();
H.paramLog.length = 0;
cc(CLICK, 127); cc(CLICK, 0); tick();
check(H.paramLog.some(e => e[0] === "get" && e[2] === "slot:receive_channel"), "Chains screen reads the receive channel: " + JSON.stringify(H.paramLog));
// Row 1 (MIDI Channel): move down, enter edit, turn +2.
g.onMidiMessageInternal([0xB0, JOG, 1]); tick();
cc(CLICK, 127); cc(CLICK, 0); tick();
g.onMidiMessageInternal([0xB0, JOG, 1]); g.onMidiMessageInternal([0xB0, JOG, 1]); tick();
check(H.slots[0].recv === 3, "chain 1 receive channel 1 -> 3 (got " + H.slots[0].recv + ")");
check(H.paramLog.some(e => e[0] === "set" && e[3] === "2" && e[4] === 200), "blocking write used");
g.onMidiMessageInternal([0xB0, JOG, 127]); g.onMidiMessageInternal([0xB0, JOG, 127]);
g.onMidiMessageInternal([0xB0, JOG, 127]); g.onMidiMessageInternal([0xB0, JOG, 127]); tick();
check(H.slots[0].recv === 0, "clamps at 0 = All (got " + H.slots[0].recv + ")");
cc(BACK, 127); cc(BACK, 0); tick();  // leave edit mode (Back tap replays on release)
// Row 2 Edit Chain opens chain 1 in co-run.
g.onMidiMessageInternal([0xB0, JOG, 1]); tick();
H.log.length = 0;
cc(CLICK, 127); cc(CLICK, 0); tick();
check(H.corun.target === 1 && H.corun.id === 0, "Edit Chain opens chain 1");
// Change channel "in the editor", exit via host -> screen re-reads.
H.slots[0].recv = 9; H.paramLog.length = 0;
H.hostEnd(); tick();
check(H.paramLog.some(e => e[2] === "slot:receive_channel"), "closing the view re-reads the chain");
// Failed reads show as unknown and are not editable.
H.setParamFails(true);
g.onMidiMessageInternal([0xB0, JOG, 127]); tick(); // to row 1
cc(CLICK, 127); cc(CLICK, 0); tick(); // retry read (fails)
g.onMidiMessageInternal([0xB0, JOG, 1]); tick();
H.setParamFails(false);
check(H.slots[0].recv === 9, "a failed read never turns into a write");

/* 12. Shift+Track acts on press and never opens a chain. */
cc(SHIFT, 127); H.log.length = 0;
cc(TR3, 127); tick(30); cc(TR3, 0); tick();
cc(SHIFT, 0); tick();
check(!H.log.some(e => e[0] === "begin_cede"), "Shift+Track never opens a chain");

/* 13. A Track pressed, Shift pressed mid-hold, then released: hold resolves, nothing stuck. */
cc(TR2, 127); tick(2); cc(SHIFT, 127); cc(TR2, 0); cc(SHIFT, 0); H.log.length = 0; tick(40);
check(!H.log.some(e => e[0] === "begin_cede"), "released hold never fires late");

/* 14. Back-hold suspend still works outside a chain view. */
H.suspends.length = 0;
hold(BACK);
check(H.suspends.length === 1, "Back hold still suspends");

/* 14b. Knob lights: Schwung's editor lights them during a chain view;
 * Arranger leaves them alone then, and turns them off when it is back --
 * even if the editor draws one more frame after the session ends. */
{
    const { setButtonLED } = await import('./shared/input_filter.mjs');
    tick(3);
    check(H.knobLeds.every(c => c === 0), "Arranger keeps the knob lights off: " + JSON.stringify(H.knobLeds));
    hold(TR2);
    for (let k = 0; k < 8; k++) setButtonLED(71 + k, 120, true);   /* the param grid */
    tick(5);
    check(H.knobLeds.every(c => c === 120), "untouched while the chain view is up: " + JSON.stringify(H.knobLeds));
    H.hostEnd(); tick();
    setButtonLED(73, 120, true);                                    /* a last editor frame */
    tick(15);                                                       /* the full repaint drains at 8 LEDs a tick */
    check(H.knobLeds.every(c => c === 0), "all off again after the chain view: " + JSON.stringify(H.knobLeds));
    setButtonLED(74, 33, true);                                     /* lit while suspended */
    g.onResume(); tick(15);
    check(H.knobLeds[3] === 0, "off again after a resume: " + H.knobLeds[3]);
}

/* 14c. Chains 5-8: under a chain view a Track TAP goes to its chain, and
 * again to the other of its pair (Track 1: Chain 1 <-> 5). Holding the
 * Track of either of the pair closes the view. */
hold(TR1);
check(H.corun.target === 1 && H.corun.id === 0, "hold Track 1: chain 1");
tap(TR1);
check(H.corun.target === 1 && H.corun.id === 4, "tap Track 1 again: chain 5 (" + H.corun.id + ")");
tap(TR1);
check(H.corun.id === 0, "and again: back to chain 1 (" + H.corun.id + ")");
tap(TR3);
check(H.corun.id === 2, "tap Track 3: chain 3 (" + H.corun.id + ")");
tap(TR3);
check(H.corun.id === 6, "tap Track 3 again: chain 7 (" + H.corun.id + ")");
hold(TR3);
check(H.corun.target === 0, "hold Track 3 on chain 7 closes the view");

/* 14d. Under Master FX (hold Menu), a Track tap goes to that Track's chain. */
cc(MENU, 127); tick(Math.ceil(600 / 23)); cc(MENU, 0); tick(3);
check(H.corun.overlay === "master_fx", "Master FX open");
tap(TR2); tick(3);
check(H.corun.target === 1 && H.corun.id === 1 && H.corun.overlay !== "master_fx",
      "tap Track 2 under Master FX: chain 2 (" + H.corun.id + ", overlay " + H.corun.overlay + ")");
hold(TR2);
check(H.corun.target === 0, "hold Track 2 closes it");

/* 15. onUnload ends a session. */
hold(TR3);
check(H.corun.target === 1, "chain 3 open");
g.onUnload();
check(H.corun.target === 0, "onUnload ends the session");

console.log(`${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
