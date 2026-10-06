/* Host mock: the display/LED/param bindings ui.js touches, plus a co-run
 * emulation that follows shadow_ui.c / shadow_ui.js (upstream 1.6.3):
 * begin_cede stores the keep complement, an overlay swaps keep_mask and
 * shadow_corun_close restores the previous one, and the host can end a
 * session on its own (Back at the editor's root, overtake teardown). */
export const log = [];
export let clock = 1_000_000;
export function advance(ms) { clock += ms; }
Date.now = () => clock;

const g = globalThis;
export const printed = [];
g.print = (x, y, text) => { printed.push(String(text)); return true; };
for (const f of ["clear_screen", "fill_rect", "draw_rect", "set_pixel", "draw_line",
                 "host_flush_display", "host_ensure_dir", "host_log",
                 "shadow_log", "console_log"]) {
    g[f] = () => true;
}
/* An in-memory file system: setlists and songs the tests write, everything
 * else absent (ui.js treats a missing config as defaults). */
export const files = new Map();
g.host_read_file = (path) => files.has(path) ? files.get(path) : null;
g.host_write_file = (path, text) => { files.set(path, String(text)); return true; };
g.host_file_exists = (path) => files.has(path);
/* LED writes: [cin, status, d1, color]; knobLeds[i] is the last colour sent
 * to the light under knob i+1 (CC 71-78), undefined = never written. */
export const knobLeds = new Array(8);
g.move_midi_internal_send = (msg) => {
    if (msg && (msg[1] & 0xF0) === 0xB0 && msg[2] >= 71 && msg[2] <= 78) knobLeds[msg[2] - 71] = msg[3];
    return true;
};
g.move_midi_external_send = () => true;
g.shadow_send_midi_to_dsp = () => true;
export const dspSets = [];
g.host_module_set_param = (k, v) => { dspSets.push([k, v]); return true; };
g.host_module_set_param_blocking = (k, v) => { dspSets.push([k, v]); return true; };
g.host_module_get_param = () => null;
export const suspends = [];
g.host_suspend_overtake = () => suspends.push(clock);

/* ---- co-run ---- */
Object.assign(g, {
    CORUN_TARGET_NONE: 0, CORUN_TARGET_CHAIN_EDIT: 1, CORUN_TARGET_MOVE_NATIVE: 2,
    CORUN_GRP_OLED: 1 << 0, CORUN_GRP_PADS: 1 << 1, CORUN_GRP_STEPS: 1 << 2,
    CORUN_GRP_JOG: 1 << 4, CORUN_GRP_TRACK_BUTTONS: 1 << 5, CORUN_GRP_KNOBS: 1 << 6,
    CORUN_GRP_MASTER: 1 << 7, CORUN_GRP_SHIFT: 1 << 8, CORUN_GRP_BACK: 1 << 9,
    CORUN_GRP_MENU: 1 << 10, CORUN_GRP_TOUCH: 1 << 11, CORUN_GRP_MUTE: 1 << 12,
    CORUN_F_CEDE_MODEL: 1, CORUN_F_OWN_BACK: 2,
});
const EXT = (1 << 13) | (1 << 14) | (0xFF << 16) | (1 << 24) | (1 << 25);
export const GRP_ALL = (1 << 0) | (1 << 1) | (1 << 2) | (1 << 4) | (1 << 5) | (1 << 6) | (1 << 7) |
    (1 << 8) | (1 << 9) | (1 << 10) | (1 << 11) | (1 << 12) | EXT;
export const corun = { target: 0, id: -1, keep: 0, flags: 0, overlay: null, prevMask: 0 };
/* shadow_ui's view model: what its co-run draw path would show. At the top of
 * each frame it re-primes the chain editor when the session's slot changed
 * (overwriting whatever coRunView was); open/close move coRunView directly. */
export const ui = { seenSlot: -1, view: "tool" };
export function hostFrame() {
    const slot = corun.target === 1 ? corun.id : -1;
    if (corun.overlay != null && !corun.target) { corun.overlay = null; ui.view = "tool"; }
    if (slot !== ui.seenSlot) {
        ui.seenSlot = slot;
        ui.view = slot >= 0 ? "chain_edit" : "tool";
    }
}
export let corunApiPresent = true;
export let masterFxEntry = true;
export function setApi(present, mfx = true) { corunApiPresent = present; masterFxEntry = mfx; install(); }
function install() {
    const names = ["shadow_corun_begin_cede", "shadow_corun_end", "shadow_corun_state",
                   "shadow_corun_entries", "shadow_corun_open", "shadow_corun_close"];
    if (!corunApiPresent) { for (const n of names) delete g[n]; return; }
    g.shadow_corun_begin_cede = (t, id, cede, flags) => {
        log.push(["begin_cede", t, id, cede, flags]);
        if (t !== 1 || id < 0 || id > 7) return;   /* SHADOW_UI_SLOTS = 8 */
        corun.flags = 1 | (flags & 2);
        corun.keep = (~cede) & GRP_ALL;
        corun.id = id; corun.target = 1;
    };
    g.shadow_corun_end = () => { log.push(["end"]); hostEnd(); };
    g.shadow_corun_state = () => corun.target
        ? { target: corun.target, id: corun.id, keep_mask: corun.keep | 0, flags: corun.flags } : null;
    g.shadow_corun_entries = () => masterFxEntry ? ["slots", "chain_editor", "master_fx", "global_settings"]
                                                 : ["slots", "chain_editor"];
    g.shadow_corun_open = (id, keep) => {
        log.push(["open", id, keep]);
        if (!g.shadow_corun_entries().includes(id)) return false;
        corun.prevMask = corun.target ? corun.keep : 0;
        corun.overlay = id; corun.keep = keep;
        ui.view = id;
        return true;
    };
    g.shadow_corun_close = () => {
        log.push(["close"]);
        if (corun.overlay == null) return;
        corun.overlay = null; corun.keep = corun.prevMask;
        ui.view = "tool";   /* shadow_corun_close: coRunView = OVERTAKE_MODULE */
    };
}
/* The host ending a session by itself. */
export function hostEnd() {
    Object.assign(corun, { target: 0, id: -1, keep: 0, flags: 0, overlay: null });
}
/* Back at an overlay's root inside shadow_ui. */
export function hostBackAtOverlayRoot() { g.shadow_corun_close(); }
install();

/* ---- chain slots in the shim ----
 * Each chain: a receive channel and its components, each with a module id, a
 * display name, chain_params and live values -- answered on the same keys the
 * chain host serves ("synth_module", "fx1_module", "<comp>:name",
 * "<comp>:chain_params", "<comp>:<key>"). */
function synth(module, name, values) {
    return { module, name, values: Object.assign({ cutoff: "0.50", wave: "Saw", voices: "4" }, values || {}),
        params: [
            { key: "cutoff", name: "Cutoff", type: "float", min: 0, max: 1, step: 0.01 },
            { key: "wave", name: "Wave", type: "enum", options: ["Sine", "Saw", "Square"] },
            { key: "voices", name: "Voices", type: "int", min: 1, max: 8 },
            { key: "sample_path", name: "Sample", type: "filepath" },
        ] };
}
export const slots = [
    { recv: 1, comps: { synth: synth("dexed", "Dexed"),
                        fx1: { module: "freeverb", name: "Freeverb", values: { mix: "0.30" },
                               params: [{ key: "mix", name: "Mix", type: "float", min: 0, max: 1, step: 0.05 }] } },
      midi_fx: 0, fx: 1 },
    { recv: 2, comps: {}, midi_fx: 0, fx: 0 },
    { recv: 0, comps: { synth: synth("obxd", "OB-Xd") }, midi_fx: 0, fx: 0 },
    { recv: 4, comps: { synth: synth("sf2", "") }, midi_fx: 0, fx: 0 },
];
/* Master FX: positions fx1..fx8 at IPC slot 0, as "master_fx:fx<N>:<key>". */
export const masterFx = {
    fx2: { module: "tapedelay", values: { feedback: "0.40" },
           params: [{ key: "feedback", name: "Feedback", type: "float", min: 0, max: 1, step: 0.01 }] },
};
export let masterModulesServed = true;
export function setMasterModulesServed(v) { masterModulesServed = v; }
export const moveSet = { uuid: "set-a", name: "Gig Set" };
export const paramLog = [];
export let paramFails = false;
export function setParamFails(v) { paramFails = v; }
g.shadow_get_param = (slot, key) => {
    paramLog.push(["get", slot, key]);
    if (paramFails) return null;
    const s = slots[slot];
    if (key === "master_fx:modules") {
        if (!masterModulesServed) return null;
        const arr = [];
        for (let n = 1; n <= 8; n++) { const c = masterFx["fx" + n]; arr.push({ id: c ? c.module : "", path: "" }); }
        return JSON.stringify(arr);
    }
    let mm = /^master_fx:(fx\d+):(.+)$/.exec(key);
    if (mm) {
        const c = masterFx[mm[1]];
        if (!c) return "";
        if (mm[2] === "name") return c.module;
        if (mm[2] === "chain_params") return JSON.stringify(c.params);
        return c.values[mm[2]] !== undefined ? String(c.values[mm[2]]) : "";
    }
    if (key === "active_set") return moveSet.uuid ? moveSet.uuid + "\n" + moveSet.name + "\n1" : "";
    if (key === "slot:receive_channel") return String(s.recv);
    if (key === "midi_fx_count") return String(s.midi_fx);
    if (key === "fx_count") return String(s.fx);
    let m = /^(synth|fx\d+|midi_fx\d+)_module$/.exec(key);
    if (m) return s.comps[m[1]] ? s.comps[m[1]].module : "";
    m = /^(synth|fx\d+|midi_fx\d+):(.+)$/.exec(key);
    if (m) {
        const c = s.comps[m[1]];
        if (!c) return "";
        if (m[2] === "name") return c.name;
        if (m[2] === "chain_params") return JSON.stringify(c.params);
        return c.values[m[2]] !== undefined ? String(c.values[m[2]]) : "";
    }
    return "";
};
export const writes = [];
g.shadow_set_param_timeout = (slot, key, val, t) => {
    paramLog.push(["set", slot, key, val, t]);
    if (paramFails) return false;
    writes.push([slot, key, String(val)]);
    const s = slots[slot];
    const mm = /^master_fx:(fx\d+):(.+)$/.exec(key);
    if (mm) {
        if (slot === 0 && masterFx[mm[1]]) masterFx[mm[1]].values[mm[2]] = String(val);
        return true;
    }
    if (key === "slot:receive_channel") {
        const n = parseInt(val, 10);
        if (n >= 0 && n <= 16) s.recv = n;
        return true;
    }
    const m = /^(synth|fx\d+|midi_fx\d+):(.+)$/.exec(key);
    if (m && s.comps[m[1]]) s.comps[m[1]].values[m[2]] = String(val);
    return true;
};
