/*
 * Arranger — Schwung Overtake Module
 *
 * Song Builder + Performance/Setlist mode for arranging GM drum MIDI clips.
 */

/* Build version stamp. Bump this on every deploy so the running JS can be
 * confirmed from the logs (see init()/playCurrentSong()) instead of guessing
 * whether a new file actually loaded. Keep the DSP dsp_build_version in
 * arranger_engine.c in sync so both sides are verifiable. */
const UI_BUILD_VERSION = "arranger-ui-0.6.0";

/* Lit white buttons at full brightness (127). Schwung's WhiteLedBright is 124. */
const WhiteLedFull = 127;

import {
    MidiNoteOn, MidiNoteOff, MidiCC,
    MoveMainKnob, MoveMainButton, MoveBack, MoveMenu, MoveShift,
    MovePlay, MoveRec, MoveRecord, MoveDelete, MoveCopy, MoveUndo, MoveLoop,
    MoveMute, MoveCapture,
    MoveUp, MoveDown, MoveLeft, MoveRight,
    MoveStep1, MoveStep16,
    MovePad1, MovePad32,
    MoveRow1, MoveRow2, MoveRow3, MoveRow4,
    Black, White, BrightRed, DarkGrey,
    WhiteLedOff, WhiteLedDim,
    AzureBlue, BrightYellow, Purple,
    MovePads, MoveSteps
} from '/data/UserData/schwung/shared/constants.mjs';

import {
    setLED, setButtonLED, clearAllLEDs, decodeDelta
} from '/data/UserData/schwung/shared/input_filter.mjs';

import {
    drawMenuHeader, drawMenuList, drawMenuFooter,
    LIST_TOP_Y, LIST_INDICATOR_BOTTOM_Y,
    showOverlay, hideOverlay, tickOverlay, drawOverlay
} from '/data/UserData/schwung/shared/menu_layout.mjs';

import {
    drawOverlayCard, contentW
} from '/data/UserData/schwung/shared/overlay_card.mjs';

import {
    drawFooter
} from '/data/UserData/schwung/shared/param_pages/render_page_movy.mjs';

import {
    createTextScroller
} from '/data/UserData/schwung/shared/text_scroll.mjs';

import {
    openTextEntry, isTextEntryActive, handleTextEntryMidi,
    drawTextEntry, tickTextEntry
} from '/data/UserData/schwung/shared/text_entry.mjs';

import {
    createMenuStack
} from '/data/UserData/schwung/shared/menu_stack.mjs';

import {
    fontPrint4x5, fontWidth4x5
} from '/data/UserData/schwung/shared/param_pages/font4x5.mjs';

import {
    asciiFold
} from '/data/UserData/schwung/shared/param_pages/render_page.mjs';

import * as os from 'os';

const { setTimeout } = globalThis;
/* NOT destructured like setTimeout above: the host neutralizes print/
 * clear_screen (along with draw_rect/fill_rect/draw_line/draw_image) into
 * no-ops on globalThis for the duration of a parked module's tick() -- see
 * shadow_ui.js's background-tick loop -- specifically so a suspend_keeps_js
 * module (like this one; see module.json) can keep running in the
 * background without stomping on whatever Schwung screen the user has
 * since navigated to. A `const { print } = globalThis` destructure captures
 * today's REAL function once at load time into a permanent local binding,
 * so every later call still reaches the live screen no matter what the host
 * swaps globalThis.print to -- exactly the bug reported as the display
 * flickering between the Arranger and a Schwung menu while parked in the
 * background. These thin wrappers re-resolve through globalThis on every
 * call instead, so the host's swap actually takes effect. fill_rect/
 * draw_rect/draw_line/draw_image are already called as bare globals
 * elsewhere in this file (never destructured), so they were never affected. */
function print(...args) { return globalThis.print(...args); }
function clear_screen(...args) { return globalThis.clear_screen(...args); }

/* ── Constants ─────────────────────────────────────────────────────── */

const SCREEN_WIDTH = 128;
const SCREEN_HEIGHT = 64;

const LIBRARY_ROOT = "/data/UserData/UserLibrary/Arranger/MidiLibrary";
const SONGS_DIR = "/data/UserData/UserLibrary/Arranger/Songs";
/* Automatic per-song backups. Each save writes a timestamped copy of the
 * previous version into this dot-folder so the DSP song scan (which skips
 * dot-entries) and the Song Bank list never see them. Max backups kept per
 * song is MAX_SONG_BACKUPS. */
const SONGS_BACKUP_DIR = SONGS_DIR + "/.backups";
const MAX_SONG_BACKUPS = 10;
const SETLISTS_DIR = "/data/UserData/UserLibrary/Arranger/Setlists";
const SETTINGS_PATH = "/data/UserData/UserLibrary/Arranger/settings.json";
/* Per-module settings persisted by Schwung Manager (the web UI) via
 * settings-schema.json. Schwung Manager writes saved values to this
 * config.json, so it is the source of truth for Options; the legacy
 * SETTINGS_PATH above is retained only as a fallback for values not yet
 * present in config.json. See schwung docs/MODULES.md "Per-Module Settings". */
const MODULE_DIR = "/data/UserData/schwung/modules/overtake/arranger";
const CONFIG_PATH = MODULE_DIR + "/config.json";

const NUM_PADS = 32;
const NUM_STEPS = 16;

const MODE_BUILDER = "builder";
const MODE_PERFORMANCE = "performance";
const MODE_JAM = "jam";

const OUTPUT_TARGETS = ["external", "move", "schwung"];
const OUTPUT_LABELS = { external: "External", move: "Move", schwung: "Schwung" };

const VIEW_ROOT = "root";
const VIEW_FOLDER_LIST = "folder_list";
const VIEW_BUILDER = "builder";
const VIEW_TRIM = "trim";
const VIEW_SONG_BANK = "song_bank";
const VIEW_PERFORMANCE = "performance_view";
const VIEW_OPTIONS = "options";
const VIEW_OPTIONS_DRUMS = "options_drums";
const VIEW_OPTIONS_INST = "options_inst";
const VIEW_OPTIONS_KEYS = "options_keys";
const VIEW_OPTIONS_CLICK = "options_click";
const VIEW_OPTIONS_CHAINS = "options_chains";
const VIEW_KNOB_MAP = "knob_map";
const VIEW_KNOB_PICK = "knob_pick";
const VIEW_SONG_SETTINGS = "song_settings";
const VIEW_SONG_BACKUPS = "song_backups";
const VIEW_SETLIST_BANK = "setlist_bank";
const VIEW_SETLIST_EDIT = "setlist_edit";
const VIEW_SETLIST_PICK = "setlist_pick";
const VIEW_SETLIST_CLICK = "setlist_click";
const VIEW_PERF_SETLIST = "perf_setlist";
const VIEW_JAM_FOLDER = "jam_folder";
const VIEW_JAM = "jam";
const VIEW_SECTION_PICK = "section_pick";
const VIEW_CHORD_PICK = "chord_pick";
const VIEW_INSTRUMENT = "instrument";
const VIEW_INSTRUMENT_BAR = "instrument_bar";
const VIEW_JAM_INSTRUMENT = "jam_instrument";
/* A setlist song's play order (Setlist Edit > a song > Sections), and the
 * picker that adds one of the song's sections to it. */
const VIEW_SETLIST_SECTIONS = "setlist_sections";
const VIEW_SETLIST_SECTION_PICK = "setlist_section_pick";
/* Song Builder, Loop on the Chord/Inst/Click track: which sections to copy
 * the track's section to. */
const VIEW_COPY_TRACK_PICK = "copy_track_pick";

/* Section names offered when adding a new section via Shift + Loop. */
const SECTION_NAMES = [
    "Intro", "Verse", "Prechorus", "Chorus", "Interlude", "Instrumental",
    "Turn", "Bridge", "Down Bridge", "Down Chorus", "Outro"
];

/* ── Chord track ─────────────────────────────────────────────────────── */

/* The four Move Row buttons select which track the Song Builder shows:
 *   0 = Drum track (existing), 1 = Chord track, 2/3 = Instrument tracks. */
const TRACK_DRUM = 0;
const TRACK_CHORD = 1;
const TRACK_INSTRUMENT_1 = 2;
const TRACK_INSTRUMENT_2 = 3;

/* Move Row button CC and colour per track, indexed by TRACK_DRUM/CHORD/
 * INSTRUMENT_1/2, so the Row buttons show which track is selected. */
/* Track button per builder track: Track 1 holds both Drum and Chord (it
 * toggles between them), Track 2 = Inst 1, Track 3 = Inst 2. Track 4 is the
 * click on/off in every mode -- see toggleClick. */
const TRACK_CLICK = 4;
/* Pads: a third instrument that only follows the chords (chord voicing on
 * the chord grid -- no Follow Note, no patterns). On Track 4, which steps
 * Pads -> Click; turned on and off in its settings (Menu > Enabled). */
const TRACK_PADS = 5;
const TRACK_ROW_CC = [MoveRow1, MoveRow1, MoveRow2, MoveRow3, MoveRow4, MoveRow4];
const TRACK_ROW_COLOUR = [White, AzureBlue, BrightYellow, Purple, 3 /* Bright Orange, CLICK_ROW_COLOUR */,
    12 /* Teal Green */];
/* The song's instruments, in order: song.instruments[i] / sec.inst[i]. */
const INST_TRACKS = [TRACK_INSTRUMENT_1, TRACK_INSTRUMENT_2, TRACK_PADS];
const INST_TRACK_NAMES = ["Inst 1", "Inst 2", "Pads"];
function instIndex(track) { return INST_TRACKS.indexOf(track); }
function isInstTrack(track) { return instIndex(track) >= 0; }
const CLICK_ROW_COLOUR = 3; /* Bright Orange */

/* The 12 major keys, in chromatic order. Each entry is the tonic note name. */
const KEYS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/* Semitone offsets of the 12 pitch classes from C. */
const PITCH_CLASS = {
    "C": 0, "C#": 1, "Db": 1, "D": 2, "D#": 3, "Eb": 3, "E": 4, "F": 5,
    "F#": 6, "Gb": 6, "G": 7, "G#": 8, "Ab": 8, "A": 9, "A#": 10, "Bb": 10, "B": 11
};

/* Diatonic chord qualities for a major key, by scale degree (0-based).
 * I=maj, ii=min, iii=min, IV=maj, V=maj, vi=min, vii°=dim. */
const DIATONIC_QUALITY = ["maj", "min", "min", "maj", "maj", "min", "dim"];

/* Chord qualities offered in the chord picker (beyond the diatonic default).
 * Each maps to a semitone offset for the third/fifth/seventh. */
/* The chord types, in the order the chord page's Type row steps through
 * them: triads, sixths and sevenths, added-note chords (add9, add4 -- "(4)"),
 * then the extended ones. The stored name is the key here; the engine has
 * the same table (CHORD_QUALITY_TABLE in arranger_engine.c). */
const CHORD_QUALITIES = ["maj", "min", "dim", "aug", "sus2", "sus4",
    "6", "m6", "7", "maj7", "m7", "m7b5", "dim7", "mmaj7", "7sus4",
    "add9", "madd9", "add4", "madd4", "7add4", "m7add4",
    "69", "9", "maj9", "m9", "7b9", "7s9", "maj7s11", "11", "m11", "13"];

/* Semitone intervals for each chord quality relative to the root. */
const CHORD_INTERVALS = {
    "maj": [0, 4, 7], "min": [0, 3, 7], "dim": [0, 3, 6], "aug": [0, 4, 8],
    "sus2": [0, 2, 7], "sus4": [0, 5, 7],
    "6": [0, 4, 7, 9], "m6": [0, 3, 7, 9], "7": [0, 4, 7, 10], "maj7": [0, 4, 7, 11],
    "m7": [0, 3, 7, 10], "m7b5": [0, 3, 6, 10], "dim7": [0, 3, 6, 9], "mmaj7": [0, 3, 7, 11],
    "7sus4": [0, 5, 7, 10], "add9": [0, 4, 7, 14], "madd9": [0, 3, 7, 14],
    "add4": [0, 4, 5, 7], "madd4": [0, 3, 5, 7], "7add4": [0, 4, 5, 7, 10], "m7add4": [0, 3, 5, 7, 10],
    "69": [0, 4, 7, 9, 14], "9": [0, 4, 7, 10, 14], "maj9": [0, 4, 7, 11, 14], "m9": [0, 3, 7, 10, 14],
    "7b9": [0, 4, 7, 10, 13], "7s9": [0, 4, 7, 10, 15], "maj7s11": [0, 4, 7, 11, 18],
    "11": [0, 4, 7, 10, 14, 17], "m11": [0, 3, 7, 10, 14, 17], "13": [0, 4, 7, 10, 14, 21]
};

/* Display label for a chord quality (used to render a compact chord name,
 * e.g. "Cm7" or "C" for a plain major — hence "maj" being blank). */
/* Inversion value meaning "Auto": voice leading by the chord's scale degree
 * (I, ii, vii root; iii, IV 2nd inversion; V, vi 1st inversion), each chord
 * placed so its lowest note is the one nearest the key's root. Resolved on
 * the DSP side (chord_voiced_notes). Default for new instruments and Jam. */
const INVERSION_AUTO = 4;

const CHORD_QUALITY_LABEL = {
    "maj": "", "min": "m", "dim": "dim", "aug": "aug", "sus2": "sus2", "sus4": "sus4",
    "6": "6", "m6": "m6", "7": "7", "maj7": "maj7", "m7": "m7", "m7b5": "m7b5", "dim7": "dim7",
    "mmaj7": "m(maj7)", "7sus4": "7sus4", "add9": "add9", "madd9": "m(add9)",
    "add4": "(4)", "madd4": "m(4)", "7add4": "7(4)", "m7add4": "m7(4)",
    "69": "6/9", "9": "9", "maj9": "maj9", "m9": "m9", "7b9": "7b9", "7s9": "7#9",
    "maj7s11": "maj7#11", "11": "11", "m11": "m11", "13": "13"
};

/* Full-word label for the chord picker's Type row, where a blank ("maj") is
 * ambiguous rather than a compact chord-name shorthand. */
const CHORD_TYPE_LABEL = {
    "maj": "Major", "min": "Minor", "dim": "Dim", "aug": "Aug", "sus2": "Sus2", "sus4": "Sus4",
    "6": "6th", "m6": "Min6", "7": "7th", "maj7": "Maj7", "m7": "Min7", "m7b5": "Min7b5", "dim7": "Dim7",
    "mmaj7": "Min(Maj7)", "7sus4": "7Sus4", "add9": "Add9", "madd9": "Min Add9",
    "add4": "Add4", "madd4": "Min Add4", "7add4": "7 Add4", "m7add4": "Min7 Add4",
    "69": "6/9", "9": "9th", "maj9": "Maj9", "m9": "Min9", "7b9": "7b9", "7s9": "7#9",
    "maj7s11": "Maj7#11", "11": "11th", "m11": "Min11", "13": "13th"
};

/* The 12 note names, used to render a chord's root/bass. */
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/* The 12 bass-note choices for a slash chord (C/G = C over G bass), in the
 * order the picker offers them: chromatically up from the song key's tonic,
 * so the first choice is the scale's base note rather than always C. */
export function bassNotesForKey(key) {
    /* Spelt as the chord roots are: the key's notes its way, the rest by degree. */
    const out = [];
    for (let i = 0; i < 12; i++) out.push(chordRootName(noteSemitone(key) >= 0 ? key : "C", i));
    return out;
}

/* The chord page's Root row: semitones above the key's root, 0-11 -- every
 * root, in or out of the key -- then No Chord (a silent bar). Named as
 * degrees of the major key: the key's own chords as I ii iii IV V vi vii°,
 * the others as the flat (or sharp IV) degrees they usually are. */
const CHORD_ROOT_NONE = 12;
const CHORD_ROOT_DEGREES = ["I", "bII", "ii", "bIII", "iii", "IV", "#IV", "V", "bVI", "vi", "bVII", "vii°"];
/* A root's degree in the key (0-6), or -1 outside it. */
const CHORD_ROOT_SCALE_DEGREE = [0, -1, 1, -1, 2, 3, -1, 4, -1, 5, -1, 6];
const FLAT_NOTE_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];

/* Major keys written with flats (F, Bb, Eb, Ab, Db); the rest use sharps. */
function keyUsesFlats(keyPc) {
    return keyPc === 1 || keyPc === 3 || keyPc === 5 || keyPc === 8 || keyPc === 10;
}

/* Pitch class `pc` named as key `keyPc` writes its notes. */
function spellInKey(pc, keyPc) {
    return (keyUsesFlats(keyPc) ? FLAT_NOTE_NAMES : NOTE_NAMES)[((pc % 12) + 12) % 12];
}

/* A key as it is written: "A#" (stored) shows as Bb, "C#" as Db... */
export function keyLabel(key) {
    const pc = noteSemitone(key);
    return pc < 0 ? String(key || "") : spellInKey(pc, pc);
}

/* The note name of root `r` (semitones above `key`): the key's own notes as
 * the key's chords name them, the flat degrees with flats. */
export function chordRootName(key, r) {
    const keyPc = noteSemitone(key);
    const pc = ((keyPc < 0 ? 0 : keyPc) + r) % 12;
    const d = CHORD_ROOT_SCALE_DEGREE[((r % 12) + 12) % 12];
    if (d >= 0) return diatonicChord(key, d).root;
    return CHORD_ROOT_DEGREES[((r % 12) + 12) % 12].startsWith("b") ? FLAT_NOTE_NAMES[pc] : NOTE_NAMES[pc];
}

/* A note name re-spelt for `key` (a chord saved as A# in F reads Bb). */
function spellNoteForKey(name, key) {
    const pc = noteSemitone(name), keyPc = noteSemitone(key);
    if (pc < 0 || keyPc < 0) return name;
    return chordRootName(key, ((pc - keyPc) % 12 + 12) % 12);
}

/* A root's default type: the key's own chord's, else major. */
function chordRootDefaultQuality(r) {
    const d = CHORD_ROOT_SCALE_DEGREE[r];
    return d >= 0 ? DIATONIC_QUALITY[d] : "maj";
}

/* Default key for a new song. */
const DEFAULT_KEY = "C";

/* ── State ───────────────────────────────────────────────────────────── */

let currentMode = MODE_BUILDER;
let currentView = VIEW_ROOT;
let menuStack = null;

let confirmState = null;   /* { title, name, labels, selectedIndex, onConfirm, onCancel } */

let libraryFolders = [];
/* Category grouping of the library. libraryFolders is the flat list of song
 * folders (indexed by the DSP's folder index); libraryFolderCategories is a
 * parallel array holding each folder's full category path, with '/' separators
 * for nested categories (e.g. "Vintage Drummer/03 Swing"). libraryCategoryTree
 * is a tree of category nodes: each node has children (sub-categories) and
 * folders (indices into libraryFolders). folderPickerPath is the array of
 * category names currently navigated to in the Builder folder picker;
 * folderPickerSelectedIndex is the cursor within that node's combined list of
 * sub-categories and folders. The Jam folder picker uses parallel state. */
let libraryFolderCategories = [];
let libraryCategoryTree = null;
/* True once the folder list + clip map have been built and the DSP scan is
 * stable. Opening a folder picker (Jam, new song, change folder) reuses this
 * cache instead of re-fetching and re-parsing every folder's clips from the
 * DSP each time. Invalidated when a scan is requested (folder_count was 0). */
let libraryCacheValid = false;
/* A rescan requested on resume, waiting to land before the lists reload --
 * see onResume / pollLibraryRescan. */
let libraryRescanPending = false;
let libraryRescanDeadline = 0;
let lastLibraryRescanPoll = 0;
const LIBRARY_RESCAN_POLL_MS = 250;
const LIBRARY_RESCAN_MAX_WAIT_MS = 20000;
let folderPickerPath = [];
let folderPickerSelectedIndex = 0;
/* Stack of the selected index at each ancestor level of the Builder folder
 * picker, so pressing Back returns to the subcategory/cursor the user was on
 * rather than resetting to the top of the parent list. */
let folderPickerSelectedStack = [];
let jamFolderPickerPath = [];
let jamFolderPickerSelectedIndex = 0;
/* Parallel stack for the Jam folder picker. */
let jamFolderPickerSelectedStack = [];
/* Map of clip leaf name -> folder name, built from the DSP folder scan. Used
 * to backfill a clip's source_folder when loading an existing song whose
 * clips were added from a different folder than the song's primary one. */
let folderClipMap = null;
/* When true, the folder list is being used to change the CURRENT song's source
 * folder (opened via the Record button in the Song Builder) rather than to
 * create a new song. Selecting a folder reloads the clip palette from it. */
let builderChangeFolder = false;

let currentSong = null;   /* { id, name, source_folder, tempo_bpm, time_signature, sections: [] } */
let currentSectionIndex = 0;
let currentClipIndex = 0; /* cursor within section */
let unsavedChanges = false;

let folderClips = [];     /* all clips: { path, name, type, bars } for selected folder */
let grooveClips = [];     /* clips with type !== "fill" */
let fillClips = [];       /* clips with type === "fill" */
let builderPage = 0;
let builderCursor = 0;  /* insertion cursor position within current section */
let previewingClip = null; /* clip currently held for preview */
let previewingFile = null;   /* file being previewed, set in buildTimeline */
let previewStartTime = 0;
let previewCursorBefore = 0; /* builder cursor before a pad preview, restored on release */

let playbackState = "stopped";
let playbackStartTime = 0;
let dspLoopEnabled = true;
let outputTarget = "schwung";
let outputChannel = 10;   /* external/Move/Schwung channel: 1-16 */
let moveChannel = 10;       /* 1-16 */
let schwungChannel = 10;    /* 1-16 */
/* Click track (Options > Click): a metronome on every beat while playing,
 * accent note on beat 1, on its own output and channel. It also plays
 * Perform's count-ins. clickOn is the Track 4 toggle -- shared by every
 * mode, not saved. Defaults: Schwung, channel 10, GM wood blocks. */
let clickOutput = "schwung";
let clickMidiChannel = 10;  /* 1-16 */
let clickAccentNote = 76;   /* GM Hi Wood Block */
let clickNormalNote = 77;   /* GM Low Wood Block */
/* Click loudness (percent of its normal velocity): each song section starts
 * here, the Click track's items change it. */
let clickVolume = 100;
let clickOn = false;
/* Instrument track output/channel, shared globally across all songs and set
 * from the Options menu (Instrument 1 / Instrument 2 submenus), not per-song. */
let inst1Output = "external";
let inst1Channel = 1;
let inst2Output = "external";
let inst2Channel = 1;
/* Pads (Inst 3) and Keys (Perform/Jam's playable pads) routing. */
let inst3Output = "external";
let inst3Channel = 1;
let keysOutput = "schwung";
let keysChannel = 1;
let keysLayout = 0;          /* index into KEYS_LAYOUTS */
let keysScale = 0;           /* index into KEYS_SCALES */
let keysStartOctave = 3;     /* the bottom-left pad's octave when Keys turn on */
let dspDirectEmit = false;
let pendingSongJson = null;
let dspTimelineInfo = null;
let lastDspState = null;

/* Async build confirmation (rearch2.md Step 3). song_json/preload_song_json
 * now return instantly -- the actual build happens on the DSP's worker
 * thread -- so a blocking set_param call returning is no longer proof that
 * the build finished, only that the DSP received it. Every caller that
 * needs to know "did MY specific request actually land" captures the
 * relevant *_published_gen from the already-fresh lastDspState (updated
 * every tick by updateDspState, so this costs nothing extra) as a baseline
 * BEFORE issuing the write, then registers here; updateDspState below fires
 * onReady once that generation has changed. A later call overwrites an
 * earlier one, matching the DSP's own "coalesce to latest" semantics for
 * the same channel. This sits alongside, not instead of, the reactive
 * active_source/bar_frac reconciliation further down in updateDspState,
 * which answers "what is the DSP actually playing" rather than "did my
 * request finish". */
let pendingPrimaryConfirm = null;  // { gen, onReady }
let pendingStagingConfirm = null;  // { gen, onReady }

function requestPrimaryBuild(setFn, onReady) {
    const baseGen = (lastDspState && lastDspState.primary_published_gen) || 0;
    setFn();
    pendingPrimaryConfirm = { gen: baseGen, onReady: onReady };
}

function requestStagingBuild(setFn, onReady) {
    const baseGen = (lastDspState && lastDspState.staging_published_gen) || 0;
    setFn();
    pendingStagingConfirm = { gen: baseGen, onReady: onReady };
}

let shiftHeld = false;
/* Long-press-Back-to-suspend state. Shift+Back can't be used for this: the
 * host intercepts it unconditionally, before onMidiMessageInternal ever
 * runs, as its own universal full-exit gesture for suspend_keeps_js modules
 * (shadow_ui.js) -- the module has no way to see it, let alone repurpose it.
 * Plain Back is the only gesture suspend_self_managed hands to the module at
 * all, and every view's existing Back handling fires immediately on PRESS
 * (stop playback + navigate in Jam/Perform, exit at root) -- so a hold
 * cannot be layered on top of that: by the time a hold is detected the
 * view's own action has already run, which is exactly what made suspending
 * pointless before this (Jam/Perform's playback was already stopped by the
 * Back press that navigated to where suspend is reachable). Back is
 * intercepted here instead, before any view sees it: press starts the hold
 * timer without dispatching anything yet; tick() promotes it to a suspend at
 * BACK_SUSPEND_HOLD_MS if still held; release dispatches the normal
 * per-view Back action only if the hold never fired -- a quick tap reaches
 * exactly the same handling as before, just on release rather than on
 * press, which is imperceptible for an actual tap and is what makes a hold
 * distinguishable from one in the first place. */
let backHoldActive = false;
let backHoldStartTime = 0;
let backHoldSuspendFired = false;
let backHoldPressValue = 0;
let backHoldStatusByte = 0xB0;
const BACK_SUSPEND_HOLD_MS = 500;

/* ---- Schwung chains alongside Arranger (co-run) --------------------------
 *
 * Hold Track 1-4 to open Schwung's own editor for Chain 1-4 WITHOUT leaving
 * Arranger; under that view, TAP a Track to switch to its chain, and tap it
 * again to toggle to its second chain (Track 1: Chain 1 <-> Chain 5 ... Track
 * 4: Chain 4 <-> Chain 8). Holding the Track of the open chain (either of its
 * pair) closes the view. and hold Menu for Schwung's Master FX. Arranger keeps running
 * underneath: playback, pads, steps, transport and the track buttons stay
 * Arranger's, while the screen, jog, knobs, knob touches and Back drive the
 * editor. So a song can keep playing while you tweak the synth it is
 * playing, and the track buttons still mute.
 *
 * This is Schwung's co-run (docs/CORUN.md in Schwung), in the cede model:
 * shadow_corun_begin_cede names only what Arranger hands over, and
 * CORUN_F_OWN_BACK lets Back navigate INSIDE the editor -- shadow_ui can see
 * its own view depth, so it ends the session itself at the editor's top
 * level. Master FX is a co-run OVERLAY (shadow_corun_open("master_fx")), and
 * an overlay only exists over an active session, so it is opened over a chain
 * session. A framework-driven exit is never announced; reconcileChainView()
 * polls shadow_corun_state() every tick to notice it.
 *
 * Replaces the inst-chain branch's host_jump_to_slot/host_jump_to_master_fx,
 * which SUSPENDED Arranger to show the editor (stopping its screen and pads)
 * and needed a patched Schwung. Co-run ships in stock Schwung; a host without
 * it gets a notice instead.
 *
 * A Track or Menu TAP keeps its old meaning, but runs on RELEASE: the same
 * press/hold/replay shape as Back-hold above, and for the same reason -- an
 * action that fires on press (a Perform/Jam mute) cannot be taken back once a
 * hold turns out to be a hold. With Shift held they act on press as before
 * (Shift+Track 3/4 opens the Jam instrument menu). */
const MAX_CHAIN_SLOTS = 8;           /* the most chain slots Schwung has: two per Move track */
let chainSlotCountCache = 0;

/* How many chain slots this Schwung has: 4 on releases up to 1.7.3, 8 once it
 * has the four aux slots. Read from shadow_get_slots() (one entry per slot),
 * cached once answered; 4 until then. Chains 5-8 are only offered where they
 * exist -- on a 4-slot Schwung a Track tap under a chain view keeps the old
 * single chain, and the chain lists stop at Chain 4. */
function chainSlotCount() {
    if (chainSlotCountCache) return chainSlotCountCache;
    let n = 0;
    try {
        const slots = typeof shadow_get_slots === "function" ? shadow_get_slots() : null;
        if (Array.isArray(slots)) n = slots.length;
    } catch (e) { n = 0; }
    if (n <= 0) return 4;
    chainSlotCountCache = Math.max(1, Math.min(MAX_CHAIN_SLOTS, n));
    return chainSlotCountCache;
}
const TRACK_CHAIN_COUNT = 4;         /* chains a Track hold opens (the first of each pair) */
const LONG_PRESS_HOLD_MS = 500;      /* = Back-hold, and Schwung's own Track hold */
const CHAIN_NOTICE_MS = 3000;
const longPressHolds = new Map();    /* cc -> { startTime, fired, pressValue, statusByte } */
let chainViewSlot = -1;              /* chain slot open alongside Arranger, or -1 */
let chainViewMfx = false;            /* the Master FX overlay is up over it */
let chainViewMfxKeep = 0;            /* keep_mask the overlay reported when it opened */
let chainViewMfxPending = false;     /* open the overlay on the next tick */
let chainViewOpenPending = -1;       /* open this slot on the next tick (fresh session) */
let chainViewRepaintTicks = 0;       /* frames to force a redraw for, after a session */
let lastChainSlot = 0;               /* which chain a Master FX session sits over */

function chainViewActive() {
    return chainViewSlot >= 0;
}

function isTrackCc(cc) {
    return cc >= MoveRow4 && cc <= MoveRow1;
}

/* CC43 = Track 1 = Chain 1 ... CC40 = Track 4 = Chain 4 (Move's track CCs run
 * backwards). The same mapping as Schwung's own Track gestures. */
function trackCcToChainSlot(cc) {
    return MoveRow1 - cc;
}

/* The co-run API, or null on a Schwung without it. Checks every name used
 * below up front, so a partial API cannot fail halfway into a session. */
function corunApi() {
    const g = globalThis;
    for (const f of ["shadow_corun_begin_cede", "shadow_corun_end", "shadow_corun_state"]) {
        if (typeof g[f] !== "function") return null;
    }
    for (const n of ["CORUN_TARGET_CHAIN_EDIT", "CORUN_F_OWN_BACK", "CORUN_GRP_OLED",
                     "CORUN_GRP_KNOBS", "CORUN_GRP_JOG", "CORUN_GRP_TOUCH", "CORUN_GRP_BACK"]) {
        if (typeof g[n] !== "number") return null;
    }
    return g;
}

function masterFxViewAvailable() {
    if (!corunApi() || typeof shadow_corun_open !== "function" ||
        typeof shadow_corun_close !== "function" || typeof shadow_corun_entries !== "function") {
        return false;
    }
    try {
        const ids = shadow_corun_entries();
        return Array.isArray(ids) && ids.indexOf("master_fx") >= 0;
    } catch (e) {
        return false;
    }
}

function corunState() {
    if (typeof shadow_corun_state !== "function") return null;
    try {
        return shadow_corun_state();
    } catch (e) {
        return null;
    }
}

/* What the editor drives: the screen, jog (turn + click), knobs, knob touches
 * and Back. Ceded for a chain session; KEPT for the Master FX overlay, because
 * an overlay drives the groups the tool keeps (docs/CORUN.md, "Overlay
 * model"). Everything else -- pads, steps, transport, track buttons, Shift,
 * Menu -- stays Arranger's either way. */
function chainViewSurface(g) {
    return g.CORUN_GRP_OLED | g.CORUN_GRP_KNOBS | g.CORUN_GRP_JOG |
        g.CORUN_GRP_TOUCH | g.CORUN_GRP_BACK;
}

/* A control the editor owns while a session is up. Its PRESS never reaches
 * Arranger, but some edges still do -- shadow_ui consumes only the press of
 * the jog click and of Back, and forwards knob touches to the tool as well --
 * and none of them may act on a screen nobody can see. */
function chainViewOwnsEvent(status, d1) {
    if (status === 0xB0) {
        return d1 === MoveMainKnob || d1 === MoveMainButton || d1 === MoveBack ||
            (d1 >= 71 && d1 <= 78);
    }
    if (status === MidiNoteOn || status === MidiNoteOff) {
        return d1 <= 9;   /* capacitive knob touches */
    }
    return false;
}

/* Under a chain view Arranger's screen is hidden, so a control that acts on
 * it -- a menu's Delete, Copy, Loop, Undo, Mute..., or a pad or step that
 * edits in Song Builder -- would change something nobody can see (Delete on
 * the Song Bank deleted a song). What stays live is PLAYING: Play, the Track
 * buttons and Menu (mutes, chain switching, the way out), Shift, and in
 * Perform and Jam their pads, steps, arrows (the pad pages) and Rec. */
function chainViewPlayingView() {
    return currentView === VIEW_PERFORMANCE || currentView === VIEW_JAM;
}

function chainViewKeepsButton(cc) {
    if (isTrackCc(cc) || cc === MoveMenu || cc === MoveShift || cc === MovePlay) return true;
    return chainViewPlayingView() &&
        (cc === MoveRec || cc === MoveUp || cc === MoveDown || cc === MoveLeft || cc === MoveRight ||
         cc === MoveCapture);
}

/* Pads/steps whose press was dropped: their release is dropped too, even if
 * the view has closed by then, so a screen never sees half a press. */
const chainViewDroppedNotes = new Set();

function chainViewBlocks(status, d1, value) {
    if (status === 0xB0) return chainViewActive() && !chainViewKeepsButton(d1);
    if (status === MidiNoteOn || status === MidiNoteOff) {
        if (status === MidiNoteOn && value > 0) {
            if (!chainViewActive() || chainViewPlayingView()) return false;
            chainViewDroppedNotes.add(d1);
            return true;
        }
        return chainViewDroppedNotes.delete(d1);
    }
    return false;
}

/* Why a chain view did not open, as a popup (drawn on every screen). */
function chainViewNotice(line) {
    showPopup("Schwung chains", line, CHAIN_NOTICE_MS);
    logDebug("chain view: " + line);
}

/* A session began: nothing Arranger was in the middle of may finish under the
 * editor, out of sight. */
function startChainView() {
    backHoldActive = false;
    for (const hold of longPressHolds.values()) hold.fired = true;
    hideOverlay();
    hidePopup();
}

/* The session is gone, however it ended. Hand the screen and LEDs back.
 * shadow_ui may draw the editor for one more frame (it reconciles at the top
 * of ITS tick, before ours), so the redraw is forced for two. */
function endChainView() {
    chainViewSlot = -1;
    chainViewMfx = false;
    chainViewMfxPending = false;
    resetLedState();
    stepLedsDirty = true;
    needsRedraw = true;
    chainViewRepaintTicks = 2;
    knobLedRepaintTicks = KNOB_LED_REPAINT_TICKS;
    /* The editor can change a chain's channel, synth or a mapped value. */
    if (currentView === VIEW_OPTIONS_CHAINS) refreshChainInfo();
    if (currentView === VIEW_PERFORMANCE) refreshPerfKnobs();
    if (currentView === VIEW_KNOB_MAP) refreshKnobEdit();
}

/* Open (or re-target) a chain session on `slot`. */
function openChainView(slot) {
    const g = corunApi();
    if (!g) {
        chainViewNotice("Needs newer Schwung");
        return false;
    }
    if (chainViewMfx) {
        /* Leaving Master FX. shadow_corun_close() drops shadow_ui to its
         * OVERTAKE_MODULE view, and it only re-primes the chain editor when
         * the session's SLOT changes -- so the chain the overlay sat over
         * cannot be reopened in place. End the session and open a fresh one
         * on the next tick instead. */
        if (slot === chainViewSlot) {
            closeChainView();
            chainViewOpenPending = slot;
            return true;
        }
        try { shadow_corun_close(); } catch (e) { /* the begin below re-targets anyway */ }
        chainViewMfx = false;
    }
    const wasActive = chainViewActive();
    try {
        g.shadow_corun_begin_cede(g.CORUN_TARGET_CHAIN_EDIT, slot, chainViewSurface(g), g.CORUN_F_OWN_BACK);
    } catch (e) {
        logDebug("chain view: begin threw " + e);
    }
    const st = corunState();
    if (!st || st.target !== g.CORUN_TARGET_CHAIN_EDIT || st.id !== slot) {
        if (wasActive) closeChainView();
        chainViewNotice("Chain " + (slot + 1) + " unavailable");
        return false;
    }
    chainViewSlot = slot;
    lastChainSlot = slot;
    chainViewMfxPending = false;
    if (!wasActive) startChainView();
    logDebug("chain view: chain " + (slot + 1));
    return true;
}

/* Master FX, over a chain session -- opening one first if needed. The overlay
 * itself goes up on the NEXT tick: shadow_ui primes a new session at the top
 * of its tick, and priming sets its view to the chain editor, which would
 * overwrite an overlay opened in the same frame. */
function openMasterFxView() {
    if (!masterFxViewAvailable()) {
        chainViewNotice("Needs newer Schwung");
        return;
    }
    if (!chainViewActive() && !openChainView(lastChainSlot)) return;
    chainViewMfxPending = true;
}

/* End whatever session is up and return to Arranger. */
function closeChainView() {
    if (!chainViewActive()) return;
    if (chainViewMfx && typeof shadow_corun_close === "function") {
        try { shadow_corun_close(); } catch (e) { /* ending the session clears it too */ }
    }
    const st = corunState();
    const g = globalThis;
    if (st && st.target === g.CORUN_TARGET_CHAIN_EDIT && typeof shadow_corun_end === "function") {
        try { shadow_corun_end(); } catch (e) { /* reconcile will see the state either way */ }
    }
    logDebug("chain view: closed");
    endChainView();
}

/* Once per tick, before any hold fires: follow the session's real state.
 * Returns true while a session is up. */
function reconcileChainView() {
    if (chainViewOpenPending >= 0) {
        const slot = chainViewOpenPending;
        chainViewOpenPending = -1;
        openChainView(slot);
        return chainViewActive();
    }
    if (!chainViewActive()) return false;
    const g = globalThis;
    const st = corunState();
    if (!st || st.target !== g.CORUN_TARGET_CHAIN_EDIT) {
        /* Back at the editor's top level, or the host tore co-run down. */
        logDebug("chain view: ended by host");
        endChainView();
        return false;
    }
    if (st.id >= 0 && st.id < chainSlotCount()) chainViewSlot = st.id;
    if (chainViewMfxPending) {
        chainViewMfxPending = false;
        let opened = false;
        try {
            opened = shadow_corun_open("master_fx", chainViewSurface(g)) === true;
        } catch (e) {
            logDebug("chain view: master_fx open threw " + e);
        }
        const now = opened ? corunState() : null;
        if (!now) {
            closeChainView();
            chainViewNotice("No Master FX view");
            return false;
        }
        chainViewMfx = true;
        chainViewMfxKeep = now.keep_mask | 0;
        return true;
    }
    if (chainViewMfx && (st.keep_mask | 0) !== chainViewMfxKeep) {
        /* Back at Master FX's root closed the overlay: shadow_corun_close()
         * restores the session's keep mask. Without the overlay shadow_ui
         * would be left on a fallback screen (see openChainView), so Back
         * from Master FX goes straight back to Arranger. */
        closeChainView();
        return false;
    }
    return true;
}

function startLongPressHold(cc, statusByte, pressValue) {
    longPressHolds.set(cc, { startTime: Date.now(), fired: false, pressValue, statusByte });
}

/* Release of a held Track/Menu: a tap replays the press through the normal
 * routing, exactly as it would have run on press before holds existed. */
function endLongPressHold(cc) {
    const hold = longPressHolds.get(cc);
    longPressHolds.delete(cc);
    if (!hold || hold.fired) return;
    if (cc === MoveMenu && chainViewActive()) {
        /* Menu has no screen to act on under the editor: it is the way out. */
        closeChainView();
        return;
    }
    /* Under a chain view a Track tap switches chain (see chainViewTrackTap)
     * rather than its usual action. */
    if (chainViewTrackTap(cc)) return;
    routeCcInput([hold.statusByte, cc, hold.pressValue], cc, hold.pressValue);
}

/* A held Track/Menu crossed LONG_PRESS_HOLD_MS. Holding the Track of the
 * chain already open closes it again, like Schwung's own Track hold toggles
 * between Move and Schwung; holding another Track switches chain. */
function fireLongPressAction(cc) {
    if (cc === MoveMenu) {
        if (chainViewMfx || chainViewMfxPending) closeChainView();
        else openMasterFxView();
        return;
    }
    const slot = trackCcToChainSlot(cc);
    if (slot < 0 || slot >= TRACK_CHAIN_COUNT) return;
    if (chainViewActive() && !chainViewMfx && !chainViewMfxPending &&
        chainViewSlot % TRACK_CHAIN_COUNT === slot) {
        closeChainView();
    } else {
        openChainView(slot);
    }
}

/* A Track tap under a chain view (no Shift): its chain, or -- tapped again
 * on its own chain -- the other of its pair (Chain 1 <-> 5 ... 4 <-> 8).
 * Under Master FX it goes to the Track's chain.
 * Returns true if the tap was used. */
function chainViewTrackTap(cc) {
    if (!chainViewActive() || !isTrackCc(cc)) return false;
    const base = trackCcToChainSlot(cc);
    if (base < 0 || base >= TRACK_CHAIN_COUNT) return false;
    if (chainViewMfx || chainViewMfxPending) {
        /* From Master FX, a Track tap goes to that Track's chain (openChainView
         * closes the overlay first). */
        openChainView(base);
        return true;
    }
    const alt = base + TRACK_CHAIN_COUNT;
    let target = base;
    if (chainViewSlot === base && alt < chainSlotCount()) target = alt;
    openChainView(target);
    return true;
}

function tickLongPressHolds() {
    if (longPressHolds.size === 0) return;
    const now = Date.now();
    for (const [cc, hold] of longPressHolds) {
        if (!hold.fired && now - hold.startTime >= LONG_PRESS_HOLD_MS) {
            hold.fired = true;
            fireLongPressAction(cc);
        }
    }
}

/* ---- Performance knobs: Schwung parameters on Move's 8 knobs --------------
 *
 * In Performance (not under a chain view, which cedes the knobs), each knob
 * can drive one parameter of one Schwung chain -- any component (synth, MIDI
 * FX, audio FX) of any of the 8 chains. Mappings live in the SETLIST
 * (setlist.knobs[0..7]); a song entry may OVERRIDE a knob (entry.knobs[i]: a
 * mapping of its own, or {off:true}; absent = use the setlist's). Values are
 * restored: when a song loads, every knob's saved value is written back to its
 * parameter, and turning a knob saves into the CURRENT song -- in its override
 * (mapping.value) or, for a setlist knob, in entry.knob_values[i] = {ref,
 * value}, falling back to the setlist mapping's own value.
 *
 * Writes go to the chain through the shim's param channel, the same
 * "<component>:<key>" keys the chain editor writes (shadow_set_param_timeout:
 * a plain set is fire-and-forget under overtake and dropped when the channel
 * is busy). Ranges, steps and options come from the component's own
 * chain_params -- a module that publishes none offers no parameters rather
 * than an invented 0..1 knob.
 *
 * Master FX and the two send buses (Send A/B) are further targets -- "bus"
 * targets -- stored as negative slots: MASTER_FX_TARGET (-1), Send A (-2) and
 * Send B (-3). A bus's positions are addressed on the shim as
 * "<bus>:fx<N>:<key>" at IPC slot 0 (bus "master_fx", "send1" or "send2"),
 * with "<bus>:fx<N>:name" serving the module id (NOT the slot chain's
 * "<comp>_module" spelling, which the buses do not serve). The sends are
 * offered only when Schwung serves them (see sendBusesAvailable).
 *
 * Each chain, and each send, also has "Settings" (SETTINGS_COMP): not a
 * module but the mixer values Schwung's Slot Settings page turns -- a chain's
 * volume, pan, mute, solo and send levels, a send's return level. Their keys
 * are stored whole ("slot:volume", "send1:return") and always present, so a
 * Settings knob never reads "not loaded".
 *
 * A mapping stores the module id it was made against. Chains belong to the
 * Move Set, so a Set change (or a module swap) can put a different module
 * there: such a knob reads "not loaded" and writes NOTHING, rather than
 * writing a number meant for another module's parameter. */
const KNOB_COUNT = 8;                /* Move's physical knobs */
/* Knob banks: Sample (Rec) switches which of 4 sets of 8 mappings Move's
 * knobs drive, in Perform and on the Knobs screen. Bank b's knob k is stored
 * at index b * KNOB_COUNT + k of setlist.knobs / a song's knobs and
 * knob_values, so existing setlists (8 entries) are bank 1. Each bank lights
 * the knobs with its own colour sweep (the Control module's four) showing
 * each knob's value, and Sample in the bank's colour. */
const KNOB_BANKS = 4;
const KNOB_SLOTS = KNOB_COUNT * KNOB_BANKS;
const KNOB_BANK_SWEEPS = [
    [0, 117, 124, 119, 123, 118, 121, 122, 120],   /* neutral */
    [33, 16, 15, 14, 11, 8, 3, 2],                  /* rainbow */
    [104, 105, 20, 21, 23, 26, 25],                 /* synthwave */
    [124, 35, 23, 26, 25]                           /* rose */
];
const KNOB_BANK_COLOURS = [120, 11, 21, 25];   /* White, Neon Green, Hot Magenta (violet), Bright Pink */
let perfKnobBank = 0;
let knobEditBank = 0;
const MASTER_FX_TARGET = -1;         /* mapping.slot for Master FX */
const SEND_A_TARGET = -2;            /* mapping.slot for Send A; Send B is -3 */
const SEND_BUS_COUNT = 2;
const BUS_FX_POSITIONS = 8;          /* Master FX and each send */
const SETTINGS_COMP = "settings";    /* mapping.comp (and .module) for Settings */
const OFF_ON = ["Off", "On"];
/* As Schwung's Slot Settings and Control module declare them. */
const CHAIN_SETTINGS_PARAMS = [
    { key: "slot:volume", name: "Volume", type: "float", min: 0, max: 2, step: 0.01 },
    { key: "slot:pan", name: "Pan", type: "float", min: -1, max: 1, step: 0.02 },
    { key: "slot:muted", name: "Mute", type: "enum", options: OFF_ON },
    { key: "slot:soloed", name: "Solo", type: "enum", options: OFF_ON }
];
const CHAIN_SEND_PARAMS = [
    { key: "buses:main_send1", name: "Send A", type: "int", min: 0, max: 127 },
    { key: "buses:main_send2", name: "Send B", type: "int", min: 0, max: 127 }
];
const KNOB_SAVE_DELAY_MS = 1500;     /* batch flash writes while a knob turns */
const KNOB_SHOW_MS = 1500;           /* feedback after the last turn */
const KNOB_WRITES_PER_TICK = 4;      /* each is one param round trip (~3 ms) */
const KNOB_WRITE_RETRIES = 20;
const KNOB_PARAM_TYPES = new Set(["float", "int", "enum", "bool"]);
/* A knob can also step through a module's user presets ("My Presets" in
 * Schwung's chain editor): not a module parameter but files under
 * USER_PRESET_ROOT/<module-id>/<name>.json, each holding the component's
 * whole state. Loading one writes that state to "<comp>:state", as
 * Schwung's own preset browser does. The mapping's key is this pseudo key
 * and its value the preset's name. */
const USER_PRESET_KEY = "__user_preset";
const USER_PRESET_ROOT = "/data/UserData/schwung/presets";
let perfKnobs = new Array(KNOB_SLOTS).fill(null);   /* resolved, all banks; see applyPerfKnobs */
let perfKnobsKey = "";               /* which setlist+song perfKnobs was built for */
const knobWriteQueue = new Map();    /* knob index -> { slot, fullKey, value, tries } */
const knobMetaCache = new Map();     /* "slot|comp|module" -> { list, byKey } */
/* Preset names by number, for a module's own presets mapped to a knob:
 * "slot|comp|module|key|value" -> name. Learned by reading the module's
 * name parameter while that preset is the one loaded (presetNameReads). */
const presetNameCache = new Map();
/* Name reads due after a preset knob's write:
 * { due, slot, comp, meta, value, knob (write-queue index), current() }. */
const presetNameReads = [];
const knobEnumAcc = new Array(KNOB_COUNT).fill(0);
const knobTouched = new Array(KNOB_COUNT).fill(false);
let knobSaveDue = 0;                 /* Date.now() after which currentSetlist is saved */
let knobShowIndex = -1;
let knobShowUntil = 0;
/* The knob slot (bank * 8 + knob) the feedback shows when an outside change
 * put it up -- possibly in another bank; -1 = this bank's knobShowIndex. */
let knobShowSlot = -1;

function knobRef(m) {
    return m.slot + "|" + m.comp + "|" + m.key;
}

function knobMappedCount(list) {
    if (!Array.isArray(list)) return 0;
    return list.filter(m => m && typeof m.key === "string").length;
}

function knobOverrideCount(entry) {
    if (!entry || !Array.isArray(entry.knobs)) return 0;
    return entry.knobs.filter(o => o && (o.off || typeof o.key === "string")).length;
}

function isMasterFxSlot(slot) {
    return slot === MASTER_FX_TARGET;
}

/* Send A/B: 0 / 1, else -1. */
function sendBusIndex(slot) {
    const i = SEND_A_TARGET - slot;
    return i >= 0 && i < SEND_BUS_COUNT ? i : -1;
}

/* Master FX or a send: a bus of FX positions rather than a chain. */
function isBusSlot(slot) {
    return isMasterFxSlot(slot) || sendBusIndex(slot) >= 0;
}

/* The shim's key prefix for a bus: "master_fx" / "send1" / "send2". */
function busPrefix(slot) {
    return isMasterFxSlot(slot) ? "master_fx" : "send" + (sendBusIndex(slot) + 1);
}

/* The shim's IPC slot and key for a component's own key: a chain addresses
 * "<comp>:<key>" at its slot, a bus "<bus>:<comp>:<key>" at slot 0. */
function knobIpcSlot(slot) {
    return isBusSlot(slot) ? 0 : slot;
}

function compKey(slot, comp, key) {
    if (comp === SETTINGS_COMP) return key;
    return (isBusSlot(slot) ? busPrefix(slot) + ":" : "") + comp + ":" + key;
}

function readCompParam(slot, comp, key) {
    return readChainSlotParam(knobIpcSlot(slot), compKey(slot, comp, key));
}

function compModuleKey(comp) {
    return comp === "synth" ? "synth_module" : comp + "_module";
}

/* Where a mapping points, for screens: "Chain 1" / "Master FX" / "Send A". */
function knobTargetName(slot) {
    if (isMasterFxSlot(slot)) return "Master FX";
    const send = sendBusIndex(slot);
    if (send >= 0) return "Send " + "AB"[send];
    return "Chain " + (slot + 1);
}

/* The short form for list rows: "C1" / "MFX" / "SndA". */
function knobTargetShort(slot) {
    if (isMasterFxSlot(slot)) return "MFX";
    const send = sendBusIndex(slot);
    if (send >= 0) return "Snd" + "AB"[send];
    return "C" + (slot + 1);
}

function compLabel(comp) {
    if (comp === SETTINGS_COMP) return "Settings";
    if (comp === "synth") return "Synth";
    const mfx = /^midi_fx(\d+)$/.exec(comp);
    if (mfx) return "MIDI FX " + mfx[1];
    const fx = /^fx(\d+)$/.exec(comp);
    return fx ? "FX " + fx[1] : comp;
}

/* The module in a chain position: a module id, "" for an empty position, or
 * null when the read did not complete (never taken for "empty"). */
function readCompModule(slot, comp) {
    if (comp === SETTINGS_COMP) return SETTINGS_COMP;
    if (isBusSlot(slot)) return readCompParam(slot, comp, "name");
    return readChainSlotParam(slot, compModuleKey(comp));
}

/* A chain's or send's Settings parameters; Master FX has none. */
function settingsMeta(slot) {
    let list = [];
    const send = sendBusIndex(slot);
    if (send >= 0) {
        list = [{ key: "send" + (send + 1) + ":return", name: "Return", type: "int", min: 0, max: 127 }];
    } else if (!isMasterFxSlot(slot)) {
        list = CHAIN_SETTINGS_PARAMS.concat(sendBusesAvailable() ? CHAIN_SEND_PARAMS : []);
    }
    return { list, byKey: new Map(list.map(p => [p.key, p])) };
}

/* The Settings entry in a chain's or send's component list. */
function settingsCompItem() {
    return { label: "Settings", value: "", action: "comp", comp: SETTINGS_COMP,
             module: SETTINGS_COMP, moduleName: "" };
}

/* A component's editable parameters from its chain_params, cached per module.
 * null = not available (no answer, or nothing parseable); a failure is not
 * cached, so the next look retries. */
function readCompMeta(slot, comp, moduleId) {
    if (comp === SETTINGS_COMP) return settingsMeta(slot);
    const cacheKey = slot + "|" + comp + "|" + moduleId;
    if (knobMetaCache.has(cacheKey)) return withUserPresets(knobMetaCache.get(cacheKey), slot, moduleId);
    const raw = readCompParam(slot, comp, "chain_params");
    if (raw === null) return null;
    let arr = null;
    try { arr = raw ? JSON.parse(raw) : []; } catch (e) { arr = null; }
    if (!Array.isArray(arr)) return null;
    const list = [];
    const byKey = new Map();
    for (const p of arr) {
        if (!p || typeof p.key !== "string" || !KNOB_PARAM_TYPES.has(p.type)) continue;
        if (p.type === "enum" && !(Array.isArray(p.options) && p.options.length > 0)) continue;
        list.push(p);
        byKey.set(p.key, p);
    }
    /* The module's own presets: a ui_hierarchy level with a list_param is a
     * preset browser, and its name_param names the preset loaded -- so a
     * knob on that parameter can show the name, not the number. A module
     * whose chain_params leaves the preset out still gets it, as a number
     * from 0 to its count. */
    const hierRaw = readCompParam(slot, comp, "ui_hierarchy");
    let hier = null;
    try { hier = hierRaw ? JSON.parse(hierRaw) : null; } catch (e) { hier = null; }
    const levels = hier && hier.levels && typeof hier.levels === "object" ? Object.values(hier.levels) : [];
    for (const lvl of levels) {
        if (!lvl || typeof lvl.list_param !== "string" || !lvl.list_param) continue;
        const key = lvl.list_param;
        const nameParam = typeof lvl.name_param === "string" && lvl.name_param ? lvl.name_param : "preset_name";
        let p = byKey.get(key);
        if (!p) {
            const count = lvl.count_param ? parseInt(readCompParam(slot, comp, lvl.count_param), 10) : NaN;
            p = { key, name: "Preset", type: "int", min: 0, max: Number.isFinite(count) && count > 0 ? count - 1 : 127 };
        } else {
            list.splice(list.indexOf(p), 1);
            p = Object.assign({}, p);
        }
        /* First in the picker: it is what a preset knob is usually for. */
        list.unshift(p);
        p.name_param = nameParam;
        p.name_ref = cacheKey + "|" + key;
        byKey.set(key, p);
    }
    const meta = { list, byKey };
    /* A hierarchy that did not answer is retried next time. */
    if (hierRaw !== null) knobMetaCache.set(cacheKey, meta);
    return withUserPresets(meta, slot, moduleId);
}

/* A preset knob's value as its preset's name, once known. */
function presetNameFor(meta, value) {
    if (!meta || !meta.name_ref || value === null || value === undefined) return null;
    return presetNameCache.get(meta.name_ref + "|" + String(parseInt(value, 10))) || null;
}

/* Read the name of the preset now loaded, for `value`. Only kept while the
 * knob still sits on that value: the name parameter names what is loaded,
 * and a turn since would make it another preset's. */
function readPresetName(slot, comp, meta, value) {
    const name = readCompParam(slot, comp, meta.name_param);
    if (typeof name === "string" && name.trim()) {
        presetNameCache.set(meta.name_ref + "|" + String(parseInt(value, 10)), name.trim());
        needsRedraw = true;
    }
}

/* After a preset knob's write: read the name on the next tick, and again a
 * little later for a module that loads its preset in the background. */
function schedulePresetName(m, meta, value, knob, current) {
    if (!meta || !meta.name_param) return;
    const now = Date.now();
    for (const delay of [0, 400]) {
        presetNameReads.push({ due: now + delay, slot: m.slot, comp: m.comp, meta, value: String(value), knob, current });
    }
}

function flushPresetNameReads() {
    if (presetNameReads.length === 0) return;
    const now = Date.now();
    for (let i = 0; i < presetNameReads.length; i++) {
        const r = presetNameReads[i];
        if (r.due > now) continue;
        presetNameReads.splice(i--, 1);
        /* Still the knob's value, and its write has landed. */
        const cur = r.current ? r.current() : r.value;
        if (cur === null || cur === undefined || String(cur) !== r.value) continue;
        if (knobWriteQueue.has(r.knob)) { r.due = now + 50; presetNameReads.push(r); continue; }
        readPresetName(r.slot, r.comp, r.meta, r.value);
        break;   /* one read a tick: each is a round trip */
    }
}

/* A module's user presets, sorted by name as Schwung lists them:
 * [{name, file}]. Read fresh each time, so presets saved since show up. */
function listUserPresets(moduleId) {
    if (!moduleId || typeof os.readdir !== "function") return [];
    const dir = USER_PRESET_ROOT + "/" + moduleId;
    let names = [];
    try {
        const raw = os.readdir(dir);
        names = Array.isArray(raw) ? (Array.isArray(raw[0]) ? raw[0] : raw) : [];
    } catch (e) { return []; }
    const out = [];
    for (const f of names) {
        if (typeof f !== "string" || !f.endsWith(".json")) continue;
        let name = f.replace(/\.json$/, "");
        try {
            const txt = host_read_file(dir + "/" + f);
            const m = txt ? txt.match(/"name"\s*:\s*"([^"]+)"/) : null;
            if (m && m[1]) name = m[1];
        } catch (e) { /* keep the file name */ }
        out.push({ name, file: f });
    }
    out.sort((a, b) => a.name.toLowerCase() < b.name.toLowerCase() ? -1 : (a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0));
    return out;
}

/* The component's parameters plus, when its module has user presets (chain
 * components; not Master FX or the sends), a "My Presets" entry: an option
 * per preset. */
function withUserPresets(meta, slot, moduleId) {
    if (isBusSlot(slot)) return meta;
    const presets = listUserPresets(moduleId);
    if (presets.length === 0) return meta;
    const up = { key: USER_PRESET_KEY, name: "My Presets", type: "enum", user_preset: true,
                 options: presets.map(p => p.name), files: presets };
    const byKey = new Map(meta.byKey);
    byKey.set(USER_PRESET_KEY, up);
    /* After the module's own Preset (see readCompMeta), ahead of the rest. */
    const own = meta.list.filter(p => p.name_param);
    return { list: own.concat([up], meta.list.filter(p => !p.name_param)), byKey };
}

/* A user preset's state as the string to write to "<comp>:state", or null. */
function readUserPresetState(moduleId, name) {
    const p = listUserPresets(moduleId).find(x => x.name === name);
    if (!p) return null;
    let obj = null;
    try { obj = JSON.parse(host_read_file(USER_PRESET_ROOT + "/" + moduleId + "/" + p.file)); } catch (e) { return null; }
    if (!obj || (obj.module && obj.module !== moduleId) || obj.state === undefined) return null;
    return typeof obj.state === "string" ? obj.state : JSON.stringify(obj.state);
}

/* What a mapped parameter is set to now, read from the chain; a user preset
 * has no readable value, so it starts from "none" (see knobStepValue). */
function readKnobLive(m) {
    if (m.key === USER_PRESET_KEY) return "";
    return readCompParam(m.slot, m.comp, m.key);
}

function knobOptions(meta) {
    if (Array.isArray(meta.options) && meta.options.length > 0) return meta.options;
    return meta.type === "bool" ? ["0", "1"] : null;
}

function knobDecimals(step) {
    if (!(step > 0) || step >= 1) return 0;
    return Math.min(4, Math.ceil(-Math.log10(step) - 1e-9));
}

/* One knob turn applied to a parameter value. Returns the new value in the
 * form the plugin uses (an option name or an index, for enums), or null when
 * it does not change. */
/* Knob detents per list item -- an enum's option, My Presets, or a module's
 * own Preset -- so a list is stepped through deliberately rather than
 * skidding past the item you wanted. */
const KNOB_LIST_DETENTS = 4;

/* Items a list knob moves for this detent `delta`: detents gather until
 * there are KNOB_LIST_DETENTS of them; turning back starts afresh, so a
 * reversal answers as quickly as the first turn. */
function knobListSteps(knob, delta) {
    if (Math.sign(delta) !== Math.sign(knobEnumAcc[knob])) knobEnumAcc[knob] = 0;
    knobEnumAcc[knob] += delta;
    const steps = Math.trunc(knobEnumAcc[knob] / KNOB_LIST_DETENTS);
    knobEnumAcc[knob] -= steps * KNOB_LIST_DETENTS;
    return steps;
}

function knobStepValue(meta, cur, delta, knob) {
    const options = knobOptions(meta);
    if (options) {
        let idx = options.indexOf(String(cur));
        /* A user preset knob with none chosen yet starts before the first. */
        const usesIndex = idx < 0 && !meta.user_preset;
        if (usesIndex) {
            const n = parseInt(cur, 10);
            idx = Number.isFinite(n) && n >= 0 && n < options.length ? n : 0;
        }
        const steps = knobListSteps(knob, delta);
        if (steps === 0) return null;
        const next = Math.max(0, Math.min(options.length - 1, idx + steps));
        if (next === idx || next < 0) return null;
        return usesIndex ? String(next) : options[next];
    }
    const num = parseFloat(cur);
    if (!Number.isFinite(num)) return null;
    const min = Number.isFinite(meta.min) ? meta.min : (meta.type === "int" ? 0 : 0);
    const max = Number.isFinite(meta.max) ? meta.max : (meta.type === "int" ? 127 : 1);
    let step = meta.step > 0 ? meta.step : (meta.type === "int" ? 1 : (max - min) / 100);
    if (!(step > 0)) step = 0.01;
    /* A module's own presets are a list too. */
    if (meta.name_param) {
        delta = knobListSteps(knob, delta);
        if (delta === 0) return null;
    }
    let next = Math.max(min, Math.min(max, num + delta * step));
    if (meta.type === "int") {
        next = Math.round(next);
        return next === Math.round(num) ? null : String(next);
    }
    const out = next.toFixed(knobDecimals(step));
    return parseFloat(out) === num ? null : out;
}

function formatKnobValue(meta, value) {
    if (value === null || value === undefined || value === "") return "—";
    const preset = presetNameFor(meta, value);
    if (preset) return preset;
    const options = meta ? knobOptions(meta) : null;
    if (options) {
        if (options.indexOf(String(value)) >= 0) return String(value);
        const n = parseInt(value, 10);
        return (Number.isFinite(n) && options[n] !== undefined) ? String(options[n]) : String(value);
    }
    const num = parseFloat(value);
    if (!Number.isFinite(num)) return String(value);
    const step = meta && meta.step > 0 ? meta.step : (meta && meta.type === "int" ? 1 : 0.01);
    const text = num.toFixed(meta && meta.type === "int" ? 0 : knobDecimals(step));
    return meta && meta.unit ? text + " " + meta.unit : text;
}

/* Which mapping a knob has for a song: the song's override, else the
 * setlist's. source "song" | "setlist"; null = unassigned (or turned off by
 * the song). */
function knobMappingFor(setlist, entry, i) {
    const o = entry && Array.isArray(entry.knobs) ? entry.knobs[i] : null;
    if (o && o.off) return null;
    if (o && typeof o.key === "string") return { m: o, source: "song" };
    const m = setlist && Array.isArray(setlist.knobs) ? setlist.knobs[i] : null;
    return (m && typeof m.key === "string") ? { m, source: "setlist" } : null;
}

function knobSavedValue(entry, i, res) {
    if (res.source === "setlist" && entry && Array.isArray(entry.knob_values)) {
        const v = entry.knob_values[i];
        if (v && v.ref === knobRef(res.m) && v.value !== undefined) return v.value;
    }
    return res.m.value !== undefined ? res.m.value : null;
}

function storeKnobValue(entry, i, res, value) {
    if (res.source === "setlist" && entry) {
        if (!Array.isArray(entry.knob_values)) entry.knob_values = [];
        entry.knob_values[i] = { ref: knobRef(res.m), value };
    } else {
        res.m.value = value;
    }
}

/* A mapping checked against what is loaded now. status: "ok", "missing"
 * (another module, or none, in that position) or "unknown" (no answer). */
function resolveKnob(res, moduleCache) {
    const m = res.m;
    const ck = m.slot + "|" + m.comp;
    let mod = moduleCache ? moduleCache.get(ck) : undefined;
    if (mod === undefined) {
        mod = readCompModule(m.slot, m.comp);
        if (moduleCache) moduleCache.set(ck, mod);
    }
    if (mod === null) return { res, meta: null, status: "unknown" };
    if (mod !== m.module) return { res, meta: null, status: "missing" };
    const all = readCompMeta(m.slot, m.comp, mod);
    const meta = all ? all.byKey.get(m.key) : null;
    return { res, meta: meta || null, status: meta ? "ok" : (all ? "missing" : "unknown") };
}

function queueKnobWrite(i, m, value) {
    if (m.key === USER_PRESET_KEY) {
        /* Load the named preset: its whole state to "<comp>:state". */
        const state = readUserPresetState(m.module, String(value));
        if (state === null) { logDebug("knobs: user preset \"" + value + "\" not readable for " + m.module); return; }
        knobWriteQueue.set(i, { slot: knobIpcSlot(m.slot), fullKey: compKey(m.slot, m.comp, "state"),
            value: state, tries: 0 });
        return;
    }
    knobWriteQueue.set(i, { slot: knobIpcSlot(m.slot), fullKey: compKey(m.slot, m.comp, m.key),
        value: String(value), tries: 0 });
}

function flushKnobWrites() {
    if (knobWriteQueue.size === 0) return;
    let n = 0;
    for (const [i, w] of knobWriteQueue) {
        if (n++ >= KNOB_WRITES_PER_TICK) break;
        let ok = false;
        try {
            if (typeof shadow_set_param_timeout === "function") {
                ok = shadow_set_param_timeout(w.slot, w.fullKey, w.value, 50) === true;
            } else if (typeof shadow_set_param === "function") {
                ok = shadow_set_param(w.slot, w.fullKey, w.value) === true;
            }
        } catch (e) { ok = false; }
        if (ok || ++w.tries >= KNOB_WRITE_RETRIES) {
            if (!ok) logDebug("knobs: gave up writing " + w.fullKey + " at slot " + w.slot);
            knobWriteQueue.delete(i);
        }
    }
}

function markKnobSave() {
    knobSaveDue = Date.now() + KNOB_SAVE_DELAY_MS;
}

function flushKnobSave(now) {
    if (!knobSaveDue || (now !== undefined && now < knobSaveDue)) return;
    knobSaveDue = 0;
    if (currentSetlist) saveSetlist(currentSetlist);
}

/* Build perfKnobs for the current song and write back its saved values. Runs
 * when a song loads; `force` re-resolves the same song (after a resume or a
 * chain view, when a module may have changed). */
function applyPerfKnobs(force) {
    const entry = currentSetlist ? currentSetlist.songs[perfSongIndex] : null;
    const key = (currentSetlist ? (currentSetlist.path || currentSetlist.name) : "") + "#" + perfSongIndex;
    if (!force && key === perfKnobsKey) return;
    perfKnobsKey = key;
    knobWriteQueue.clear();
    knobEnumAcc.fill(0);
    const modules = new Map();
    for (let i = 0; i < KNOB_SLOTS; i++) {
        const res = currentSetlist ? knobMappingFor(currentSetlist, entry, i) : null;
        if (!res) { perfKnobs[i] = null; continue; }
        const k = resolveKnob(res, modules);
        k.value = knobSavedValue(entry, i, res);
        perfKnobs[i] = k;
        if (k.status === "ok" && k.value !== null) {
            queueKnobWrite(i, res.m, k.value);
            schedulePresetName(res.m, k.meta, k.value, i, () => perfKnobs[i] && perfKnobs[i].value);
        }
    }
}

/* Re-resolve the current song's knobs WITHOUT writing their saved values:
 * after a chain view or a resume the user may have changed those parameters
 * elsewhere, and that is what the knobs should now continue from. */
function refreshPerfKnobs() {
    const entry = currentSetlist ? currentSetlist.songs[perfSongIndex] : null;
    perfKnobsKey = (currentSetlist ? (currentSetlist.path || currentSetlist.name) : "") + "#" + perfSongIndex;
    knobWriteQueue.clear();
    const modules = new Map();
    for (let i = 0; i < KNOB_SLOTS; i++) {
        const res = currentSetlist ? knobMappingFor(currentSetlist, entry, i) : null;
        if (!res) { perfKnobs[i] = null; continue; }
        const k = resolveKnob(res, modules);
        k.value = null;
        if (k.status === "ok") {
            const live = readKnobLive(res.m);
            k.value = live ? live : knobSavedValue(entry, i, res);
            /* A preset knob: name the preset loaded now. */
            if (live && k.meta && k.meta.name_param && !presetNameFor(k.meta, live)) readPresetName(res.m.slot, res.m.comp, k.meta, live);
        }
        perfKnobs[i] = k;
    }
    needsRedraw = true;
}

/* Perform and Jam recording: Record toggles Schwung's own sampler, recording
 * the Schwung mix ("Resample") to a WAV under RECORDINGS_DIR -- the same
 * host_sampler_* calls Schwung's Song Mode tool uses. Independent of
 * playback, so a set can be recorded across several Play/Stops. Stops when
 * leaving Perform or Jam. The file is named after the setlist, or the Jam
 * folder. */
const RECORDINGS_DIR = "/data/UserData/UserLibrary/Recordings/Arranger";
let perfRecording = false;

function perfRecordingAvailable() {
    return typeof host_sampler_start === "function" && typeof host_sampler_stop === "function";
}

function perfToggleRecording(label) {
    if (perfRecording) { perfStopRecording(); return; }
    if (!perfRecordingAvailable()) {
        showPopup("Recording", "Not available on this Schwung", 3000);
        needsRedraw = true;
        return;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").substring(0, 19);
    const name = safeFileName(label || "set");
    const path = RECORDINGS_DIR + "/" + name + "_" + stamp + ".wav";
    try { ensureDir(RECORDINGS_DIR); } catch (e) {}
    if (typeof host_sampler_set_source === "function") host_sampler_set_source(0); /* Schwung mix */
    host_sampler_start(path);
    perfRecording = true;
    logDebug("PERFREC start path=" + path);
    showPopup("Recording", name + "_" + stamp + ".wav", 3000);
    needsRedraw = true;
}

function perfStopRecording() {
    if (!perfRecording) return;
    host_sampler_stop();
    perfRecording = false;
    logDebug("PERFREC stop");
    showPopup("Recording saved", "In Recordings / Arranger", 3000);
    needsRedraw = true;
}

/* Back out of Performance to the setlist picker (Move Set check: Back). */
function leavePerformanceToSetlists() {
    perfStopRecording();
    perfStop();
    flushKnobSave();
    menuStack.pop();
    currentView = VIEW_PERF_SETLIST;
    needsRedraw = true;
    ledDirtyAll = true;
}

function showKnob(i) {
    knobShowIndex = i;
    knobShowSlot = -1;
    knobShowUntil = Date.now() + KNOB_SHOW_MS;
    needsRedraw = true;
}

/* ---- Following outside changes (Remote UI, Schwung's editor, ...) ----
 *
 * A mapped parameter changed anywhere but on Move's knobs -- most often the
 * Remote UI -- is taken up as that knob's value for the current song, as a
 * turn would be: saved, on the knob light, and in the feedback at the foot
 * of the display.
 *
 * A Schwung with the param change feed (shadow_param_changes: every completed
 * set, from any client, read from shared memory with no round trip) is
 * followed from that, every tick, at no read cost; a change the feed lost
 * sends Perform back over every mapped knob once. Without the feed, Perform
 * reads the mapped parameters back: one knob every
 * KNOB_POLL_MS in turn (each read is a ~3 ms round trip), and the knob that
 * last changed every KNOB_POLL_HOT_MS for KNOB_POLL_HOT_HOLD_MS after, so a
 * drag in the browser is followed closely. A knob with a write of ours still
 * queued is skipped: what it reads is about to change. */
const KNOB_POLL_MS = 120;
const KNOB_POLL_HOT_MS = 45;
const KNOB_POLL_HOT_HOLD_MS = 2000;
let knobPollNext = 0;          /* round-robin position over KNOB_SLOTS */
let knobPollDue = 0;
let knobPollHotSlot = -1;
let knobPollHotUntil = 0;
let knobPollHotDue = 0;

/* Two values of a parameter are the same knob position: compared as the
 * feedback shows them, so float noise ("0.55" / "0.5500") is not a change. */
function knobValuesMatch(meta, a, b) {
    if (a === null || a === undefined || b === null || b === undefined) return a === b;
    return formatKnobValue(meta, a) === formatKnobValue(meta, b);
}

/* Read knob slot `s` back; if its parameter moved, take the new value.
 * Returns true when it changed. */
function pollPerfKnob(s) {
    const k = perfKnobs[s];
    if (!k || k.status !== "ok" || !k.meta || knobWriteQueue.has(s)) return false;
    if (k.res.m.key === USER_PRESET_KEY) return false;   /* a preset has no readable value */
    return adoptPerfKnobValue(s, readKnobLive(k.res.m));
}

/* Knob slot `s`'s parameter is now `live`: if that moved it, take it. */
function adoptPerfKnobValue(s, live) {
    const k = perfKnobs[s];
    if (!k || k.status !== "ok" || !k.meta || knobWriteQueue.has(s)) return false;
    if (live === null || live === undefined || live === "") return false;
    live = String(live);
    /* A knob with nothing saved yet notes where it is first, and follows from
     * there; it is not a change. */
    if (k.value === null) {
        if (k.polled === undefined) { k.polled = live; return false; }
        if (knobValuesMatch(k.meta, k.polled, live)) return false;
    } else if (knobValuesMatch(k.meta, k.value, live)) {
        return false;
    }
    k.value = live;
    k.polled = live;
    const entry = currentSetlist ? currentSetlist.songs[perfSongIndex] : null;
    storeKnobValue(entry, s, k.res, live);
    markKnobSave();
    if (!knobTouched[s % KNOB_COUNT] || Math.floor(s / KNOB_COUNT) !== perfKnobBank) {
        knobShowIndex = s % KNOB_COUNT;
        knobShowSlot = s;
        knobShowUntil = Date.now() + KNOB_SHOW_MS;
    }
    needsRedraw = true;
    return true;
}

/* The param change feed's position; null = not following (start from the
 * newest change when Perform is next shown). */
let knobFeedSeq = null;
/* Mapped knobs still to re-read after the feed lost changes. */
let knobFeedResync = 0;

/* The knob slots a set of (slot, key) addresses: a chain parameter at its
 * chain's slot, a bus (Master FX, a send) parameter at any. */
function perfKnobSlotsFor(slot, key) {
    const out = [];
    for (let s = 0; s < KNOB_SLOTS; s++) {
        const k = perfKnobs[s];
        if (!k || k.status !== "ok") continue;
        const m = k.res.m;
        if (m.key === USER_PRESET_KEY || compKey(m.slot, m.comp, m.key) !== key) continue;
        if (isBusSlot(m.slot) || knobIpcSlot(m.slot) === slot) out.push(s);
    }
    return out;
}

/* Follow the feed: true when it is there to follow (else poll). */
function followPerfKnobFeed() {
    if (typeof shadow_param_changes !== "function") return false;
    let r;
    try { r = shadow_param_changes(knobFeedSeq === null ? -1 : knobFeedSeq); } catch (e) { r = null; }
    if (!r) return false;
    if (knobFeedSeq === null) { knobFeedSeq = r.seq; return true; }   /* from now on */
    knobFeedSeq = r.seq;
    if (chainViewActive()) return true;   /* the editor's; refreshPerfKnobs takes it after */
    if (r.lost) knobFeedResync = KNOB_SLOTS;
    for (const c of r.changes || []) {
        for (const s of perfKnobSlotsFor(c.slot, c.key)) {
            /* Too long for the feed: read the parameter itself. */
            if (c.truncated) pollPerfKnob(s);
            else adoptPerfKnobValue(s, c.value);
        }
    }
    /* After a loss, every mapped knob once -- one a tick. */
    while (knobFeedResync > 0) {
        const s = KNOB_SLOTS - knobFeedResync--;
        if (perfKnobs[s] && perfKnobs[s].status === "ok") { pollPerfKnob(s); break; }
    }
    return true;
}

/* Once per tick in Perform. */
function pollPerfKnobs(now) {
    if (currentView !== VIEW_PERFORMANCE) { knobFeedSeq = null; return; }
    if (followPerfKnobFeed()) return;
    if (chainViewActive()) return;
    if (knobPollHotSlot >= 0 && now < knobPollHotUntil && now >= knobPollHotDue) {
        knobPollHotDue = now + KNOB_POLL_HOT_MS;
        if (pollPerfKnob(knobPollHotSlot)) knobPollHotUntil = now + KNOB_POLL_HOT_HOLD_MS;
        return;   /* one read a tick */
    }
    if (now < knobPollDue) return;
    knobPollDue = now + KNOB_POLL_MS;
    /* The next mapped knob, this bank's first. */
    for (let n = 0; n < KNOB_SLOTS; n++) {
        const s = (perfKnobBank * KNOB_COUNT + knobPollNext) % KNOB_SLOTS;
        knobPollNext = (knobPollNext + 1) % KNOB_SLOTS;
        const k = perfKnobs[s];
        if (!k || k.status !== "ok") continue;
        if (pollPerfKnob(s)) {
            knobPollHotSlot = s;
            knobPollHotUntil = now + KNOB_POLL_HOT_HOLD_MS;
            knobPollHotDue = now + KNOB_POLL_HOT_MS;
        }
        return;
    }
}

/* A knob turned in Performance. */
function turnPerfKnob(i, delta) {
    const slot = perfKnobBank * KNOB_COUNT + i;   /* this bank's knob i */
    const k = perfKnobs[slot];
    showKnob(i);
    if (!k || k.status !== "ok" || !delta) return;
    const m = k.res.m;
    if (k.value === null) {
        /* Nothing saved yet: start from what the parameter is now. */
        const cur = readKnobLive(m);
        if (cur === null || (cur === "" && m.key !== USER_PRESET_KEY)) return;
        k.value = cur;
    }
    const next = knobStepValue(k.meta, k.value, delta, i);
    if (next === null) return;
    k.value = next;
    queueKnobWrite(slot, m, next);
    schedulePresetName(m, k.meta, next, slot, () => perfKnobs[slot] && perfKnobs[slot].value);
    const entry = currentSetlist ? currentSetlist.songs[perfSongIndex] : null;
    storeKnobValue(entry, slot, k.res, next);
    markKnobSave();
}

/* Bottom-of-screen feedback while a knob is touched or just turned: what the
 * knob drives (chain or Master FX, component and module) above the parameter
 * and its value. */
function perfKnobFeedbackVisible() {
    const i = knobShowIndex;
    return i >= 0 && (Date.now() < knobShowUntil || !!knobTouched[i]);
}

/* A chain slot's name -- its preset's -- from Schwung's slot list (shared
 * memory, no round trip); "" when it has none or the host cannot say. */
function chainSlotName(slot) {
    try {
        const slots = typeof shadow_get_slots === "function" ? shadow_get_slots() : null;
        const s = Array.isArray(slots) ? slots[slot] : null;
        const name = s && typeof s.name === "string" ? s.name.trim() : "";
        return name === "Untitled" ? "" : name;
    } catch (e) { return ""; }
}

/* `pre` + `name` + `post` in `maxPx`, shortening the name (with "..") rather
 * than losing the end of the line. */
function fitWithName(pre, name, post, maxPx) {
    const measure = (t) => (typeof text_width === "function" ? text_width(t) : t.length * 6);
    if (measure(pre + name + post) <= maxPx) return pre + name + post;
    for (let n = name.length - 1; n > 0; n--) {
        const t = pre + name.substring(0, n).trimEnd() + ".." + post;
        if (measure(t) <= maxPx) return t;
    }
    return pre + post.replace(/^ - /, "");
}

function drawPerfKnobFeedback() {
    const i = knobShowIndex;
    if (!perfKnobFeedbackVisible()) return;
    const slot = knobShowSlot >= 0 ? knobShowSlot : perfKnobBank * KNOB_COUNT + i;
    const bank = Math.floor(slot / KNOB_COUNT);
    const k = perfKnobs[slot];
    let where;
    let what;
    let fitted = false;
    if (!k) {
        where = "Bank " + (bank + 1) + " Knob " + (i + 1);
        what = "Unassigned";
    } else {
        const m = k.res.m;
        /* A knob in another bank (changed elsewhere) names its bank. */
        const pre = (bank !== perfKnobBank ? "B" + (bank + 1) + " " : "") + knobTargetShort(m.slot) + " ";
        /* A chain's Settings name the chain by its slot's (preset) name:
         * "C1 Lead Pad - Settings". */
        const slotName = m.comp === SETTINGS_COMP && !isBusSlot(m.slot) ? chainSlotName(m.slot) : "";
        fitted = !!slotName;
        /* Drawn from x=1, so the line has 127 px: Move's spaces are 5 px wide. */
        where = slotName ? fitWithName(pre, slotName, " - " + compLabel(m.comp), 127)
            : pre + compLabel(m.comp) + (m.moduleName ? " " + m.moduleName : "");
        if (k.status === "missing") what = m.label + ": not loaded";
        else if (k.status === "unknown") what = m.label + ": no answer";
        else {
            const v = formatKnobValue(k.meta, k.value);
            /* A preset's name alone when the label would crowd it out. */
            what = presetNameFor(k.meta, k.value) && (m.label + " " + v).length > 21 ? v : m.label + " " + v;
        }
    }
    fill_rect(0, 40, 128, 24, 0);
    fill_rect(0, 40, 128, 1, 1);
    /* A line fitted around a slot name is already measured to fit. */
    if (fitted) print(1, 43, where, 1);
    else print(2, 43, where.length > 21 ? where.substring(0, 21) : where, 1);
    print(2, 54, what.length > 21 ? what.substring(0, 21) : what, 1);
}

/* ---- Knob editing: Setlist Edit > Knobs, and a song's Transitions > Knobs --
 *
 * VIEW_KNOB_MAP lists Knob 1-8 for one scope: the setlist, or one song (whose
 * rows show the setlist's mapping in parentheses while not overridden).
 * Turning a physical knob here edits that knob's saved value at this scope,
 * live on the chain, so the value a song restores is set the same way it is
 * played. Jog click picks a mapping (VIEW_KNOB_PICK: chain, component,
 * parameter); Delete clears it (a song: back to the setlist's). */
let knobEditScope = "setlist";       /* "setlist" | "song" */
let knobEditFocus = 0;
let knobEditReturnView = VIEW_SETLIST_EDIT;
let knobEditKnobs = new Array(KNOB_COUNT).fill(null);  /* resolveKnob() per row */
let knobPickStage = "chain";         /* "chain" | "comp" | "param" */
let knobPickIndex = 0;
let knobPickSlot = 0;
let knobPickComp = "";
let knobPickModule = "";
let knobPickModuleName = "";
let knobPickItems = [];

/* The storage index of Knobs-screen row `row` in the bank being edited. */
function knobEditSlot(row) {
    return knobEditBank * KNOB_COUNT + row;
}

function knobEditEntry() {
    return knobEditScope === "song" && currentSetlist ? currentSetlist.songs[setlistSongIndex] : null;
}

/* The mapping a row edits: the song's view of it (override or inherited) in
 * song scope, the setlist's own in setlist scope. */
function knobEditMapping(i) {
    if (!currentSetlist) return null;
    const s = knobEditSlot(i);
    if (knobEditScope === "song") return knobMappingFor(currentSetlist, knobEditEntry(), s);
    const m = Array.isArray(currentSetlist.knobs) ? currentSetlist.knobs[s] : null;
    return m && typeof m.key === "string" ? { m, source: "setlist" } : null;
}

function refreshKnobEdit() {
    const modules = new Map();
    for (let i = 0; i < KNOB_COUNT; i++) {
        const res = knobEditMapping(i);
        knobEditKnobs[i] = res ? resolveKnob(res, modules) : null;
    }
    needsRedraw = true;
}

function openKnobMap(scope, returnView) {
    knobEditScope = scope;
    knobEditReturnView = returnView;
    knobEditFocus = 0;
    knobEditBank = 0;
    knobEnumAcc.fill(0);
    currentView = VIEW_KNOB_MAP;
    menuStack.push({ title: "Knobs", selectedIndex: 0 });
    refreshKnobEdit();
}

function knobRowLabel(i) {
    const res = knobEditMapping(i);
    const entry = knobEditEntry();
    const o = entry && Array.isArray(entry.knobs) ? entry.knobs[knobEditSlot(i)] : null;
    if (knobEditScope === "song" && o && o.off) return (i + 1) + " Off";
    if (!res) return (i + 1) + " —";
    const name = knobTargetShort(res.m.slot) + " " + res.m.label;
    return (i + 1) + " " + (knobEditScope === "song" && res.source === "setlist" ? "(" + name + ")" : name);
}

function knobRowValue(i) {
    const k = knobEditKnobs[i];
    if (!k) return "";
    if (k.status === "missing") return "not loaded";
    if (k.status === "unknown") return "?";
    return formatKnobValue(k.meta, knobSavedValue(knobEditEntry(), knobEditSlot(i), k.res));
}

function drawKnobMap() {
    const entry = knobEditEntry();
    const title = knobEditScope === "song" && entry ? "Knobs: " + shortSongName(entry.name) : "Knobs: Setlist";
    const bank = "Bank " + (knobEditBank + 1);
    drawMenuHeader(fitHeader(title, bank), bank);
    const items = [];
    for (let i = 0; i < KNOB_COUNT; i++) items.push({ i });
    drawMenuList({
        ...LIST_ROW_FIT,
        labelX: 3,
        items,
        selectedIndex: knobEditFocus,
        getLabel: (item) => knobRowLabel(item.i),
        getValue: (item) => knobRowValue(item.i),
        valueAlignRight: true,
        labelGap: 2,
        prioritizeSelectedValue: true,
        selectedMinLabelChars: 8,
        listArea: { topY: LIST_TOP_Y, bottomY: LIST_INDICATOR_BOTTOM_Y }
    });
}

/* A physical knob turned on the Knobs screen: edit the value this scope
 * restores, and hear it. */
function turnEditKnob(i, delta) {
    knobEditFocus = i;
    needsRedraw = true;
    const k = knobEditKnobs[i];
    if (!k || k.status !== "ok" || !delta) return;
    const m = k.res.m;
    const entry = knobEditEntry();
    const slot = knobEditSlot(i);
    let cur = knobSavedValue(entry, slot, k.res);
    if (cur === null) cur = readKnobLive(m);
    if (cur === null || (cur === "" && m.key !== USER_PRESET_KEY)) return;
    const next = knobStepValue(k.meta, cur, delta, i);
    if (next === null) return;
    queueKnobWrite(slot, m, next);
    schedulePresetName(m, k.meta, next, slot, () => knobSavedValue(knobEditEntry(), slot, k.res));
    if (knobEditScope === "song") storeKnobValue(entry, slot, k.res, next);
    else m.value = next;
    perfKnobsKey = "";               /* Performance re-reads it */
    markKnobSave();
}

function clearKnobMapping(row) {
    if (!currentSetlist) return;
    const i = knobEditSlot(row);
    if (knobEditScope === "song") {
        const entry = knobEditEntry();
        if (entry && Array.isArray(entry.knobs)) entry.knobs[i] = null;
        if (entry && Array.isArray(entry.knob_values)) entry.knob_values[i] = null;
    } else if (Array.isArray(currentSetlist.knobs)) {
        currentSetlist.knobs[i] = null;
    }
    perfKnobsKey = "";
    saveSetlist(currentSetlist);
    refreshKnobEdit();
}

/* Shift+jog on the Knobs screen: move the selected knob's assignment to the
 * next/previous knob (swapping with what is there). At setlist scope every
 * song's saved value for those knobs moves with it (knob_values follow their
 * mapping; a song's own overrides belong to the knob position and stay). At
 * song scope that song's overrides and values swap. */
function moveKnobMapping(delta) {
    if (!currentSetlist || !delta) return;
    const row = Math.max(0, Math.min(KNOB_COUNT - 1, knobEditFocus + Math.sign(delta)));
    if (row === knobEditFocus) return;
    const i = knobEditSlot(knobEditFocus), j = knobEditSlot(row);
    const swap = (arr) => {
        if (!Array.isArray(arr)) return;
        const a = arr[i] === undefined ? null : arr[i], b = arr[j] === undefined ? null : arr[j];
        arr[i] = b;
        arr[j] = a;
    };
    if (knobEditScope === "song") {
        const entry = knobEditEntry();
        if (!entry) return;
        if (!Array.isArray(entry.knobs)) entry.knobs = [];
        swap(entry.knobs);
        swap(entry.knob_values);
    } else {
        if (!Array.isArray(currentSetlist.knobs)) currentSetlist.knobs = [];
        swap(currentSetlist.knobs);
        for (const entry of currentSetlist.songs || []) swap(entry && entry.knob_values);
    }
    knobEditFocus = row;
    perfKnobsKey = "";               /* Performance re-reads it */
    markKnobSave();
    refreshKnobEdit();
    needsRedraw = true;
}

/* Sample: the next knob bank (Knobs screen or Perform). */
function nextKnobBank(bank) {
    showPopup("Knobs", "Bank " + (((bank + 1) % KNOB_BANKS) + 1), 1500);
    knobEnumAcc.fill(0);
    needsRedraw = true;
    return (bank + 1) % KNOB_BANKS;
}

function handleKnobMapInput(cc, value) {
    if (cc === MoveRecord && value > 0) {
        knobEditBank = nextKnobBank(knobEditBank);
        refreshKnobEdit();
        return;
    }
    if (cc === MoveMainKnob) {
        const delta = decodeDelta(value);
        if (shiftHeld) { moveKnobMapping(delta); return; }
        const n = Math.max(0, Math.min(KNOB_COUNT - 1, knobEditFocus + delta));
        if (n !== knobEditFocus) { knobEditFocus = n; needsRedraw = true; }
    } else if (cc >= 71 && cc <= 78) {
        turnEditKnob(cc - 71, decodeDelta(value));
    } else if (cc === MoveMainButton && value > 0) {
        openKnobPick();
    } else if (cc === MoveDelete && value > 0) {
        clearKnobMapping(knobEditFocus);
    } else if (cc === MoveBack && value > 0) {
        flushKnobSave();
        menuStack.pop();
        currentView = knobEditReturnView;
        needsRedraw = true;
    }
}

/* ---- the picker ---- */
function knobPickChainItems() {
    const items = [];
    if (knobEditScope === "song") {
        items.push({ label: "Use Setlist", action: "inherit" });
        items.push({ label: "Off", action: "off" });
    } else {
        items.push({ label: "None", action: "clear" });
    }
    for (let slot = 0; slot < chainSlotCount(); slot++) {
        const mod = readCompModule(slot, "synth");
        const value = mod === null ? "?" : (mod === "" ? "Empty" : (readChainSlotParam(slot, "synth:name") || mod));
        items.push({ label: "Chain " + (slot + 1), value, action: "chain", slot });
    }
    items.push({ label: "Master FX", value: "", action: "chain", slot: MASTER_FX_TARGET });
    if (sendBusesAvailable()) {
        for (let i = 0; i < SEND_BUS_COUNT; i++) {
            const slot = SEND_A_TARGET - i;
            items.push({ label: knobTargetName(slot), value: "", action: "chain", slot });
        }
    }
    return items;
}

/* A bus's module ids by position, from one read of "<bus>:modules"
 * ([{id, path}] per position): null when unserved or unparseable. */
function readBusModuleIds(slot) {
    const raw = readChainSlotParam(0, busPrefix(slot) + ":modules");
    if (!raw) return null;
    try {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) return arr.map(e => (e && typeof e === "object" && e.id) ? String(e.id) : "");
    } catch (e) { /* unparseable */ }
    return null;
}

/* Whether this Schwung has the send buses (they are newer than Master FX):
 * asked once, and only a served module list counts. */
let sendBusesAvailableCache = null;
function sendBusesAvailable() {
    if (sendBusesAvailableCache === null) sendBusesAvailableCache = readBusModuleIds(SEND_A_TARGET) !== null;
    return sendBusesAvailableCache;
}

/* A bus's loaded positions (Master FX, Send A/B): the module list, else a
 * ":name" read per position. */
function busCompItems(slot) {
    const ids = readBusModuleIds(slot);
    const items = [];
    for (let n = 1; n <= BUS_FX_POSITIONS; n++) {
        const comp = "fx" + n;
        const mod = ids ? (ids[n - 1] || "") : readCompModule(slot, comp);
        if (!mod) continue;
        items.push({ label: compLabel(comp), value: mod, action: "comp", comp, module: mod, moduleName: mod });
    }
    if (items.length === 0 && isMasterFxSlot(slot)) items.push({ label: "No Master FX", action: "none" });
    if (!isMasterFxSlot(slot)) items.push(settingsCompItem());
    return items;
}

function knobPickCompItems(slot) {
    if (isBusSlot(slot)) return busCompItems(slot);
    const items = [];
    const comps = ["synth"];
    const midiCount = parseInt(readChainSlotParam(slot, "midi_fx_count") || "0", 10) || 0;
    const fxCount = parseInt(readChainSlotParam(slot, "fx_count") || "0", 10) || 0;
    for (let n = 1; n <= Math.min(midiCount, 8); n++) comps.push("midi_fx" + n);
    for (let n = 1; n <= Math.min(fxCount, 8); n++) comps.push("fx" + n);
    for (const comp of comps) {
        const mod = readCompModule(slot, comp);
        if (!mod) continue;
        const name = readChainSlotParam(slot, comp + ":name") || mod;
        items.push({ label: compLabel(comp), value: name, action: "comp", comp, module: mod, moduleName: name });
    }
    items.push(settingsCompItem());
    return items;
}

function knobPickParamItems(slot, comp, moduleId) {
    const meta = readCompMeta(slot, comp, moduleId);
    if (!meta) return [{ label: "No answer: retry", action: "retry" }];
    if (meta.list.length === 0) return [{ label: "No parameters", action: "none" }];
    return meta.list.map(p => ({ label: p.name || p.key, action: "param", param: p }));
}

function setKnobPickStage(stage) {
    knobPickStage = stage;
    knobPickIndex = 0;
    if (stage === "chain") knobPickItems = knobPickChainItems();
    else if (stage === "comp") knobPickItems = knobPickCompItems(knobPickSlot);
    else knobPickItems = knobPickParamItems(knobPickSlot, knobPickComp, knobPickModule);
    needsRedraw = true;
}

/* "Knob 3", or "B2 Knob 3" past bank 1. */
function knobEditName() {
    return (knobEditBank > 0 ? "B" + (knobEditBank + 1) + " " : "") + "Knob " + (knobEditFocus + 1);
}

function openKnobPick() {
    currentView = VIEW_KNOB_PICK;
    menuStack.push({ title: knobEditName(), selectedIndex: 0 });
    setKnobPickStage("chain");
}

function closeKnobPick() {
    menuStack.pop();
    currentView = VIEW_KNOB_MAP;
    refreshKnobEdit();
}

/* Store a new mapping (or none) for the focused knob at the edit scope. The
 * Move Set it was made with is remembered, if the setlist has none yet. */
function assignKnob(mapping) {
    if (!currentSetlist) return;
    const i = knobEditSlot(knobEditFocus);
    if (knobEditScope === "song") {
        const entry = knobEditEntry();
        if (!entry) return;
        if (!Array.isArray(entry.knobs)) entry.knobs = [];
        entry.knobs[i] = mapping;
        if (Array.isArray(entry.knob_values)) entry.knob_values[i] = null;
    } else {
        if (!Array.isArray(currentSetlist.knobs)) currentSetlist.knobs = [];
        currentSetlist.knobs[i] = mapping;
    }
    if (!currentSetlist.move_set) {
        const set = currentMoveSet();
        if (set) currentSetlist.move_set = { uuid: set.uuid, name: set.name };
    }
    perfKnobsKey = "";
    saveSetlist(currentSetlist);
}

function drawKnobPick() {
    let title = knobEditName();
    if (knobPickStage !== "chain") title += ": " + knobTargetName(knobPickSlot);
    if (knobPickStage === "param") title += " " + compLabel(knobPickComp);
    drawMenuHeader(scrollHeader(title, 28), "");
    drawMenuList({
        ...LIST_ROW_FIT,
        labelX: 3,
        items: knobPickItems,
        selectedIndex: knobPickIndex,
        getLabel: (item) => item.label,
        getValue: (item) => item.value || "",
        valueAlignRight: true,
        labelGap: 2,
        listArea: { topY: LIST_TOP_Y, bottomY: LIST_INDICATOR_BOTTOM_Y }
    });
}

function handleKnobPickInput(cc, value) {
    if (cc === MoveMainKnob) {
        const delta = decodeDelta(value);
        const n = Math.max(0, Math.min(knobPickItems.length - 1, knobPickIndex + delta));
        if (n !== knobPickIndex) { knobPickIndex = n; needsRedraw = true; }
    } else if (cc === MoveMainButton && value > 0) {
        const item = knobPickItems[knobPickIndex];
        if (!item) return;
        if (item.action === "chain") {
            knobPickSlot = item.slot;
            setKnobPickStage("comp");
        } else if (item.action === "comp") {
            knobPickComp = item.comp;
            knobPickModule = item.module;
            knobPickModuleName = item.moduleName;
            setKnobPickStage("param");
        } else if (item.action === "retry") {
            setKnobPickStage(knobPickStage);
        } else if (item.action === "param") {
            const p = item.param;
            const cur = p.key === USER_PRESET_KEY ? "" : readCompParam(knobPickSlot, knobPickComp, p.key);
            const mapping = {
                slot: knobPickSlot, comp: knobPickComp, key: p.key, module: knobPickModule,
                moduleName: knobPickModuleName, label: p.name || p.key
            };
            if (cur !== null && cur !== "") mapping.value = cur;
            assignKnob(mapping);
            closeKnobPick();
        } else if (item.action === "clear" || item.action === "inherit") {
            assignKnob(null);
            closeKnobPick();
        } else if (item.action === "off") {
            assignKnob({ off: true });
            closeKnobPick();
        }
    } else if (cc === MoveBack && value > 0) {
        if (knobPickStage === "param") setKnobPickStage("comp");
        else if (knobPickStage === "comp") setKnobPickStage("chain");
        else closeKnobPick();
    }
}

/* ---- Move Set check --------------------------------------------------------
 *
 * Schwung's chains belong to the Move Set, so a setlist's knob mappings only
 * mean something with the Set they were made against. The setlist remembers
 * the Set it was last played with (setlist.move_set = {uuid, name}); opening
 * it for Performance with a different Set loaded asks first, naming the
 * expected Set, so the user can back out and load it on Move. Arranger cannot
 * load a Set itself -- Move offers no way to, short of its own Set Overview. */
function currentMoveSet() {
    let raw = readChainSlotParam(0, "active_set");
    if (!raw && typeof host_read_file === "function") {
        try { raw = host_read_file("/data/UserData/schwung/active_set.txt"); } catch (e) { raw = null; }
    }
    if (!raw) return null;
    const lines = String(raw).split("\n");
    const uuid = (lines[0] || "").trim();
    const name = (lines[1] || "").trim();
    return uuid ? { uuid, name: name || uuid } : null;
}

function rememberMoveSet(setlist, set) {
    if (!setlist || !set) return;
    if (setlist.move_set && setlist.move_set.uuid === set.uuid && setlist.move_set.name === set.name) return;
    setlist.move_set = { uuid: set.uuid, name: set.name };
    saveSetlist(setlist);
}

/* Run `proceed` if the loaded Move Set is the setlist's (or either is not
 * known); otherwise ask, naming the expected Set. Continue adopts the loaded
 * Set as the setlist's; Back runs `cancel`. */
function checkMoveSet(setlist, proceed, cancel) {
    const cur = currentMoveSet();
    const saved = setlist ? setlist.move_set : null;
    if (!cur) { proceed(); return; }
    if (!saved || !saved.uuid) { rememberMoveSet(setlist, cur); proceed(); return; }
    if (saved.uuid === cur.uuid) {
        if (saved.name !== cur.name) rememberMoveSet(setlist, cur);
        proceed();
        return;
    }
    openConfirm({
        title: "Use Move Set:",
        name: saved.name,
        detail: "Loaded: " + cur.name,
        labels: ["Back", "Continue"],
        onConfirm: () => { rememberMoveSet(setlist, cur); proceed(); },
        onCancel: () => { if (cancel) cancel(); }
    });
}

let needsRedraw = true;
/* Pending LED writes, keyed by LED: the note for a pad or step, 128 + the CC
 * for a button. A Map rather than a FIFO array: queueing an LED that is
 * already waiting replaces its colour where it stands, so each LED goes out
 * once, with its newest colour, at the place it first queued. The FIFO sent
 * every intermediate colour in order, so a burst (a playhead crossing the
 * steps, a grid redraw) built a backlog that replayed stale colours for
 * several ticks -- and held some LEDs' current colour back behind them. The
 * queue can now hold at most one entry per LED. */
let ledQueue = new Map();
let ledQueueWrites = 0;   /* every queued write, coalesced or not (LEDQ diagnostics) */
const LEDS_PER_TICK = 8;
let lastPadState = new Uint8Array(NUM_PADS);
let lastStepState = new Uint8Array(NUM_STEPS);
let lastButtonState = new Map();
let lastLedView = null;
let lastLedKey = "";
let ledDirtyAll = true;

let activeSongFile = null;
/* The song object that activeSongFile holds. currentSong is not always it:
 * play-from-section, play-from-cursor and pad previews point currentSong at a
 * trimmed or one-clip copy while their build is in flight, Performance plays
 * other songs, and Jam plays one-clip songs. Only this object may be written
 * to activeSongFile. */
let activeSongObj = null;
/* Temp songs sliced from activeSongObj (play from section/cursor), mapped to
 * the full song they were cut from, so a change the DSP reports for the temp
 * song can be applied to -- and saved as -- the full one. */
const tempSongOrigin = new WeakMap();
/* The section of the real song a temporary copy starts at (its section 0). */
const tempSongStart = new WeakMap();
let songFiles = [];
let selectedSongIndex = 0;
/* Set after a song file is added/removed on disk (duplicate/delete), so the
 * Song Bank list stays in sync with the DSP's cached song scan
 * (host_module_get_param song_count, song_name_N, song_path_N), which only
 * updates asynchronously on its worker thread after scan_library is
 * requested. Polled each tick until `path` appears/disappears from the
 * list; selectOnArrive additionally moves the cursor onto it once found. */
let pendingSongBankSync = null; /* { path, shouldExist, selectOnArrive } */

let trimEditing = false;
let trimPendingStart = 0;
let trimPendingStartBeat = 0;
let trimPendingEnd = 1;
let trimPendingEndBeat = 0;
let trimPendingGuard = 0;
let trimPendingSpeed = 1.0;
let trimPendingVelocityScale = 1.0;
let trimPendingSnareNote = 38;
let trimPendingSnareVelocityScale = 1.0;
let trimPendingKickNote = 36;
let trimPendingKickTarget = 0;
let trimPendingChannel = 0;   /* per-clip MIDI out channel: 0 = follow Options, 1-16 = explicit */
let trimAdvanced = false;
let trimOriginalStart = 0;
let trimOriginalStartBeat = 0;
let trimOriginalEnd = 1;
let trimOriginalEndBeat = 0;
let trimOriginalGuard = 0;
let trimOriginalSpeed = 1.0;
let trimOriginalVelocityScale = 1.0;
let trimOriginalSnareNote = 38;
let trimOriginalSnareVelocityScale = 1.0;
let trimOriginalKickNote = 36;
let trimOriginalKickTarget = 0;
let trimOriginalChannel = 0;
/* The clip object being edited in the trim view. Captured when the view opens
 * so a section auto-advance during playback doesn't switch the edit to a clip
 * in the new section. */
let trimClip = null;
/* Scroller for the read-only source-folder line at the top of the trim view,
 * so long folder paths marquee instead of being hard-truncated. */
let trimSrcScroller = createUniformScroller();

let songSettingsFocus = 0;
let songSettingsPendingBpm = 120;
let songSettingsPendingNum = 4;
let songSettingsPendingDen = 4;
let songSettingsPendingKey = DEFAULT_KEY;
let songSettingsEditing = false;

/* ── Chord / instrument track state ─────────────────────────────────── */

/* Which track the Song Builder currently shows (TRACK_DRUM/CHORD/INST_1/2). */
let builderTrack = TRACK_DRUM;
/* The bar (0-based within the section) the chord-track cursor is on, and
 * which of that bar's chords (a bar can hold several). */
let chordCursorBar = 0;
let chordCursorIdx = 0;
/* Chord picker state: which bar is being edited, and the current selection. */
let chordPickBar = -1;
let chordPickRoot = 0;        /* semitones above the key's root (0-11), or CHORD_ROOT_NONE */
let chordPickQuality = 0;     /* index into CHORD_QUALITIES */
let chordPickBass = -1;       /* index into bassNotesForKey(key), -1 = no slash bass */
let chordPickFocus = 0;       /* row index into chordPickItems() */
/* The chord being edited: where it started (chordPickOrigBar/Idx, -1 for a
 * new one) and its original object, its beat, Advanced (half-beat starts),
 * and whether its chord fields were edited (see pickResult). chordPickBar
 * is its (possibly moved) bar. */
/* The song and section the chord page edits, fixed when it opens: Play from
 * the page swaps currentSong for a play-from copy until playback confirms,
 * and a save in that window must still land in the real song. */
let chordPickSong = null;
let chordPickSecIdx = -1;
let chordPickOrig = null;
let chordPickOrigBar = -1;
let chordPickOrigIdx = -1;
let chordPickBeat = 1;
let chordPickAdv = false;
let chordPickDirty = false;
/* The Chord track list's selection: -1 = the section row, 0..n-1 = the
 * section's chords in order, n = the "+ Add" row. */
let chordListCursor = 0;
let chordPickEditing = false;
/* Whether a chord actually exists for the bar being edited (either it was
 * already set, or the user has started setting one this session). While
 * false the picker shows no values and Back discards without committing, so
 * simply opening the picker and backing out never creates a chord. */
let chordPickHasChord = false;
/* Instrument track being edited (TRACK_INSTRUMENT_1 or _2), or -1. */
let instrumentEditTrack = -1;
let instrumentFocus = 0;
let instrumentEditing = false;
/* Per-bar instrument override menu state (Octave/Follow Note/Voicing/Mute
 * for a single bar, opened by a plain step press on an instrument track). */

let selectedOutputIndex = 0;
let optionsFocus = 0;      /* 0 = Drums, 1 = Instrument 1, 2 = Instrument 2, 3 = Chains, 4 = Click channel, 5 = Swap guard, 6 = Schwung clock, 7 = DSP debug */
let optionsEditing = false;
/* Focus/edit state within the Drums or Instrument 1/2 submenu (both are a
 * 2-item Output/Channel list). optionsInstIndex selects which instrument
 * submenu is open (1 or 2) when currentView is VIEW_OPTIONS_INST. Drums has
 * a 3rd row (Drop Note-Offs); Instrument 1/2 stay at 2 rows -- see
 * handleOptionsDrumsInput/handleOptionsInstInput's own row-count clamps. */
let optionsSubFocus = 0;   /* 0 = Output, 1 = MIDI channel, (Drums only) 2 = Drop Note-Offs */
let optionsSubEditing = false;
let optionsInstIndex = 1;
/* Options > Chains: one of Schwung's chain slots, read straight from the
 * shim with shadow_get_param -- the SLOT is the source of truth for its own
 * receive channel and synth, not Arranger, so these are only the last read,
 * refreshed when the screen opens, the chain changes or a chain view closes.
 * null = the read did not complete (never shown as a value). */
let optionsChainIndex = 0;          /* 0..chainSlotCount()-1 */
let chainInfoChannel = null;        /* 0 = All, 1-16 */
let chainInfoSynth = null;          /* display name; "" = no synth loaded */
let swapGuardFraction = 0.25;  /* guard window (fraction of a beat) at mid-clip swap boundaries */
let dspDebugEnabled = false;   /* runtime toggle for the DSP debug log (.dsp_log) */
/* Drums Options: some drum playback modules/samplers don't ring out their
 * own tail, so the source clip's own recorded note-off cuts the sound short
 * instead of letting it ring. Off by default -- see arranger_engine.c's
 * drop_note_offs field for the DSP-side behavior. */
let dropNoteOffs = false;
/* Options > Schwung Clock: the DSP sends MIDI clock to Schwung while playing,
 * so clock-synced chain modules (LFOs, delays, arps) follow the song tempo.
 * See send_clock in arranger_engine.c. On by default. */
let sendClock = true;

let setlistFiles = [];
let selectedSetlistIndex = 0;
let currentSetlist = null;
let setlistSongIndex = 0;
let editingSetlist = false;
let setlistPendingName = "My Setlist";
let setlistPickIndex = 0; /* selected song in the add-song picker */
let sectionPickIndex = 0; /* selected name in the add-section picker */
/* The picker names a new section (Shift + Loop), or renames sectionPickTarget
 * (the jog click on a section row), with "Custom..." first for the keyboard. */
let sectionPickRename = false;
let sectionPickTarget = null;
let perfSetlistIndex = 0; /* selected setlist in the performance picker */
let clickSettingsFocus = 0; /* 0 = bars, 1 = note */
let clickSettingsEditing = false;
let lastTickLogTime = 0;
let tickLogInterval = 1000;
let lastLoggedDspError = null;
let lastSwapGuardSuppressed = -1; /* last DSP swap_guard_suppressed counter, to log on change */
let lastBeatLogBar = -1;
let lastBeatLogBeat = -1;
let lastStepBarIndex = -1;
let lastStepBarFlashTime = 0;
/* Per-tick Jam TICK logging is gated behind this flag (off by default) so the
 * hot tick path doesn't do a file write every frame. Enable only when
 * debugging boundary/timing issues. */
let jamTickLogEnabled = false;
let stepBarFlashState = false;
let lastStepBeatKey = "";
let lastDspTransport = null;
let lastBeatFlashMs = 0;
let lastBeatFlashBeat = -1;
let stepLedsDirty = true;
let previewBarOffset = 0; /* bar offset within section for Play-previewed clip */
let padPreviewClip = null; /* clip currently held for pad preview */
let padPreviewBars = 0;    /* bar length of the pad-previewed clip */
let padPreviewTriggerTime = 0; /* when the pad press happened */
let padPreviewScheduled = false; /* true once preview has been triggered */
let padPreviewStopping = false;  /* true for a few ticks after a pad preview is released */
/* Custom scrolling overlay for the builder pad preview, so long clip names
 * marquee instead of being hard-truncated by the shared drawOverlay(). */
let wasTextEntryActive = false;  /* previous tick's text-entry state, to detect close */
let stepScrollOffset = 0;   /* bar offset for the step-LED window when a section has more than NUM_STEPS bars */
let stepRedrawAll = false;  /* true for one tick after a section change, to force a full step redraw */
let playbackSectionIndex = 0; /* section currently being played by DSP */
/* Song Builder: when the user navigates sections with Left/Right while
 * playing, show that section in the display and step LEDs instead of the
 * currently playing section. -1 = follow the playhead. */
let builderDisplaySection = -1;
/* True while playFromCurrentSection/previewClipAtCursor have currentSong
 * temporarily pointed at a song sliced to start at currentSectionIndex (so
 * the sliced song's own section 0 IS the section being played), waiting on
 * playCurrentSong's async confirmation before restoring the real song. Until
 * that confirmation lands, playbackState is still not "playing" (it only
 * flips inside that same confirmation), so builderDisplaySectionIndex() and
 * drawBuilderStepLEDs's fallback to currentSectionIndex would index the
 * SLICED song with the ORIGINAL, un-sliced section index -- landing one
 * section too far in (section 2 of 4 briefly showing section 3). This flag
 * lets both know to show section 0 of the sliced song instead, for exactly
 * that window. */
let builderPlayingFromTemp = false;
/* Set to the source-folder NAME when the builder needs its clip pads loaded
 * but the DSP folder scan isn't ready yet (e.g. an existing song opened on a
 * fresh boot). The tick re-resolves the folder index (once libraryFolders is
 * populated) and reloads the clips until they arrive. */
let pendingFolderClipLoadName = null;
/* Set when a Jam folder is entered but the DSP folder scan isn't ready yet
 * (folder_clips_json_ returned empty on a fresh boot). The tick re-resolves
 * the folder index and reloads the clips until they arrive, so the Jam pads
 * aren't left empty on first entry. */
let pendingJamFolderClipLoadIndex = -1;
/* Set when loadLibraryFolders() fired scan_library but the DSP folder scan
 * hadn't caught up yet (folder_count still 0). The tick re-polls until the
 * folder list arrives, so opening Folder List / Jam Folder on a fresh boot
 * (or right after a scan invalidation) doesn't leave the list empty forever. */
let pendingLibraryFoldersReload = false;
/* What the DSP's worker is still scanning, so a list that has not arrived yet
 * says "Loading..." instead of looking empty: { songs, folders, found } from
 * get_param("scan_state") (found = library folders the walk has reached so
 * far), or null when the engine cannot say. Polled while a screen that shows
 * one of these lists (or clips waiting on the folder scan) is up; when a list
 * finishes loading it is reloaded at once. */
let scanState = null;
let lastScanStatePoll = 0;
const SCAN_STATE_POLL_MS = 250;
/* A folder scan finished and found no MIDI folders: say so, and stop asking
 * for rescans of an empty library. */
let libraryKnownEmpty = false;
let lastLoadingPhase = -1;
let lastTransportBar = 0;     /* last bar number seen from DSP transport */
let maxBeatThisBar = 0;       /* highest transport beat seen in current bar */
let transportBeatsPerBar = 0; /* observed transport beats in last complete bar */
let lastSubdivisionIndex = 0; /* current subdivision within transport beat */
let lastSubFlashMs = 0;       /* wall-clock anchor of the current sub-beat flash */

/* Live Perform-mode mute toggles (Row1/3/4 track buttons) -- purely a
 * runtime performance control, not persisted, and reset to all-on whenever
 * Perform is (re)entered or a new song loads (see perfLoadSong). */
let perfDrumEnabled = true;
let perfInst1Enabled = true;
let perfInst2Enabled = true;
let perfInst3Enabled = true;   /* Pads: Track 4 */

/* Performance / setlist playback state */
let perfPlaying = false;            /* is the setlist advancing on its own */
let perfSongIndex = 0;              /* index into currentSetlist.songs */
let perfQueuedSection = -1;         /* section index queued to jump to, -1 = none */
let perfQueuedSectionPresses = 0;  /* 1 = jump at section end, 2 = jump at bar end */
let perfQueuedSongIndex = -1;       /* song index queued to jump to, -1 = none */
let perfSongLoaded = false;         /* has the current song been sent to DSP */
let perfAdvancePending = false;     /* advance to next song is pending (end detected) */
let perfJumpPending = false;        /* a queued jump is waiting to fire at section end */
let perfLastBar = -1;               /* last bar index seen, for end detection */
let perfLastBarCounter = -1;        /* last DSP bar_counter, for authoritative bar-change detect */
let perfLastSection = -1;           /* last section index seen, for section-end detection */
let perfAdvanceStartMs = 0;         /* timestamp of last advance (debounce) */
let perfFullSongLoaded = false;     /* true once the full song timeline is in the DSP */
let perfFullSong = null;            /* original full song for the current setlist entry */
let perfSeekScheduled = false;      /* true when a seek_bar_scheduled was sent to the DSP */
let perfLastSeekCounter = -1;       /* last DSP seek_counter, to detect a repeat/seek firing */
let perfSongSections = [];          /* per-setlist-song section info: { name, sections:[{hasClips}], click } */
let perfClickBars = 0;              /* click bars for the current song (0 = none) */
let perfClickPlaying = false;       /* true while the count-in click timeline is playing */
let perfClickDsp = false;           /* true if the click is a DSP timeline (MIDI note), false = pad-flash timer */
let perfClickMute = false;          /* true to suppress MIDI output during a pad-flash click */
let perfClickStartMs = 0;           /* when the JS count-in started */
let perfClickTotalMs = 0;           /* total duration of the JS count-in */
let perfClickSwapCounter = -1;      /* last DSP swap_counter during the click-to-song preload */
let perfClickSongStaged = false;    /* true once the real song has been preloaded into DSP staging */
let perfDisplayIndex = 0;           /* scroll index for the performance info display */
let perfScrollRow = 0;              /* row offset of the bottom visible pad row (0-based) */
let perfManualScroll = false;               /* user has manually scrolled during playback; disables auto-follow until a song change */
let perfLastPadSongIdx = -2;        /* last song index the pad grid was fully drawn for */
let perfLastPadScrollRow = 0;       /* last scroll row the pad grid was fully drawn for */
let perfLastUpDownScrollRow = -1;   /* last scroll row the up/down button LEDs were drawn for (-1 = force first draw) */
let perfSelectedSection = -1;       /* section selected while stopped in performance view */
let perfSelectedSong = -1;          /* song selected while stopped in performance view */
let perfStoppedKeepSelection = false; /* if true, perfStop() preserves perfSelectedSection/perfSelectedSong */
let perfSetTotalSec = 0;            /* cached total duration of the whole setlist (sec) */
let perfSetTotalKeyCached = "";     /* cache key for perfSetTotalSec */

/* ── Jam mode state ─────────────────────────────────────────────────── */
/* Live Jam-mode mute toggles (Row1/3/4 track buttons) -- separate from
 * perfDrumEnabled/etc. above so Perform and Jam don't affect each other.
 * Not persisted; reset to all-on whenever Jam is (re)entered. Inst1/2
 * enabled also gate whether the chord-pad grid layout is shown -- see
 * jamChordModeActive(). */
let jamDrumEnabled = true;
let jamInst1Enabled = true;
let jamInst2Enabled = true;
let jamPadsEnabled = false;   /* Track 4 in Jam: the Pads (Jam instrument 3) */

/* Jam chord performance: the key the 8 chord pads are built from (reuses
 * diatonicChord, ui.js:1123), and JS's own mirror of the DSP's pending/live
 * chord split (see arranger_engine.c's jam_chord_pending/jam_chord_live) so
 * pad LEDs can show "selected, takes effect next bar" vs. "currently
 * sounding" without a round trip. While playing, a pad press stays pending
 * until promoted locally on the next bar_counter change (polled off
 * transport/state), mirroring the DSP's own bar-boundary promotion timing
 * (see updateDspState). While stopped, jamChordLiveDegree instead holds
 * whatever chord will resume the moment Play is pressed -- see
 * jamQueuedChordDegree, drawJamLEDs, and jamPlayClip's own promotion (which
 * mirrors the DSP's "play" handler promoting immediately, since a chord
 * picked while stopped has no "current bar" to wait for). Not persisted --
 * resets whenever Jam is (re)entered. */
let jamKey = "C";
let jamChordPendingDegree = -1;     /* 0-7 (7 = octave-root pad), -1 = none queued */
let jamChordLiveDegree = -1;
/* The key each of those chords was built in -- a key change (Shift+jog)
 * re-queues the chord in the new key, so the live chord can briefly be in a
 * different key from jamKey and must be labelled with its own. */
let jamChordPendingKey = "C";
let jamKeyChangePending = false; /* key turned with Shift held; applied on Shift release */
let jamChordLiveKey = "C";
let jamLastBarCounterForChord = -1; /* last-seen bar_counter, to detect a boundary crossing */
let jamLastSwapCounterForChord = -1; /* last-seen swap_counter -- a groove/fill swap is a boundary too, see updateDspState */

/* Per-Jam-instrument live config (Shift+Row3/Row4 menu -- see
 * openJamInstrumentMenu). Mirrors the fields pushed to the DSP's jam_inst[]
 * via jam_inst<N>_* set_param keys (arranger_engine.c), each applied
 * immediately, no rebuild. Inst 1 defaults to follow_note 36 (kick) with
 * bass voicing, a low root note driven by the beat. Inst 2 defaults to
 * follow_note "off" (0) with chord voicing -- it instead uses the
 * "trigger once per bar" fallback (emit_jam_instruments_at_tick), giving a
 * sustained chordal pad by default rather than a second beat-driven bass.
 * Not persisted -- resets to these defaults each session. */
let jamInstConfig = jamInstDefaults();
/* Jam's instruments as they start: Inst 1 a bass on the kick, Inst 2 a chord
 * each bar, the Pads (3) a chord held until it changes, an octave up. */
function jamInstDefaults() {
    return [
        { octave: 3, voicing: "bass", inversion: INVERSION_AUTO, note_gap: 0.25, follow_note: 36, velocity: 100 },
        { octave: 3, voicing: "chord", inversion: INVERSION_AUTO, note_gap: 0.25, follow_note: 0, velocity: 100 },
        { octave: 4, voicing: "chord", inversion: INVERSION_AUTO, note_gap: 0.125, follow_note: 0, velocity: 80 }
    ];
}
let jamInstrumentEditIndex = 0;  /* 0 Inst 1, 1 Inst 2, 2 Pads -- which jamInstConfig entry the menu edits */
let jamInstrumentFocus = 0;
let jamInstrumentEditing = false;
let jamInstRoutingPushed = [false, false, false]; /* has jam_inst<N>_channel/_output been sent yet (see pushJamInstrumentRouting) */

let jamGrooves = [];                /* grooves for the selected folder: { path, name, type, bars } */
let jamFills = [];                  /* fills for the selected folder */
let jamGrooveScroll = 0;            /* scroll offset for the groove pad grid (rows) */
let jamFillScroll = 0;              /* scroll offset for the fill pad grid (rows) */
let jamCurrentClip = null;          /* clip currently playing (groove or fill) */
let jamReturnGroove = null;         /* most recent groove to return to after fills */
let jamReturnFromStart = false;     /* true when the return groove should restart from tick 0 after a fill (pressed its pad during the fill) */
let jamStandaloneFill = false;      /* true while an intro fill starts playback on its own, before the return groove takes over */
let jamQueue = [];                  /* ordered queued clips */
let jamPlaying = false;             /* true while a clip is looping */
let jamLastBarCounter = -1;         /* last DSP bar_counter (authoritative boundary detect) */
let jamLastWrapCounter = -1;        /* last DSP wrap_counter (authoritative loop-wrap detect) */
let jamLastSwapCounter = -1;        /* last DSP swap_counter (authoritative clip-swap detect) */
let jamQueuedGroove = null;         /* groove queued to start after current groove finishes */
let jamQueuedGrooveEscalated = false; /* true if the queued groove was pressed again (bar-end) */
let jamFillQueued = false;          /* true if a fill is queued to play at next bar-end */
let jamCurrentType = "";            /* part type of the currently playing/selected groove */
let jamBpm = 120;                   /* playback tempo, read from folder name, jog-adjustable */
let jamSettling = true;             /* true for one tick after a clip starts, to ignore the initial bar=1 boundary */
let jamStagedClip = null;           /* clip currently preloaded in the DSP staging timeline */
let jamStagedIsFill = false;        /* whether the staged clip is a fill (used for state logging) */
let jamStagedResumeTick = 0;        /* resume position (ticks) for the staged clip, set via swap_resume */
let jamFillBaseBar = 1;             /* 1-based groove bar when the current fill batch started */
let jamFillsPlayedBars = 0;         /* total bars of fills played in the current batch */
let jamScheduledSwapBar = -1;       /* next bar boundary at which a queued fill swap is pre-scheduled (-1 = none) */
let jamScheduledSwap = null;        /* the clip to swap to at jamScheduledSwapBar */
let jamActiveSource = "";           /* last active clip source reported by DSP state; used to sync UI after DSP-side swaps */
/* Cached list of fills shown on the right. Recomputed only while a groove is
 * playing (see jamVisibleFills). While a fill is queued or playing, the fill
 * pads stay frozen on the last groove's filter so they don't flicker. */
let jamVisibleFillList = [];
let lastJamLedKey = "";             /* last jam LED state key, to log only on change */
let lastPerfDispKey = "";           /* last PERFDISP state key, to log only on change */
let lastJamStepKey = "";            /* last jam step LED state key, to log only on change */
let lastJamPreviewStepKey = "";     /* last jam PREVIEW step LED state key, to log only on change */
let lastJamPreviewQueueKey = "";    /* last jam PREVIEW queue-diagnostic key, to log only on change */

/* Jam preview (pad-held one-shot while stopped). Mirrors the builder pad
 * preview: press a pad while stopped, hold past the delay to hear the clip
 * as a one-shot until release; a quick (short) press starts loop playback. */
let jamPreviewPad = -1;             /* pad index held for a potential jam preview (-1 = none) */
let jamPreviewClip = null;          /* clip armed/playing for jam preview */
let jamPreviewTriggerTime = 0;      /* when the jam pad press happened */
let jamPreviewScheduled = false;    /* true once the jam one-shot preview playback started */
let jamPreviewStartTime = 0;        /* when the jam preview playback started */
/* True once the DSP has actually been observed running since this preview
 * was scheduled. song_json/play are now async (Step 3), so there is a real
 * window right after jamPlayClip is called where the DSP hasn't started yet
 * and lastDspState.running is still false -- distinct from the clip having
 * actually played and finished. The "preview finished on its own" check
 * below must only fire on that second case. */
let jamPreviewObservedRunning = false;
/* True once the DSP has actually been observed running since the current
 * Performance-mode song was requested. Same async gap as
 * jamPreviewObservedRunning above, different symptom: perfTick's song-end
 * detection reads lastDspState.stopped_at_end, and that object isn't
 * refreshed until the new song's async build/play confirms (playCurrentSong's
 * onReady is what nulls it out) -- so right after perfAdvance/perfPlayCurrent
 * issues a new play request, lastDspState can still be the JUST-ENDED song's
 * own terminal state, stopped_at_end included. Every perfTick in that window
 * (which can span several ticks -- observed ~300ms on hardware for a normal-
 * sized song) re-read that same stale stopped_at_end as "this new song also
 * already ended" and fired ANOTHER advance, skipping the song that had just
 * been requested without it ever actually playing. Gating stopped_at_end on
 * this flag (only trust it once the new song has been observed running at
 * least once) closes the gap the same way jamPreviewObservedRunning does. */
let perfObservedRunningSincePlay = true;

/* Jam hold-overlay (pad held while playback is running): shows the name of the
 * held groove/fill in the display overlay without queueing it. A quick press
 * still queues normally. */
let jamHoldPad = -1;               /* pad index held for a jam hold-overlay (-1 = none) */
let jamHoldClip = null;             /* clip being held for the jam hold-overlay */
let jamHoldTriggerTime = 0;         /* when the jam hold-overlay pad press happened */
let jamHoldOverlayShown = false;    /* true once the hold-overlay has been shown */
/* Custom scrolling overlay for the jam hold, so long clip names marquee
 * instead of being hard-truncated by the shared drawOverlay(). */
/* Chord pad being held (degree 0-7, -1 = none) and when it was pressed.
 * Chord pads act on release: a quick tap selects the chord, a hold past
 * PAD_PREVIEW_DELAY_MS only shows its name in the hold overlay (same as
 * groove/fill pads while playing). */
let jamChordHoldDegree = -1;
let jamChordHoldTime = 0;
let jamChordHoldShown = false;

/* Dedicated marquee scroller for the Jam header (folder name). */
const jamHeaderScroller = createUniformScroller();

/* Dedicated marquee scrollers for the four performance info lines (Now / Sec /
 * NSec / Next). Kept separate from the shared menu/header scrollers so long
 * song and section names scroll in place without fighting other scrollers. */
const perfLineScrollers = [0, 1, 2].map(() => createUniformScroller());

const PAD_PREVIEW_DELAY_MS = 250; /* delay before pad tap triggers insert preview */

/* Menu views that show scrollable lists. While one of these is active we
 * redraw periodically so the shared marquee scroller animates long Song /
 * Setlist / clip names that overflow the row width. */
const SCROLLABLE_MENU_VIEWS = new Set([
    VIEW_ROOT, VIEW_FOLDER_LIST, VIEW_BUILDER, VIEW_TRIM, VIEW_SONG_SETTINGS, VIEW_SONG_BACKUPS,
    VIEW_SONG_BANK, VIEW_OPTIONS, VIEW_OPTIONS_DRUMS, VIEW_OPTIONS_INST, VIEW_OPTIONS_KEYS, VIEW_OPTIONS_CLICK, VIEW_OPTIONS_CHAINS,
    VIEW_SETLIST_BANK, VIEW_SETLIST_EDIT,
    VIEW_SETLIST_PICK, VIEW_SETLIST_CLICK, VIEW_SETLIST_SECTIONS, VIEW_SETLIST_SECTION_PICK, VIEW_COPY_TRACK_PICK,
    VIEW_PERF_SETLIST, VIEW_PERFORMANCE,
    VIEW_JAM_FOLDER, VIEW_JAM, VIEW_SECTION_PICK, VIEW_CHORD_PICK, VIEW_INSTRUMENT
]);
const MENU_SCROLL_TICK_MS = 30; /* ~25fps redraw for marquee animation (halves the ~2s scroll-start delay) */
let lastMenuScrollTick = 0;

/* All of Arranger's marquee scrollers run at one speed: the shared menu
 * list's own settings (the text_scroll defaults), stepped at most once per
 * scroll beat -- the MENU_SCROLL_TICK_MS cadence that also redraws the
 * scrolling menu screens, which is what paces the shared list. They used to
 * differ: some had slower settings, and all stepped once per redraw, so a
 * screen redrawn every tick (Perform, Jam) scrolled faster than a menu. */
let scrollBeat = 0;
let lastScrollBeatMs = 0;

function createUniformScroller() {
    const sc = createTextScroller();
    let lastBeat = -1;
    return Object.assign({}, sc, {
        tick() {
            if (lastBeat === scrollBeat) return false;
            lastBeat = scrollBeat;
            return sc.tick();
        }
    });
}
let lastLedQueueSampleTick = 0;    /* throttle for the LED-queue backlog diagnostic */
let lastLedQueueSampleLen = -1;    /* previous sampled ledQueue.size, to log the growth rate */
/* Per-mechanism push accumulators for the same diagnostic -- reset each time
 * the periodic sample above logs, so the log shows a breakdown of which of
 * updateLEDs()/the per-tick step refresh/updateButtonLEDs() actually grew
 * the queue since the last sample, not just the total. */
let ledQueuePushByUpdateLEDs = 0;
let ledQueuePushByStepRefresh = 0;
let ledQueuePushByButtonLEDs = 0;

/* ── Helpers ─────────────────────────────────────────────────────────── */

function ensureDir(path) {
    if (typeof host_ensure_dir === "function") host_ensure_dir(path);
}

function readJson(path) {
    if (typeof host_file_exists !== "function" || !host_file_exists(path)) {
        logDebug("readJson: missing or not exists " + path);
        return null;
    }
    let raw;
    try {
        raw = host_read_file(path);
    } catch (e) {
        logDebug("readJson: host_read_file threw " + e + " for " + path);
        return null;
    }
    try { return JSON.parse(raw); } catch (e) {
        logDebug("readJson: JSON.parse failed " + e + " raw=" + String(raw).slice(0, 200) + " path=" + path);
        return null;
    }
}

function writeJson(path, obj) {
    ensureDir(path.substring(0, path.lastIndexOf("/")));
    host_write_file(path, JSON.stringify(obj, null, 2));
}

/* Keep a rolling set of the most recent versions of each song, stored in a
 * hidden .backups folder so the DSP song scan and the Song Bank list never
 * see them. Called immediately BEFORE a save, and copies the file AS IT IS ON
 * DISK -- the version the save is about to replace. It used to write the
 * in-memory song instead, i.e. the new content, so a bad save produced a
 * backup of the bad version and nothing of the good one. Purely background;
 * has no UI. Failures are swallowed so a full backup dir never breaks a save. */
function backupCurrentSong(path, name) {
    path = path || activeSongFile;
    if (!path) return;
    if (typeof os.readdir !== "function" || typeof os.remove !== "function") return;
    let previous = null;
    try { if (host_file_exists(path)) previous = host_read_file(path); } catch (e) { previous = null; }
    if (!previous) return;   /* a first save: nothing to preserve */
    writeSongBackup(name || (currentSong && currentSong.name) || "song", previous);
}

/* This song's backup folder. */
function songBackupDir(name) {
    return SONGS_BACKUP_DIR + "/" + safeFileName(name || "song");
}

/* Write `text` as a new timestamped backup of song `name`, then trim the
 * folder to the newest MAX_SONG_BACKUPS. */
function writeSongBackup(name, text) {
    if (typeof os.readdir !== "function" || typeof os.remove !== "function") return;
    const dir = songBackupDir(name);
    try { ensureDir(dir); } catch (e) { return; }
    /* Timestamp down to the second; guard against two saves in the same
     * millisecond by appending a counter if the file already exists. */
    const stamp0 = new Date().toISOString().replace(/[:.]/g, "-");
    let stamp = stamp0;
    let n = 1;
    let backupPath = dir + "/" + stamp + ".json";
    while (host_file_exists(backupPath)) {
        stamp = stamp0 + "-" + (++n);
        backupPath = dir + "/" + stamp + ".json";
    }
    try {
        host_write_file(backupPath, text);
    } catch (e) { return; }
    /* Trim to the newest MAX_SONG_BACKUPS, in lexicographic order (the
     * timestamped names sort chronologically). */
    let names = [];
    try {
        const raw = os.readdir(dir);
        const list = Array.isArray(raw) ? (Array.isArray(raw[0]) ? raw[0] : raw) : [];
        for (const nm of list) {
            if (typeof nm === "string" && nm.endsWith(".json")) names.push(nm);
        }
    } catch (e) { return; }
    names.sort();
    while (names.length > MAX_SONG_BACKUPS) {
        const old = names.shift();
        try { os.remove(dir + "/" + old); } catch (e) {}
    }
}

/* Generate a click MIDI file (a single note per beat, for `bars` bars) and
 * write it to the given path. Returns true on success. The click note is
 * `note` (0 = no note, pad-flash only). */
/* A deleted drum clip in a section with chords or items leaves a placeholder
 * clip of the same length -- silence -- so the chords and items after it stay
 * on their drums (they are placed by bar, not by clip). A pad tapped on it
 * replaces it; Delete on it removes it. In the song it is a clip with
 * placeholder: true and the deleted clip's timing (bars, beat trims, speed);
 * the engine is sent a silent MIDI file long enough for it. */
const PLACEHOLDER_DIR = "/data/UserData/UserLibrary/Arranger/.placeholders";
const PLACEHOLDER_DIVISION = 240;

/* The silent MIDI file for a placeholder of up to `bars` bars in num/den:
 * written once, then reused. Its only event, a note-off on its last tick,
 * sets its length (the engine takes a clip's end from its last event) and
 * falls just past what plays. */
function placeholderMidiPath(bars, num, den) {
    const path = PLACEHOLDER_DIR + "/silence_" + bars + "_" + num + "-" + den + ".mid";
    try {
        if (typeof host_file_exists === "function" && host_file_exists(path)) return path;
        ensureDir(PLACEHOLDER_DIR);
        const ticks = Math.round(bars * PLACEHOLDER_DIVISION * 4 * num / den);
        const bytes = [];
        const push = (b) => bytes.push(b & 0xFF);
        const push32 = (v) => { push(v >>> 24); push(v >>> 16); push(v >>> 8); push(v); };
        const pushVlq = (v) => {
            const buf = [v & 0x7F];
            v >>>= 7;
            while (v > 0) { buf.unshift((v & 0x7F) | 0x80); v >>>= 7; }
            for (const b of buf) push(b);
        };
        push(0x4D); push(0x54); push(0x68); push(0x64); push32(6);
        push(0); push(0); push(0); push(1); push(PLACEHOLDER_DIVISION >> 8); push(PLACEHOLDER_DIVISION);
        push(0x4D); push(0x54); push(0x72); push(0x6B);
        const lenAt = bytes.length;
        push32(0);
        pushVlq(ticks); push(0x80); push(0); push(0);
        pushVlq(0); push(0xFF); push(0x2F); push(0x00);
        const len = bytes.length - lenAt - 4;
        bytes[lenAt] = len >>> 24; bytes[lenAt + 1] = (len >>> 16) & 0xFF;
        bytes[lenAt + 2] = (len >>> 8) & 0xFF; bytes[lenAt + 3] = len & 0xFF;
        const fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC);
        if (fd < 0) return path;
        const buf = new Uint8Array(bytes);
        let written = 0;
        while (written < buf.length) {
            const n = os.write(fd, buf.buffer, written, buf.length - written);
            if (n <= 0) break;
            written += n;
        }
        os.close(fd);
    } catch (e) {
        logDebug("placeholderMidiPath: " + e);
    }
    return path;
}

/* A placeholder for `clip`: its timing, no source. */
function placeholderFor(clip) {
    return {
        placeholder: true, source: "", name: "(empty)", type: "",
        start_bar: clip.start_bar, start_beat: clip.start_beat, end_bar: clip.end_bar, end_beat: clip.end_beat,
        speed: clip.speed, advanced: !!clip.advanced
    };
}

/* Whether a section has chords or Inst/Click items, which deleting one of
 * its clips would leave over the wrong drums. */
function sectionHasTrackContent(sec) {
    if (!sec) return false;
    if (Array.isArray(sec.chords) && sec.chords.some(Boolean)) return true;
    if (Array.isArray(sec.click) && sec.click.length) return true;
    return Array.isArray(sec.inst) && sec.inst.some(l => Array.isArray(l) && l.length);
}

function writeClickMidi(path, note, beatsPerBar, division, bars, ticksPerBeat) {
    if (note <= 0) return false;
    const ppq = division || 240;
    /* The DSP's ticks_per_beat is ppq * 4 / time_sig_den (e.g. 120 for 6/8 at
     * ppq 240), so the click notes must be spaced at that interval to land on
     * the DSP's beats. Defaulting to ppq would place them a quarter-note apart
     * and turn a 6/8 click into 6/4. */
    const tpb = ticksPerBeat || ppq;
    const totalBeats = Math.max(1, (bars || 1)) * beatsPerBar;
    const bytes = [];
    const push = (b) => bytes.push(b & 0xFF);
    const push32 = (v) => { push(v >>> 24); push(v >>> 16); push(v >>> 8); push(v); };
    const push16 = (v) => { push(v >>> 8); push(v); };
    const pushVlq = (v) => {
        let buf = [v & 0x7F];
        v >>>= 7;
        while (v > 0) { buf.unshift((v & 0x7F) | 0x80); v >>>= 7; }
        for (const b of buf) push(b);
    };
    /* Header: MThd, len 6, format 0, 1 track, division. */
    push(0x4D); push(0x54); push(0x68); push(0x64); push32(6); push16(0); push16(1); push16(ppq);
    /* Track: MTrk. */
    push(0x4D); push(0x54); push(0x72); push(0x6B);
    const trackStart = bytes.length;
    push32(0); /* length placeholder */
    /* For each beat, a note-on then note-off. The note lasts a sensible
     * fraction of a beat so it sounds like a real click rather than a 1-tick
     * blip. The gap from note-off to the next note-on is shortened by the
     * same duration so each downbeat stays exactly ticksPerBeat apart. The
     * final click is held almost to the next downbeat so the DSP clip ends
     * exactly at the bar boundary without needing an extra silent tail event. */
    const clickDuration = Math.min(tpb - 1, Math.max(24, Math.floor(tpb / 4)));
    const finalBarTick = totalBeats * tpb;
    /* Accent (louder) velocity for the first beat of each bar (downbeat), so
     * the count-in helps the player feel the bar grouping. Regular beats use
     * a quieter velocity. */
    const ACCENT_VELOCITY = 120;
    const BEAT_VELOCITY = 92;
    for (let b = 0; b < totalBeats; b++) {
        const delta = (b === 0) ? 0 : Math.max(1, tpb - clickDuration);
        pushVlq(delta);
        const isDownbeat = (b % beatsPerBar === 0);
        push(0x90); push(note); push(isDownbeat ? ACCENT_VELOCITY : BEAT_VELOCITY); /* note-on */
        const duration = (b === totalBeats - 1) ? Math.max(1, finalBarTick - b * tpb - 1) : clickDuration;
        pushVlq(duration);
        push(0x80); push(note); push(0);   /* note-off */
    }
    /* End of track at the exact boundary (excluded from timeline events). */
    pushVlq(0); push(0xFF); push(0x2F); push(0x00);
    const trackLen = bytes.length - trackStart - 4;
    /* Patch the track length. */
    bytes[trackStart] = (trackLen >>> 24) & 0xFF;
    bytes[trackStart + 1] = (trackLen >>> 16) & 0xFF;
    bytes[trackStart + 2] = (trackLen >>> 8) & 0xFF;
    bytes[trackStart + 3] = trackLen & 0xFF;
    /* Write as binary via os.open/os.write, looping until all bytes are
     * written (os.write may return a short count on partial writes). */
    try {
        const fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC);
        if (fd < 0) { logDebug("writeClickMidi: os.open failed fd=" + fd); return false; }
        const buf = new Uint8Array(bytes);
        let written = 0;
        while (written < buf.length) {
            const n = os.write(fd, buf.buffer, written, buf.length - written);
            if (n <= 0) break;
            written += n;
        }
        os.close(fd);
        if (written !== buf.length) {
            logDebug("writeClickMidi: short write " + written + "/" + buf.length);
            return false;
        }
        logDebug("writeClickMidi: wrote " + written + " bytes note=" + note + " beats=" + beatsPerBar);
        return true;
    } catch (e) {
        logDebug("writeClickMidi: failed " + e);
        return false;
    }
}

/* Unique click path per performance start. The DSP caches clips by full
 * path and does not reload a file it has already parsed, so we must use a
 * fresh filename each time to pick up timing changes in the generated click. */
let clickMidiPath = "/data/UserData/UserLibrary/Arranger/.click.mid";
const CLICK_DIR = "/data/UserData/UserLibrary/Arranger";

const DEBUG_LOG_PATH = "/data/UserData/UserLibrary/Arranger/.arranger_log";
const CLICK_LOG_PATH = "/data/UserData/UserLibrary/Arranger/.clickflash_log";
const JAM_LOG_PATH = "/data/UserData/UserLibrary/Arranger/.jam_log";
const LOG_STEPLED = false;

/* UTF-8 bytes of a string, for os.write (log lines carry clip names). */
function utf8Bytes(s) {
    const out = [];
    for (let i = 0; i < s.length; i++) {
        let c = s.charCodeAt(i);
        if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
            const d = s.charCodeAt(i + 1);
            if (d >= 0xDC00 && d <= 0xDFFF) {
                c = 0x10000 + ((c - 0xD800) << 10) + (d - 0xDC00);
                i++;
            }
        }
        if (c < 0x80) out.push(c);
        else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
        else if (c < 0x10000) out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        else out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
}

/* Bytes believed to be in each debug log, so appendLogLine can decide when
 * to trim without a stat per line. Seeded from os.stat on first use. */
let logFileSizes = {};

/* Append one line to a debug log, keeping roughly the newest `cap` bytes.
 *
 * host_append_file is not part of the host's API (no Schwung release has
 * had it), so each logger used to fall back to reading the WHOLE log and
 * rewriting it for every line -- up to 500 KB of file I/O per line, on the
 * UI thread, precisely when debug logging was switched on to measure timing.
 * This appends with O_APPEND, and only once the file has grown past twice
 * `cap` does it rewrite it down to the newest `cap` characters. */
function appendLogLine(path, cap, line) {
    if (typeof host_append_file === "function") {
        host_append_file(path, line);
        return;
    }
    try {
        if (logFileSizes[path] === undefined) {
            const st = os.stat(path);
            logFileSizes[path] = (st && st[1] === 0 && st[0]) ? st[0].size : 0;
        }
        if (logFileSizes[path] > 2 * cap) {
            let existing = "";
            try { existing = host_read_file(path) || ""; } catch (e) {}
            const kept = existing.length > cap ? existing.slice(existing.length - cap) : existing;
            host_write_file(path, kept);
            logFileSizes[path] = kept.length;
        }
        const bytes = utf8Bytes(line);
        const fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644);
        if (fd < 0) return;
        let written = 0;
        while (written < bytes.length) {
            const n = os.write(fd, bytes.buffer, written, bytes.length - written);
            if (n <= 0) break;
            written += n;
        }
        os.close(fd);
        logFileSizes[path] += written;
    } catch (e) {}
}

function logJam(msg) {
    if (!dspDebugEnabled) return;
    if (typeof host_write_file !== "function") return;
    appendLogLine(JAM_LOG_PATH, 500000, new Date().toISOString() + " " + msg + "\n");
}

function logDebug(msg) {
    if (!dspDebugEnabled) return;
    if (typeof host_write_file !== "function") return;
    appendLogLine(DEBUG_LOG_PATH, 20000, new Date().toISOString() + " " + msg + "\n");
}

const TIMING_LOG_PATH = "/data/UserData/UserLibrary/Arranger/.timing_log";

function logTiming(msg) {
    if (!dspDebugEnabled) return;
    if (typeof host_write_file !== "function") return;
    appendLogLine(TIMING_LOG_PATH, 500000, new Date().toISOString() + " " + msg + "\n");
}

function logClick(msg) {
    if (!dspDebugEnabled) return;
    if (typeof host_write_file !== "function") return;
    appendLogLine(CLICK_LOG_PATH, 20000, new Date().toISOString() + " " + msg + "\n");
}

function inferTempoFromFolder(name) {
    /* A number followed by "BPM" (e.g. "120 BPM", "85BPM") is the tempo.
     * Accept 2-3 digits so two-digit tempos like "85BPM" are not missed. */
    const explicit = name.match(/(\d{2,3})\s*BPM/i);
    if (explicit) return parseInt(explicit[1], 10);
    /* Fallback: a standalone 3-digit number together (e.g. "078", "110"). */
    const m = name.match(/(?<!\d)(\d{3})(?!\d)/);
    return m ? parseInt(m[1], 10) : 120;
}

function inferTimeSigFromFolder(name) {
    /* Numbers with a '-' between them (e.g. "6-8", "4-4") is the time
     * signature: numerator-denominator. */
    const m = name.match(/(\d{1,2})\s*-\s*(\d{1,2})/);
    if (m) return [parseInt(m[1], 10), parseInt(m[2], 10)];
    return [4, 4];
}

function clipDisplayBars(path) {
    if (!path) return 1;
    const leaf = clipDisplayName(path) || "";
    // Only treat a number as "bars" when it is immediately followed by "bar" / "bars".
    const m = leaf.match(/(\d{1,3})\s*(?:bar|bars)\b/i);
    if (m) return parseInt(m[1], 10);
    return 1;
}

function clipTrueBars(clip) {
    if (!clip) return 1;
    const src = clip.source || clip.path || "";
    if (src && folderClips.length > 0) {
        /* Match by exact source path first, then by leaf name. */
        for (const c of folderClips) {
            if (c.path === src && c.bars > 0) return c.bars;
        }
        const leaf = src.substring(src.lastIndexOf("/") + 1);
        for (const c of folderClips) {
            const cLeaf = (c.path || "").substring((c.path || "").lastIndexOf("/") + 1);
            if (cLeaf === leaf && c.bars > 0) return c.bars;
        }
    }
    /* Fall back to the clip's stored end bar, then the filename heuristic. */
    if (typeof clip.end_bar === "number" && clip.end_bar > 0) return clip.end_bar;
    return clipDisplayBars(src);
}

/* Start bar for a clip. Clips whose name contains ':' (e.g. "Gospel Smack:
 * Verse") have a single blank bar at the start of the file, so they should
 * start from bar 1 (skipping the silence) rather than bar 0. All other clips
 * start from bar 0. */
function clipStartBar(clip) {
    const name = (clip && (clip.name || clip.path)) || "";
    return name.includes(":") ? 1 : 0;
}

/* Effective playable bar count for a clip. ':' clips have a leading blank bar
 * that is skipped (start_bar 1), so they play one fewer bar than the file's
 * total. Used for overlay bar counts and step-LED lengths. */
function clipPlayBars(clip) {
    const bars = (clip && clip.bars) ? clip.bars : 1;
    return clipStartBar(clip) > 0 ? Math.max(1, bars - 1) : bars;
}

function inferPartTypeFromFilename(name) {
    const lower = name.toLowerCase();
    /* "Fill" must win over section names like "Bridge Fill" or "Chorus Fill". */
    if (lower.includes("fill")) return "fill";
    if (lower.includes("intro")) return "intro";
    if (lower.includes("verse")) return "verse";
    /* "prechorus" must be checked before "chorus" (it contains "chorus"). */
    if (lower.includes("prechorus")) return "prechorus";
    if (lower.includes("chorus")) return "chorus";
    if (lower.includes("bridge")) return "bridge";
    if (lower.includes("outro")) return "outro";
    if (lower.includes("break")) return "break";
    return "groove";
}

/* Extract the section keyword (intro/verse/prechorus/chorus/bridge/outro/break)
 * from a filename, or "" if none. Used to match fills to the groove type they
 * belong to (e.g. "Chorus Fill" -> "chorus"). */
function inferSectionFromFilename(name) {
    const lower = (name || "").toLowerCase();
    if (lower.includes("intro")) return "intro";
    if (lower.includes("verse")) return "verse";
    /* "prechorus" must be checked before "chorus" (it contains "chorus"). */
    if (lower.includes("prechorus")) return "prechorus";
    if (lower.includes("chorus")) return "chorus";
    if (lower.includes("bridge")) return "bridge";
    if (lower.includes("outro")) return "outro";
    if (lower.includes("break")) return "break";
    return "";
}

/* Extract the instrument keyword (hat/stick/ride/clap) from a clip path or
 * name. Used to match fills to the groove's instrument (e.g. a "Chorus Hat"
 * groove shows Hat fills). Returns "" if none. */
function inferInstrumentFromFilename(name) {
    const lower = (name || "").toLowerCase();
    if (lower.includes("hat")) return "hat";
    if (lower.includes("stick")) return "stick";
    if (lower.includes("ride")) return "ride";
    if (lower.includes("clap")) return "clap";
    return "";
}

/* Section ordering rank for groove/fill palettes: intro, verse, prechorus,
 * chorus, bridge, break, other, outro. Prechorus comes before chorus. */
const SECTION_RANK = { intro: 0, verse: 1, prechorus: 2, chorus: 3, bridge: 4, break: 5, outro: 7 };
function sectionRankOf(clip) {
    const s = inferSectionFromFilename(clip.name || clip.path);
    return (SECTION_RANK[s] !== undefined) ? SECTION_RANK[s] : 6;
}

/* Compare two clips for palette ordering: by section rank, then alphabetically.
 * Alphabetical (localeCompare) naturally groups a clip family together (e.g.
 * "Stick", "Stick A", "Stick B") with the base/shortest name first, because a
 * shorter prefix always sorts before its longer variants. Sorting by name
 * LENGTH instead interleaves families (a short "Stick" lands before a "Clap A"
 * and the longer "Stick A" after it), which scrambled the palette. */
function clipOrderCompare(a, b) {
    const ra = sectionRankOf(a);
    const rb = sectionRankOf(b);
    if (ra !== rb) return ra - rb;
    const na = (a.name || "");
    const nb = (b.name || "");
    const cmp = na.localeCompare(nb);
    if (cmp !== 0) return cmp;
    return na.length - nb.length;
}

/* A clip is non-looping (plays once then stops) if it is a fill, or an outro
 * groove/fill. Outro sections are endings, so they should not loop. */
function isNonLoopingClip(clip) {
    if (!clip) return false;
    if (clip.type === "fill") return true;
    return inferSectionFromFilename(clip.name || clip.path) === "outro";
}

/* True if the clip is an outro (groove or fill). Outros are endings: when one
 * finishes, playback should stop rather than return to a groove. */
function isOutroClip(clip) {
    if (!clip) return false;
    return inferSectionFromFilename(clip.name || clip.path) === "outro";
}

/* Shorten "Song NN" folder names to "SNN" for display (e.g. "Song 01 4-4 120
 * BPM" -> "S01 4-4 120 BPM"). Used wherever folder/song names are shown, and
 * in Jam mode. */
function shortSongName(name) {
    if (!name) return name;
    return String(name).replace(/\bSong\s+(\d{1,2})\b/ig, (m, n) => "S" + String(n).padStart(2, "0"));
}

function newSong(folderName) {
    /* Store the FULL relative path (category + leaf) as source_folder so the
     * DSP resolves clips directly and the folder picker can reopen at the
     * exact category. Tempo/time-sig are still inferred from the leaf name. */
    const fullPath = folderFullPathForName(folderName);
    const [num, den] = inferTimeSigFromFolder(folderName);
    return {
        id: "song-" + Date.now(),
        name: folderName,
        source_folder: fullPath,
        tempo_bpm: inferTempoFromFolder(folderName),
        time_sig_num: num,
        time_sig_den: den,
        ppq: 240,
        sync_mode: "internal",
        locked: false,
        key: DEFAULT_KEY,
        created: new Date().toISOString(),
        modified: new Date().toISOString(),
        sections: [newSection("Intro")]
    };
}

function newSection(name = "Section") {
    return { id: "sec-" + Date.now(), name, clips: [], chords: [] };
}

/* ── Chord theory helpers ───────────────────────────────────────────── */

/* Semitone offset of a note name (e.g. "C" -> 0, "G" -> 7). Returns -1 for
 * an unknown name. */
function noteSemitone(name) {
    if (!name) return -1;
    const v = PITCH_CLASS[name];
    return (v === undefined) ? -1 : v;
}

/* The diatonic chord (root note name + quality) for a scale degree in a major
 * key. degree is 0-based (0 = tonic). Returns { root, quality }. */
function diatonicChord(key, degree) {
    const keyPc = noteSemitone(key);
    if (keyPc < 0) return { root: "C", quality: "maj" };
    const d = ((degree % 7) + 7) % 7;
    /* Major scale semitone steps from the tonic: 0,2,4,5,7,9,11. */
    const scaleSteps = [0, 2, 4, 5, 7, 9, 11];
    const rootPc = (keyPc + scaleSteps[d]) % 12;
    return { root: spellInKey(rootPc, keyPc), quality: DIATONIC_QUALITY[d] };
}

/* Render a chord object as a display string, e.g. "C", "Dm", "C/G", "Dm7". */
export function chordLabel(chord, key) {
    if (!chord) return "";
    if (chord.none) return "N.C.";
    /* With a key, the notes are spelt as that key writes them. */
    const root = key ? spellNoteForKey(chord.root || "C", key) : (chord.root || "C");
    const bass = chord.bass && key ? spellNoteForKey(chord.bass, key) : chord.bass;
    const q = CHORD_QUALITY_LABEL[chord.quality] || "";
    let s = root + q;
    if (bass && bass !== root) s += "/" + bass;
    return s;
}

/* The number of bars in a section (used to size the per-bar chord array). */
function sectionChordBars(sec) {
    return Math.max(1, Math.ceil(sectionBars(sec)));
}

/* The beat (1-based; halves in Advanced) a chord starts on in its bar. */
export function chordBeat(chord) {
    return (chord && typeof chord.beat === "number" && chord.beat >= 1) ? chord.beat : 1;
}

/* A bar's chords, in beat order. A bar's entry is null (it holds the
 * previous chord), one chord, or -- with several -- an array of them. */
export function barChords(sec, barIndex) {
    if (!sec || !sec.chords) return [];
    const e = sec.chords[barIndex];
    if (!e) return [];
    const list = Array.isArray(e) ? e.filter(Boolean) : [e];
    return list.slice().sort((a, b) => chordBeat(a) - chordBeat(b));
}

/* Set a bar's chords (an empty list clears the bar). Each chord keeps its
 * own beat and Advanced (half-beat starts) flag. A lone chord on beat 1 is
 * stored as just that chord, as before multiple chords existed. */
export function setBarChords(sec, barIndex, list) {
    if (!sec) return;
    if (!sec.chords) sec.chords = [];
    const out = (list || []).filter(Boolean).map(c => {
        const o = Object.assign({}, c);
        if (chordBeat(o) === 1) delete o.beat;
        if (!o.adv) delete o.adv;
        return o;
    }).sort((a, b) => chordBeat(a) - chordBeat(b));
    if (out.length === 0) delete sec.chords[barIndex];
    else if (out.length === 1 && chordBeat(out[0]) === 1) sec.chords[barIndex] = out[0];
    else sec.chords[barIndex] = out;
    unsavedChanges = true;
}

/* Song Builder's Inst 1/2 and Click tracks keep a list of items in each
 * section (sec.inst[0|1], sec.click), so they move with their section. An
 * item starts at a bar/beat (beat as for chords: 1-based, halves when
 * "adv") and holds until the section's next item; each section starts on
 * the track's defaults. An Inst item may set mute, octave, follow_note,
 * voicing, inversion and note_gap (unset = the track default); a Click item
 * sets volume (percent). */
export function sectionItems(sec, track) {
    if (!sec) return [];
    if (track === TRACK_CLICK) {
        if (!Array.isArray(sec.click)) sec.click = [];
        return sec.click;
    }
    const k = Math.max(0, instIndex(track));
    if (!Array.isArray(sec.inst)) sec.inst = [];
    if (!Array.isArray(sec.inst[k])) sec.inst[k] = [];
    return sec.inst[k];
}

export function sortItems(list) {
    list.sort((a, b) => (a.bar - b.bar) || (chordBeat(a) - chordBeat(b)));
    return list;
}

/* An instrument's note-on velocity, 1-127: 100 for a song saved before it
 * was a setting (every instrument note used to be 100). */
export function instrumentVelocity(inst) {
    const v = inst ? inst.velocity : undefined;
    return (typeof v === "number" && v >= 1 && v <= 127) ? Math.round(v) : 100;
}

/* ── Instrument playing variety ── */
/* Fields an instrument (and its items) can set beyond octave/voicing/...,
 * all read by the engine's instrument_attack (arranger_engine.c):
 *   pattern     Bass: Root, Root/5th, Root/Oct, R-5-O-5 (root, fifth,
 *               octave, fifth); Arp: Up, Down, Up-Down, Random.
 *   approach    Bass: a passing note half a beat before each new bass
 *               note -- Off, Below, Above (a semitone), Scale (step below).
 *   strum       Chord: ms between the chord's notes, 0 = Off.
 *   strum_dir   Up (lowest first), Down, Alt (alternating).
 *   chance      percent of attacks that play, 100 = always.
 *   vel_follow  a drum-following attack is as loud as its hit (x velocity/100).
 *   arp_rate    Arp with Follow Note Off: steps per beat, ARP_RATES. */
export const VOICINGS = ["bass", "chord", "arp"];
/* Bass, named by the notes they walk -- 1 the root, 3 and 5 the chord's
 * third and fifth above it, 8 its octave, as the arp's 1-5-8-10 is: 1 (the
 * root alone), 1-5, 1-8, 1-5-8-5, 1-5 Low (the fifth BELOW, country style),
 * 1-3-5-3, 1-3-5-8, and 1-3-5-6-b7 (boogie: 1 3 5 6 b7 6 5 3). */
const BASS_PATTERN_LABELS = ["1", "1-5", "1-8", "1-5-8-5", "1-5 Low", "1-3-5-3", "1-3-5-8", "1-3-5-6-b7"];
/* Arp: Random / Rnd Walk (a step up or down) / Shuffle (every tone once a
 * round) start each chord on the base; Alberti low-high-mid-high; Pedal the
 * base between each other tone; Converge outside in; 1-5-8-10 the root's
 * broken chord. */
const ARP_PATTERN_LABELS = ["Up", "Down", "Up-Down", "Random", "Rnd Walk", "Shuffle", "Alberti", "Pedal",
    "Converge", "1-5-8-10"];
const APPROACH_LABELS = ["Off", "Below", "Above", "Scale"];
const STRUM_DIR_LABELS = ["Up", "Down", "Alt"];
const STRUM_MAX_MS = 100;
/* Arp Rate as steps per beat, and its names. */
const ARP_RATES = [1, 2, 3, 4, 6];
const ARP_RATE_LABELS = { 1: "1/4", 2: "1/8", 3: "1/8T", 4: "1/16", 6: "1/16T" };
/* Which voicings each variety row applies to; the others hide it. */
const VARIETY_ROWS = {
    pattern: { label: "Pattern", voicings: ["bass", "arp"] },
    approach: { label: "Approach", voicings: ["bass"] },
    strum: { label: "Strum", voicings: ["chord"] },
    strum_dir: { label: "Strum Dir", voicings: ["chord"] },
    arp_range: { label: "Range", voicings: ["arp"] },
    arp_vel: { label: "Vel Range", voicings: ["arp"] }
};

function arpRangeLabel(r) { return r + " Oct"; }
function arpVelLabel(v) { return v > 0 ? v + "%" : "Off"; }

function voicingLabel(v) {
    return v === "chord" ? "Chord" : (v === "arp" ? "Arp" : "Bass");
}

/* Voicing turned by `delta`, Bass / Chord / Arp, stopping at the ends. */
export function stepVoicing(cur, delta) {
    const i = Math.max(0, VOICINGS.indexOf(cur));
    return VOICINGS[Math.max(0, Math.min(VOICINGS.length - 1, i + delta))];
}

function patternList(voicing) {
    return voicing === "arp" ? ARP_PATTERN_LABELS : BASS_PATTERN_LABELS;
}

/* A pattern past the voicing's list (an Arp pattern kept after switching to
 * Bass) plays its first: the engine does the same. */
export function patternLabel(voicing, p) {
    const list = patternList(voicing);
    const i = p | 0;
    return list[i >= 0 && i < list.length ? i : 0];
}

function strumLabel(ms) { return ms > 0 ? ms + "ms" : "Off"; }
function chanceLabel(c) { return c + "%"; }

/* An instrument's variety settings with their defaults filled in. */
export function instVariety(inst) {
    const o = inst || {};
    const int = (v, lo, hi, d) => (typeof v === "number" && v >= lo && v <= hi) ? Math.round(v) : d;
    return {
        pattern: int(o.pattern, 0, ARP_PATTERN_LABELS.length - 1, 0),
        approach: int(o.approach, 0, 3, 0),
        strum: int(o.strum, 0, STRUM_MAX_MS, 0),
        strum_dir: int(o.strum_dir, 0, 2, 0),
        chance: int(o.chance, 1, 100, 100),
        vel_follow: !!o.vel_follow,
        arp_rate: ARP_RATES.includes(o.arp_rate) ? o.arp_rate : 2,
        arp_range: int(o.arp_range, 1, 3, 1),
        arp_vel: int(o.arp_vel, 0, 90, 0)
    };
}

/* The variety row `key` for a menu, when it applies to `voicing`. */
function instVarietyRows(voicing, key, value) {
    const r = VARIETY_ROWS[key];
    return r.voicings.includes(voicing || "bass") ? [{ key, label: r.label, value: value() }] : [];
}

/* Turn an instrument's variety field. */
function stepInstVariety(inst, key, delta) {
    const v = instVariety(inst);
    if (key === "pattern") {
        const max = patternList(inst.voicing || "bass").length - 1;
        inst.pattern = Math.max(0, Math.min(max, Math.min(max, v.pattern) + delta));
    }
    else if (key === "arp_range") inst.arp_range = Math.max(1, Math.min(3, v.arp_range + delta));
    else if (key === "arp_vel") inst.arp_vel = Math.max(0, Math.min(90, v.arp_vel + delta * 10));
    else if (key === "approach") inst.approach = Math.max(0, Math.min(3, v.approach + delta));
    else if (key === "strum") inst.strum = Math.max(0, Math.min(STRUM_MAX_MS, v.strum + delta * 5));
    else if (key === "strum_dir") inst.strum_dir = Math.max(0, Math.min(2, v.strum_dir + delta));
    else if (key === "chance") inst.chance = Math.max(5, Math.min(100, v.chance + delta * 5));
    else if (key === "vel_follow") inst.vel_follow = delta > 0;
    else if (key === "arp_rate") {
        const i = ARP_RATES.indexOf(v.arp_rate);
        inst.arp_rate = ARP_RATES[Math.max(0, Math.min(ARP_RATES.length - 1, i + delta))];
    }
}

/* The Arp's Rate row: only with Follow Note Off -- following a drum, the
 * hits are its rhythm. */
function arpRateRows(voicing, followNote, value) {
    return voicing === "arp" && !(followNote > 0) ? [{ key: "arp_rate", label: "Rate", value: value() }] : [];
}

const INST_ITEM_FIELDS = ["mute", "octave", "follow_note", "voicing", "inversion", "note_gap", "velocity",
    "pattern", "approach", "strum", "strum_dir", "chance", "vel_follow", "arp_rate", "arp_range", "arp_vel"];

/* Turn an instrument's old per-bar mutes (inst.bars) and per-bar overrides
 * (inst.overrides), both indexed by section number, into section items that
 * sound the same: an item wherever a bar's settings differ from the bar
 * before, and one back to the defaults after the last. Returns true if the
 * song changed. */
export function migrateInstrumentItems(song) {
    if (!song || !Array.isArray(song.instruments) || !Array.isArray(song.sections)) return false;
    let changed = false;
    song.instruments.forEach((inst, k) => {
        if (!inst || k > 1) return;
        const bars = Array.isArray(inst.bars) ? inst.bars : [];
        const ovs = Array.isArray(inst.overrides) ? inst.overrides.filter(Boolean) : [];
        const hasOld = bars.some(sb => Array.isArray(sb) && sb.some(b => b === false)) || ovs.length > 0;
        if (!hasOld) return;
        song.sections.forEach((sec, si) => {
            if (Array.isArray(sec.inst) && Array.isArray(sec.inst[k]) && sec.inst[k].length) return;
            const sb = Array.isArray(bars[si]) ? bars[si] : [];
            const so = ovs.filter(o => o.section === si);
            let n = sb.length;
            for (const o of so) n = Math.max(n, o.bar + 1);
            const list = [];
            let prev = "{}";
            for (let b = 0; b <= n; b++) {
                const st = {};
                if (b < n) {
                    if (sb[b] === false) st.mute = true;
                    const o = so.find(x => x.bar === b);
                    if (o) for (const f of ["octave", "follow_note", "voicing", "inversion"]) {
                        if (o[f] !== null && o[f] !== undefined) st[f] = o[f];
                    }
                }
                const key = JSON.stringify(st);
                if (key !== prev) { list.push(Object.assign({ bar: b }, st)); prev = key; }
            }
            if (list.length) {
                if (!Array.isArray(sec.inst)) sec.inst = [];
                sec.inst[k] = list;
            }
        });
        inst.bars = [];
        inst.overrides = [];
        changed = true;
    });
    return changed;
}

/* Transpose a chord object by a number of semitones (used when the song key
 * changes so existing chords follow the new key). */
export function transposeChord(chord, semitones) {
    if (!chord) return null;
    if (Array.isArray(chord)) return chord.map(c => transposeChord(c, semitones));
    const out = chord.none ? { none: true } : { quality: chord.quality || "maj" };
    if (typeof chord.beat === "number") out.beat = chord.beat;
    if (chord.adv) out.adv = true;
    if (chord.none) return out;
    const rootPc = noteSemitone(chord.root);
    if (rootPc >= 0) out.root = NOTE_NAMES[((rootPc + semitones) % 12 + 12) % 12];
    else out.root = chord.root;
    if (chord.bass) {
        const bassPc = noteSemitone(chord.bass);
        if (bassPc >= 0) out.bass = NOTE_NAMES[((bassPc + semitones) % 12 + 12) % 12];
        else out.bass = chord.bass;
    }
    return out;
}

/* ── A setlist's edits to a song ─────────────────────────────────────
 *
 * A setlist entry may play its song in another key (entry.key), at another
 * tempo (entry.tempo_bpm) or with its sections in another order -- repeated,
 * left out, rearranged (entry.sections: [{i, name}], i the section's index in
 * the song file, name what it was called then). Absent = the song's own. The
 * song file is never changed: Perform plays a copy. A reference whose index
 * no longer names that section (the song was edited since) is found again by
 * name, and one that cannot be is left out. */
export function setlistSectionIndices(song, entry) {
    const secs = song && Array.isArray(song.sections) ? song.sections : [];
    if (!entry || !Array.isArray(entry.sections)) return secs.map((_, i) => i);
    const out = [];
    for (const ref of entry.sections) {
        if (!ref) continue;
        let i = typeof ref.i === "number" ? ref.i : -1;
        if (!(secs[i] && (ref.name === undefined || (secs[i].name || "") === ref.name))) {
            i = secs.findIndex(sec => (sec.name || "") === ref.name);
        }
        if (i >= 0) out.push(i);
    }
    return out.length ? out : secs.map((_, i) => i);
}

export function applySetlistEdits(song, entry) {
    if (!song || !entry) return song;
    const key = typeof entry.key === "string" && KEYS.indexOf(entry.key) >= 0 ? entry.key : null;
    const tempo = typeof entry.tempo_bpm === "number" && entry.tempo_bpm >= 20 && entry.tempo_bpm <= 300 ? entry.tempo_bpm : null;
    if (!key && !tempo && !Array.isArray(entry.sections)) return song;
    const out = JSON.parse(JSON.stringify(song));
    if (Array.isArray(entry.sections)) {
        const seen = {};
        out.sections = setlistSectionIndices(song, entry).map(i => {
            const sec = JSON.parse(JSON.stringify(song.sections[i]));
            /* A repeat is its own section (its own id). */
            seen[i] = (seen[i] || 0) + 1;
            if (seen[i] > 1 && sec.id) sec.id = sec.id + "-r" + seen[i];
            return sec;
        });
    }
    if (key) {
        const from = song.key || DEFAULT_KEY;
        if (key !== from) transposeSongChords(out, from, key);
        out.key = key;
    }
    if (tempo) out.tempo_bpm = tempo;
    return out;
}

/* Transpose every chord in the song by the semitone delta between two keys.
 * Called when the song key changes so set chords follow the new key. */
function transposeSongChords(song, oldKey, newKey) {
    if (!song || !song.sections) return;
    const oldPc = noteSemitone(oldKey);
    const newPc = noteSemitone(newKey);
    if (oldPc < 0 || newPc < 0) return;
    const delta = newPc - oldPc;
    if (delta === 0) return;
    for (const sec of song.sections) {
        if (!sec.chords) continue;
        for (let i = 0; i < sec.chords.length; i++) {
            if (sec.chords[i]) sec.chords[i] = transposeChord(sec.chords[i], delta);
        }
    }
}

/* ── Instrument track helpers ───────────────────────────────────────── */

/* The instrument config for an instrument track (Inst 1, Inst 2, Pads). */
function instrumentForTrack(track) {
    /* The real song, also while a temporary copy plays (Play from the
     * cursor): a setting changed during playback used to go to the copy and
     * was lost on Stop. Playback hears it through pushInstrumentLive. */
    const song = viewSong();
    if (!song) return null;
    if (!song.instruments) song.instruments = [];
    const idx = instIndex(track);
    if (idx < 0) return null;
    /* Never a gap: a song saved with Pads but no Inst 1/2 still lists them. */
    for (let k = 0; k <= idx; k++) {
        if (!song.instruments[k]) song.instruments[k] = defaultInstrument(k);
    }
    if (!song.instruments[idx].overrides) song.instruments[idx].overrides = [];
    if (typeof song.instruments[idx].inversion !== "number") song.instruments[idx].inversion = INVERSION_AUTO;
    return song.instruments[idx];
}

/* While Song Builder plays, a change to an instrument -- its settings, or
 * its items -- is heard at once: the engine takes that instrument's JSON as
 * a live update (inst<N>_live) and re-attacks, instead of the change waiting
 * for the next Play. Built from the real song; while a temporary copy plays
 * (from a section or the cursor), its items are renumbered onto the copy's
 * sections. Sent once a tick at most (flushInstrumentLive). */
const instLiveDirty = new Set();

function markInstrumentLive(track) {
    if (isInstTrack(track) && playbackState === "playing" && currentMode !== MODE_PERFORMANCE && !harmonyPreviewing) instLiveDirty.add(track);
}

export function instrumentLiveJson(song, idx, start) {
    const eng = JSON.parse(toEngineSongJson(song));
    const inst = eng.instruments && eng.instruments[idx];
    if (!inst) return null;
    if (Array.isArray(inst.items)) {
        inst.items = inst.items.filter(it => it.section >= start)
            .map(it => Object.assign({}, it, { section: it.section - start }));
    }
    /* Items replace the old per-bar maps (the engine ignores them then). */
    delete inst.bars;
    delete inst.overrides;
    return JSON.stringify([inst]);
}

function flushInstrumentLive() {
    if (instLiveDirty.size === 0) return;
    const tracks = [...instLiveDirty];
    instLiveDirty.clear();
    if (playbackState !== "playing" || typeof host_module_set_param !== "function") return;
    const song = viewSong();
    if (!song) return;
    const start = builderPlayingFromTemp ? (tempSongStart.get(currentSong) || 0) : 0;
    for (const track of tracks) {
        const idx = instIndex(track);
        const json = instrumentLiveJson(song, idx, start);
        if (json) host_module_set_param("inst" + (idx + 1) + "_live", json);
    }
}

/* A new song's instrument `idx`: Inst 1/2 as they always were; Pads a
 * chord an octave up, voice-led (Auto), off until switched on. */
export function defaultInstrument(idx) {
    const pads = idx === 2;
    return {
        enabled: false,
        octave: pads ? 4 : 3,
        follow_note: 0,
        voicing: pads ? "chord" : "bass",
        inversion: INVERSION_AUTO,
        note_gap: pads ? 0.125 : 0.25,
        velocity: pads ? 80 : 100,
        bars: [],
        overrides: []
    };
}

/* "Play from section N"/"play from cursor" build a temporary song whose
 * `sections` array is sliced to start at `startSectionIndex` (so section N
 * becomes index 0 in what's sent to the DSP), but leave each instrument's
 * per-section `bars` array and `overrides[].section` values as absolute
 * indices into the ORIGINAL, unsliced section list -- a bar-boundary mute
 * toggle happens to look harmless when it's misaligned (most bars default
 * to "on" either way), but a per-bar Follow Note/Octave/Voicing override
 * lands on the wrong bar entirely (or past the sliced array's end, i.e.
 * nowhere), which is why only overrides appeared "ignored" when playing
 * from a non-first section. Mutates `song.instruments` in place to match
 * the same slice -- callers pass a song that's already a deep clone (e.g.
 * `JSON.parse(JSON.stringify(currentSong))`), never `currentSong` itself. */
export function reindexInstrumentsForSectionSlice(song, startSectionIndex) {
    if (!song || !song.instruments || startSectionIndex <= 0) return;
    for (const inst of song.instruments) {
        if (inst.bars) inst.bars = inst.bars.slice(startSectionIndex);
        if (inst.overrides) {
            inst.overrides = inst.overrides
                .filter(ov => ov && ov.section >= startSectionIndex)
                .map(ov => Object.assign({}, ov, { section: ov.section - startSectionIndex }));
        }
    }
}

/* Display label for a full-chord inversion (0-3: root/1st/2nd/3rd). Only
 * audible with "chord" voicing -- a triad clamps 3rd inversion down to 2nd
 * on the DSP side, so labelling all four here is harmless either way. */
export function inversionLabel(inv) {
    const labels = ["Root", "1st Inv", "2nd Inv", "3rd Inv", "Auto"];
    return labels[Math.max(0, Math.min(INVERSION_AUTO, inv || 0))];
}

/* A chord's scale degree (0-6) in a major key by its root, or -1 if the root
 * isn't in the key. Sent to the DSP with each chord for the Auto inversion. */
export function chordDegreeInKey(chord, key) {
    if (!chord) return -1;
    const keyPc = noteSemitone(key);
    const rootPc = noteSemitone(chord.root);
    if (keyPc < 0 || rootPc < 0) return -1;
    return [0, 2, 4, 5, 7, 9, 11].indexOf(((rootPc - keyPc) % 12 + 12) % 12);
}

/* Display label for the note-gap value (fraction of a beat). */
export function noteGapLabel(gap) {
    if (!gap || gap <= 0) return "Off";
    if (gap >= 1) return "1 beat";
    if (gap >= 0.5) return "1/2";
    if (gap >= 0.25) return "1/4";
    if (gap >= 0.125) return "1/8";
    return "1/16";
}

function resolveClipSource(source, folderName) {
    if (!source) return "";
    let s = source.trim();
    if (!s) return "";
    /* If the source already has a known extension or is absolute, keep it. */
    const lower = s.toLowerCase();
    if (s.startsWith("/") || lower.endsWith(".mid") || lower.endsWith(".midi")) return s;
    /* Normalize leaf names by appending .mid when missing. */
    return s + ".mid";
}

export function toEngineSongJson(song) {
    const secOut = [];
    for (const sec of song.sections) {
        const clipsOut = [];
        for (const c of sec.clips || []) {
            /* Clamp end_bar to a sane value so corrupt end_bar:72 songs still play one bar. */
            let endBar = c.end_bar;
            if (typeof endBar !== "number" || endBar <= 0 || endBar > 256) endBar = 1;
            /* A placeholder plays a silent file at least as long as it. */
            const src = c.placeholder
                ? placeholderMidiPath(Math.ceil(endBar) + 1, song.time_sig_num || 4, song.time_sig_den || 4)
                : resolveClipSource(c.source, song.source_folder);
            let startBar = c.start_bar;
            if (typeof startBar !== "number" || startBar < 0 || startBar >= endBar) startBar = 0;
            const startBeat = (typeof c.start_beat === "number" && c.start_beat > 0) ? c.start_beat : 0;
            const endBeat = (typeof c.end_beat === "number" && c.end_beat > 0) ? c.end_beat : 0;
            /* Round scaling values to 2 decimal places so saved songs don't
             * accumulate long floating-point tails (e.g. 0.7999999999999998). */
            const round2 = (v) => Math.round(v * 100) / 100;
            const clipOut = {
                source: src,
                start_bar: startBar,
                start_beat: startBeat,
                end_bar: endBar,
                end_beat: endBeat,
                guard_fraction: (typeof c.guard_fraction === "number") ? round2(c.guard_fraction) : 0,
                speed: (typeof c.speed === "number" && c.speed > 0) ? round2(c.speed) : 1.0,
                velocity_scale: (typeof c.velocity_scale === "number" && c.velocity_scale >= 0) ? round2(c.velocity_scale) : 1,
                snare_note: (typeof c.snare_note === "number") ? c.snare_note : 38,
                snare_velocity_scale: (typeof c.snare_velocity_scale === "number" && c.snare_velocity_scale >= 0) ? round2(c.snare_velocity_scale) : 1,
                kick_note: (typeof c.kick_note === "number") ? c.kick_note : 36,
                kick_target: (typeof c.kick_target === "number") ? c.kick_target : 0,
                /* Per-clip MIDI channel override: 0 = follow the engine's
                 * output-target channel; 1-16 = explicit channel (used for the
                 * count-in click). */
                channel: (typeof c.channel === "number" && c.channel > 0) ? c.channel : 0
            };
            /* A clip added from a different folder than the song's primary one
             * stores its own source_folder so the DSP resolves it correctly.
             * Only emit it when it differs from the song's primary folder. */
            if (c.source_folder && c.source_folder !== song.source_folder && !c.placeholder) {
                clipOut.source_folder = c.source_folder;
            }
            clipsOut.push(clipOut);
        }
        /* Emit the per-bar chord array for this section. Each entry is a
         * {root, quality, bass} object or null. */
        const chordsOut = [];
        if (sec.chords && sec.chords.length > 0) {
            for (let i = 0; i < sec.chords.length; i++) {
                /* A bar: null (holds the previous chord), one chord, or an
                 * array for several, each with its beat. No Chord is a
                 * silent bar that stops the previous chord carrying forward
                 * (an empty bar holds it). */
                const list = barChords(sec, i);
                const one = (ch) => {
                    const o = ch.none ? { none: true } : {
                        root: ch.root || "C",
                        quality: ch.quality || "maj",
                        bass: ch.bass || "",
                        /* For the Auto inversion -- see INVERSION_AUTO. */
                        degree: chordDegreeInKey(ch, song.key || DEFAULT_KEY),
                        key: song.key || DEFAULT_KEY
                    };
                    if (chordBeat(ch) !== 1) o.beat = chordBeat(ch);
                    return o;
                };
                if (list.length === 0) chordsOut.push(null);
                else if (list.length === 1) chordsOut.push(one(list[0]));
                else chordsOut.push(list.map(one));
            }
        }
        secOut.push({ name: sec.name || "Section", clips: clipsOut, chords: chordsOut });
    }
    /* Emit the instrument tracks (Step 2). Each is a config object; the DSP
     * uses the chord track to emit notes on the instrument's channel. Output
     * and channel are global (set in Options), not per-song, so pull them
     * from the global inst1/inst2 state by track index rather than from the
     * song's own instrument entry. */
    const instrumentsOut = [];
    const instGlobals = [
        { output: inst1Output, channel: inst1Channel },
        { output: inst2Output, channel: inst2Channel },
        { output: inst3Output, channel: inst3Channel }
    ];
    const instList = song.instruments || [];
    for (let i = 0; i < instList.length; i++) {
        const inst = instList[i] || defaultInstrument(i);
        const g = instGlobals[i] || instGlobals[0];
        /* Settings changes by position, from each section's items (see
         * sectionItems); the engine then ignores bars/overrides below. */
        const itemsOut = [];
        (song.sections || []).forEach((sec, si) => {
            const list = (Array.isArray(sec.inst) && Array.isArray(sec.inst[i])) ? sec.inst[i] : [];
            for (const it of list) {
                const o = { section: si, bar: it.bar };
                if (chordBeat(it) !== 1) o.beat = chordBeat(it);
                for (const f of INST_ITEM_FIELDS) if (it[f] !== null && it[f] !== undefined) o[f] = it[f];
                itemsOut.push(o);
            }
        });
        instrumentsOut.push({
            items: itemsOut,
            enabled: !!inst.enabled,
            output: g.output || "external",
            channel: (typeof g.channel === "number" && g.channel >= 1 && g.channel <= 16) ? g.channel : 1,
            octave: (typeof inst.octave === "number") ? inst.octave : 3,
            /* Pads (the third) are always a chord on the chord grid. */
            follow_note: i === 2 ? 0 : (typeof inst.follow_note === "number") ? inst.follow_note : 0,
            voicing: i === 2 ? "chord" : (inst.voicing || "bass"),
            /* Full-chord inversion (voicing "chord" only): 0 = root position,
             * 1/2/3 = first/second/third inversion. Meaningless for "bass"
             * voicing, but still carried so switching a bar back to "chord"
             * remembers it. */
            inversion: (typeof inst.inversion === "number") ? inst.inversion : 0,
            note_gap: (typeof inst.note_gap === "number") ? inst.note_gap : 0.25,
            /* Note-on velocity, 1-127 (items can change it from a bar/beat). */
            velocity: instrumentVelocity(inst),
            /* Playing variety (see instVariety). */
            ...instVariety(inst),
            /* Per-section per-bar on/off map: 1 = send chord, 0 = muted.
             * Bars are "on by default": only an explicit `false` mutes a bar;
             * an unset (undefined) bar sends. Serialize accordingly so the DSP
             * (which also defaults bars to "send") matches the UI. */
            bars: (inst.bars || []).map(sec => (sec || []).map(b => (b === false ? 0 : 1))),
            /* Sparse per-bar overrides for octave/follow_note/voicing/
             * inversion: only bars with an explicit override appear here at
             * all, and a field left "Default" on a bar that DOES have an
             * override is simply omitted (see parse_instrument_overrides on
             * the DSP side). */
            overrides: (inst.overrides || []).filter(ov => ov && (
                (ov.octave !== null && ov.octave !== undefined) ||
                (ov.follow_note !== null && ov.follow_note !== undefined) ||
                (ov.voicing !== null && ov.voicing !== undefined) ||
                (ov.inversion !== null && ov.inversion !== undefined)
            )).map(ov => {
                const out = { section: ov.section, bar: ov.bar };
                if (ov.octave !== null && ov.octave !== undefined) out.octave = ov.octave;
                if (ov.follow_note !== null && ov.follow_note !== undefined) out.follow_note = ov.follow_note;
                if (ov.voicing !== null && ov.voicing !== undefined) out.voicing = ov.voicing;
                if (ov.inversion !== null && ov.inversion !== undefined) out.inversion = ov.inversion;
                return out;
            })
        });
    }
    return JSON.stringify({
        source_folder: song.source_folder || "",
        name: song.name || "Untitled",
        tempo_bpm: song.tempo_bpm || 120,
        time_sig_num: song.time_sig_num || 4,
        time_sig_den: song.time_sig_den || 4,
        ppq: song.ppq || 240,
        sync_mode: song.sync_mode || "internal",
        key: song.key || DEFAULT_KEY,
        /* A Perform count-in: the click track plays it -- see clickSoundOn. */
        count_in: song.count_in ? 1 : 0,
        count_in_sound: song.count_in_sound ? 1 : 0,
        /* Click volume changes (the Click track's items). */
        click_items: (song.sections || []).flatMap((sec, si) => (Array.isArray(sec.click) ? sec.click : []).map(it => {
            const o = { section: si, bar: it.bar, volume: typeof it.volume === "number" ? it.volume : 100 };
            if (chordBeat(it) !== 1) o.beat = chordBeat(it);
            return o;
        })),
        sections: secOut,
        instruments: instrumentsOut
    });
}

export function toUiSong(engineLike) {
    const s = engineLike || {};
    const songFolder = s.source_folder || "";
    const song = {
        id: s.id || ("song-" + Date.now()),
        name: s.name || "Untitled",
        source_folder: songFolder,
        tempo_bpm: s.tempo_bpm || 120,
        time_sig_num: s.time_sig_num || (s.time_signature ? s.time_signature[0] : 4),
        time_sig_den: s.time_sig_den || (s.time_signature ? s.time_signature[1] : 4),
        locked: !!(s.locked),
        key: s.key || DEFAULT_KEY,
        created: s.created || new Date().toISOString(),
        modified: s.modified || new Date().toISOString(),
        sections: (s.sections || []).map(sec => ({
            id: sec.id || ("sec-" + Date.now()),
            name: sec.name || "Section",
            /* The Inst 1/2 and Click tracks' items (see sectionItems). */
            inst: Array.isArray(sec.inst)
                ? sec.inst.map(l => (Array.isArray(l) ? l : []).filter(Boolean).map(it => Object.assign({}, it)))
                : undefined,
            click: Array.isArray(sec.click) ? sec.click.filter(Boolean).map(it => Object.assign({}, it)) : undefined,
            chords: (sec.chords || []).map(e => {
                if (!e) return null;
                const one = (c) => {
                    const o = c.none ? { none: true } : {
                        root: c.root || "C",
                        quality: c.quality || "maj",
                        bass: c.bass || ""
                    };
                    if (typeof c.beat === "number" && c.beat > 1) o.beat = c.beat;
                    if (c.adv) o.adv = true;
                    return o;
                };
                return Array.isArray(e) ? e.filter(Boolean).map(one) : one(e);
            }),
            clips: (sec.clips || []).map(c => {
                const src = c.source || c.path || "";
                /* Backfill a clip's source_folder for existing songs whose
                 * clips were added from a different folder than the song's
                 * primary one. A clip that already carries its own folder is
                 * kept; otherwise, if the clip's leaf name is found in another
                 * folder, record that folder so the DSP resolves it correctly
                 * and the saved file is updated. */
                let clipFolder = c.source_folder || "";
                if (!clipFolder && folderClipMap && src) {
                    clipFolder = clipFolderBackfill(folderClipMap, clipDisplayName(src), songFolder);
                }
                return {
                    source: src,
                    name: c.name || clipDisplayName(src),
                    type: c.type || inferPartTypeFromFilename(c.name || src),
                    source_folder: clipFolder,
                    start_bar: c.start_bar !== undefined ? c.start_bar : (c.trim ? c.trim.start_bar : 0),
                    start_beat: c.start_beat !== undefined ? c.start_beat : 0,
                    end_bar: c.end_bar !== undefined ? c.end_bar : (c.trim ? c.trim.end_bar : 1),
                    end_beat: c.end_beat !== undefined ? c.end_beat : 0,
                    guard_fraction: c.guard_fraction !== undefined ? c.guard_fraction : 0,
                    speed: c.speed !== undefined ? c.speed : 1.0,
                    velocity_scale: c.velocity_scale !== undefined ? c.velocity_scale : 1.0,
                    snare_note: c.snare_note !== undefined ? c.snare_note : 38,
                    snare_velocity_scale: c.snare_velocity_scale !== undefined ? c.snare_velocity_scale : 1.0,
                    kick_note: c.kick_note !== undefined ? c.kick_note : 36,
                    kick_target: c.kick_target !== undefined ? c.kick_target : 0,
                    channel: c.channel !== undefined ? c.channel : 0,
                    advanced: !!(c.advanced),
                    ...(c.placeholder ? { placeholder: true, name: "(empty)", type: "" } : {})
                };
            })
        })),
        instruments: (s.instruments || []).map((inst, i) => inst || defaultInstrument(i)).map(inst => ({
            enabled: !!inst.enabled,
            octave: (typeof inst.octave === "number") ? inst.octave : 3,
            follow_note: (typeof inst.follow_note === "number") ? inst.follow_note : 0,
            voicing: inst.voicing || "bass",
            inversion: (typeof inst.inversion === "number") ? inst.inversion : 0,
            note_gap: (typeof inst.note_gap === "number") ? inst.note_gap : 0.25,
            velocity: instrumentVelocity(inst),
            ...instVariety(inst),
            bars: (inst.bars || []).map(sec => (sec || []).map(b => !!b)),
            overrides: (inst.overrides || []).map(ov => {
                const out = { section: ov.section, bar: ov.bar };
                if (typeof ov.octave === "number") out.octave = ov.octave;
                if (typeof ov.follow_note === "number") out.follow_note = ov.follow_note;
                if (ov.voicing === "bass" || ov.voicing === "chord") out.voicing = ov.voicing;
                if (typeof ov.inversion === "number") out.inversion = ov.inversion;
                return out;
            })
        }))
    };
    /* Old per-bar instrument data becomes section items (see
     * migrateInstrumentItems). */
    migrateInstrumentItems(song);
    return song;
}

function clipDisplayName(path) {
    if (!path) return "";
    const slash = path.lastIndexOf("/");
    let leaf = slash >= 0 ? path.substring(slash + 1) : path;
    const dot = leaf.lastIndexOf(".");
    if (dot > 0) leaf = leaf.substring(0, dot);
    return leaf;
}

function safeFileName(name) {
    return name.replace(/[^a-zA-Z0-9 _-]/g, "").replace(/\s+/g, "_").substring(0, 48) || "untitled";
}

function songPath(name) {
    return SONGS_DIR + "/" + safeFileName(name) + ".json";
}

function setlistPath(name) {
    return SETLISTS_DIR + "/" + safeFileName(name) + ".json";
}

/* Read one of the DSP's paged list answers ("songs_json", "folders_json",
 * "clip_leaves_json"): {"count":N,"start":S,"items":[...]}, whole items only.
 * One read normally returns the whole list -- the per-index keys this
 * replaces cost one synchronous round trip (~2.9 ms) per name, so 2N+1 for
 * the Song Bank on every open. Pages on from wherever an answer stopped.
 * Returns null if the DSP gave no usable answer (the caller falls back to the
 * per-index keys), else { count, items } with items.length <= count -- short
 * only if a page made no progress, so the caller can read the rest per index. */
function readDspList(key) {
    const items = [];
    let count = -1;
    for (let page = 0; page < 64; page++) {
        const raw = host_module_get_param(page === 0 ? key : key + "_" + items.length);
        if (!raw) break;
        let p;
        try { p = JSON.parse(raw); } catch (e) { break; }
        if (!p || !Array.isArray(p.items) || typeof p.count !== "number") break;
        if (count < 0) count = p.count;
        if (p.count !== count) return null;   /* rescanned between pages */
        for (const it of p.items) items.push(it);
        if (items.length >= count || p.items.length === 0) break;
    }
    if (count < 0) return null;
    return { count, items };
}

function listSongFiles() {
    const out = [];
    if (typeof host_module_get_param !== "function") return out;
    let count = 0;
    let listedItems = [];
    const listed = readDspList("songs_json");
    if (listed) {
        count = listed.count;
        listedItems = listed.items;
    } else {
        try {
            const cnt = host_module_get_param("song_count");
            if (cnt) count = parseInt(cnt, 10);
        } catch (e) {}
    }
    for (let i = 0; i < count; i++) {
        /* From the list answer where it reached, else by index. */
        const s = i < listedItems.length ? listedItems[i] : null;
        const name = s ? s.name : host_module_get_param("song_name_" + i);
        const path = s ? s.path : host_module_get_param("song_path_" + i);
        if (name && path) out.push({ name, path });
    }
    return out;
}

function listSetlistFiles() {
    const out = [];
    if (typeof os.readdir !== "function") return out;
    let names = [];
    try {
        const raw = os.readdir(SETLISTS_DIR);
        if (Array.isArray(raw)) {
            /* os.readdir may return [names] or [names, types]. */
            names = Array.isArray(raw[0]) ? raw[0] : raw;
        }
    } catch (e) {
        return out;
    }
    for (const n of names) {
        if (typeof n !== "string" || !n.endsWith(".json")) continue;
        const path = SETLISTS_DIR + "/" + n;
        const obj = readJson(path);
        out.push({
            name: (obj && obj.name) ? obj.name : n.replace(/\.json$/, ""),
            path
        });
    }
    return out;
}

/* Normalize a song in place before saving: round scaling values to 2 decimal
 * places and ensure each clip carries its own source_folder when it was added
 * from a different folder than the song's primary one. This keeps the saved
 * file consistent with what the DSP plays (toEngineSongJson) and avoids
 * accumulating floating-point tails (e.g. 0.7999999999999998). */
function normalizeSongForSave(song) {
    if (!song) return;
    const round2 = (v) => Math.round(v * 100) / 100;
    const songFolder = song.source_folder || "";
    for (const sec of song.sections || []) {
        for (const c of sec.clips || []) {
            if (typeof c.guard_fraction === "number") c.guard_fraction = round2(c.guard_fraction);
            if (typeof c.speed === "number") c.speed = round2(c.speed);
            if (typeof c.velocity_scale === "number") c.velocity_scale = round2(c.velocity_scale);
            if (typeof c.snare_velocity_scale === "number") c.snare_velocity_scale = round2(c.snare_velocity_scale);
            /* Backfill a clip's source_folder when it was added from a
             * different folder than the song's primary one. A clip that
             * already carries its own folder is kept; otherwise, if the clip's
             * leaf name is found in another folder, record that folder. */
            if (!c.source_folder && folderClipMap && c.source) {
                const found = clipFolderBackfill(folderClipMap, clipDisplayName(c.source), songFolder);
                if (found) c.source_folder = found;
            }
            /* A clip whose source_folder equals the song's primary folder
             * needs no override — the song folder already resolves it. Strip
             * it so the saved file only stores the folder when it differs. */
            if (c.source_folder && c.source_folder === songFolder) {
                delete c.source_folder;
            }
        }
    }
}

function saveCurrentSong() {
    if (!currentSong) return;
    /* Only persist (and thus create a backup of) a song that actually has
     * unsaved changes. Editing screens call saveCurrentSong on exit even
     * when nothing was modified; bailing here avoids rewriting the file and
     * spawning a duplicate backup each time a song is opened and closed. */
    if (!unsavedChanges) return;
    /* A play-from-section/cursor copy still standing in for the song (its
     * build never confirmed, so nothing swapped the full song back) saves as
     * the full song it was cut from -- never as itself. */
    const song = tempSongOrigin.get(currentSong) || currentSong;
    if (activeSongFile && activeSongObj && song !== activeSongObj) {
        logDebug("saveCurrentSong: REFUSED -- current song is not the one loaded from " + activeSongFile +
            " (sections=" + (song.sections ? song.sections.length : "?") + ")");
        return;
    }
    song.modified = new Date().toISOString();
    const path = activeSongFile || songPath(song.name);
    activeSongFile = path;
    activeSongObj = song;
    /* Normalize the song before writing so the saved file reflects the same
     * rounding and per-clip source_folder that the DSP playback uses. The
     * in-memory song is updated in place so the UI stays consistent. */
    normalizeSongForSave(song);
    /* Preserve the previous version in the background backup store before
     * overwriting it, so the last few saves of this song can be inspected. */
    backupCurrentSong(path, song.name);
    writeJson(path, song);
    unsavedChanges = false;
    /* Invalidate the DSP's cached song scan so a newly saved song appears in
     * the Song Bank list. Without this, listSongFiles() returns the stale
     * cached scan and a brand-new song is missing until the module reloads. */
    requestSongRescan();
    reloadSongBankAndPreserveSelection();
    needsRedraw = true;
}

/* Ask the DSP to rescan the Song Bank folder only (a song was saved,
 * duplicated or deleted). "scan_library" also re-walked the whole MIDI
 * library and re-read every clip, on the worker that builds songs, so a Play
 * right after a save waited behind it. An engine too old to know
 * "scan_songs" ignores it -- and the Song Bank would then never update -- so
 * fall back to the full rescan unless it answers "scan_pending" (added
 * alongside). */
function requestSongRescan() {
    if (typeof host_module_set_param !== "function") return;
    const knowsScanSongs = typeof host_module_get_param === "function" &&
        host_module_get_param("scan_pending") !== null;
    host_module_set_param(knowsScanSongs ? "scan_songs" : "scan_library", "1");
}

function loadSongFile(path) {
    logDebug("loadSongFile: reading " + path);
    const obj = readJson(path);
    if (!obj) { logDebug("loadSongFile: readJson returned null for " + path); return false; }
    activeSongFile = path;
    currentSong = toUiSong(obj);
    activeSongObj = currentSong;
    /* A freshly loaded song starts with no pending edits (unless the upgrade
     * below changes it). This prevents a stale dirty flag from a previously
     * edited song causing a spurious save when the new song is merely opened
     * and closed. */
    unsavedChanges = false;
    /* Upgrade leaf-only source_folder values to full paths so the DSP resolves
     * clips directly and the folder picker reopens at the exact category.
     * Persist the upgrade immediately so the saved file is corrected. */
    if (upgradeSongSourceFolders(currentSong)) {
        normalizeSongForSave(currentSong);
        backupCurrentSong(path, currentSong.name);
        writeJson(path, currentSong);
        logDebug("loadSongFile: upgraded source_folder paths in " + path);
    }
    currentSectionIndex = 0;
    builderCursor = 0;
    logDebug("loadSongFile: loaded song " + (currentSong && currentSong.name));
    return true;
}

function loadSettings() {
    /* The host's host_get_setting only knows a fixed set of keys and ignores
     * module-specific ones, so we persist the Options settings to a file and
     * restore them here. Schwung Manager (the web UI) writes our Options to
     * CONFIG_PATH via settings-schema.json, so that is the source of truth;
     * the legacy SETTINGS_PATH only supplies values not yet saved there. */
    const saved = readJson(CONFIG_PATH) || {};
    const legacy = readJson(SETTINGS_PATH);
    const pick = (key, type) => {
        let v = saved[key];
        if (v === undefined && legacy !== null) v = legacy[key];
        return v;
    };
    const s = pick("output", "string");
    if (typeof s === "string") outputTarget = s;
    const oc = pick("output_channel", "number");
    if (typeof oc === "number") outputChannel = oc;
    const mc = pick("move_channel", "number");
    if (typeof mc === "number") moveChannel = mc;
    const sc = pick("schwung_channel", "number");
    if (typeof sc === "number") schwungChannel = sc;
    /* The web UI shows the drums one channel -- the selected output's --
     * as drums_channel; the per-output channels above remember each
     * output's, and are written for that. drums_channel, when saved, is
     * the selected output's channel. */
    const dc = saved.drums_channel;
    if (typeof dc === "number") {
        if (outputTarget === "move") moveChannel = dc;
        else if (outputTarget === "schwung") schwungChannel = dc;
        else outputChannel = dc;
    }
    const co = pick("click_output", "string");
    if (typeof co === "string") clickOutput = co;
    const cmc = pick("click_midi_channel", "number");
    if (typeof cmc === "number") {
        clickMidiChannel = cmc;
    } else {
        /* The old count-in "Click Channel" (0 = follow the drums). */
        const old = pick("click_channel", "number");
        if (typeof old === "number" && old > 0) clickMidiChannel = old;
    }
    const can = pick("click_accent_note", "number");
    if (typeof can === "number") clickAccentNote = can;
    const cnn = pick("click_normal_note", "number");
    if (typeof cnn === "number") clickNormalNote = cnn;
    const cvol = pick("click_volume", "number");
    if (typeof cvol === "number") clickVolume = cvol;
    const sg = pick("swap_guard_fraction", "number");
    if (typeof sg === "number") swapGuardFraction = sg;
    const dd = pick("dsp_debug", "boolean");
    if (typeof dd === "boolean") dspDebugEnabled = dd;
    const dno = pick("drop_note_offs", "boolean");
    if (typeof dno === "boolean") dropNoteOffs = dno;
    const sck = pick("send_clock", "boolean");
    if (typeof sck === "boolean") sendClock = sck;
    const i1o = pick("inst1_output", "string");
    if (typeof i1o === "string") inst1Output = i1o;
    const i1c = pick("inst1_channel", "number");
    if (typeof i1c === "number") inst1Channel = i1c;
    const i2o = pick("inst2_output", "string");
    if (typeof i2o === "string") inst2Output = i2o;
    const i2c = pick("inst2_channel", "number");
    if (typeof i2c === "number") inst2Channel = i2c;
    const i3o = pick("inst3_output", "string");
    if (typeof i3o === "string") inst3Output = i3o;
    const i3c = pick("inst3_channel", "number");
    if (typeof i3c === "number") inst3Channel = i3c;
    const ko = pick("keys_output", "string");
    if (typeof ko === "string") keysOutput = ko;
    const kc = pick("keys_channel", "number");
    if (typeof kc === "number") keysChannel = kc;
    const kl = pick("keys_layout", "number");
    if (typeof kl === "number") keysLayout = kl;
    const ksc = pick("keys_scale", "number");
    if (typeof ksc === "number") keysScale = ksc;
    const koc = pick("keys_octave", "number");
    if (typeof koc === "number") keysStartOctave = koc;
    if (outputChannel < 1) outputChannel = 1;
    if (outputChannel > 16) outputChannel = 16;
    if (moveChannel < 1) moveChannel = 1;
    if (moveChannel > 16) moveChannel = 16;
    if (schwungChannel < 1) schwungChannel = 1;
    if (schwungChannel > 16) schwungChannel = 16;
    if (clickMidiChannel < 1) clickMidiChannel = 1;
    if (clickMidiChannel > 16) clickMidiChannel = 16;
    clickAccentNote = Math.max(0, Math.min(127, clickAccentNote));
    clickNormalNote = Math.max(0, Math.min(127, clickNormalNote));
    clickVolume = Math.max(0, Math.min(100, Math.round(clickVolume)));
    if (OUTPUT_TARGETS.indexOf(clickOutput) < 0) clickOutput = "schwung";
    if (swapGuardFraction < 0) swapGuardFraction = 0;
    if (swapGuardFraction > 1) swapGuardFraction = 1;
    if (inst1Channel < 1) inst1Channel = 1;
    if (inst1Channel > 16) inst1Channel = 16;
    if (inst2Channel < 1) inst2Channel = 1;
    if (inst2Channel > 16) inst2Channel = 16;
    if (OUTPUT_TARGETS.indexOf(inst1Output) < 0) inst1Output = "external";
    if (OUTPUT_TARGETS.indexOf(inst2Output) < 0) inst2Output = "external";
    inst3Channel = Math.max(1, Math.min(16, Math.round(inst3Channel) || 1));
    if (OUTPUT_TARGETS.indexOf(inst3Output) < 0) inst3Output = "external";
    keysChannel = Math.max(1, Math.min(16, Math.round(keysChannel) || 1));
    if (OUTPUT_TARGETS.indexOf(keysOutput) < 0) keysOutput = "schwung";
    keysLayout = Math.max(0, Math.min(KEYS_LAYOUTS.length - 1, Math.round(keysLayout) || 0));
    keysScale = Math.max(0, Math.min(KEYS_SCALES.length - 1, Math.round(keysScale) || 0));
    keysStartOctave = Math.max(-1, Math.min(8, Math.round(keysStartOctave)));
    if (!Number.isFinite(keysStartOctave)) keysStartOctave = 3;
    selectedOutputIndex = OUTPUT_TARGETS.indexOf(outputTarget);
    if (selectedOutputIndex < 0) selectedOutputIndex = 0;
}

/* Schwung Manager writes this module's settings to CONFIG_PATH. Re-read it
 * about once a second so a change made in the web UI applies without
 * reloading the module (docs/MODULES.md, "Reading values at runtime") --
 * before this, a setting changed there waited for the next module load.
 * Compared as raw text, so an unchanged file costs one small read. A file
 * that does not parse (caught mid-write) is left for the next poll rather
 * than applied, which would fall back to defaults for a second. */
const CONFIG_POLL_MS = 1000;
let lastConfigPoll = 0;
let lastConfigRaw = null;

function readConfigRaw() {
    try {
        if (typeof host_file_exists !== "function" || !host_file_exists(CONFIG_PATH)) return null;
        return host_read_file(CONFIG_PATH);
    } catch (e) {
        return null;
    }
}

function pollModuleConfig() {
    const now = Date.now();
    if (now - lastConfigPoll < CONFIG_POLL_MS) return;
    lastConfigPoll = now;
    const raw = readConfigRaw();
    if (raw === null || raw === lastConfigRaw) return;
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object") return;
    } catch (e) {
        return;
    }
    lastConfigRaw = raw;
    loadSettings();
    applyOutputSettingsToDsp();
    needsRedraw = true;
    logDebug("config.json changed; settings reloaded");
}

function saveOutputSettings() {
    const values = {
        output: outputTarget,
        output_channel: outputChannel,
        move_channel: moveChannel,
        schwung_channel: schwungChannel,
        drums_channel: activeOutputChannel(),
        click_output: clickOutput,
        click_midi_channel: clickMidiChannel,
        click_accent_note: clickAccentNote,
        click_normal_note: clickNormalNote,
        click_volume: clickVolume,
        swap_guard_fraction: swapGuardFraction,
        dsp_debug: dspDebugEnabled,
        drop_note_offs: dropNoteOffs,
        send_clock: sendClock,
        inst1_output: inst1Output,
        inst1_channel: inst1Channel,
        inst2_output: inst2Output,
        inst2_channel: inst2Channel,
        inst3_output: inst3Output,
        inst3_channel: inst3Channel,
        keys_output: keysOutput,
        keys_channel: keysChannel,
        keys_layout: keysLayout,
        keys_scale: keysScale,
        keys_octave: keysStartOctave
    };
    /* Keep the legacy file for backwards compatibility. */
    writeJson(SETTINGS_PATH, values);
    /* Also write to the Schwung Manager config.json so the web UI and the
     * on-device Options view stay in sync (Schwung Manager reads config.json
     * when rendering the module's Settings page). Merge over the existing
     * file so we preserve any other fields Schwung Manager (or a future
     * settings page) has written that this module doesn't manage — a plain
     * full-file overwrite would silently wipe them. */
    try {
        const existing = readJson(CONFIG_PATH) || {};
        writeJson(CONFIG_PATH, Object.assign({}, existing, values));
    } catch (e) {
        logDebug("saveOutputSettings: writeJson(CONFIG_PATH) failed " + e);
    }
    /* Our own write is not a change to pick up (see pollModuleConfig). */
    lastConfigRaw = readConfigRaw();
}

function currentOutputLabel() {
    let label = OUTPUT_LABELS[outputTarget] || outputTarget;
    return label;
}

function activeOutputChannel() {
    if (outputTarget === "move") return moveChannel;
    if (outputTarget === "schwung") return schwungChannel;
    return outputChannel;
}

/* Push the click track's route, notes and on/off to the DSP. */
function pushClickToDsp() {
    if (typeof host_module_set_param !== "function" &&
        typeof host_module_set_param_blocking !== "function") return;
    const block = typeof host_module_set_param_blocking === "function";
    const set = block ? host_module_set_param_blocking : host_module_set_param;
    const t = block ? 100 : undefined;
    set("click_output", clickOutput, t);
    set("click_channel", String(clickMidiChannel - 1), t); /* DSP wants 0-based */
    set("click_accent_note", String(clickAccentNote), t);
    set("click_normal_note", String(clickNormalNote), t);
    set("click_volume", String(clickVolume), t);
    set("click_enabled", clickOn ? "1" : "0", t);
}

/* Track 4, in every mode: turn the click on or off. */
function toggleClick() {
    clickOn = !clickOn;
    if (typeof host_module_set_param === "function") {
        host_module_set_param("click_enabled", clickOn ? "1" : "0");
    }
    showPopup("Click", clickOn ? "On" : "Off", 2000);
    needsRedraw = true;
    ledDirtyAll = true;
}

/* Push the full output-routing state to the DSP. In co-run/overtake mode,
 * host_module_set_param is fire-and-forget over a SINGLE shared shadow_param
 * SHM slot, so several back-to-back non-blocking writes race: the host drains
 * them one at a time and later writes clobber earlier ones before they are
 * consumed — only the last write survives. The arranger log showed
 * `output_target` (sent first) never reaching the DSP while `emit_directly`
 * (sent last) did. Use the BLOCKING variant so each routing write is fully
 * consumed before the next, guaranteeing the DSP sees the real target.
 *
 * Order matters: output_target first, then the channel it needs. */
function pushOutputRoutingToDsp() {
    if (typeof host_module_set_param !== "function" &&
        typeof host_module_set_param_blocking !== "function") {
        return;
    }
    /* Use the blocking variant when available so each routing write is fully
     * consumed before the next (see comment above on the SHM-slot race). */
    const block = typeof host_module_set_param_blocking === "function";
    const set = block ? host_module_set_param_blocking : host_module_set_param;
    const t = block ? 100 : undefined;
    set("output_target", outputTarget, t);
    set("output_channel", String(activeOutputChannel() - 1), t);
    set("move_channel", String(moveChannel - 1), t);
    set("schwung_channel", String(schwungChannel - 1), t);
    /* Direct DSP emission routes by target: schwung→midi_send_internal (chain
     * synth slots), move→midi_inject_to_move (Move MIDI_IN cable 2, track
     * instruments), external→midi_send_external (MIDI_OUT). All three host
     * functions are audio-thread-safe, so enable the sample-accurate DSP path
     * for every target. */
    dspDirectEmit = true;
    set("emit_directly", dspDirectEmit ? "1" : "0", t);
}

function setOutputTarget(target) {
    outputTarget = target;
    selectedOutputIndex = OUTPUT_TARGETS.indexOf(outputTarget);
    saveOutputSettings();
    pushOutputRoutingToDsp();
    needsRedraw = true;
    logDebug("setOutputTarget: target=" + outputTarget + " channel=" + activeOutputChannel() + " direct=" + dspDirectEmit);
}

/* Push the current output settings to the DSP. Called after restoring
 * settings on init so the engine's routing matches what was saved. */
function applyOutputSettingsToDsp() {
    if (typeof host_module_set_param !== "function" &&
        typeof host_module_set_param_blocking !== "function") return;
    pushOutputRoutingToDsp();
    pushSwapGuardToDsp();
    pushDspDebugToDsp();
    pushDropNoteOffsToDsp();
    pushSendClockToDsp();
    pushClickToDsp();
}

/* Push the mid-clip swap guard fraction to the DSP. */
function pushSwapGuardToDsp() {
    if (typeof host_module_set_param !== "function" &&
        typeof host_module_set_param_blocking !== "function") return;
    const block = typeof host_module_set_param_blocking === "function";
    const set = block ? host_module_set_param_blocking : host_module_set_param;
    const t = block ? 100 : undefined;
    set("swap_guard_fraction", String(swapGuardFraction), t);
}

/* Push the DSP debug-log toggle to the DSP. */
function pushDspDebugToDsp() {
    if (typeof host_module_set_param !== "function" &&
        typeof host_module_set_param_blocking !== "function") return;
    const block = typeof host_module_set_param_blocking === "function";
    const set = block ? host_module_set_param_blocking : host_module_set_param;
    const t = block ? 100 : undefined;
    set("debug", dspDebugEnabled ? "1" : "0", t);
}

/* Push the Drums "Drop Note-Offs" toggle to the DSP. */
function pushDropNoteOffsToDsp() {
    if (typeof host_module_set_param !== "function" &&
        typeof host_module_set_param_blocking !== "function") return;
    const block = typeof host_module_set_param_blocking === "function";
    const set = block ? host_module_set_param_blocking : host_module_set_param;
    const t = block ? 100 : undefined;
    set("drop_note_offs", dropNoteOffs ? "1" : "0", t);
}

/* Push the Options "Schwung Clock" toggle to the DSP. */
function pushSendClockToDsp() {
    if (typeof host_module_set_param !== "function" &&
        typeof host_module_set_param_blocking !== "function") return;
    const block = typeof host_module_set_param_blocking === "function";
    const set = block ? host_module_set_param_blocking : host_module_set_param;
    const t = block ? 100 : undefined;
    set("send_clock", sendClock ? "1" : "0", t);
}

/* Delete the module's log files. Called when debug logging is turned off so
 * stale logs don't accumulate on the device. */
function deleteLogFiles() {
    const paths = [
        DEBUG_LOG_PATH,
        CLICK_LOG_PATH,
        JAM_LOG_PATH,
        TIMING_LOG_PATH,
        "/data/UserData/UserLibrary/Arranger/.dsp_log"
    ];
    for (const p of paths) {
        try {
            if (typeof host_file_exists === "function" && host_file_exists(p)) {
                os.remove(p);
            }
        } catch (e) {}
    }
    logFileSizes = {};   /* appendLogLine re-reads each size on next use */
}

function saveSetlist(setlist) {
    const path = setlist.path || setlistPath(setlist.name);
    setlist.path = path;
    setlist.modified = new Date().toISOString();
    ensureDir(SETLISTS_DIR);
    writeJson(path, setlist);
    setlistFiles = listSetlistFiles();
}

function newSetlist(name) {
    return {
        id: "setlist-" + Date.now(),
        name: name || "My Setlist",
        created: new Date().toISOString(),
        modified: new Date().toISOString(),
        songs: []
    };
}

function addSongToSetlist(setlist, songFile) {
    if (!setlist || !songFile) return;
    const entry = {
        id: "entry-" + Date.now(),
        name: songFile.name || clipDisplayName(songFile.path || songFile),
        path: songFile.path || (SONGS_DIR + "/" + songFile),
        click_bars: 0,
        click_sound: true,
        stop_after_finish: false
    };
    setlist.songs.push(entry);
    saveSetlist(setlist);
}

/* Call `mutate(obj, path)` for every saved setlist's parsed object. If it
 * returns true (meaning obj.songs was changed), the file is rewritten and
 * currentSetlist is kept in sync if it's the one just edited on disk, so a
 * view still holding it (Setlist Editor, Performance) doesn't show a
 * dangling/stale entry until its own next reload. Shared by
 * removeSongFromAllSetlists and renameSongInAllSetlists below -- both need
 * the same "find every setlist, maybe touch its songs[], save if touched"
 * shape, just a different mutation. */
function forEachSetlistFile(mutate) {
    if (typeof os.readdir !== "function") return;
    let names = [];
    try {
        const raw = os.readdir(SETLISTS_DIR);
        if (Array.isArray(raw)) names = Array.isArray(raw[0]) ? raw[0] : raw;
    } catch (e) { return; }
    for (const n of names) {
        if (typeof n !== "string" || !n.endsWith(".json")) continue;
        const path = SETLISTS_DIR + "/" + n;
        const obj = readJson(path);
        if (!obj || !Array.isArray(obj.songs)) continue;
        if (!mutate(obj, path)) continue;
        obj.modified = new Date().toISOString();
        writeJson(path, obj);
        if (currentSetlist && currentSetlist.path === path) {
            currentSetlist.songs = obj.songs;
        }
    }
    setlistFiles = listSetlistFiles();
}

/* Remove every reference to `songPath` from every saved setlist. Called after
 * a song is deleted so a setlist doesn't keep pointing at a file that no
 * longer exists -- left alone, that entry would linger forever in the
 * Setlist Editor and the Performance pad grid, and perfLoadSong/readJson
 * would just silently fail on it each time it came up. */
function removeSongFromAllSetlists(songPath) {
    if (!songPath) return;
    forEachSetlistFile((obj, path) => {
        const before = obj.songs.length;
        obj.songs = obj.songs.filter((s) => s && s.path !== songPath);
        const changed = obj.songs.length !== before;
        if (changed) {
            logDebug("removeSongFromAllSetlists: removed " + (before - obj.songs.length) +
                " entry from " + path + " for deleted song " + songPath);
        }
        return changed;
    });
}

/* Update every reference to `oldPath` in every saved setlist to point at
 * `newPath` instead (and refresh the entry's own cached display name to
 * `newName`, if given). Called after a song is renamed -- unlike a delete,
 * the song still exists, just under a new path/name, so setlist entries are
 * repointed rather than dropped. */
function renameSongInAllSetlists(oldPath, newPath, newName) {
    if (!oldPath || !newPath) return;
    forEachSetlistFile((obj, path) => {
        let changed = false;
        for (const s of obj.songs) {
            if (s && s.path === oldPath) {
                s.path = newPath;
                if (newName) s.name = newName;
                changed = true;
            }
        }
        if (changed) {
            logDebug("renameSongInAllSetlists: repointed entry in " + path + " -> " + newPath);
        }
        return changed;
    });
}

function setSetlistClickBars(setlist, idx, bars) {
    if (!setlist || idx < 0 || idx >= setlist.songs.length) return;
    setlist.songs[idx].click_bars = Math.max(0, Math.min(4, bars));
    entryClickRevision(setlist.songs[idx]);
    generateClickForEntry(setlist.songs[idx]);
    saveSetlist(setlist);
}

/* Whether a song's count-in is heard (the click track plays it) or silent
 * (pad flashes only). Setlists saved before the click track had a per-song
 * click_note instead, where 0 ("None") meant silent. */
function clickSoundOn(entry) {
    if (!entry) return false;
    if (typeof entry.click_sound === "boolean") return entry.click_sound;
    return (entry.click_note || 0) > 0;
}

function setSetlistClickSound(setlist, idx, on) {
    if (!setlist || idx < 0 || idx >= setlist.songs.length) return;
    setlist.songs[idx].click_sound = !!on;
    saveSetlist(setlist);
}

/* Bump the click-file revision so the next generation writes a fresh path
 * (the DSP caches clips by full path and won't reload a seen file). */
function entryClickRevision(entry) {
    if (!entry) return;
    entry.click_rev = ((entry.click_rev || 0) + 1);
}

/* Generate the count-in click MIDI file for a setlist entry at edit time, so
 * it is ready before playback (no file generation on the performance path).
 * The file's note/beats-per-bar/division are derived from the entry's click
 * settings and the song's time signature/PPQ. Stores the resulting path in
 * `entry.click_path` for use at playback. Returns the path, or null if there
 * is no click configured / generation failed. */
function generateClickForEntry(entry) {
    if (!entry) return null;
    const bars = entry.click_bars || 0;
    if (bars <= 0) { entry.click_path = ""; return null; }
    const song = entry.path ? readJson(entry.path) : null;
    if (!song) return null;
    const beatsPerBar = song.time_sig_num || 4;
    const ppq = song.ppq || 240;
    const note = (entry.click_note || 0) > 0 ? entry.click_note : 1;
    /* The DSP's ticks_per_beat is the MIDI ppq, and the click notes must be
     * spaced at the DSP's beats so they land on them. For 6/8 the DSP reports
     * a quarter-note beat (ppq) but there are 6 eighth-note clicks per bar, so
     * the click note interval is ppq / (num*4/den... ) — this note spacing is
     * handled by writeClickMidi via ticksPerBeat below. */
    const ticksPerBeat = Math.max(1, Math.round(ppq * 4 / (song.time_sig_den || 4)));
    /* Unique per-edit path so the DSP reloads the clip on click changes. When
     * the click settings change, entryClickRevision bumps click_rev -> a new
     * path -> this regenerates. The file's content also depends on the song's
     * time signature (beatsPerBar), division (ppq) and beat spacing
     * (ticksPerBeat), so those are folded into the path too — the DSP caches
     * clips by full path and won't reload a file with the same path even if
     * its bytes change. If the current-revision file already exists
     * (unchanged settings, already written), reuse it instead of rewriting. */
    const path = CLICK_DIR + "/.click-" + (entry.id || "setlist") +
        "-" + (entry.click_rev || 0) + "-" + beatsPerBar + "x" + ppq +
        "t" + ticksPerBeat + ".mid";
    if (typeof host_file_exists === "function" && host_file_exists(path)) {
        entry.click_path = path;
        return path;
    }
    if (writeClickMidi(path, note, beatsPerBar, ppq, bars, ticksPerBeat)) {
        entry.click_path = path;
        pruneOldClickFiles();
        return path;
    }
    entry.click_path = "";
    return null;
}

/* Delete obsolete generated click MIDI files so they don't accumulate. Every
 * live-click file referenced by any setlist entry (via entry.click_path), plus
 * the currently-active click path, is kept; any other .click-*.mid is a stale
 * revision and is removed. Cheap enough to run on each click file write. */
function pruneOldClickFiles() {
    if (typeof os.readdir !== "function" || typeof os.remove !== "function") return;
    const keep = new Set();
    const harvest = (list) => {
        if (!list || !list.songs) return;
        for (const e of list.songs) {
            if (e && e.click_path) keep.add(e.click_path);
        }
    };
    harvest(currentSetlist);
    for (const d of setlistFiles) {
        if (!d || !d.path) continue;
        harvest(readJson(d.path));
    }
    if (clickMidiPath) keep.add(clickMidiPath);
    let names = [];
    try {
        const raw = os.readdir(CLICK_DIR);
        if (Array.isArray(raw)) names = Array.isArray(raw[0]) ? raw[0] : raw;
    } catch (e) { return; }
    for (const name of names) {
        if (!name || name.indexOf(".click-") !== 0 || !name.endsWith(".mid")) continue;
        const full = CLICK_DIR + "/" + name;
        if (!keep.has(full)) {
            try { os.remove(full); } catch (e) {}
        }
    }
}

/* Regenerate the count-in click MIDI file for every song in the setlist that
 * has a click configured. Called when a setlist is opened in the editor so the
 * click files are ready before playback. */
function regenerateSetlistClicks(setlist) {
    if (!setlist || !setlist.songs) return;
    for (const entry of setlist.songs) {
        if ((entry.click_bars || 0) > 0) {
            generateClickForEntry(entry);
        }
    }
}

function setSetlistStopAfterFinish(setlist, idx, stop) {
    if (!setlist || idx < 0 || idx >= setlist.songs.length) return;
    setlist.songs[idx].stop_after_finish = !!stop;
    saveSetlist(setlist);
}

function removeSetlistSong(setlist, idx) {
    if (!setlist || idx < 0 || idx >= setlist.songs.length) return;
    setlist.songs.splice(idx, 1);
    saveSetlist(setlist);
}

function moveSetlistSong(setlist, idx, delta) {
    if (!setlist || idx < 0 || idx >= setlist.songs.length) return;
    const newIdx = idx + delta;
    if (newIdx < 0 || newIdx >= setlist.songs.length) return;
    const [item] = setlist.songs.splice(idx, 1);
    setlist.songs.splice(newIdx, 0, item);
    setlistSongIndex = newIdx;
    saveSetlist(setlist);
}

function renameSetlist(setlist, newName) {
    if (!setlist || !newName || newName.trim().length === 0) return;
    const trimmed = newName.trim();
    const oldPath = setlist.path || setlistPath(setlist.name);
    const newPath = setlistPath(trimmed);
    if (newPath !== oldPath) {
        try { os.remove(oldPath); } catch (e) {}
    }
    setlist.name = trimmed;
    setlist.path = newPath;
    saveSetlist(setlist);
}

function deleteSetlist(setlist) {
    if (!setlist) return;
    const path = setlist.path || setlistPath(setlist.name);
    try { os.remove(path); } catch (e) {}
    setlistFiles = listSetlistFiles();
}

/* ── MIDI output routing ────────────────────────────────────────────── */

/* Push the live drum/instrument mutes that belong to the mode about to
 * play. drum_enabled and inst1/inst2_enabled are engine-level and survive a
 * song rebuild, so without this a mute set in Perform or Jam would carry
 * over into Song Builder playback. Perform uses its Track-button toggles;
 * Jam uses its drum toggle (its own instruments are the separate jam_inst
 * ones, so the song-instrument mutes are simply cleared); anything else
 * plays everything.
 *
 * Jam's own instruments are switched off outside Jam too. They're
 * engine-level as well and were only reset on entering Jam, so leaving Jam
 * with one on left it playing Jam's last chord over Perform/Song Builder
 * (Inst 2's once-per-bar default played it every bar) -- found live, where
 * it looked like Perform's Inst 2 mute not working. */
function pushLiveMutesToDsp(set, t) {
    let drums = true, inst1 = true, inst2 = true, inst3 = true;
    let jamInst1 = false, jamInst2 = false, jamPads = false;
    if (currentMode === MODE_PERFORMANCE) {
        drums = perfDrumEnabled; inst1 = perfInst1Enabled; inst2 = perfInst2Enabled; inst3 = perfInst3Enabled;
    } else if (currentMode === MODE_JAM) {
        drums = jamDrumEnabled;
        jamInst1 = jamInst1Enabled; jamInst2 = jamInst2Enabled; jamPads = jamPadsEnabled;
    }
    set("drum_enabled", drums ? "1" : "0", t);
    set("inst1_enabled", inst1 ? "1" : "0", t);
    set("inst2_enabled", inst2 ? "1" : "0", t);
    set("inst3_enabled", inst3 ? "1" : "0", t);
    set("jam_inst1_enabled", jamInst1 ? "1" : "0", t);
    set("jam_inst2_enabled", jamInst2 ? "1" : "0", t);
    set("jam_inst3_enabled", jamPads ? "1" : "0", t);
}

/* Build the current song's timeline in the DSP WITHOUT starting playback.
 * Used when jumping to a section on first load: we want the full song timeline
 * built so a subsequent play_from_bar seek is instant, but we must NOT send
 * `play` (which starts from tick 0 and would play the song's first note before
 * the seek lands — a double-note blip). */
function buildSongTimelineOnly(onConfirmed) {
    if (!currentSong) return;
    if (typeof host_module_set_param !== "function") return;
    const json = toEngineSongJson(currentSong);
    const block = typeof host_module_set_param_blocking === "function";
    const set = block ? host_module_set_param_blocking : host_module_set_param;
    const t = block ? 100 : undefined; /* delivery-only budget now -- see playCurrentSong */
    set("library_root", LIBRARY_ROOT, t);
    pushOutputRoutingToDsp();
    pushLiveMutesToDsp(set, t);
    set("loop", "0", t);
    requestPrimaryBuild(function () {
        set("song_json", json, t);
    }, function () {
        if (onConfirmed) onConfirmed();
    });
}

function playCurrentSong(preloadStaged, onConfirmed) {
    if (!currentSong) { logDebug("playCurrentSong: no currentSong"); return; }
    lastLoggedDspError = null;
    const json = toEngineSongJson(currentSong);
    const builtSong = currentSong;
    pendingSongJson = json;
    const secCount = currentSong.sections ? currentSong.sections.length : 0;
    const clipCount = currentSong.sections ? currentSong.sections.reduce((a, s) => a + (s.clips ? s.clips.length : 0), 0) : 0;
    if (typeof host_module_set_param === "function") {
        logTiming("START BUILD=" + UI_BUILD_VERSION + " song=" + currentSong.name + " sections=" + secCount + " clips=" + clipCount +
            " bpm=" + (currentSong.tempo_bpm || "?") + " ts=" + (currentSong.time_sig_num || "?") + "/" + (currentSong.time_sig_den || "?") +
            " bars=" + (dspTimelineInfo ? dspTimelineInfo.total_bars : "?") + " t=" + Date.now());
        logDebug("playCurrentSong: BUILD=" + UI_BUILD_VERSION + " song=" + currentSong.name + " sections=" + secCount + " clips=" + clipCount + " json_len=" + json.length + " output=" + outputTarget);
        logDebug("playCurrentSong json=" + json.slice(0, 600));
        /* song_json now builds asynchronously on the DSP's worker thread and
         * returns instantly regardless of song complexity -- the blocking
         * variant is still used so each write is fully delivered into the
         * single shared shadow_param SHM slot before the next one (a later
         * write can otherwise clobber an earlier one before it's consumed),
         * but the budget only needs to cover delivery now, not build time. */
        const block = typeof host_module_set_param_blocking === "function";
        const set = block ? host_module_set_param_blocking : host_module_set_param;
        const t = block ? 100 : undefined;
        /* Ensure library_root is set first so clip resolution works. */
        set("library_root", LIBRARY_ROOT, t);
        pushOutputRoutingToDsp();
        pushLiveMutesToDsp(set, t);
        set("loop", "0", t);
        /* The error/timeline_info/resolved_clips checks that used to follow
         * song_json immediately only became meaningful once the build
         * actually finished (which, when this ran synchronously, was
         * guaranteed by the time the call returned). Now that the build
         * happens on the worker, they -- and "play" itself -- move into
         * requestPrimaryBuild's onReady, which fires once the DSP confirms
         * primary_published_gen actually advanced. */
        requestPrimaryBuild(function () {
            set("song_json", json, t);
        }, function () {
            if (typeof host_module_get_param === "function") {
                const afterJsonErr = host_module_get_param("error");
                const afterJsonInfo = host_module_get_param("timeline_info");
                logDebug("playCurrentSong after song_json: error=" + (afterJsonErr || "null") + " timeline_info=" + (afterJsonInfo || "null"));
                /* If a clip file is missing, surface it on the display so the
                 * user knows which clip is the problem. */
                if (afterJsonErr && afterJsonErr.indexOf("clip not found") >= 0) {
                    showMissingClipOverlay();
                }
                /* If any clip resolved to a different folder than the song
                 * stored (i.e. the file moved), persist the corrected
                 * source_folder so the next play resolves directly instead of
                 * re-searching. */
                persistResolvedClipFolders(builtSong);
            }
            set("loop", dspLoopEnabled ? "1" : "0", t);
            /* Start the click FIRST, then preload the full song into staging,
             * so the preload's (now-async, but still delivery-blocking) write
             * can't clobber this "play" write in the shared shadow_param SHM
             * slot -- the click starts immediately; the preload then stages
             * the full song while the click plays, so the click->song swap
             * still fires sample-accurately at the click's end. */
            set("play", "1", t);
            if (preloadStaged) {
                preloadPerfSongToStaging();
            }
            if (typeof host_module_get_param === "function") {
                const info = host_module_get_param("timeline_info");
                const err = host_module_get_param("error");
                logDebug("playCurrentSong post: timeline_info=" + (info || "null") + " error=" + (err || "null"));
            }
            /* Clear stale transport/end state so perfTick doesn't act on old
             * data, and only now flip to "playing" -- confirmed by the DSP,
             * not assumed the instant song_json was issued. */
            lastDspState = null;
            lastDspTransport = null;
            playbackState = "playing";
            playbackStartTime = Date.now();
            /* While builderPlayingFromTemp, currentSong is sliced to start at
             * the played section -- that section is index 0 there, not the
             * original absolute currentSectionIndex (which the "follow the
             * DSP playhead" block below would otherwise briefly show before
             * self-correcting on the next tick). */
            playbackSectionIndex = builderPlayingFromTemp ? 0 : currentSectionIndex;
            lastStepBeatKey = "";
            lastStepBarIndex = -1;
            lastTransportBar = 0;
            maxBeatThisBar = 0;
            transportBeatsPerBar = 0;
            lastSubdivisionIndex = 0;
            needsRedraw = true;
            if (onConfirmed) onConfirmed();
        });
    } else {
        logDebug("playCurrentSong: host_module_set_param unavailable");
    }
}

/* Persist corrected clip source_folder values reported by the DSP. When a clip
 * file has moved, the DSP resolves it via a recursive library search on every
 * play (the audible delay). It reports the resolved folder via the
 * "resolved_clips" get_param; we write that folder back into the song so the
 * next play resolves directly and the delay disappears. Returns true if any
 * clip was updated. */
/* `built` is the song object playCurrentSong sent to the DSP -- not
 * necessarily the song whose file is open. The folder corrections are applied
 * to it (so later plays of it resolve directly), and to the open song when
 * `built` is the open song or a play-from-section/cursor copy cut from it;
 * only the open song is ever written. This used to fix and save currentSong,
 * which while a play-from-section build is in flight is the TRIMMED copy --
 * so starting playback from section 3 saved the song without sections 1 and
 * 2. A pad preview (a one-clip song) or a Performance-mode song could be
 * written over the open song's file the same way. */
function persistResolvedClipFolders(built) {
    if (typeof host_module_get_param !== "function") return false;
    built = built || currentSong;
    let raw = null;
    try {
        raw = host_module_get_param("resolved_clips");
    } catch (e) { return false; }
    if (!raw || raw === "[]") return false;
    let list = [];
    try {
        list = JSON.parse(raw);
    } catch (e) { return false; }
    if (!Array.isArray(list) || list.length === 0) return false;
    const applyTo = function (song) {
        let changed = false;
        for (const item of list) {
            const src = item && item.source;
            const folder = item && item.folder;
            if (!src || !folder) continue;
            for (const sec of song && song.sections ? song.sections : []) {
                for (const c of sec.clips || []) {
                    if (c.source === src && c.source_folder !== folder) {
                        c.source_folder = folder;
                        changed = true;
                    }
                }
            }
        }
        return changed;
    };
    let target = built === activeSongObj ? built : tempSongOrigin.get(built);
    /* Only the song as loaded from the file is saved: in Perform a setlist's
     * edited copy (applySetlistEdits) stands in for it, and saving that would
     * write the setlist's key, tempo and section order over the song. */
    if (target && target !== activeSongObj) target = null;
    const changedBuilt = built && built !== target ? applyTo(built) : false;
    if (!target) {
        logDebug("persistResolvedClipFolders: " + list.length + " folder fix(es) for a song that is not the open file; not saved");
        return changedBuilt;
    }
    const changed = applyTo(target);
    if (changed) {
        unsavedChanges = true;
        if (activeSongFile) {
            normalizeSongForSave(target);
            backupCurrentSong(activeSongFile, target.name);
            writeJson(activeSongFile, target);
            unsavedChanges = false;
        }
    }
    return changed || changedBuilt;
}

/* Show a display overlay naming the clip that could not be found, so the user
 * knows which file is the problem instead of the song silently failing. The
 * overlay auto-dismisses after a few seconds (the UI does not call
 * dismissOverlayOnInput, so a finite duration is required). */
const MISSING_CLIP_OVERLAY_MS = 10000;
function showMissingClipOverlay() {
    if (typeof host_module_get_param !== "function") return;
    let raw = null;
    try {
        raw = host_module_get_param("error");
    } catch (e) { return; }
    if (!raw) return;
    const m = raw.match(/clip not found: source='([^']*)'/);
    const clipName = m ? m[1] : "";
    /* Show the leaf name (after the last slash) so a long folder-relative
     * source path doesn't get truncated in the overlay band. */
    const leaf = clipName ? clipName.substring(clipName.lastIndexOf("/") + 1) : "";
    const title = "Clip not found";
    const value = leaf ? leaf : "missing file";
    showPopup(title, value, MISSING_CLIP_OVERLAY_MS);
    logDebug("showMissingClipOverlay: " + raw);
}

function stopPlayback() {
    logTiming("STOP t=" + Date.now());
    /* Blocking, so the next parameter write can't overwrite "stop" in the
     * shared slot before the DSP has read it. */
    if (typeof host_module_set_param_blocking === "function") {
        host_module_set_param_blocking("stop", "1", 100);
    } else if (typeof host_module_set_param === "function") {
        host_module_set_param("stop", "1");
    }
    playbackState = "stopped";
    builderDisplaySection = -1;
    previewBarOffset = 0;
    playbackSectionIndex = currentSectionIndex;
    /* Select the first clip of the current section when stopped. */
    builderCursor = 0;
    lastStepBeatKey = "";
    lastStepBarIndex = -1;
    lastBeatFlashMs = 0;
    lastBeatFlashBeat = -1;
    lastTransportBar = 0;
    maxBeatThisBar = 0;
    transportBeatsPerBar = 0;
    lastSubdivisionIndex = 0;
    lastBeatLogBar = -1;
    lastBeatLogBeat = -1;
    needsRedraw = true;
    stepLedsDirty = true;
}

function stopPreview() {
    previewBarOffset = 0;
    padPreviewClip = null;
    padPreviewBars = 0;
    playbackSectionIndex = currentSectionIndex;
    stopPlayback();
}

/* Drain queued MIDI events from the DSP. The DSP emits directly (sample-
 * accurate) for every output target; the JS UI only acks any stale queued
 * events so the DSP queue does not grow. MIDI notes are NEVER formatted or
 * sent from JS — all audio-critical MIDI output lives in the C engine. */
function drainOutputEvents() {
    if (typeof host_module_get_param !== "function") return;
    /* With emit_directly on -- which pushOutputRoutingToDsp always sets --
     * the DSP never queues an event (queue_push is only reached with it
     * off), so "events" can only ever answer "[]". Each read is a
     * synchronous round trip of one SPI frame (~2.9 ms), and this ran twice
     * per tick (here and from updateDspState). */
    if (dspDirectEmit) return;
    const raw = host_module_get_param("events");
    if (!raw || raw === "[]") return;
    let events = [];
    try {
        events = JSON.parse(raw);
    } catch (e) {
        logDebug("drainOutputEvents parse error: " + String(e));
        return;
    }
    if (!events || events.length === 0) return;

    /* A pad-flash-only click plays a DSP timeline for beat-clock sync but must
     * not emit any MIDI. Drain (ack) the events without sending them. */
    if (perfClickMute) {
        if (typeof host_module_set_param === "function") {
            host_module_set_param("events_ack", "1");
        }
        return;
    }

    /* The DSP emits directly for all targets; just ack so the queue clears. */
    if (typeof host_module_set_param === "function") {
        host_module_set_param("events_ack", "1");
    }
}

/* Where updateDspState reads each DSP value from on this tick.
 *
 * Normally that is ONE read: get_param("ui_poll") answers timeline_info,
 * state, transport, error and swap_guard_suppressed together. Each
 * host_module_get_param is a synchronous round trip through the host's param
 * channel, serviced once per SPI frame (~2.9 ms), and this used to make five
 * of them every tick (six in Jam, plus two "events" reads) -- roughly 15-20
 * ms blocked per tick. The host hands pad and button input to the module only
 * between ticks, so that was added straight onto every press.
 *
 * If ui_poll gives no answer (a dsp.so older than this ui.js, or a read that
 * failed), each value falls back to its own read, exactly as before. A poll
 * value is already parsed; a per-key value is still a string (dspObject
 * accepts either). */
function readDspPoll() {
    const raw = host_module_get_param("ui_poll");
    if (raw) {
        try { return { poll: JSON.parse(raw) }; } catch (e) {}
    }
    return { poll: null };
}

function dspPollValue(src, key) {
    if (src.poll) {
        const v = src.poll[key];
        return v === undefined ? null : v;
    }
    return host_module_get_param(key);
}

function dspObject(v) {
    return (typeof v === "string") ? JSON.parse(v) : v;
}

function updateDspState() {
    if (typeof host_module_get_param !== "function") return;
    let src = readDspPoll();
    try {
        const info = dspPollValue(src, "timeline_info");
        if (info) dspTimelineInfo = dspObject(info);
    } catch (e) { dspTimelineInfo = null; }
    /* Declared outside the try below (not `const st = ...` inside it) so the
     * catch block can safely reference it in its error log. `const` inside a
     * try is block-scoped to the try and NOT visible in the paired catch --
     * referencing it there throws a SECOND, unrelated ReferenceError that
     * masks whatever actually failed, and (being uncaught) crashes tick()
     * and closes the module entirely. This is exactly what happened on
     * device: a real TypeError below (see next comment) was masked by this
     * scoping bug, surfacing only as "ReferenceError: 'st' is not defined". */
    let st;
    /* Set when a build-confirmation callback below runs: it writes to the
     * DSP (play, swap, ...), and the values after it -- transport onwards --
     * were always read after those writes. A fresh poll keeps that. */
    let confirmedBuild = false;
    try {
        st = dspPollValue(src, "state");
        if (st) {
            lastDspState = dspObject(st);
            /* Log only when the DSP-reported active source changes, so the
             * log isn't flooded every tick. */
            if (jamPlaying && lastDspState.active_source !== jamActiveSource) {
                logJam("STATE active_source=" + lastDspState.active_source + " jamActiveSource=" + jamActiveSource);
            }
            /* Fire any pending async-build confirmation whose generation has
             * now advanced -- see requestPrimaryBuild/requestStagingBuild.
             * Capture both generations BEFORE invoking either callback: an
             * onReady callback (e.g. playCurrentSong's) sets
             * lastDspState = null as part of its own "clear stale state"
             * reset, so if the primary callback ran first and nulled it out,
             * the staging check right below would then dereference null and
             * throw -- exactly what happened on device when
             * jamStartWithIntroFill fires both a primary (fill) and a
             * staging (return groove) request together and both confirm on
             * the same tick. */
            const primaryGen = lastDspState.primary_published_gen;
            const stagingGen = lastDspState.staging_published_gen;
            if (pendingPrimaryConfirm && primaryGen !== pendingPrimaryConfirm.gen) {
                const cb = pendingPrimaryConfirm.onReady;
                pendingPrimaryConfirm = null;
                confirmedBuild = true;
                cb();
            }
            if (pendingStagingConfirm && stagingGen !== pendingStagingConfirm.gen) {
                const cb = pendingStagingConfirm.onReady;
                pendingStagingConfirm = null;
                confirmedBuild = true;
                cb();
            }
        }
    } catch (e) {
        if (jamPlaying) logJam("STATE parse error=" + e + " raw=" + (typeof st === "string" ? st : JSON.stringify(st)));
        lastDspState = null;
    }
    if (confirmedBuild && src.poll) src = readDspPoll();
    let tr;
    try {
        tr = dspPollValue(src, "transport");
        if (tr) {
            lastDspTransport = dspObject(tr);
            /* Mirror the DSP's own jam_chord_pending -> jam_chord_live
             * promotion timing (apply_pending_jam_chord, called from
             * update_bar_counter) so the chord pads' pending/live LED
             * colours update at the same bar boundary the DSP actually
             * applies the change, without a round trip. Own counter
             * (jamLastBarCounterForChord), separate from the pre-existing
             * jamLastBarCounter used by the groove/fill queue logic below --
             * that one is reset at specific clip-swap points not relevant
             * here, and reusing it risked interfering with its own timing. */
            /* A groove/fill swap applies the queued chord too (the DSP's
             * swap sites call apply_pending_jam_chord directly), but it
             * doesn't advance bar_counter -- so swap_counter is watched as
             * well, or the pads stayed red/white after the chord had
             * already changed. */
            const bc = lastDspTransport.bar_counter;
            const sc = lastDspTransport.swap_counter;
            if (typeof bc === "number" && typeof sc === "number") {
                if (jamLastBarCounterForChord < 0 || jamLastSwapCounterForChord < 0) {
                    jamLastBarCounterForChord = bc;
                    jamLastSwapCounterForChord = sc;
                } else if (bc !== jamLastBarCounterForChord || sc !== jamLastSwapCounterForChord) {
                    jamLastBarCounterForChord = bc;
                    jamLastSwapCounterForChord = sc;
                    if (jamChordPendingDegree >= 0) {
                        jamChordLiveDegree = jamChordPendingDegree;
                        jamChordLiveKey = jamChordPendingKey;
                        jamChordPendingDegree = -1;
                        stepLedsDirty = true;
                        /* See handleJamChordPad's comment: drawJamLEDs only
                         * redraws the pad grid on ledDirtyAll. */
                        ledDirtyAll = true;
                    }
                }
            }
        }
    } catch (e) {
        logDebug("updateDspState transport parse error=" + e + " raw=" + (typeof tr === "string" ? tr : JSON.stringify(tr)));
        lastDspTransport = null;
    }
    try {
        const err = dspPollValue(src, "error");
        if (err && err !== lastLoggedDspError) {
            logDebug("dsp_error=" + err);
            lastLoggedDspError = err;
        }
    } catch (e) {}
    /* Confirm the mid-clip swap guard is being applied: log whenever the DSP's
     * suppressed-note-on counter changes (fires on any swap path, not just
     * jamSwapStaged). */
    if (jamPlaying) {
        try {
            const suppressed = dspPollValue(src, "swap_guard_suppressed");
            const n = suppressed ? parseInt(suppressed, 10) : 0;
            if (n !== lastSwapGuardSuppressed) {
                lastSwapGuardSuppressed = n;
                logJam("GUARD suppressed=" + n + " fraction=" + swapGuardFraction);
            }
        } catch (e) {}
    }
    /* Jam mode: keep the UI in sync with any clip the DSP has auto-swapped to
     * (e.g. a non-looping fill returning to its groove). The DSP exposes the
     * active clip's source path in state.active_source. Also require
     * lastDspState.running: active_source is only meaningful while the DSP
     * is actually playing something -- the DSP now clears it on "stop", but
     * this check is a second, independent guard against ever trusting it
     * while stopped, since a stale-but-nonempty active_source here was
     * exactly what caused a just-released preview's clip to flash back in
     * as jamCurrentClip the instant jamPlaying next went true for an
     * unrelated tap (jamPlaying flips synchronously on tap, but this poll
     * can still be looking at state captured before that -- guarding on
     * jamPlaying alone isn't enough). */
    if (jamPlaying && lastDspState && lastDspState.running && lastDspState.active_source &&
        lastDspState.active_source !== jamActiveSource) {
        jamActiveSource = lastDspState.active_source;
        /* Find the matching clip in the currently loaded folder. The DSP
         * reports the full absolute path in active_source, while the UI's
         * jamGrooves/jamFills paths are folder-relative (e.g.
         * "Grooves/098 Chorus Stops F2.mid"). Match by leaf name so the sync
         * fires regardless of the path prefix. */
        const activeLeaf = jamActiveSource.substring(jamActiveSource.lastIndexOf("/") + 1);
        const matchByLeaf = (c) => {
            const cLeaf = (c.path || "").substring((c.path || "").lastIndexOf("/") + 1);
            return cLeaf === activeLeaf;
        };
        let matched = jamGrooves.find(matchByLeaf) || jamFills.find(matchByLeaf) || null;
        if (matched) {
            /* The DSP reports active_source as the clip that is now actually
             * playing. When it swaps to a groove, clear any queued-groove /
             * bar-end-restart state — even if the path is the same as the
             * previous clip (a bar-end restart of the current groove), since
             * in that case the guard below would otherwise skip this and leave
             * the pad stuck red. */
            if (matched.type !== "fill") {
                /* Capture whether a fill was playing and the return-groove path
                 * BEFORE jamCurrentClip is overwritten with the matched groove,
                 * so the same-groove guard below can keep the fill page. */
                const wasFillPlaying = !!(jamCurrentClip && jamCurrentClip.type === "fill");
                const returnGroovePath = jamReturnGroove ? jamReturnGroove.path : null;
                jamCurrentClip = matched;
                jamCurrentType = matched.type || "groove";
                jamReturnGroove = matched;
                jamStandaloneFill = false;
                jamReturnFromStart = false;
                jamQueuedGroove = null;
                jamQueuedGrooveEscalated = false;
                jamFillQueued = false;
                jamQueue = [];
                jamScheduledSwap = null;
                jamScheduledSwapBar = -1;
                /* Returning to the same groove after a fill: keep the fill page
                 * where it is instead of resetting to the start. */
                const returningToSameGroove = wasFillPlaying && returnGroovePath &&
                    matched.path === returnGroovePath;
                if (!returningToSameGroove) {
                    jamFillScroll = 0;
                }
                resetStepFlash();
                needsRedraw = true;
                stepLedsDirty = true;
                ledDirtyAll = true;
            } else if (!jamCurrentClip || jamCurrentClip.path !== matched.path) {
                logJam("SYNC active_source -> " + matched.name + " type=" + matched.type + " path=" + matched.path);
                jamCurrentClip = matched;
                jamCurrentType = matched.type || "groove";
                /* A fill was applied by a pre-scheduled DSP swap, confirmed
                 * by the authoritative active_source. The fill is non-looping
                 * and 1 bar, so it produces no JS-visible boundary and
                 * jamFireNext() would never run to consume it or stage the
                 * return clip. Consume the fill now and stage the next clip
                 * (the return groove, or the next queued fill) so the DSP
                 * auto-swaps to it sample-accurately when the fill ends. */
                const qIdx = jamQueue.findIndex(c => c.path === matched.path);
                if (qIdx >= 0) jamQueue.splice(qIdx, 1);
                jamFillQueued = jamQueue.length > 0;
                jamScheduledSwap = null;
                jamScheduledSwapBar = -1;
                /* Account for the fill that just played so the return groove
                 * resumes after it (jamFireNext increments this on its branch;
                 * this SYNC path must too, otherwise the groove resumes one bar
                 * early). */
                jamFillsPlayedBars += Math.max(1, matched.bars || 1);
                const remaining = (isOutroClip(matched) || jamQueue.length > 0)
                    ? (jamQueue.length > 0 ? jamQueue[0] : null)
                    : jamReturnGroove;
                if (remaining) {
                    logJam("SYNC fill -> stage return=" + remaining.name +
                        " fillsPlayed=" + jamFillsPlayedBars);
                    /* Stage the return groove (or next fill). The groove resumes
                     * where it left off (plus fills played); a next fill starts
                     * at tick 0. */
                    const resumeTick = (remaining.type !== "fill")
                        ? jamReturnGrooveResumeTick()
                        : 0;
                    jamPreloadClip(remaining, resumeTick);
                }
                resetStepFlash();
                needsRedraw = true;
                stepLedsDirty = true;
                ledDirtyAll = true;
            }
        } else if (jamCurrentClip && jamCurrentClip.type === "fill" && jamReturnGroove) {
            /* The DSP moved off a fill (auto-swapped to the return groove) but
             * the new active_source could not be matched to a clip in the UI
             * lists (e.g. a path/name mismatch). The audio has returned to the
             * groove; clear the fill LED and show the return groove so the
             * pads don't stay stuck on the fill. */
            logJam("SYNC unmatched -> return-to-groove=" + jamReturnGroove.name +
                " active=" + jamActiveSource);
            jamCurrentClip = jamReturnGroove;
            jamCurrentType = jamReturnGroove.type || "groove";
            jamQueuedGroove = null;
            jamQueuedGrooveEscalated = false;
            jamFillQueued = false;
            jamQueue = [];
            jamScheduledSwap = null;
            jamScheduledSwapBar = -1;
            /* Returning to the return groove after a fill: keep the fill page
             * where it is instead of resetting to the start. */
            resetStepFlash();
            needsRedraw = true;
            stepLedsDirty = true;
            ledDirtyAll = true;
        }
    }

    /* Track whether the preview's play request has actually landed on the
     * DSP yet. song_json/play are async now, so "not running" can mean
     * either "genuinely finished" or "the build/play hasn't confirmed yet" --
     * only the transition INTO running, observed at least once, distinguishes
     * them from "never started". */
    if (jamPreviewScheduled && ((lastDspState && lastDspState.running) || (lastDspTransport && lastDspTransport.running))) {
        jamPreviewObservedRunning = true;
    }

    /* Same idea for Performance mode's song-end detection -- see
     * perfObservedRunningSincePlay's declaration for the bug this exists to
     * fix (a stale stopped_at_end from the JUST-ENDED song spuriously
     * advancing a SECOND time before the newly requested song's async build
     * has even confirmed, skipping it entirely). */
    if ((lastDspState && lastDspState.running) || (lastDspTransport && lastDspTransport.running)) {
        perfObservedRunningSincePlay = true;
    }

    /* If a jam preview one-shot finished on its own (non-looping clip ended),
     * clear the preview state and return to the stopped Jam grid. This must
     * run before the generic DSP-stop branch below so it isn't mistaken for a
     * normal clip that ended. Gated on jamPreviewObservedRunning so this
     * doesn't fire while the (now-async) song_json/play request for this
     * preview is still in flight and simply hasn't landed yet -- see its
     * declaration. */
    if (jamPreviewScheduled && jamPreviewObservedRunning &&
        ((lastDspState && !lastDspState.running) || (lastDspTransport && !lastDspTransport.running))) {
        logJam("PREVIEW finished on its own");
        hideHoldPopup();
        jamPreviewPad = -1;
        jamPreviewClip = null;
        jamPreviewScheduled = false;
        jamPreviewStartTime = 0;
        jamPreviewObservedRunning = false;
        /* jamStopPlayback() (used on a manual release) clears these two so
         * drawJamLEDs's isCurrent check stops matching the pad and it
         * returns to its normal colour. This path resets the other preview
         * fields above but was missing this -- so a preview that finished
         * naturally WHILE STILL HELD left jamCurrentClip pointing at the
         * finished clip forever, and the pad stayed white indefinitely
         * (ledDirtyAll below forces a redraw, but with jamCurrentClip still
         * matching, that redraw just reasserts white instead of clearing
         * it). */
        jamCurrentClip = null;
        jamCurrentType = "";
        playbackState = "stopped";
        playbackSectionIndex = currentSectionIndex;
        previewBarOffset = 0;
        lastDspTransport = null;
        needsRedraw = true;
        stepLedsDirty = true;
        ledDirtyAll = true;
    }

    if (((lastDspState && !lastDspState.running) || (lastDspTransport && !lastDspTransport.running)) && playbackState === "playing") {
        /* Jam-mode: the DSP now auto-swaps a staged return groove when a
         * non-looping fill ends, so the UI should not restart playback here.
         * Only fall back to restarting if the DSP really stopped without a
         * staged clip (no auto-swap happened). */
        if (jamPlaying && jamCurrentClip && isOutroClip(jamCurrentClip)) {
            /* An outro groove/fill finished: stop playback entirely (outros are
             * endings). This runs here (not in jamTick) because jamTick
             * returns early when the transport is no longer running. */
            logJam("DSP stopped outro stop -> " + jamCurrentClip.name);
            jamStopPlayback();
        } else if (jamPlaying && jamCurrentClip && jamCurrentClip.type === "fill" && jamReturnGroove) {
            /* A regular fill finished and there is a return groove to switch
             * back to. The DSP may have auto-swapped to it (active_source
             * updated, jamFireNext is a no-op) or stopped (the staged clip was
             * not promoted in time); either way fire the return so playback
             * continues on the groove and the LEDs clear the fill. We do NOT
             * gate on stopped_at_end here — a fill that stops without a staged
             * clip still must return to its groove, not halt. */
            logJam("DSP stopped fill fallback -> return-to-groove=" + jamReturnGroove.name);
            jamFireNext();
            /* keep playbackState = "playing"; jamFireNext restarts the engine */
        } else {
            playbackState = "stopped";
            playbackSectionIndex = currentSectionIndex;
            previewBarOffset = 0;
            lastDspTransport = null;
            lastStepBeatKey = "";
            lastStepBarIndex = -1;
            lastBeatFlashMs = 0;
            lastBeatFlashBeat = -1;
            lastTransportBar = 0;
            maxBeatThisBar = 0;
            transportBeatsPerBar = 0;
            lastSubdivisionIndex = 0;
            lastBeatLogBar = -1;
            lastBeatLogBeat = -1;
            needsRedraw = true;
            stepLedsDirty = true;
        }
    }
    /* Log every new bar/beat while playing so we can verify timing accuracy. */
    if (playbackState === "playing" && lastDspTransport && lastDspTransport.running) {
        const bar = lastDspTransport.bar || 1;
        const beat = lastDspTransport.beat || 1;
        if (bar !== lastBeatLogBar || beat !== lastBeatLogBeat) {
            lastBeatLogBar = bar;
            lastBeatLogBeat = beat;
            const fullBar = bar + previewBarOffset;
            logTiming("BEAT t=" + Date.now() + " bar=" + bar + " beat=" + beat +
                " fullBar=" + fullBar + " section=" + (playbackSectionIndex + 1) +
                " bpm=" + lastDspTransport.bpm + " ts=" + lastDspTransport.time_sig_num + "/" + lastDspTransport.time_sig_den);
        }
    }
    /* While playing a multi-section preview, follow the DSP playhead so the
     * screen and step LEDs switch to whichever section is currently playing.
     * Map against the full original song (perfFullSong) so section indices are
     * stable even when the DSP is playing a sliced one-shot timeline.
     * Skip while a pad preview is active: the preview is a single-clip
     * audition and following it would reset the builder cursor to the first
     * clip, changing the highlighted clip the user is previewing. */
    if (playbackState === "playing" && lastDspTransport && lastDspTransport.running && !padPreviewClip && !harmonyPreviewing) {
        /* Use the fractional bar position (bar_frac, 0-based) so a clip that
         * ends mid-bar (Advanced Trim / speed) switches sections at the exact
         * musical boundary instead of the next integer bar. */
        const dspBarFrac = (typeof lastDspTransport.bar_frac === "number") ? lastDspTransport.bar_frac : ((lastDspTransport.bar || 1) - 1);
        /* builderPlayingFromTemp: currentSong is already sliced to start at
         * the played section (that section is index 0 there), so it must be
         * walked with the DSP's own local bar position, not previewBarOffset
         * added back in -- that offset restates positions in the ORIGINAL
         * song's terms, which only matches sectionSource when sectionSource
         * is itself the full, unsliced song (Performance mode's perfFullSong,
         * or the Builder playing the real currentSong with no slice). Adding
         * it here too walked the sliced array with an offset sized for the
         * full one, landing on the wrong (often last) section before this
         * self-corrected once the offset error grew past a section boundary. */
        const fullSongBarFrac = builderPlayingFromTemp ? dspBarFrac : (dspBarFrac + previewBarOffset);
        const sectionSource = (currentView === VIEW_PERFORMANCE && perfFullSong) ? perfFullSong : currentSong;
        if (sectionSource) {
            let playedBars = 0;
            let newSectionIndex = -1;
            for (let i = 0; i < sectionSource.sections.length; i++) {
                const secBars = sectionBars(sectionSource.sections[i]);
                if (fullSongBarFrac < playedBars + secBars || (i === sectionSource.sections.length - 1 && fullSongBarFrac >= playedBars)) {
                    newSectionIndex = i;
                    break;
                }
                playedBars += secBars;
            }
            if (newSectionIndex >= 0 && newSectionIndex !== playbackSectionIndex) {
                playbackSectionIndex = newSectionIndex;
                /* Reset the step-LED scroll window and flash state so they
                 * don't carry over stale values from the previous section,
                 * which left the step LEDs blank/wrong after a section change.
                 * Force a full step redraw for the new section. */
                stepScrollOffset = 0;
                resetStepFlash();
                stepRedrawAll = true;
                /* Highlight the first clip of the newly playing section so the
                 * jogwheel/trim operate on the live section, not the stale
                 * cursor position from the previous section. */
                builderCursor = 0;
                logDebug("section follow: dspBarFrac=" + dspBarFrac.toFixed(2) + " fullBarFrac=" + fullSongBarFrac.toFixed(2) + " section=" + (playbackSectionIndex + 1));
                needsRedraw = true;
                stepLedsDirty = true;
            }
        }
        /* Auto-scroll: when the currently playing item reaches the top visible
         * row (row 3), scroll the window down one row so the playing section
         * moves to row 2 and the next row of sections becomes visible at the
         * top. Skipped once the user has manually scrolled, so the auto-follow
         * doesn't yank the view back to the current song against the user's
         * explicit scroll. */
        if (!perfManualScroll && currentView === VIEW_PERFORMANCE && perfSongSections.length > 0) {
            const playingIdx = perfSongSections.findIndex(it =>
                it.kind === "section" && it.songIndex === perfSongIndex && it.sectionIndex === playbackSectionIndex);
            if (playingIdx >= 0) {
                const windowRow = Math.floor(playingIdx / 8) - perfScrollRow;
                const maxRow = Math.max(0, Math.ceil(perfSongSections.length / 8) - 4);
                if (windowRow === 3 && perfScrollRow < maxRow) {
                    perfScrollRow++;
                    needsRedraw = true;
                    ledDirtyAll = true;
                }
            }
        }
    }
    drainOutputEvents();
    if (playbackState === "playing" && dspTimelineInfo) {
        const now = Date.now();
        const hasEvents = dspTimelineInfo.count > 0;
        if (now - lastTickLogTime >= tickLogInterval) {
            lastTickLogTime = now;
            if (hasEvents || (lastDspState && (lastDspState.stopped_at_end || !lastDspState.running))) {
                logDebug("tick timeline_info=" + JSON.stringify(dspTimelineInfo) + " state=" + JSON.stringify(lastDspState));
            }
        }
    }
}

/* ── LED queue ───────────────────────────────────────────────────────── */

function flushLedQueue() {
    let n = 0;
    for (const [key, msg] of ledQueue) {
        if (n >= LEDS_PER_TICK) break;
        if (msg.length === 4) {
            /* msg = [0x09, MidiNoteOn, note, color] */
            if (dspDebugEnabled && perfClickPlaying && (msg[2] >= MovePad1 && msg[2] < MovePad1 + NUM_PADS)) {
                logDebug("LEDSEND pad=" + (msg[2] - MovePad1) + " color=" + msg[3] +
                    " bar=" + (lastDspTransport ? lastDspTransport.bar : "?") +
                    " beat=" + (lastDspTransport ? lastDspTransport.beat : "?") +
                    " t=" + Date.now());
            }
            /* The host refuses a write (false) when its MIDI-out buffer is
             * full; padColor/stepColor already recorded this colour as sent,
             * so a dropped write would never be retried. Leave it queued. */
            if (move_midi_internal_send(msg) === false) break;
        } else {
            /* Knob lights are forced: the cache in input_filter is shared
             * with Schwung's own screens, which paint them too (see
             * KNOB_LED_CCS). */
            setButtonLED(msg[0], msg[1], KNOB_LED_CCS.indexOf(msg[0]) >= 0);
        }
        ledQueue.delete(key);
        n++;
    }
}

function queueLed(key, msg) {
    ledQueue.set(key, msg);
    ledQueueWrites++;
}

/* Send all 32 pads to the host immediately, bypassing the per-tick throttle.
 * Used after a forced grid redraw (song change / autoscroll). The normal
 * ledQueue path drains only LEDS_PER_TICK (8) messages per tick, so a 32-pad
 * forced send would need 4 ticks — and updateLEDs wipes the queue on every
 * ledDirtyAll (which fires on section changes / bar boundaries), dropping the
 * rest. Sending here guarantees the whole grid lands. */
function flushPadGridImmediate() {
    for (let p = 0; p < NUM_PADS; p++) {
        const note = MovePad1 + p;
        const msg = [0x09, MidiNoteOn, note, lastPadState[p]];
        /* Sent: a queued write for this pad is now redundant (it can only
         * hold the same colour, or an older one). Refused: keep it queued. */
        if (move_midi_internal_send(msg) !== false) ledQueue.delete(note);
    }
}

function queuePadLED(padIndex, color) {
    const note = MovePad1 + padIndex;
    queueLed(note, [0x09, MidiNoteOn, note, color]);
}

function queueStepLED(stepIndex, color) {
    const note = MoveStep1 + stepIndex;
    queueLed(note, [0x09, MidiNoteOn, note, color]);
}

function queueButtonLED(cc, color) {
    queueLed(128 + cc, [cc, color]);
}

function padColor(padIndex, color, force = false) {
    if (force || ledDirtyAll || lastPadState[padIndex] !== color) {
        queuePadLED(padIndex, color);
        lastPadState[padIndex] = color;
    }
}

function stepColor(stepIndex, color, force) {
    /* Step LEDs are used for dynamic bar/beat progress, so always queue
     * to keep up with tempo-driven flash updates. */
    if (force || lastStepState[stepIndex] !== color) {
        queueStepLED(stepIndex, color);
        lastStepState[stepIndex] = color;
    }
}

function buttonColor(cc, color) {
    const last = lastButtonState.get(cc);
    if (ledDirtyAll || last !== color) {
        queueButtonLED(cc, color);
        lastButtonState.set(cc, color);
    }
}

function clearPadLEDs() {
    for (let i = 0; i < NUM_PADS; i++) padColor(i, Black);
}

function clearStepLEDs() {
    for (let i = 0; i < NUM_STEPS; i++) stepColor(i, Black, true);
}

/* The lights under the eight knobs (CC 71-78). Arranger does not use them,
 * but Schwung's parameter grid lights them while a chain view is up, and on
 * leaving asks the shim to restore Move's own -- which the shim only does
 * outside overtake, i.e. never while Arranger runs. So Arranger turns them
 * off whenever it has the surface, and leaves them to the editor during a
 * chain view. KNOB_LED_REPAINT_TICKS covers the editor drawing one last frame
 * after the session ends (shadow_ui reconciles before Arranger's tick). */
const KNOB_LED_CCS = [71, 72, 73, 74, 75, 76, 77, 78];
const KNOB_LED_REPAINT_TICKS = 3;
let knobLedRepaintTicks = 0;

/* Where a knob's value sits in its range, 0..1, or null when there is no
 * value to show. */
function knobValueLevel(meta, value) {
    if (!meta || value === null || value === undefined || value === "") return null;
    const options = knobOptions(meta);
    if (options) {
        let idx = options.indexOf(String(value));
        if (idx < 0) { const n = parseInt(value, 10); idx = Number.isFinite(n) ? n : -1; }
        if (idx < 0) return null;
        return options.length > 1 ? Math.max(0, Math.min(1, idx / (options.length - 1))) : 1;
    }
    const v = parseFloat(value);
    if (!Number.isFinite(v)) return null;
    const min = Number.isFinite(meta.min) ? meta.min : 0;
    const max = Number.isFinite(meta.max) ? meta.max : (meta.type === "int" ? 127 : 1);
    return max > min ? Math.max(0, Math.min(1, (v - min) / (max - min))) : 0;
}

/* A knob light: the bank's colour sweep at the knob's value (its first colour
 * with none yet); off for an unmapped or unloaded knob. */
function knobLedColour(bank, k, value) {
    if (!k || k.status !== "ok") return Black;
    const sweep = KNOB_BANK_SWEEPS[bank] || KNOB_BANK_SWEEPS[0];
    const level = knobValueLevel(k.meta, value);
    return sweep[level === null ? 0 : Math.round(level * (sweep.length - 1))];
}

function updateKnobLEDs() {
    if (chainViewActive()) return;
    if (knobLedRepaintTicks > 0) {
        knobLedRepaintTicks--;
        for (const cc of KNOB_LED_CCS) lastButtonState.delete(cc);
    }
    for (let i = 0; i < KNOB_LED_CCS.length; i++) {
        let colour = Black;
        if (currentView === VIEW_PERFORMANCE) {
            const k = perfKnobs[perfKnobBank * KNOB_COUNT + i];
            colour = knobLedColour(perfKnobBank, k, k ? k.value : null);
        } else if (currentView === VIEW_KNOB_MAP) {
            const k = knobEditKnobs[i];
            colour = knobLedColour(knobEditBank, k, k ? knobSavedValue(knobEditEntry(), knobEditSlot(i), k.res) : null);
        }
        setButtonHint(KNOB_LED_CCS[i], colour);
    }
}

const ALL_BUTTON_CCS = [
    MoveBack, MoveMenu, MoveCapture, MovePlay, MoveRec, MoveRecord,
    MoveLoop, MoveMute, MoveDelete, MoveCopy, MoveUndo,
    MoveShift, MoveUp, MoveDown, MoveLeft, MoveRight,
    MoveRow1, MoveRow2, MoveRow3, MoveRow4
];

function resetLedState() {
    lastPadState.fill(Black);
    lastStepState.fill(Black);
    lastButtonState.clear();
    ledDirtyAll = true;
}

function setButtonHint(cc, color) {
    /* buttonColor already deduplicates via lastButtonState. */
    buttonColor(cc, color);
}

function updateButtonLEDs() {
    const active = new Map();

    if (confirmState) {
        active.set(MoveBack, WhiteLedFull);
        active.set(MoveMainButton, WhiteLedFull);
    } else {
        switch (currentView) {
            case VIEW_ROOT:
                active.set(MoveBack, WhiteLedFull);
                break;
            case VIEW_FOLDER_LIST:
                active.set(MoveBack, WhiteLedFull);
                active.set(MoveMainButton, WhiteLedFull);
                break;
            case VIEW_BUILDER: {
                const ledLocked = songIsLocked();
                /* Use the displayed section (auto-followed/jumped during
                 * playback) so the left/right arrow LEDs reflect the section
                 * actually shown, not the stale currentSectionIndex. */
                const ledSec = currentSong ? currentSong.sections[builderDisplaySectionIndex()] : null;
                /* Left/right availability needs the TRUE original index/total,
                 * not builderDisplaySectionIndex()'s sliced-array-relative one.
                 * While builderPlayingFromTemp, currentSong is sliced to start
                 * at currentSectionIndex, so builderDisplaySectionIndex()
                 * returns 0 -- correct for indexing into that sliced array
                 * (ledSec above), but wrong for "is there a previous section":
                 * 0 > 0 is false, so the Left arrow LED went dark for the
                 * whole async gap before flipping back on once the jump
                 * confirmed and currentSong reverted. currentSectionIndex
                 * itself is never touched during that gap (only currentSong/
                 * dspLoopEnabled/builderPlayingFromTemp are -- see
                 * builderPlayingFromTemp's declaration), so it's still the
                 * true original index throughout; same recovery the section
                 * counter in drawBuilder uses. */
                const ledSectionIndex = builderPlayingFromTemp ? currentSectionIndex : builderDisplaySectionIndex();
                const ledTotalSections = (currentSong && currentSong.sections)
                    ? (builderPlayingFromTemp ? currentSong.sections.length + currentSectionIndex : currentSong.sections.length)
                    : 0;
                const ledHasLeftSection = !!(currentSong && ledSectionIndex > 0);
                const ledHasRightSection = !!(currentSong && currentSong.sections && ledSectionIndex < ledTotalSections - 1);
                active.set(MoveBack, WhiteLedFull);
                active.set(MoveMenu, WhiteLedFull);
                /* Record (change source folder) is a Drum-track concept. */
                if (!ledLocked && builderTrack === TRACK_DRUM) active.set(MoveRecord, PureBlue);
                /* Row buttons: the selected track's row lights up in its
                 * colour; the others stay dark grey — the same grey used for
                 * an available-but-unset bar on the chord/instrument steps.
                 * A selected Instrument track that's currently disabled shows
                 * its very-dark partner instead of the full colour. */
                active.set(MoveRow1, DarkGrey);
                active.set(MoveRow2, DarkGrey);
                active.set(MoveRow3, DarkGrey);
                active.set(MoveRow4, DarkGrey);
                {
                    /* An instrument that is off shows its very-dark partner;
                     * so does the Click track while the click is off. */
                    const t = builderTrack;
                    let rowColour = TRACK_ROW_COLOUR[t];
                    if (isInstTrack(t)) {
                        const trackInst = instrumentForTrack(t);
                        if (trackInst && !trackInst.enabled) rowColour = veryDarkPartner(rowColour);
                    } else if (t === TRACK_CLICK && !clickOn) {
                        rowColour = veryDarkPartner(CLICK_ROW_COLOUR);
                    }
                    active.set(TRACK_ROW_CC[t], rowColour);
                }
                if (ledHasLeftSection) active.set(MoveLeft, WhiteLedFull);
                if (ledHasRightSection) active.set(MoveRight, WhiteLedFull);
                /* Play is green while playing; when stopped it is white only
                 * if the current section has clips, else black (nothing to
                 * play). */
                if (playbackState === "playing") {
                    active.set(MovePlay, PureGreen);
                } else if (ledSec && ledSec.clips.length > 0) {
                    active.set(MovePlay, White);
                }
                /* Mute merges this section with the next (lit when there is
                 * one); Shift+Mute splits it at the selected clip (Drum
                 * track, from the 2nd clip). Both need the song stopped and
                 * unlocked. */
                if (!ledLocked && playbackState !== "playing" && currentSong) {
                    const mSec = currentSong.sections[currentSectionIndex];
                    const canMerge = currentSectionIndex + 1 < currentSong.sections.length;
                    const canSplit = builderTrack === TRACK_DRUM && mSec &&
                        builderCursor >= 1 && builderCursor < mSec.clips.length;
                    if (shiftHeld ? canSplit : canMerge) active.set(MoveMute, WhiteLedFull);
                }
                /* The Drum track's clip-editing controls (main button, copy,
                 * loop, delete, page up/down); the Chord, Inst and Click
                 * tracks' lists light theirs in the else branch below. */
                if (builderTrack === TRACK_DRUM) {
                    const ledOnClip = ledSec && builderCursor >= 0 && builderCursor < ledSec.clips.length;
                    const ledOnSection = builderCursor === -1;
                    const ledOnInsert = ledSec && ledSec.clips.length === 0 && builderCursor === 0;
                    const ledTotalPages = builderPageCount();
                    const ledHasUp = builderPage > 0;
                    const ledHasDown = builderPage < ledTotalPages - 1;
                    /* Lit where the click does something (as the footer
                     * says -- see builderClickAction). */
                    if (builderClickAction()) active.set(MoveMainButton, WhiteLedFull);
                    /* Loop, Copy, and Delete do nothing on a locked song, so keep
                     * them black (not added to the active map). */
                    if (!ledLocked) {
                        if (ledOnClip) active.set(MoveCopy, WhiteLedFull);
                        else if (ledOnSection || ledOnInsert) active.set(MoveCopy, WhiteLedDim);
                        active.set(MoveLoop, WhiteLedDim);
                        if (ledOnClip) active.set(MoveDelete, WhiteLedFull);
                        else if (ledOnSection || ledOnInsert) active.set(MoveDelete, WhiteLedDim);
                    }
                    if (ledHasDown) active.set(MoveUp, WhiteLedFull);
                    if (ledHasUp) active.set(MoveDown, WhiteLedFull);
                    if (!ledLocked) {
                        /* Shift does nothing on a locked song (all its alternate
                         * actions are blocked), so leave it black. */
                        active.set(MoveShift, WhiteLedDim);
                        if (shiftHeld) {
                            active.set(MoveShift, WhiteLedFull);
                            active.set(MoveMainButton, WhiteLedFull);
                            /* Shift+Copy / Shift+Delete / Shift+Loop / Shift+Left /
                             * Shift+Right act on the whole section, so they stay
                             * lit anywhere. */
                            active.set(MoveCopy, WhiteLedFull);
                            active.set(MoveLoop, WhiteLedFull);
                            if (ledHasLeftSection) active.set(MoveLeft, WhiteLedFull);
                            if (ledHasRightSection) active.set(MoveRight, WhiteLedFull);
                            active.set(MoveDelete, WhiteLedFull);
                            if (playbackState !== "playing") active.set(MovePlay, White);
                        }
                    } else if (shiftHeld) {
                        active.set(MoveShift, WhiteLedFull);
                        active.set(MoveMainButton, WhiteLedFull);
                        /* Shift+Copy / Shift+Delete / Shift+Loop are inert on a
                         * locked song, so leave them black. Shift+Left/Right
                         * (reorder sections) are also blocked but keep their
                         * dim/bright hints per section availability. */
                        if (playbackState !== "playing") active.set(MovePlay, White);
                    }
                } else {
                    /* The Chord, Inst and Click tracks' lists: the jog click
                     * edits, renames or adds where it can (builderClickAction,
                     * as the footer shows); Copy and
                     * Delete act on a selected chord/item, so they light only
                     * there -- and not on a locked song. Shift+jog moves the
                     * selected one. */
                    const ledListSec = currentSong ? currentSong.sections[chordDisplaySectionIndex()] : null;
                    const ledOnItem = listCursorBar(ledListSec) >= 0;
                    if (builderClickAction()) active.set(MoveMainButton, WhiteLedFull);
                    if (!ledLocked && ledOnItem) {
                        active.set(MoveCopy, WhiteLedFull);
                        active.set(MoveDelete, WhiteLedFull);
                    }
                    /* Loop copies the track to other sections (same-named ones ticked). */
                    if (!ledLocked && currentSong && currentSong.sections.length > 1) {
                        active.set(MoveLoop, WhiteLedFull);
                    }
                    if (!ledLocked) active.set(MoveShift, shiftHeld ? WhiteLedFull : WhiteLedDim);
                    else if (shiftHeld) active.set(MoveShift, WhiteLedFull);
                    if (shiftHeld && playbackState !== "playing") active.set(MovePlay, White);
                }
                break;
            }
            case VIEW_TRIM:
                active.set(MoveBack, WhiteLedFull);
                active.set(MoveMainButton, WhiteLedFull);
                break;
            case VIEW_SONG_SETTINGS:
            case VIEW_SONG_BACKUPS:
                active.set(MoveBack, WhiteLedFull);
                active.set(MoveMainButton, WhiteLedFull);
                break;
            case VIEW_SONG_BANK:
                active.set(MoveBack, WhiteLedFull);
                active.set(MoveMainButton, WhiteLedFull);
                if (selectedSongIndex > 0) {
                    /* A locked song cannot be deleted or renamed: leave the
                     * Delete and Shift buttons black (omit from active map).
                     * Copy (duplicate) is allowed regardless of lock — it
                     * always produces a new, unlocked copy. */
                    const entry = songFiles[selectedSongIndex - 1];
                    const locked = entry ? !!(readJson(entry.path)?.locked) : false;
                    active.set(MoveCopy, WhiteLedFull);
                    if (!locked) active.set(MoveDelete, WhiteLedFull);
                    if (!locked) {
                        /* Shift (rename) only applies to an existing, unlocked
                         * song — not the "+ New Song" row nor a locked one. */
                        active.set(MoveShift, WhiteLedDim);
                        if (shiftHeld) active.set(MoveShift, WhiteLedFull);
                    }
                }
                break;
            case VIEW_OPTIONS:
            case VIEW_OPTIONS_DRUMS:
            case VIEW_OPTIONS_INST:
            case VIEW_OPTIONS_KEYS:
            case VIEW_OPTIONS_CLICK:
            case VIEW_OPTIONS_CHAINS:
            case VIEW_KNOB_PICK:
            /* Song Builder's chord, item and instrument pages, and Jam's
             * instrument page: Back leaves. */
            case VIEW_CHORD_PICK:
            case VIEW_INSTRUMENT:
            case VIEW_INSTRUMENT_BAR:
            case VIEW_JAM_INSTRUMENT:
                active.set(MoveBack, WhiteLedFull);
                active.set(MoveMainButton, WhiteLedFull);
                break;
            case VIEW_KNOB_MAP:
                active.set(MoveBack, WhiteLedFull);
                active.set(MoveMainButton, WhiteLedFull);
                if (knobEditMapping(knobEditFocus) || knobEditScope === "song") active.set(MoveDelete, WhiteLedFull);
                /* Shift+jog moves the selected knob's assignment. */
                active.set(MoveShift, shiftHeld ? WhiteLedFull : WhiteLedDim);
                active.set(MoveRecord, KNOB_BANK_COLOURS[knobEditBank]);
                break;
            case VIEW_SETLIST_BANK:
                active.set(MoveBack, WhiteLedFull);
                active.set(MoveMainButton, WhiteLedFull);
                if (selectedSetlistIndex > 0) {
                    active.set(MoveDelete, WhiteLedFull);
                    active.set(MoveCopy, WhiteLedFull);
                    /* Shift (rename) only applies to an existing setlist, not
                     * the "+ New Setlist" row. */
                    active.set(MoveShift, WhiteLedDim);
                    if (shiftHeld) active.set(MoveShift, WhiteLedFull);
                }
                break;
            case VIEW_SETLIST_EDIT: {
                const songs = currentSetlist ? currentSetlist.songs : [];
                const onAddSong = setlistSongIndex >= songs.length;
                active.set(MoveBack, WhiteLedFull);
                active.set(MoveMainButton, WhiteLedFull);
                if (!onAddSong) active.set(MoveDelete, WhiteLedFull);
                if (!onAddSong) {
                    /* Shift has no action on "(add song)", so leave it black. */
                    active.set(MoveShift, WhiteLedDim);
                    if (shiftHeld) active.set(MoveShift, WhiteLedFull);
                }
                break;
            }
            case VIEW_SETLIST_PICK:
                active.set(MoveBack, WhiteLedFull);
                active.set(MoveMainButton, WhiteLedFull);
                break;
            case VIEW_SETLIST_CLICK:
            case VIEW_SETLIST_SECTION_PICK:
            case VIEW_COPY_TRACK_PICK:
                active.set(MoveBack, WhiteLedFull);
                active.set(MoveMainButton, WhiteLedFull);
                break;
            case VIEW_SETLIST_SECTIONS: {
                active.set(MoveBack, WhiteLedFull);
                const rows = setlistSectionRows();
                const row = rows[setlistSecCursor];
                if (row && row.type !== "section") active.set(MoveMainButton, WhiteLedFull);
                if (row && row.type === "section") {
                    active.set(MoveCopy, WhiteLedFull);
                    if (setlistSecRefs().length > 1) active.set(MoveDelete, WhiteLedFull);
                    active.set(MoveShift, shiftHeld ? WhiteLedFull : WhiteLedDim);
                }
                break;
            }
            case VIEW_SECTION_PICK:
                active.set(MoveBack, WhiteLedFull);
                active.set(MoveMainButton, WhiteLedFull);
                break;
            case VIEW_PERF_SETLIST:
                active.set(MoveBack, WhiteLedFull);
                active.set(MoveMainButton, PureGreen);
                break;
            case VIEW_PERFORMANCE:
                active.set(MoveBack, WhiteLedFull);
                {
                    const maxRow = Math.max(0, Math.ceil(perfSongSections.length / 8) - 4);
                    const upLit = perfScrollRow < maxRow;
                    const downLit = perfScrollRow > 0;
                    if (upLit) active.set(MoveUp, WhiteLedFull);
                    if (downLit) active.set(MoveDown, WhiteLedFull);
                    /* When the pad window scrolls (auto-scroll or manual), the
                     * up/down button LEDs must reflect the new position. Force a
                     * re-send on a scroll-row change so a stale queued/deduped
                     * state can't leave them lit incorrectly. */
                    if (perfScrollRow !== perfLastUpDownScrollRow) {
                        perfLastUpDownScrollRow = perfScrollRow;
                        /* Send directly, bypassing the throttled ledQueue. A
                         * queued button message can be wiped by the next
                         * ledDirtyAll's ledQueue.clear() (which fires on bar
                         * boundaries during playback) before it flushes,
                         * leaving the up/down LEDs stuck in their old state
                         * after an auto-scroll. */
                        setButtonLED(MoveUp, upLit ? WhiteLedFull : Black);
                        setButtonLED(MoveDown, downLit ? WhiteLedFull : Black);
                        lastButtonState.set(MoveUp, upLit ? WhiteLedFull : Black);
                        lastButtonState.set(MoveDown, downLit ? WhiteLedFull : Black);
                        /* ...and drop any write still queued for them, which
                         * would otherwise land after this one and undo it. */
                        ledQueue.delete(128 + MoveUp);
                        ledQueue.delete(128 + MoveDown);
                    }
                }
                active.set(MovePlay, perfPlaying ? PureGreen : White);
                if (perfRecordingAvailable()) active.set(MoveRec, perfRecording ? PureRed : White);
                /* Sample (knob banks): the current bank's colour. */
                active.set(MoveRecord, KNOB_BANK_COLOURS[perfKnobBank]);
                active.set(MoveRow1, perfDrumEnabled ? TRACK_ROW_COLOUR[TRACK_DRUM] : Black);
                active.set(MoveRow2, perfInst1Enabled ? TRACK_ROW_COLOUR[TRACK_INSTRUMENT_1] : Black);
                active.set(MoveRow3, perfInst2Enabled ? TRACK_ROW_COLOUR[TRACK_INSTRUMENT_2] : Black);
                /* Track 4: the Pads; with Shift held, the click. */
                active.set(MoveRow4, shiftHeld ? (clickOn ? CLICK_ROW_COLOUR : Black)
                                               : (perfInst3Enabled ? TRACK_ROW_COLOUR[TRACK_PADS] : Black));
                break;
            case VIEW_JAM_FOLDER:
                active.set(MoveBack, WhiteLedFull);
                active.set(MoveMainButton, WhiteLedFull);
                break;
            case VIEW_JAM:
                active.set(MoveBack, WhiteLedFull);
                {
                    const maxScroll = Math.max(0, Math.ceil(jamGrooves.length / (jamGrooveCols() * 4)) - 1);
                    /* Reversed: Up scrolls down, Down scrolls up. */
                    if (jamGrooveScroll < maxScroll) active.set(MoveUp, WhiteLedFull);
                    if (jamGrooveScroll > 0) active.set(MoveDown, WhiteLedFull);
                    const fills = jamVisibleFills();
                    const maxFillScroll = Math.max(0, Math.ceil(fills.length / (jamFillCols() * 4)) - 1);
                    if (jamFillScroll > 0) active.set(MoveLeft, WhiteLedFull);
                    if (jamFillScroll < maxFillScroll) active.set(MoveRight, WhiteLedFull);
                }
                active.set(MovePlay, jamPlaying ? PureGreen : Black);
                if (perfRecordingAvailable()) active.set(MoveRec, perfRecording ? PureRed : White);
                active.set(MoveRow1, jamDrumEnabled ? TRACK_ROW_COLOUR[TRACK_DRUM] : Black);
                active.set(MoveRow2, jamInst1Enabled ? TRACK_ROW_COLOUR[TRACK_INSTRUMENT_1] : Black);
                active.set(MoveRow3, jamInst2Enabled ? TRACK_ROW_COLOUR[TRACK_INSTRUMENT_2] : Black);
                active.set(MoveRow4, jamPadsEnabled ? TRACK_ROW_COLOUR[TRACK_PADS] : Black);
                break;
        }
        /* Perform and Jam: Capture is Keys (lit, bright while on), Up/Down
         * its octave while on. */
        if (keysViewActive()) {
            active.set(MoveCapture, keysOn ? WhiteLedFull : WhiteLedDim);
            if (keysOn) {
                active.set(MoveUp, keysOctave < 8 ? WhiteLedFull : Black);
                active.set(MoveDown, keysOctave > -1 ? WhiteLedFull : Black);
            }
        }
        /* Song Builder's settings pages: Play works there as in Song Builder. */
        if (currentSong && SONG_BUILDER_SUBVIEWS.has(currentView)) {
            active.set(MovePlay, playbackState === "playing" ? PureGreen : White);
        }
    }

    for (const cc of ALL_BUTTON_CCS) {
        /* Under a chain view, only what still works is lit. */
        if (chainViewActive() && !chainViewKeepsButton(cc)) {
            setButtonHint(cc, Black);
        } else if (active.has(cc)) {
            setButtonHint(cc, active.get(cc));
        } else {
            setButtonHint(cc, Black);
        }
    }
    updateKnobLEDs();
}

/* ── LED drawing ─────────────────────────────────────────────────────── */

const GROOVE_COLOUR_BASE = 11;   /* Neon Green */
const GROOVE_DIM_COLOUR = 85;    /* Dark Grass dim partner of Neon Green */
const GROOVE_DARK_COLOUR = 86;   /* Very Dark Grass dark partner */
const FILL_COLOUR_BASE = 1;     /* Bright Red */
const FILL_DIM_COLOUR = 65;      /* Deep Red dim partner */
const FILL_DARK_COLOUR = 66;     /* Very Dark Red dark partner */
const GROOVE_VARIATION_COLOURS = [11, 12, 13, 14]; /* Neon Green, Teal Green, Muted Teal, Cyan-Teal */

/* Colour used for the final step LED when a section has more bars than fit on
 * the 16 step buttons, indicating there are additional bars to scroll to. */
const MORE_BARS_COLOUR = 45; /* Muted Blue — distinct from clip colours */

/* The palette's very-dark partner for a base hue colour 1-26 is base*2 + 64
 * (e.g. 16 Azure Blue -> 96 Very Dark Azure), one tier darker than the mid
 * "dim" partner (base*2 + 63). Used throughout for a muted/disabled state. */
function veryDarkPartner(base) {
    return base * 2 + 64;
}

/* Chord/instrument track step LED colour: the bar colour matches the
 * selected track's Row button colour (see TRACK_ROW_COLOUR), and the muted
 * (chord exists but off for this instrument) colour is its very-dark
 * partner. */

/* Pure palette colours (indexed 0-127) used for transport/state LEDs. */
const PureGreen = 126;   /* solid green */
const PureRed = 127;     /* solid red */
const PureBlue = 125;    /* solid blue */

/* Single colour for the count-in click section, used consistently for the
 * click pad and the click step LEDs (dim variant for the pad, matching dim for
 * the steps). Previously the click pad/steps used inconsistent colours
 * (grey/green/light-red) depending on state. */
const CLICK_COLOUR = 16;       /* Azure Blue */
const CLICK_DIM_COLOUR = veryDarkPartner(CLICK_COLOUR); /* Very Dark Azure (96) */

/* Instrument variation colour (hat/stick/ride/clap). Returns -1 if the name
 * has no instrument keyword. Used so variation grooves and fills share a
 * colour that stands out from plain section clips. The very-dark partner for
 * a colour in 1-26 is base*2 + 64 (e.g. colour 2 -> 68, colour 12 -> 88). */
function instrumentColor(name, dim) {
    const lower = (name || "").toLowerCase();
    if (lower.includes("hat")) return dim ? 15 * 2 + 64 : 15;    /* Teal-Cyan (avoid a red close to PureRed) */
    if (lower.includes("stick")) return dim ? 5 * 2 + 64 : 5;  /* Light Yellow */
    if (lower.includes("ride")) return dim ? 20 * 2 + 64 : 20;  /* Electric Violet */
    if (lower.includes("clap")) return dim ? 25 * 2 + 64 : 25;  /* Bright Pink */
    return -1;
}

/* Base colour (1-26) for a section type. Grooves and fills of the same type
 * share this colour, so a groove and its matching fill look alike. Colours are
 * chosen from the first 26 palette entries with maximum hue separation:
 *   intro=orange, verse=lime, prechorus=azure, chorus=purple, bridge=magenta,
 *   outro=red, break=yellow, generic=neon green. */
const SECTION_BASE_COLOUR = {
    intro: 3,       /* Bright Orange */
    verse: 9,       /* Bright Lime */
    prechorus: 16,  /* Azure Blue */
    chorus: 22,     /* Purple */
    bridge: 26,     /* Light Magenta */
    outro: 1,       /* Bright Red */
    break: 13,       /* Muted Teal */
    fill: 11,       /* Neon Green (generic) */
    groove: 11      /* Neon Green (generic) */
};

/* Colour for a section type. The very-dark partner for a base colour in 1-26
 * is base*2 + 64 (e.g. intro 3 Bright Orange -> 70 Dark Brown, not red). */
function sectionColor(type, dim) {
    const base = SECTION_BASE_COLOUR[type] !== undefined ? SECTION_BASE_COLOUR[type] : 11;
    return dim ? base * 2 + 64 : base;
}

/* A clip that matches no named section (intro/verse/prechorus/chorus/bridge/
 * outro/break) and no instrument (hat/stick/ride/clap) is a "generic" groove
 * or fill. Instead of every generic clip sharing the same green, choose from
 * this group of colours (1-26), spread out deterministically per clip. The
 * group deliberately avoids the reds/oranges/pinks (close to PureRed) and the
 * limes/greens/teals (close to PureGreen), so they stay distinct from the pure
 * transport/state LEDs. */
const GENERIC_COLOURS = [16, 17, 18, 19, 20, 21, 22, 23, 24, 26];

/* Deterministic 0-based index into GENERIC_COLOURS for a clip name, so the
 * same generic clip always gets the same colour (stable across redraws). */
function genericColourIndex(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) {
        h = (h * 31 + name.charCodeAt(i)) >>> 0;
    }
    return h % GENERIC_COLOURS.length;
}

/* Colour for a clip. Instrument colours (hat/stick/ride/clap) override the
 * section colour for both grooves and fills, so a variation groove and its
 * matching fill share the instrument colour. A named section type uses its
 * section colour, identical for a groove and its fill. A generic clip (no
 * matching section or instrument) picks a colour from GENERIC_COLOURS. */
function clipColor(clip, dim) {
    if (!clip) return dim ? GROOVE_DARK_COLOUR : GROOVE_COLOUR_BASE;
    /* A placeholder's bars: grey, as empty. */
    if (clip.placeholder) return DarkGrey;
    const inst = instrumentColor(clip.name, dim);
    if (inst >= 0) return inst;
    const name = clip.name || clip.path || "";
    const section = inferSectionFromFilename(name);
    if (section === "") {
        const base = GENERIC_COLOURS[genericColourIndex(name)];
        return dim ? base * 2 + 64 : base;
    }
    /* Use the section type inferred from the name (intro/verse/chorus/...),
     * not clip.type. Fills always have type "fill" even when their name is a
     * section (e.g. "Verse Fill"), so clip.type would wrongly give them the
     * generic green instead of the groove's section colour. */
    return sectionColor(section, dim);
}

/* Colour for a performance setlist section pad. The section's colour comes
 * from its part type inferred from the section name (e.g. "Verse" -> lime,
 * "Chorus" -> purple), matching the builder/jam clip colours, dimmed when not
 * the active/current song section. */
function sectionPadColor(sectionName, dim) {
    const type = inferPartTypeFromFilename(sectionName || "");
    return clipColor({ name: sectionName || "", type }, dim);
}

const GROOVE_PADS_PER_BANK = 16;  /* 4 columns x 4 rows */
const FILL_PADS_PER_BANK = 16;    /* 4 columns x 4 rows */
const PAD_COLUMNS = 8;
const PAD_ROWS = 4;
const GROOVE_COLUMNS = 4;

/* Move pads are 8 columns x 4 rows, indexed 0..31 bottom-left to top-right, row-major.
 * Grooves occupy the left 4 columns (columns 0-3), fills the next 4 columns (columns 4-7). */
function builderSlotForPad(padIndex) {
    const col = padIndex % PAD_COLUMNS;
    const r = Math.floor(padIndex / PAD_COLUMNS);
    if (col < GROOVE_COLUMNS) {
        return { bank: "groove", slot: r * GROOVE_COLUMNS + col };
    }
    return { bank: "fill", slot: r * (PAD_COLUMNS - GROOVE_COLUMNS) + (col - GROOVE_COLUMNS) };
}

function builderPadColorForIndex(index) {
    const slot = builderSlotForPad(index);
    const c = slot.bank === "groove"
        ? grooveClips[builderPage * GROOVE_PADS_PER_BANK + slot.slot]
        : fillClips[builderPage * FILL_PADS_PER_BANK + slot.slot];
    if (!c) return 0;
    return clipColor(c, false);
}

function drawBuilderLEDs() {
    clearPadLEDs();
    /* The Chord, Inst and Pads tracks' pads: see drawHarmonyPads. The
     * Click track's stay unlit. */
    if (harmonyTrack(builderTrack)) { drawHarmonyPads(); return; }
    if (builderTrack !== TRACK_DRUM) return;
    logDebug("drawBuilderLEDs page=" + builderPage + " grooves=" + grooveClips.length + " fills=" + fillClips.length);
    for (let i = 0; i < NUM_PADS; i++) {
        const slot = builderSlotForPad(i);
        const c = slot.bank === "groove"
            ? grooveClips[builderPage * GROOVE_PADS_PER_BANK + slot.slot]
            : fillClips[builderPage * FILL_PADS_PER_BANK + slot.slot];
        /* Force each pad so the LEDs reach the hardware on a cold start, when
         * lastPadState may already match the desired colour and the dedupe in
         * padColor would otherwise skip the send (the drawer only runs when
         * ledDirtyAll is set, so forcing is safe here). */
        if (c) padColor(i, clipColor(c, false), true);
    }
    /* Track buttons are handled by setButtonLED; step LEDs show section progress. */
}

/* True while the count-in click timeline is playing. */
function perfInClick() {
    return perfPlaying && perfClickPlaying;
}

/* Map a pad index to the setlist layout item it currently shows, accounting
 * for the scroll offset. Pads are 8 columns x 4 rows, row-major, bottom row
 * first. The visible window is 4 rows tall, scrolled by perfScrollRow (the
 * bottom visible row index). Returns the item or null if out of range. */
function perfItemForPad(padIndex) {
    const col = padIndex % 8;
    const row = Math.floor(padIndex / 8);
    const itemIndex = (row + perfScrollRow) * 8 + col;
    if (itemIndex < 0 || itemIndex >= perfSongSections.length) return null;
    return perfSongSections[itemIndex];
}

/* Return the section index that will play next in the current song, or -1 if
 * none. A queued section jump takes priority; when a count-in click is present
 * (playing, or stopped with a click configured and no section selected) the
 * next section is the first real section; otherwise it's the section after the
 * one currently playing. */
function perfNextSectionIndex() {
    if (perfQueuedSection >= 0) return perfQueuedSection;
    const full = perfFullSong || currentSong;
    if (!full) return -1;
    const hasClick = currentSetlist && perfSongIndex >= 0 &&
        (currentSetlist.songs[perfSongIndex]?.click_bars || 0) > 0;
    if (perfClickPlaying || (!perfPlaying && hasClick && perfSelectedSection < 0)) return 0;
    if (playbackSectionIndex + 1 < full.sections.length) return playbackSectionIndex + 1;
    return -1;
}

/* Return the perfSongSections item that will play next, which may be the first
 * section (or click) of the next song when the current song is on its last
 * section. Returns null if there is no next item. */
function perfNextItem() {
    /* A queued section jump to a DIFFERENT section targets that section. */
    if (perfQueuedSection >= 0 && perfQueuedSection !== playbackSectionIndex) {
        return perfSongSections.find(it =>
            it.kind === "section" && it.songIndex === perfSongIndex && it.sectionIndex === perfQueuedSection) || null;
    }
    /* A queued repeat of the CURRENT section (perfQueuedSection === the
     * playing section): the current section plays again, so it is the item
     * to highlight as "next" (matching the display's Nsec line). */
    if (perfQueuedSection >= 0 && perfQueuedSection === playbackSectionIndex) {
        return perfSongSections.find(it =>
            it.kind === "section" && it.songIndex === perfSongIndex && it.sectionIndex === playbackSectionIndex) || null;
    }
    /* A queued song jump targets the first playable item of that song. */
    if (perfQueuedSongIndex >= 0) {
        return perfSongSections.find(it => it.songIndex === perfQueuedSongIndex) || null;
    }
    const full = perfFullSong || currentSong;
    if (!full) return null;
    const hasClick = currentSetlist && perfSongIndex >= 0 &&
        (currentSetlist.songs[perfSongIndex]?.click_bars || 0) > 0;
    if (perfClickPlaying || (!perfPlaying && hasClick && perfSelectedSection < 0)) {
        return perfSongSections.find(it =>
            it.kind === "section" && it.songIndex === perfSongIndex && it.sectionIndex === 0) || null;
    }
    /* Next section in the current song. */
    if (playbackSectionIndex + 1 < full.sections.length) {
        return perfSongSections.find(it =>
            it.kind === "section" && it.songIndex === perfSongIndex && it.sectionIndex === playbackSectionIndex + 1) || null;
    }
    /* Last section of the current song: next is the first item of the next song. */
    const nextSong = perfNextPlayable(perfSongIndex + 1);
    if (nextSong >= 0) {
        return perfSongSections.find(it => it.songIndex === nextSong) || null;
    }
    return null;
}

/* The item that will play first from a stopped state (used to light the pad
 * white when stopped). This must match the "Now" section shown on the display:
 *  - if a section is selected while stopped, that section is queued;
 *  - else if the song has a count-in click and no section is selected, the
 *    click plays first (its own pad);
 *  - else the first section plays first. */
function perfFirstItem() {
    if (!currentSong || !perfFullSong) return null;
    const hasClick = currentSetlist && perfSongIndex >= 0 &&
        (currentSetlist.songs[perfSongIndex]?.click_bars || 0) > 0;
    if (perfSelectedSection >= 0) {
        /* A section was selected while stopped: it is the queued target. */
        return perfSongSections.find(it =>
            it.kind === "section" && it.songIndex === perfSongIndex && it.sectionIndex === perfSelectedSection) || null;
    }
    if (hasClick) {
        /* The click plays first; the click pad is lit white. */
        return perfSongSections.find(it =>
            it.kind === "click" && it.songIndex === perfSongIndex) || null;
    }
    /* Otherwise the section shown under "Now" plays first (the last played
     * section index when stopped). */
    return perfSongSections.find(it =>
        it.kind === "section" && it.songIndex === perfSongIndex && it.sectionIndex === playbackSectionIndex) || null;
}

/* True when the next item to play is imminent (about to trigger within its
 * last bar), so its pad can be lit red instead of white — mirroring Jam mode's
 * queued-clip behaviour. A queued section jump with 2 presses fires at the bar
 * end, so it is always imminent; otherwise the trigger lands at the end of the
 * current section, so the next item is imminent only when the playhead is on
 * the current section's last bar. */
function perfNextImminent() {
    if (!perfPlaying || !lastDspTransport || !lastDspTransport.running) return false;
    const full = perfFullSong || currentSong;
    if (!full) return false;
    /* A queued song jump fires at the end of the current section's last bar;
     * a 2-press section jump fires at the end of the current bar (always
     * imminent); a 1-press section jump fires at the end of the current
     * section, so it is imminent only on the current section's last bar. */
    if (perfQueuedSongIndex >= 0) {
        /* Fall through to last-bar detection on the current section. */
    } else if (perfQueuedSection >= 0) {
        if (perfQueuedSectionPresses >= 2) return true;
        /* 1-press: fall through to last-bar detection below. */
    }
    /* During the count-in click, the next item is the first section. It is
     * imminent once the click reaches its last bar. The click timeline is
     * `perfClickBars` bars long and maps to bars 0..perfClickBars-1 in the
     * temp timeline (previewBarOffset is 0 during a click). */
    if (perfClickPlaying) {
        const clickBar = (lastDspTransport.bar || 1) - 1;
        return clickBar >= perfClickBars - 1;
    }
    /* Compute the 0-based bar within the current section. */
    const dspBar0 = (lastDspTransport.bar || 1) - 1;
    const fullSongBar0 = dspBar0 + previewBarOffset;
    const secBars = sectionBars(full.sections[playbackSectionIndex] || { clips: [] });
    const sectionRange = perfSectionBarRange(playbackSectionIndex);
    const sectionStartBar = sectionRange ? sectionRange.startBar : 0;
    const withinSectionBar = fullSongBar0 - sectionStartBar;
    /* Last bar of the section -> imminent. */
    return withinSectionBar >= secBars - 1;
}

function drawPerformanceLEDs(force) {
    const inClick = perfInClick();
    const desired = new Uint16Array(NUM_PADS);
    /* Default unused pads to black. */
    for (let p = 0; p < NUM_PADS; p++) desired[p] = Black;
    /* The first item that will play from a stopped state (the click pad, or
     * the first section). Lit white when it's the "now" queued target. */
    const firstItem = perfPlaying ? null : perfFirstItem();

    /* Pads map to the song/section layout: sections of each song (full colour
     * for the current song, dimmed for others), plus a click pad per song that
     * has a click flag. The visible window is 4 rows tall, scrolled by
     * perfScrollRow (bottom row index). */
    for (let p = 0; p < NUM_PADS; p++) {
        const item = perfItemForPad(p);
        if (!item) continue;
        const isFirst = firstItem && item.songIndex === firstItem.songIndex &&
            item.kind === firstItem.kind && item.sectionIndex === firstItem.sectionIndex;
        const nextItem = perfNextItem();
        const isNext = nextItem && item.songIndex === nextItem.songIndex &&
            item.kind === nextItem.kind && item.sectionIndex === nextItem.sectionIndex;
        const nextImminent = isNext && perfNextImminent();
        if (item.kind === "click") {
            const isCurrent = item.songIndex === perfSongIndex;
            if (!perfPlaying) {
                /* Stopped: only the "Now" queued item is puregreen; the current
                 * song's click is dim-blue, other songs' clicks are grey. */
                desired[p] = isFirst ? PureGreen : (isCurrent ? CLICK_DIM_COLOUR : DarkGrey);
            } else if (isNext) {
                /* The next item to play (e.g. a queued song's click) is
                 * puregreen until its last bar, then purered (mirrors Jam
                 * mode). */
                desired[p] = nextImminent ? PureRed : PureGreen;
            } else if (isCurrent) {
                /* The current song's click pad is white while the count-in is
                 * actively playing, dim-blue otherwise. */
                desired[p] = inClick ? White : CLICK_DIM_COLOUR;
            } else {
                /* Other songs' clicks are uncoloured (grey). */
                desired[p] = DarkGrey;
            }
            continue;
        }
        const isCurrentSong = item.songIndex === perfSongIndex;
        const isActive = isCurrentSong && item.sectionIndex === playbackSectionIndex && !inClick;
        const isQueued = (!isCurrentSong && perfQueuedSongIndex === item.songIndex);
        if (!perfPlaying) {
            /* Stopped: current-song sections are coloured, other songs
             * grey, and only the "Now" queued section is puregreen. */
            if (isFirst) {
                desired[p] = PureGreen;
            } else if (isCurrentSong) {
                desired[p] = sectionPadColor(item.sectionInfo.name, false);
            } else {
                desired[p] = DarkGrey;
            }
        } else if (isQueued) {
            desired[p] = PureGreen;
        } else if (isNext) {
            /* The next section to play (including a queued repeat of the
             * current section) is green until its last bar, then purered
             * (mirrors Jam mode's queued-clip behaviour). Checked before
             * isActive so a queued repeat of the playing section shows the
             * queued colour instead of the plain active white. */
            desired[p] = nextImminent ? PureRed : PureGreen;
        } else if (isActive) {
            desired[p] = White;
        } else if (isCurrentSong) {
            /* Current song but not currently playing: section colour. */
            desired[p] = sectionPadColor(item.sectionInfo.name, false);
        } else {
            desired[p] = DarkGrey;
        }
    }
    /* Send pads. When called from drawPerformanceLEDs with force, send every
     * pad so the grid is guaranteed to reflect the current song/section state
     * after a transition. Otherwise use change detection so the LED queue
     * isn't flooded every tick. */
    for (let p = 0; p < NUM_PADS; p++) {
        if (force || lastPadState[p] !== desired[p]) {
            padColor(p, desired[p], true);
        }
    }
}

function ledStateKey() {
    if (currentView === VIEW_BUILDER) {
        /* Only the clip grid page and the available clips affect pad LEDs.
         * Cursor/section movement and playback state must not force a full pad redraw. */
        return [currentView, builderPage, folderClips.length].join("|");
    }
    if (currentView === VIEW_PERFORMANCE) {
        return [currentView, playbackState, playbackStartTime, perfSongIndex, perfSelectedSong, perfSelectedSection, playbackSectionIndex, perfQueuedSection, perfQueuedSectionPresses, perfQueuedSongIndex].join("|");
    }
    if (currentView === VIEW_JAM) {
        return [currentView, jamGrooveScroll, jamFillScroll, jamPlaying, jamCurrentClip ? jamCurrentClip.path : "", jamQueuedGroove ? jamQueuedGroove.path : "", jamQueue.map(q => q.path).join(","), jamCurrentType, jamReturnFromStart].join("|");
    }
    return currentView;
}

/* Compute whether the current-bar step LED should be flashing white.
 * The DSP transport "beat" may not match the written time signature (e.g.
 * 6/8 often reports 3 beats per bar). We observe how many transport beats
 * occur in one complete bar, then subdivide each beat so we flash
 * time_sig_num times per bar (6 for 6/8, 4 for 4/4, etc.).
 * `activeBeats` is the number of beats that actually play in the current bar
 * (Advanced Trim): a bar trimmed to 2 beats flashes on the first 2 transport
 * beats of the bar and stays dark for the rest. Defaults to the full bar. */
function resetStepFlash() {
    lastStepBeatKey = "";
    lastBeatFlashMs = 0;
    lastBeatFlashBeat = -1;
    lastTransportBar = 0;
    maxBeatThisBar = 0;
    transportBeatsPerBar = 0;
    lastSubdivisionIndex = 0;
    lastSubFlashMs = 0;
}

function updateStepFlash(currentBar, currentBeat, bpm, beatsPerBar) {
    /* Every bar flashes the full beatsPerBar times, in time with the beat.
     * The trim (start_beat/end_beat) affects the AUDIO and section advance, but
     * the step LED always shows the full bar's beat count. */
    const nowMs = Date.now();
    const beatKey = currentBar + "." + currentBeat;
    const beatChanged = beatKey !== lastStepBeatKey;

    if (currentBar !== lastTransportBar) {
        if (lastTransportBar > 0) {
            transportBeatsPerBar = Math.max(1, maxBeatThisBar);
        }
        maxBeatThisBar = currentBeat;
        lastTransportBar = currentBar;
    } else if (beatChanged) {
        maxBeatThisBar = Math.max(maxBeatThisBar, currentBeat);
    }
    if (transportBeatsPerBar <= 0 && beatsPerBar > 0) {
        const isCompound = (beatsPerBar % 3) === 0 && beatsPerBar >= 6;
        transportBeatsPerBar = isCompound ? Math.round(beatsPerBar / 2) : beatsPerBar;
    }

    const beatDurationMs = 60000.0 / (bpm || 120);

    /* In compound meters the DSP reports fewer transport beats than the written
     * time signature (6/8 -> 3 quarter-note beats/bar), but the step LED must
     * flash on the full time_sig_num beats (6 for 6/8). Subdivide each quarter
     * transport beat into subdivs = beatsPerBar / transportBeatsPerBar (6/3=2)
     * and flash once per sub-beat, using the DSP's sample-accurate beat_progress
     * to anchor each subdivision so all sub-beats stay in time. */
    const subdiv = (beatsPerBar > 0 && transportBeatsPerBar > 0)
        ? Math.max(1, Math.round(beatsPerBar / transportBeatsPerBar))
        : 1;
    const subDivDurationMs = beatDurationMs / subdiv;
    const beatProgress = (lastDspTransport && lastDspTransport.running)
        ? (lastDspTransport.beat_progress || 0) : 0;
    const subIndex = Math.max(0, Math.min(subdiv - 1, Math.floor(beatProgress * subdiv)));

    if (beatChanged) {
        lastStepBeatKey = beatKey;
        lastBeatFlashMs = nowMs;
        lastSubdivisionIndex = 0;
        lastSubFlashMs = nowMs;
        logDebug("stepflash bar=" + currentBar + " beat=" + currentBeat + " bpb=" + beatsPerBar +
            " subdiv=" + subdiv + " t=" + nowMs);
    }
    if (subIndex !== lastSubdivisionIndex) {
        lastSubdivisionIndex = subIndex;
        lastSubFlashMs = nowMs;
    }

    /* Blink each sub-beat: on for ~45% of the sub-division, off for the rest. */
    const elapsedInBeat = nowMs - lastSubFlashMs;
    const onMs = Math.min(Math.max(subDivDurationMs * 0.45, 80), 220);
    return elapsedInBeat < onMs;
}

function drawBuilderStepLEDs(force) {
    /* In performance mode the actual `currentSong` may be a sliced one-shot
     * timeline, so use the full original song (or the setlist entry) for
     * stable section/bar metadata. */
    const stepSong = (currentView === VIEW_PERFORMANCE)
        ? (perfFullSong || currentSong || getPerfDisplaySong())
        : viewSong();

    let secIndex = currentSectionIndex;
    if (currentView === VIEW_PERFORMANCE) {
        /* When stopped and a section is selected, preview its bars on the
         * step LEDs so the user sees where the play head will land. */
        if (!perfPlaying && perfSelectedSection >= 0 && stepSong && perfSelectedSection < stepSong.sections.length) {
            secIndex = perfSelectedSection;
        } else if (perfPlaying) {
            /* perfPlaying, not playbackState === "playing": perfPlaying is
             * Performance mode's own flag, set synchronously and early in
             * perfStart(); playbackState only flips once the DSP confirms
             * the async build/play (playCurrentSong's onReady, or
             * perfFinishSectionJumpUiState for a section jump). Between
             * those two points playbackSectionIndex is already correct (set
             * synchronously in perfFireSectionJump -- see its comment) but
             * this branch was still gated on the laggy playbackState, so it
             * fell to the else below and went blank (secIndex=-1, clearing
             * the step LEDs) instead of showing the section actually being
             * jumped to. drawPerformance's section-name display has the
             * same two-branch shape and never checked playbackState at all,
             * which is why fixing playbackSectionIndex alone fixed the
             * display but not this. */
            secIndex = playbackSectionIndex;
        } else {
            secIndex = -1;
        }
    } else if (builderPlayingFromTemp) {
        /* stepSong is the real song (see viewSong), not the sliced copy. */
        secIndex = viewSectionIndex();
    } else {
        secIndex = playbackState === "playing"
            ? (builderDisplaySection >= 0 ? builderDisplaySection : playbackSectionIndex)
            : currentSectionIndex;
    }
    const sec = (stepSong && secIndex >= 0 && secIndex < stepSong.sections.length)
        ? stepSong.sections[secIndex]
        : null;
    if (currentView === VIEW_PERFORMANCE) {
        if (LOG_STEPLED) {
            logDebug("STEPLED perf stepSong=" + (stepSong ? stepSong.name : "null") +
                " secIndex=" + secIndex + " perfSelected=" + perfSelectedSection +
                " playbackSection=" + playbackSectionIndex + " perfPlaying=" + perfPlaying +
                " playbackState=" + playbackState + " sec=" + (sec ? sec.name : "null"));
        }
    } else {
        if (LOG_STEPLED) {
            logDebug("STEPLED builder stepSong=" + (stepSong ? stepSong.name : "null") +
                " secIndex=" + secIndex + " currentSection=" + currentSectionIndex +
                " playbackSection=" + playbackSectionIndex + " builderDisplay=" + builderDisplaySection +
                " playbackState=" + playbackState + " secEmpty=" + (!sec || !sec.clips || sec.clips.length === 0) +
                " padPreview=" + (padPreviewClip ? padPreviewClip.name : "null") +
                " previewBars=" + padPreviewBars + " previewScheduled=" + padPreviewScheduled);
        }
    }

    /* Pad preview: show the held clip's colour/length on the first N steps. */
    if (padPreviewClip) {
        const color = clipColor(padPreviewClip, false);
        let flashOn = false;
        if (lastDspTransport && lastDspTransport.running) {
            const previewBar = lastDspTransport.bar || 1;
            const previewBeat = lastDspTransport.beat || 1;
            const bpm = stepSong ? stepSong.tempo_bpm : (lastDspTransport.bpm || 120);
            const beatsPerBar = (lastDspTransport && lastDspTransport.time_sig_num) ? lastDspTransport.time_sig_num : (stepSong ? stepSong.time_sig_num : 4);
            flashOn = updateStepFlash(previewBar, previewBeat, bpm, beatsPerBar);
        }
        logDebug("STEPLED preview draw clip=" + padPreviewClip.name + " bars=" + padPreviewBars +
            " transport=" + (lastDspTransport ? (lastDspTransport.running ? "running" : "stopped") : "null") +
            " flashOn=" + flashOn + " color=" + color);
        for (let s = 0; s < NUM_STEPS; s++) {
            if (s >= padPreviewBars) {
                stepColor(s, Black, force);
            } else if (lastDspTransport && lastDspTransport.running &&
                       s === ((lastDspTransport.bar || 1) - 1)) {
                /* Active preview bar: flash white to black, then return to the
                 * clip colour when the playhead moves on to the next bar. */
                stepColor(s, flashOn ? White : Black, force);
            } else {
                stepColor(s, color, force);
            }
        }
        return;
    }

    if (!sec || !sec.clips || sec.clips.length === 0) {
        /* An empty section has no bars to show, so every step must be black.
         * Use the non-forced stepColor so each step is only queued when it
         * actually changes from its current colour to black. This clears the
         * steps exactly once (on the transition) instead of flooding the LED
         * queue with 16 black messages every tick (which starves the button
         * LEDs). The per-tick call passes force=false, so once the steps are
         * already black these are no-ops. */
        for (let i = 0; i < NUM_STEPS; i++) stepColor(i, Black, force);
        return;
    }

    /* Map the bars of the current section to the step buttons, honouring the
     * scroll window. Each step represents one bar. If the section has more
     * than NUM_STEPS bars, stepScrollOffset selects which window of bars is
     * shown; the final step LED is drawn with a "more bars" colour to show
     * there are additional bars to scroll to. */
    const totalSectionBars = sectionBars(sec);
    const bpb = (stepSong && stepSong.time_sig_num > 0) ? stepSong.time_sig_num : 4;
    /* For each step (bar) in the section, the clip that owns it. Each step
     * represents one bar of the section's total; a clip's effective (beat-
     * trimmed) length is mapped onto the steps it covers, so two half-bar
     * clips combine into a single step rather than two. The step LED always
     * flashes the full beatsPerBar times (in time with the beat); the trim
     * (start_beat/end_beat) affects the audio and section advance, not the
     * flash count. */
    const totalClips = new Array(Math.max(1, Math.ceil(totalSectionBars))).fill(null);
    let cursor = 0; /* cumulative fractional bar position across clips */
    for (let i = 0; i < sec.clips.length; i++) {
        const clip = sec.clips[i];
        const effBars = clipEffBars(clip);
        const start = cursor;
        const end = cursor + effBars;
        /* Assign every step whose bar range [s, s+1) overlaps this clip. */
        for (let s = Math.floor(start); s < end; s++) {
            if (s >= 0 && s < totalClips.length) totalClips[s] = clip;
        }
        cursor = end;
    }
    const maxScroll = totalSectionBars > NUM_STEPS ? totalSectionBars - NUM_STEPS : 0;
    if (stepScrollOffset > maxScroll) stepScrollOffset = maxScroll;
    if (stepScrollOffset < 0) stepScrollOffset = 0;

    const stepClips = new Array(NUM_STEPS).fill(null);
    for (let s = 0; s < NUM_STEPS; s++) {
        const barIdx = stepScrollOffset + s;
        if (barIdx < totalClips.length) {
            stepClips[s] = totalClips[barIdx];
        }
    }

    /* Use the DSP transport for the exact bar/beat. If unavailable, fall back
     * to parsing the position string. */
    let currentBar = -1;
    let currentBeat = -1;
    let beatsPerBar = (stepSong && stepSong.time_sig_num) ? stepSong.time_sig_num : 4;
    if (lastDspTransport && lastDspTransport.running) {
        currentBar = lastDspTransport.bar;
        currentBeat = lastDspTransport.beat;
        if (lastDspTransport.time_sig_num) beatsPerBar = lastDspTransport.time_sig_num;
    } else if (playbackState === "playing" && lastDspState && lastDspState.running) {
        const pos = String(lastDspState.position || "1.1");
        const dot = pos.indexOf(".");
        currentBar = dot >= 0 ? parseInt(pos.substring(0, dot), 10) : parseInt(pos, 10);
        currentBeat = dot >= 0 ? parseInt(pos.substring(dot + 1), 10) : 1;
        if (isNaN(currentBar)) currentBar = 1;
        if (isNaN(currentBeat)) currentBeat = 1;
    }

    /* Map the DSP bar (which starts from 1 in the temporary timeline) back into
     * the original full song, then to a bar index within the displayed section
     * so the white flash lands on the correct step LED for the current section.
     * If the playhead is NOT in the displayed section, leave currentBar at -1 so
     * no step flashes (avoids the flash bleeding across other sections when the
     * playhead has just crossed a section boundary but the displayed section has
     * not yet caught up). */
    const displaySection = secIndex;
    if (playbackState === "playing" && currentBar > 0) {
        /* Use the fractional bar position so a clip ending mid-bar (Advanced
         * Trim / speed) places the white step at the exact boundary. */
        const dspBarFrac = (typeof lastDspTransport.bar_frac === "number") ? lastDspTransport.bar_frac : (currentBar - 1);
        /* builderPlayingFromTemp: stepSong (== currentSong here) is already
         * sliced to start at the played section, so walk it with the DSP's
         * own local bar position -- adding previewBarOffset back in (sized
         * for the ORIGINAL, unsliced song) would walk the sliced array with
         * an offset too large for it, so playingSection would never match
         * displaySection (0) and the current-bar flash would just never
         * appear during temp-song playback. */
        const fullSongBarFrac = builderPlayingFromTemp ? dspBarFrac : (dspBarFrac + previewBarOffset);
        let barsBefore = 0;
        let playingSection = -1;
        if (stepSong) {
            for (let i = 0; i < stepSong.sections.length; i++) {
                const sb = sectionBars(stepSong.sections[i]);
                if (fullSongBarFrac < barsBefore + sb) {
                    playingSection = i;
                    break;
                }
                barsBefore += sb;
            }
        }
        if (playingSection === displaySection) {
            currentBar = fullSongBarFrac - barsBefore + 1;
        } else {
            /* Not in the displayed section: no bar to flash. */
            currentBar = -1;
        }
    }
    currentBar--; /* 0-based index into section bars */
    currentBeat--; /* 0-based beat */

    let flashOn = false;
    if (lastDspTransport && lastDspTransport.running) {
        const flashBar = lastDspTransport.bar || 1;
        const flashBeat = lastDspTransport.beat || 1;
        const bpm = stepSong ? stepSong.tempo_bpm : (lastDspTransport.bpm || 120);
        const flashBeatsPerBar = (lastDspTransport && lastDspTransport.time_sig_num) ? lastDspTransport.time_sig_num : (stepSong ? stepSong.time_sig_num : 4);
        flashOn = updateStepFlash(flashBar, flashBeat, bpm, flashBeatsPerBar);
    } else if (currentView === VIEW_PERFORMANCE && !perfPlaying && perfSelectedSection >= 0) {
        flashOn = updateStepFlash(1, 1, 120, 4);
        currentBar = flashOn ? 0 : -1;
    }

    /* Auto-scroll the step window so the active bar stays visible. During
     * playback (or a stopped performance preview) we follow the playhead;
     * otherwise we keep the selected clip's first bar in view. */
    if (totalSectionBars > NUM_STEPS) {
        let targetBar = currentBar >= 0 ? currentBar : 0;
        if (playbackState !== "playing" && currentView === VIEW_BUILDER &&
            builderCursor >= 0 && builderCursor < sec.clips.length) {
            /* Find the bar index of the start of the selected clip, using the
             * same effective (beat-trimmed) bar counts as the step mapping so
             * the scroll window lands on the right step. */
            let cursorBar = 0;
            for (let i = 0; i < builderCursor; i++) {
                cursorBar += Math.max(1, Math.round(clipEffBars(sec.clips[i])));
            }
            targetBar = cursorBar;
        }
        const autoMax = totalSectionBars - NUM_STEPS;
        if (stepScrollOffset > targetBar) stepScrollOffset = targetBar;
        else if (targetBar > stepScrollOffset + (NUM_STEPS - 1)) {
            /* Wrap: scroll the window so the current bar lands at step 1 of
             * the new window, letting the flash move across the steps instead
             * of staying pinned to the last step. */
            stepScrollOffset = targetBar;
        }
        if (stepScrollOffset > autoMax) stepScrollOffset = autoMax;
        if (stepScrollOffset < 0) stepScrollOffset = 0;
    }

    /* Builder: dim every clip except the one the cursor is on. */
    let selectedClip = null;
    if (currentView === VIEW_BUILDER && builderCursor >= 0 && builderCursor < sec.clips.length) {
        selectedClip = sec.clips[builderCursor];
    }

    /* Bars beyond the scroll window get a distinct colour on the edge steps. */
    const hasMoreBars = (stepScrollOffset + NUM_STEPS) < totalClips.length;
    const hasPrevBars = stepScrollOffset > 0;

    /* Performance: colour all steps with the active section's pad colour. */
    let perfSectionColour = null;
    if (currentView === VIEW_PERFORMANCE && stepSong && stepSong.sections) {
        const idx = perfPlaying ? playbackSectionIndex : perfSelectedSection;
        if (idx >= 0 && idx < stepSong.sections.length) {
            const secName = stepSong.sections[idx].name;
            perfSectionColour = {
                full: sectionPadColor(secName, false),
                dim: sectionPadColor(secName, true)
            };
        }
    }

    for (let s = 0; s < NUM_STEPS; s++) {
        const clip = stepClips[s];
        const isMoreBar = hasMoreBars && s === NUM_STEPS - 1;
        const isPrevBar = hasPrevBars && s === 0;
        if (!clip) {
            stepColor(s, Black, force);
        } else if (s === Math.floor(currentBar) - stepScrollOffset) {
            /* Current bar: flash white to black on the active beat for a more
             * prominent cue, then return to the clip colour when the playhead
             * moves on to the next bar. */
            if (flashOn) {
                stepColor(s, White, force);
            } else {
                stepColor(s, Black, force);
            }
        } else if (isMoreBar) {
            /* Final step when there are more bars to scroll to. */
            stepColor(s, MORE_BARS_COLOUR, force);
        } else if (isPrevBar) {
            /* First step when scrolled past the start. */
            stepColor(s, MORE_BARS_COLOUR, force);
        } else if (perfSectionColour) {
            /* Performance: all steps use the active section's pad colour. */
            stepColor(s, (selectedClip && clip === selectedClip) ? perfSectionColour.full : perfSectionColour.dim, force);
        } else if (selectedClip && clip === selectedClip) {
            /* The selected clip is full colour. */
            stepColor(s, clipColor(clip, false), force);
        } else {
            /* All other clips are dimmed (same colour, dimmer). */
            stepColor(s, clipColor(clip, true), force);
        }
    }
}

/* ── Jam LED drawing ────────────────────────────────────────────────── */

/* True when the current clip is within one bar of its end, so the next queued
 * clip (or the return groove after a fill) is about to start. For 1-bar clips
 * (fills) this is always true, since they return at the bar end. */
function jamImminentNext() {
    if (!jamCurrentClip) return false;
    const totalBars = Math.max(1, jamCurrentClip.bars || 1);
    const bar = (lastDspTransport && lastDspTransport.bar) ? lastDspTransport.bar : 1;
    return bar >= totalBars;
}

/* Draw the Jam pad LEDs. Left 4 columns = grooves (scrollable), right 4
 * columns = fills (filtered by current groove type). Rule for the pads:
 *   - the next queued clip is white, unless it is within one bar of playing
 *     (then purered);
 *   - the current playing clip is bright green, unless it is queued for a
 *     bar-end restart (then purered);
 *   - other grooves are dimmed type colour; fills are shown by type (dimmed
 *     unless queued/playing). */
/* True whenever the chord-pad performance grid should replace part of the
 * Grooves/Fills grid -- i.e. at least one Jam instrument is enabled via its
 * track button (Row3/Row4). See drawJamLEDs/handleJamPad/jamGrooveCols. */
function jamChordModeActive() {
    return jamInst1Enabled || jamInst2Enabled || jamPadsEnabled;
}

/* Grooves/Fills column counts and the chord block's own column count,
 * given the current chord-mode state -- single source of truth for
 * drawJamLEDs, handleJamPad, and the pagination math (jamGroovePerPage/
 * jamFillPerPage) so they can never disagree on the layout. */
function jamGrooveCols() { return jamChordModeActive() ? 3 : 4; }
function jamFillCols() { return jamChordModeActive() ? 3 : 4; }
function jamGrooveColOffset() { return jamChordModeActive() ? 2 : 0; }
function jamFillColOffset() { return jamChordModeActive() ? 5 : 4; }

/* Chord pad degree (0-7) for a (row, col) position within the 2-column
 * chord block (columns 0-1): column 0 rows 0-3 (bottom to top) = the
 * diatonic degrees 0-3 (I, ii, iii, IV), column 1 rows 0-3 = degrees 4-6
 * (V, vi, vii°) then row 3 = the 8th "octave root" pad (same chord as
 * degree 0, played an octave up -- see jamChordForDegree). Row 0 = bottom,
 * matching the hardware's own bottom-left-to-top-right pad numbering. */
export function jamChordDegreeForPad(row, col) {
    return col * 4 + row;
}

/* {root, quality, shift} for a chord pad degree (0-7), built from jamKey via
 * diatonicChord (ui.js:1154). shift is added to the instrument's own octave
 * on the DSP side (jam_chord_live_octave_shift) -- chord_t itself carries
 * no octave. */
export function jamChordForDegree(degree, key) {
    const k = key || jamKey;
    const c = diatonicChord(k, degree === 7 ? 0 : degree);
    /* The engine places every root in the same octave by pitch class, so in
     * any key but C the degrees whose root wraps past C (e.g. C, D, E, F# in
     * G) would drop below the tonic. Shift those up an octave so the pads
     * always climb from the key's root; the 8th pad is the root an octave
     * up. */
    const wraps = noteSemitone(c.root) < noteSemitone(k);
    return { root: c.root, quality: c.quality, shift: (degree === 7 || wraps) ? 1 : 0 };
}

/* The single chord pad degree that represents "what's currently in effect
 * or about to be" -- used both for the status-line chord label (drawJam)
 * and the stopped-state pad highlight (drawJamLEDs). While playing, that's
 * the live (sounding) chord, falling back to a pending pick that hasn't
 * been promoted yet (e.g. the instant after a press, before the next
 * transport poll); while stopped, it's whichever the user most recently
 * chose -- a fresh pending pick made while stopped, or (if none) the chord
 * that was live when playback stopped, since "play" resumes that chord
 * immediately (see arranger_engine.c's "play" handler calling
 * apply_pending_jam_chord). -1 if nothing has ever been chosen. */
function jamQueuedChordDegree() {
    if (jamPlaying) {
        return jamChordLiveDegree >= 0 ? jamChordLiveDegree : jamChordPendingDegree;
    }
    return jamChordPendingDegree >= 0 ? jamChordPendingDegree : jamChordLiveDegree;
}

/* The "jam_chord" set_param value for a chord pad: root, quality, octave
 * shift, plus degree and key for the Auto inversion. */
function jamChordParam(chord, degree, key) {
    return chord.root + ":" + chord.quality + ":" + chord.shift + ":" + degree + ":" + key;
}

/* Short display label for a chord pad degree (e.g. "D", "F#m", "D+8" for
 * the octave-root pad), or null for -1 (nothing chosen) -- used to build
 * drawJam's status line. */
function jamChordDegreeLabel(degree, key) {
    if (degree < 0) return null;
    return chordLabel(jamChordForDegree(degree, key), key) + (degree === 7 ? "+8" : "");
}

function drawJamLEDs() {
    const curKey = (jamCurrentClip ? jamCurrentClip.path : "null") + "|" + jamCurrentType +
        "|" + (jamQueuedGroove ? jamQueuedGroove.path : "-") + "|" + jamQueue.length;
    if (curKey !== lastJamLedKey) {
        lastJamLedKey = curKey;
        logJam("LEDS drawJamLEDs current=" + (jamCurrentClip ? jamCurrentClip.name : "null") +
            " type=" + jamCurrentType + " qGroove=" + (jamQueuedGroove ? jamQueuedGroove.name : "-") +
            " qLen=" + jamQueue.length + " ledDirtyAll=" + ledDirtyAll);
    }
    const desired = new Uint8Array(NUM_PADS);
    for (let p = 0; p < NUM_PADS; p++) desired[p] = Black;

    const chordMode = jamChordModeActive();
    const grooveCols = jamGrooveCols();
    const fillCols = jamFillCols();
    const grooveColOffset = jamGrooveColOffset();
    const fillColOffset = jamFillColOffset();
    const rows = 4;

    const imminent = jamImminentNext();

    /* Chord pads: columns 0-1, only while chord mode is active -- see
     * jamChordModeActive. While playing: live (currently-sounding) chord
     * white, pending (just pressed, takes effect next bar) red, everything
     * else dim. While stopped: a single green pad shows whichever chord is
     * queued to start the moment Play is pressed (jamQueuedChordDegree) --
     * there's no "next bar" to distinguish pending from live while
     * stopped, so there's only one highlighted state. */
    if (chordMode) {
        const queued = jamPlaying ? -1 : jamQueuedChordDegree();
        for (let row = 0; row < rows; row++) {
            for (let col = 0; col < 2; col++) {
                const degree = jamChordDegreeForPad(row, col);
                const p = row * 8 + col;
                if (jamPlaying) {
                    /* Queued is checked first: after a key change the
                     * queued chord is usually on the same pad as the live
                     * one, and should still show red until it lands. */
                    if (degree === jamChordPendingDegree) {
                        desired[p] = PureRed;
                    } else if (degree === jamChordLiveDegree) {
                        desired[p] = White;
                    } else {
                        desired[p] = DarkGrey;
                    }
                } else {
                    desired[p] = (degree === queued) ? PureGreen : DarkGrey;
                }
            }
        }
    }

    /* Grooves: scrolled by jamGrooveScroll (rows), columns/offset shift
     * left when chord mode frees up columns 0-1. */
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < grooveCols; c++) {
            const idx = (r + jamGrooveScroll * rows) * grooveCols + c;
            const clip = jamGrooves[idx];
            if (!clip) continue;
            const p = r * 8 + grooveColOffset + c;
            const isCurrent = jamCurrentClip && jamCurrentClip.path === clip.path;
            const isQueued = jamQueuedGroove && jamQueuedGroove.path === clip.path;
            /* The return groove is only the next clip when a fill is playing
             * and no other fill is queued after it. If a new fill is queued
             * while a fill plays, that fill is next, so the return groove
             * should not light. */
            const isReturn = jamCurrentClip && jamCurrentClip.type === "fill" &&
                jamQueue.length === 0 &&
                jamReturnGroove && jamReturnGroove.path === clip.path;
            if (isCurrent && isQueued && jamQueuedGrooveEscalated) {
                /* The current groove is queued for a bar-end restart: red. */
                desired[p] = PureRed;
            } else if (isCurrent) {
                /* The current playing clip is white, turning red on its last
                 * bar only when it is about to loop AND no other clip is
                 * queued to take over. A fill never loops; a queued fill or a
                 * queued groove interrupts the loop, so it stays white. */
                const willLoop = jamCurrentClip.type !== "fill" &&
                    jamQueue.length === 0 && !jamQueuedGroove;
                desired[p] = (imminent && willLoop) ? PureRed : White;
            } else if (isQueued) {
                /* A queued groove is green, turning red only when it is
                 * within one bar of playing (escalated bar-end, or the current
                 * clip is in its last bar). */
                desired[p] = (jamQueuedGrooveEscalated || imminent) ? PureRed : PureGreen;
            } else if (isReturn) {
                /* A fill is playing and this is the return groove. Red means
                 * it will resume from the start (tick 0); blue means it will
                 * resume partway through, shown once the return is imminent
                 * (the fill's last bar) so it isn't blue the whole time a
                 * fill plays. Green is the default "will be returned to,
                 * not yet imminent" state.
                 *
                 * The resume position is read from jamStagedResumeTick (the
                 * actual value most recently sent to the DSP via
                 * swap_resume for this clip), not from jamReturnFromStart --
                 * that flag only covers ONE of three ways a return ends up
                 * at tick 0 (the user pressing the groove's own pad mid-fill,
                 * jamQueueGroove's "return-from-start" branch). It stayed
                 * false, so this pad wrongly showed blue, in the other two:
                 * an intro fill's return groove (jamStartWithIntroFill
                 * preloads it at resume=0 directly, since it's the very
                 * first playback -- there is no prior position to resume
                 * from), and a fill queued late enough in a groove that
                 * jamReturnGrooveResumeTick() wraps the resume position back
                 * to 0 on its own (the fill carried past the groove's end).
                 * jamStagedResumeTick reflects all three correctly, since
                 * every path that preloads the return groove -- including
                 * both of those -- funnels through jamPreloadClip, which
                 * records the resume tick it actually sent. */
                const returnFromStart = jamStagedClip && jamStagedClip.path === clip.path &&
                    jamStagedResumeTick === 0;
                desired[p] = returnFromStart ? PureRed : (imminent ? PureBlue : PureGreen);
            } else {
                desired[p] = clipColor(clip, false);
            }
        }
    }

    /* Fills: right columns (3 or 4 depending on chord mode), filtered by
     * current groove type, scrolled by jamFillScroll (rows). Only the next
     * fill to play (front of the queue) is highlighted; fills queued
     * further back are white. */
    const nextFill = (jamQueue.length > 0) ? jamQueue[0] : null;
    const fills = jamVisibleFills();
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < fillCols; c++) {
            const idx = (r + jamFillScroll * rows) * fillCols + c;
            const clip = fills[idx];
            if (!clip) continue;
            const p = r * 8 + fillColOffset + c;
            if (jamCurrentClip && jamCurrentClip.path === clip.path) {
                desired[p] = White;
            } else if (nextFill && nextFill.path === clip.path) {
                /* The next fill plays at the next bar, so it is red. */
                desired[p] = PureRed;
            } else if (jamQueue.some(q => q.path === clip.path)) {
                /* A fill queued further back: green. */
                desired[p] = PureGreen;
            } else {
                desired[p] = clipColor(clip, false);
            }
        }
    }

    for (let p = 0; p < NUM_PADS; p++) {
        if (lastPadState[p] !== desired[p]) {
            padColor(p, desired[p], true);
        }
    }
}

/* Draw the Jam step LEDs: show the current clip's bar layout with the
 * current-bar flash, matching the builder/performance step behaviour. When
 * playback is stopped all steps are cleared to black. */
function drawJamStepLEDs(force) {
    const clip = jamCurrentClip;
    /* When playback is stopped, clear all step LEDs to black. */
    if (!jamPlaying) {
        /* A jam preview (pad-held one-shot while stopped) plays the clip but
         * leaves jamPlaying false. Show the preview clip's bar layout on the
         * step LEDs, coloured and flashing on the current bar as it plays. */
        if (jamPreviewScheduled && jamPreviewClip) {
            const pclip = jamPreviewClip;
            const pBars = Math.max(1, Math.min(clipPlayBars(pclip), NUM_STEPS));
            const pColour = clipColor(pclip, false);
            let pBar = -1;
            let pBeat = -1;
            let pBeatsPerBar = 4;
            if (lastDspTransport && lastDspTransport.running) {
                pBar = (lastDspTransport.bar || 1) - 1;
                pBeat = (lastDspTransport.beat || 1) - 1;
                pBeatsPerBar = lastDspTransport.time_sig_num || 4;
            }
            let pFlash = false;
            if (lastDspTransport && lastDspTransport.running) {
                const bpm = lastDspTransport.bpm || 120;
                pFlash = updateStepFlash(pBar + 1, pBeat + 1, bpm, pBeatsPerBar);
            }
            /* Diagnostic for the "steps don't fill for the clip's full bar
             * count" report: log every input to the fill/flash decision
             * below, but only when something actually changes, so this
             * doesn't flood the log every tick. */
            const pKey = (pclip.name || pclip.path) + "|clipBars=" + pclip.bars + "|clipPlayBars=" + clipPlayBars(pclip) +
                "|pBars=" + pBars + "|dspRunning=" + !!(lastDspTransport && lastDspTransport.running) +
                "|dspBar=" + (lastDspTransport ? lastDspTransport.bar : "?") +
                "|pBar=" + pBar + "|pFlash=" + pFlash + "|observedRunning=" + jamPreviewObservedRunning;
            if (pKey !== lastJamPreviewStepKey) {
                lastJamPreviewStepKey = pKey;
                logJam("PREVIEW-LEDS " + pKey);
            }
            /* Diagnostic: confirm the colour fill loop actually QUEUES a
             * message per step, rather than trusting that the computed
             * inputs above (already confirmed correct) reach the hardware.
             * Logs how many LED writes this queued and, on the first draw of a new
             * preview (or whenever the queued count looks wrong), every
             * per-step color decision and whether stepColor's dedup
             * (lastStepState) suppressed it. */
            const qBefore = ledQueueWrites;
            const perStep = [];
            for (let s = 0; s < NUM_STEPS; s++) {
                let want;
                if (s >= pBars) {
                    want = Black;
                } else if (s === pBar) {
                    want = pFlash ? White : Black;
                } else {
                    want = pColour;
                }
                const before = lastStepState[s];
                stepColor(s, want, force);
                const queued = lastStepState[s] !== before || force;
                perStep.push(s + ":want=" + want + ":prev=" + before + ":" + (queued ? "QUEUED" : "skip"));
            }
            const qAfter = ledQueueWrites;
            const qKey = pKey + "|qDelta=" + (qAfter - qBefore);
            if (qKey !== lastJamPreviewQueueKey) {
                lastJamPreviewQueueKey = qKey;
                logJam("PREVIEW-QUEUE qBefore=" + qBefore + " qAfter=" + qAfter + " delta=" + (qAfter - qBefore) +
                    " force=" + force + " pColour=" + pColour + " steps=[" + perStep.join(",") + "]");
            }
            return;
        }
        /* Confirmed via the LEDQ diagnostic: this fallback (stopped, no
         * active preview) runs unconditionally every tick while in Jam view
         * and not playing. Passing force=true here queued all NUM_STEPS
         * messages on EVERY tick regardless of whether they were already
         * black, growing the queue by ~16 messages/tick indefinitely (measured
         * ~768/sec) any time the user sat in Jam view without a preview
         * held -- this was the actual source of the multi-thousand-message
         * backlog, not anything specific to the preview feature itself.
         * `force` (the function's own parameter, true only for an explicit
         * full redraw) lets stepColor's dedup do its job the rest of the
         * time, matching every other branch in this function. */
        for (let s = 0; s < NUM_STEPS; s++) stepColor(s, Black, force);
        return;
    }
    /* The 0-based groove bar the current fill sits on (when the current clip
     * is a fill). jamFillBaseBar is where the fill batch started and
     * jamFillsPlayedBars already includes this fill's bars, so subtracting
     * them yields this fill's start position within the groove. */
    const fillPos = (clip && clip.type === "fill")
        ? Math.max(0, jamFillBaseBar + jamFillsPlayedBars - Math.max(1, clip.bars || 1))
        : -1;
    const stepKey = (clip ? clip.path : "null") + "|" + (clip ? (clip.bars || 1) : "?") + "|" + fillPos + "|" + stepLedsDirty;
    if (stepKey !== lastJamStepKey) {
        lastJamStepKey = stepKey;
        logJam("LEDS drawJamStepLEDs force=" + force + " clip=" + (clip ? clip.name : "null") +
            " bars=" + (clip ? (clip.bars || 1) : "?") + " fillPos=" + fillPos + " stepDirty=" + stepLedsDirty);
    }
    if (!clip) {
        if (force) clearStepLEDs();
        return;
    }
    let currentBar = -1;
    let currentBeat = -1;
    let beatsPerBar = 4;
    if (lastDspTransport && lastDspTransport.running) {
        currentBar = (lastDspTransport.bar || 1) - 1;
        currentBeat = (lastDspTransport.beat || 1) - 1;
        beatsPerBar = lastDspTransport.time_sig_num || 4;
    }
    let flashOn = false;
    if (lastDspTransport && lastDspTransport.running) {
        const bpm = lastDspTransport.bpm || 120;
        flashOn = updateStepFlash(currentBar + 1, currentBeat + 1, bpm, beatsPerBar);
    }

    if (clip.type === "fill") {
        /* A standalone intro fill (started playback on its own): show only the
         * fill's own bars (its length), like a groove, not overlaid on a return
         * groove that hasn't started yet. */
        if (jamStandaloneFill) {
            const fillBars = Math.max(1, Math.min(clipPlayBars(clip), NUM_STEPS));
            const fillColour = clipColor(clip, false);
            for (let s = 0; s < NUM_STEPS; s++) {
                if (s >= fillBars) {
                    stepColor(s, Black, force);
                } else if (s === currentBar) {
                    stepColor(s, flashOn ? White : Black, force);
                } else {
                    stepColor(s, fillColour, force);
                }
            }
            return;
        }
        /* A fill: keep the groove's step LEDs visible and overlay the fill at
         * the position within the groove where it plays (rather than starting
         * at step 1). The bars the fill covers show the fill colour and flash
         * on the current fill bar; the remaining groove bars stay dim. When
         * the groove resumes, this branch is no longer taken, so the fill
         * bars return to the groove colour. */
        const groove = jamReturnGroove;
        const grooveBars = groove ? Math.max(1, Math.min(clipPlayBars(groove), NUM_STEPS)) : 0;
        const fillBars = Math.max(1, Math.min(clipPlayBars(clip), NUM_STEPS));
        /* 0-based groove index this fill starts on. If it is past the groove's
         * end (a fill queued in the last bar fires at the loop wrap), wrap it
         * back into the groove for display. */
        let fillStart = fillPos;
        if (grooveBars > 0 && fillStart >= grooveBars) fillStart %= grooveBars;
        const fillColour = clipColor(clip, false);
        /* Groove bars not covered by the fill keep their normal (full) colour
         * so they "remain" while the fill overlaps its own bars. */
        const grooveColour = groove ? clipColor(groove, false) : Black;
        const fillStep = (currentBar >= 0) ? fillStart + currentBar : -1;
        for (let s = 0; s < NUM_STEPS; s++) {
            if (s >= fillStart && s < fillStart + fillBars) {
                /* A fill bar: overwrites the groove bar in place. */
                if (s === fillStep) {
                    stepColor(s, flashOn ? White : Black, force);
                } else {
                    stepColor(s, fillColour, force);
                }
            } else if (groove && s < grooveBars) {
                /* A groove bar not covered by the fill: remains. */
                stepColor(s, grooveColour, force);
            } else {
                stepColor(s, Black, force);
            }
        }
        return;
    }

    /* A groove (or the return to a groove): draw its bars as before. */
    const bars = Math.max(1, Math.min(clipPlayBars(clip), NUM_STEPS));
    const colour = clipColor(clip, false);
    for (let s = 0; s < NUM_STEPS; s++) {
        if (s >= bars) {
            stepColor(s, Black, force);
        } else if (s === currentBar) {
            stepColor(s, flashOn ? White : Black, force);
        } else {
            stepColor(s, colour, force);
        }
    }
}

function updateLEDs() {
    const key = ledStateKey();
    if (key !== lastLedKey) {
        ledDirtyAll = true;
        lastLedKey = key;
    }
    let leavingStepView = false;
    if (currentView !== lastLedView) {
        /* Changing views needs a full pad refresh. Step LEDs only matter in
         * builder/performance/jam (and the chord-pick and instrument-bar
         * submenus, which keep showing the chord/instrument track's bar LEDs
         * underneath them); leaving that family should turn them off so they
         * don't stay stuck showing the last song/section. */
        if (currentView === VIEW_BUILDER || currentView === VIEW_PERFORMANCE || currentView === VIEW_JAM || currentView === VIEW_CHORD_PICK || currentView === VIEW_INSTRUMENT_BAR ||
            lastLedView === VIEW_BUILDER || lastLedView === VIEW_PERFORMANCE || lastLedView === VIEW_JAM || lastLedView === VIEW_CHORD_PICK || lastLedView === VIEW_INSTRUMENT_BAR) {
            stepLedsDirty = true;
        }
        if ((lastLedView === VIEW_BUILDER || lastLedView === VIEW_PERFORMANCE || lastLedView === VIEW_JAM || lastLedView === VIEW_CHORD_PICK || lastLedView === VIEW_INSTRUMENT_BAR) &&
            currentView !== VIEW_BUILDER && currentView !== VIEW_PERFORMANCE && currentView !== VIEW_JAM && currentView !== VIEW_CHORD_PICK && currentView !== VIEW_INSTRUMENT_BAR) {
            leavingStepView = true;
            stepLedsDirty = false;
        }
        lastLedView = currentView;
    }
    if (ledDirtyAll) {
        /* Confirmed via device logging (PREVIEW-QUEUE/PREVIEW-WIPE): the
         * ledQueue can carry a large backlog (LEDS_PER_TICK throttles
         * draining to 8/tick, so a burst of traffic outpaces it), and this
         * wipe discards whatever hasn't been sent yet. But stepColor/
         * padColor already updated lastStepState/lastPadState at QUEUE time,
         * not at delivery -- so a wiped message leaves those caches claiming
         * a color was sent when it never reached the hardware, and every
         * later redraw's dedup check (color === lastState) then wrongly
         * skips resending it forever. Invalidate both caches here so the
         * draw calls below (and every later one this view triggers) treat
         * every LED as unknown and actually resend it. This was reproducing
         * exactly as "some step LEDs never fill in" during a Jam preview:
         * the flashing step keeps changing color so it keeps re-queuing
         * (and recovers on its own), but the static-colour steps only ever
         * got sent once, and if that single send landed in a backlog that
         * got wiped, nothing ever corrected it again. */
        if (ledQueue.size > 0) {
            lastStepState.fill(255);
            lastPadState.fill(255);
            lastButtonState.clear();
        }
        ledQueue.clear();
        switch (currentView) {
            case VIEW_BUILDER: drawBuilderLEDs(); break;
            case VIEW_PERFORMANCE:
                /* Force a full send only when the grid content actually changed:
                 * a song change, or an auto-scroll that moved the pad window
                 * (perfScrollRow). During playback ledDirtyAll also fires on
                 * section changes and bar boundaries; force-sending all 32 pads
                 * on every one of those floods the LED queue and makes the
                 * pad/step beat flash inconsistent. When neither the song nor
                 * the scroll row changed, use change-detection. */
                if (keysOn) { drawKeysLEDs(); perfLastPadSongIdx = -1; break; }
                if (perfSongIndex !== perfLastPadSongIdx || perfScrollRow !== perfLastPadScrollRow) {
                    perfLastPadSongIdx = perfSongIndex;
                    perfLastPadScrollRow = perfScrollRow;
                    drawPerformanceLEDs(true);
                    /* The forced grid must reach the hardware now. The queued
                     * path throttles to 8/tick and gets wiped by a later
                     * ledDirtyAll, so flush all 32 pads immediately. */
                    flushPadGridImmediate();
                } else {
                    drawPerformanceLEDs(false);
                }
                break;
            case VIEW_JAM: if (keysOn) drawKeysLEDs(); else drawJamLEDs(); break;
            default: clearPadLEDs();
        }
        ledDirtyAll = false;
    }
    /* Clear step LEDs after the queue has been reset, otherwise the black
     * messages queued by clearStepLEDs get wiped by ledQueue.clear(). */
    if (leavingStepView) {
        clearStepLEDs();
    }
    /* Don't clear steps to black first (the 16 black messages trickle out and
     * make steps fill in late). Just redraw; only changed LEDs are sent. */
    /* Consume the force flag only when a valid transport is available (or
     * stopped): perfFireSectionJump nulls lastDspTransport in the same tick it
     * sets stepRedrawAll, so drawing then would use a stale position. */
    const hasTransport = !!(lastDspTransport && lastDspTransport.running);
    const canForce = hasTransport || !perfPlaying;
    const forceSteps = stepRedrawAll && canForce;
    if (stepRedrawAll && canForce) stepRedrawAll = false;
    /* Performance: show the selected section's bars when stopped, else the
     * click bars, else the active/selected section layout. */
    if (currentView === VIEW_PERFORMANCE && !perfPlaying && perfSelectedSection >= 0) {
        drawBuilderStepLEDs(forceSteps);
        stepLedsDirty = false;
    } else if (currentView === VIEW_PERFORMANCE && perfClickBars > 0 &&
               (perfClickPlaying || (!perfPlaying && perfSelectedSection < 0))) {
        drawClickStepLEDs(forceSteps);
        stepLedsDirty = false;
    } else if (currentView === VIEW_JAM) {
        drawJamStepLEDs(forceSteps);
        stepLedsDirty = false;
    } else if ((currentView === VIEW_BUILDER || currentView === VIEW_CHORD_PICK || currentView === VIEW_INSTRUMENT_BAR) && builderTrack !== TRACK_DRUM) {
        drawChordStepLEDs(forceSteps);
        stepLedsDirty = false;
    } else if (currentView === VIEW_BUILDER || currentView === VIEW_PERFORMANCE) {
        drawBuilderStepLEDs(forceSteps);
        stepLedsDirty = false;
    }
}

/* Draw the step LEDs for the chord/instrument track. Each step maps to a bar
 * of the current section (same scroll window as the drum track).
 *
 * Chord track: dark grey for a bar available from the drum track with no
 * chord set, white for the selected (cursor) bar, coloured for a bar with a
 * chord set.
 *
 * Instrument track: grey with no chord on the bar, coloured when the chord
 * sends on this instrument, dimmed coloured when it's muted for this
 * instrument. The cursor bar isn't highlighted white here — colour alone
 * conveys state, since white is reserved for the chord track's selection. */
function drawChordStepLEDs(force) {
    /* The real song/section while a play-from build is pending (viewSong). */
    const secIndex = builderPlayingFromTemp ? viewSectionIndex() : chordDisplaySectionIndex();
    const sec = viewSong() ? viewSong().sections[secIndex] : null;
    if (!sec) {
        for (let s = 0; s < NUM_STEPS; s++) stepColor(s, Black, force);
        return;
    }
    const totalBars = sectionChordBars(sec);
    const maxScroll = totalBars > NUM_STEPS ? totalBars - NUM_STEPS : 0;
    if (stepScrollOffset > maxScroll) stepScrollOffset = maxScroll;
    if (stepScrollOffset < 0) stepScrollOffset = 0;
    const inst = isInstTrack(builderTrack) ? instrumentForTrack(builderTrack) : null;
    /* Match the bar colour to the selected track's Row button colour. */
    const trackColour = TRACK_ROW_COLOUR[builderTrack];
    /* The white cursor: the bar of the row selected in this section's list,
     * read from the list itself each time -- a stored bar went stale when
     * the section changed (Left/Right, or playback following), lighting a
     * different step than the one highlighted. */
    const chordCursorBar = listCursorBar(sec);

    /* Playback flash: the same bar/beat-accurate white flash on the
     * currently playing bar as the drum track (drawBuilderStepLEDs) -- see
     * that function's matching block for the full derivation, ported here
     * so the chord/instrument tracks show the same playhead cue instead of
     * only ever showing static bar colours. currentBar ends up a 0-based,
     * possibly-fractional bar position within the DISPLAYED section
     * (secIndex); -1 if playback isn't currently inside it (e.g. mid-
     * transition to the next section), in which case nothing flashes here. */
    let currentBar = -1;
    /* (A pad preview's bar is not the section's.) */
    if (playbackState === "playing" && lastDspTransport && lastDspTransport.running && !harmonyPreviewing) {
        const dspBar = lastDspTransport.bar || 1;
        const dspBarFrac = (typeof lastDspTransport.bar_frac === "number") ? lastDspTransport.bar_frac : (dspBar - 1);
        /* builderPlayingFromTemp: currentSong is already sliced to start at
         * the played section, so walk it with the DSP's own local bar
         * position instead of adding previewBarOffset back in -- see the
         * matching comment in drawBuilderStepLEDs. */
        const fullSongBarFrac = builderPlayingFromTemp ? dspBarFrac : (dspBarFrac + previewBarOffset);
        let barsBefore = 0;
        let playingSection = -1;
        for (let i = 0; i < currentSong.sections.length; i++) {
            const sb = sectionBars(currentSong.sections[i]);
            if (fullSongBarFrac < barsBefore + sb) {
                playingSection = i;
                break;
            }
            barsBefore += sb;
        }
        if (playingSection === secIndex) {
            currentBar = fullSongBarFrac - barsBefore;
        }
    }
    let flashOn = false;
    if (lastDspTransport && lastDspTransport.running) {
        const flashBar = lastDspTransport.bar || 1;
        const flashBeat = lastDspTransport.beat || 1;
        const bpm = currentSong ? currentSong.tempo_bpm : (lastDspTransport.bpm || 120);
        const flashBeatsPerBar = lastDspTransport.time_sig_num || (currentSong ? currentSong.time_sig_num : 4);
        flashOn = updateStepFlash(flashBar, flashBeat, bpm, flashBeatsPerBar);
    }

    for (let s = 0; s < NUM_STEPS; s++) {
        const barIndex = stepScrollOffset + s;
        if (barIndex >= totalBars) {
            stepColor(s, Black, force);
            continue;
        }
        if (currentBar >= 0 && s === Math.floor(currentBar) - stepScrollOffset) {
            /* Currently playing bar: flash white to black in time with the
             * beat, same as the drum track, taking priority over the
             * chord/instrument/cursor colouring below. */
            stepColor(s, flashOn ? White : Black, force);
            continue;
        }
        const inBar = barChords(sec, barIndex);
        /* The bar's first sounding chord, else its No Chord, else null. */
        const chord = inBar.find(c => !c.none) || inBar[0] || null;
        if (builderTrack === TRACK_CLICK) {
            /* Bars where a click item starts in the track colour; others
             * dim while the click sounds there, dark grey where it's at 0%.
             * The selected item's bar white. */
            const list = sectionItems(sec, TRACK_CLICK);
            const at = itemAtBarStart(list, barIndex);
            const vol = at && typeof at.volume === "number" ? at.volume : clickVolume;
            if (barIndex === chordCursorBar) stepColor(s, White, force);
            else if (list.some(it => it.bar === barIndex)) stepColor(s, trackColour, force);
            else stepColor(s, vol > 0 ? veryDarkPartner(trackColour) : DarkGrey, force);
        } else if (inst) {
            /* A disabled instrument track shows every bar dimmed — none of
             * it is actually sounding right now, regardless of its items.
             * A bar muted by an item is dimmed too. The selected item's bar
             * shows white. */
            const muteItem = itemAtBarStart(sectionItems(sec, builderTrack), barIndex);
            if (barIndex === chordCursorBar) {
                stepColor(s, White, force);
            } else if (!chord || chord.none) {
                stepColor(s, DarkGrey, force);
            } else if (inst.enabled && !(muteItem && muteItem.mute)) {
                stepColor(s, trackColour, force);
            } else {
                stepColor(s, veryDarkPartner(trackColour), force);
            }
        } else if (barIndex === chordCursorBar) {
            stepColor(s, White, force);
        } else if (chord && chord.none) {
            /* No Chord: set, but silent -- dimmer than a chord, unlike an
             * empty bar (which holds the previous chord). */
            stepColor(s, veryDarkPartner(trackColour), force);
        } else if (chord) {
            stepColor(s, trackColour, force);
        } else {
            stepColor(s, DarkGrey, force);
        }
    }
}

/* During a count-in click, show one step LED per click bar and flash the
 * current bar white on each beat, matching the song-section step LEDs. */
function drawClickStepLEDs(force) {
    const bars = Math.max(1, Math.min(perfClickBars, NUM_STEPS));
    let currentBar = -1;
    let currentBeat = -1;
    let beatsPerBar = 4;
    if (lastDspTransport && lastDspTransport.running) {
        currentBar = (lastDspTransport.bar || 1) - 1;
        currentBeat = (lastDspTransport.beat || 1) - 1;
        beatsPerBar = lastDspTransport.time_sig_num || 4;
    }
    let flashOn = false;
    if (lastDspTransport && lastDspTransport.running) {
        const bpm = lastDspTransport.bpm || (currentSong ? currentSong.tempo_bpm : 120);
        flashOn = updateStepFlash(currentBar + 1, currentBeat + 1, bpm, beatsPerBar);
    }
    for (let s = 0; s < NUM_STEPS; s++) {
        if (s >= bars) {
            /* Steps beyond the click bars must be black (forced so stale
             * section steps from the previous song are cleared). */
            stepColor(s, Black, force);
        } else if (s === currentBar) {
            /* Active click bar: flash white to black, then return to the dim
             * colour when the playhead moves on to the next bar. */
            stepColor(s, flashOn ? White : Black, force);
        } else {
            stepColor(s, CLICK_DIM_COLOUR, force);
        }
    }
}

/* ── Drawing ─────────────────────────────────────────────────────────── */

function clipShortName(clip) {
    if (clip.placeholder) return "(empty)";
    let name = clip.name || clipDisplayName(clip.source || clip.path || "");
    const folder = currentSong ? currentSong.source_folder : "";
    if (folder && name.startsWith(folder)) {
        name = name.substring(folder.length).trim();
    }
    if (name.startsWith("Grooves/")) name = name.substring(8).trim();
    if (name.startsWith("Fills/")) name = name.substring(6).trim();
    /* Strip leading tempo/time-sig and song identifiers common to every file. */
    name = name.replace(/\.mid$/i, "");
    name = name.replace(/^Song\s+\d+\s+\d-\d\s+/i, "");
    name = name.replace(/\b\d{2,3}\s*BPM\b/gi, "");
    name = name.replace(/^\d{2,3}\s+\d-\d\s+/i, "");
    name = name.replace(/^\d{2,3}\s+/i, "");
    name = name.replace(/^\d\s+-\s+\d\s+/i, "");
    name = name.replace(/\bS\d{1,2}\b/ig, "");
    name = name.replace(/\bSong\s+\d{1,2}\b/ig, "");
    name = name.replace(/\s{2,}/g, " ").trim();
    return name.trim() || "clip";
}

function truncate(str, maxLen) {
    if (!str) return "";
    return str.length > maxLen ? str.substring(0, maxLen - 1) + "…" : str;
}

/* Dedicated marquee scrollers for header titles that show long Song/Setlist/
 * clip names. Kept separate from the shared list scroller so each header can
 * scroll independently. A scroller is created per unique title string and
 * reset automatically when the title changes. */
const headerScrollers = new Map();
function scrollHeader(title, maxChars) {
    if (!title) return "";
    let sc = headerScrollers.get(title);
    if (!sc) {
        sc = createUniformScroller();
        headerScrollers.set(title, sc);
    }
    sc.setSelected(title);
    sc.tick();
    if (title.length <= maxChars) return title;
    return sc.getScrolledText(title, maxChars);
}

/* A header title scrolled to what actually fits beside `right`, measured in
 * the header's own font (uppercase font4x5, 128px less 2px margins and a 4px
 * gap before the right text) -- a fixed character count cut titles well
 * short in this proportional font. Every window the scroller can show must
 * fit, so the budget is the longest length whose widest window fits. */
function fitHeader(title, right) {
    if (!title) return "";
    return scrollHeader(title, headerFitChars(title, headerTitleRoom(right)));
}

/* Pixels a header title has beside `right`. */
function headerTitleRoom(right) {
    return 124 - (right ? fontWidth4x5(String(right).toUpperCase()) + 4 : 0);
}

/* The longest window length of `title` whose every window fits `avail`
 * pixels in the header face (its whole length when it fits outright). */
function headerFitChars(title, avail) {
    const T = String(title).toUpperCase();
    if (fontWidth4x5(T) <= avail) return T.length;
    for (let len = T.length - 1; len >= 1; len--) {
        let fits = true;
        for (let i = 0; i + len <= T.length && fits; i++) fits = fontWidth4x5(T.slice(i, i + len)) <= avail;
        if (fits) return len;
    }
    return 1;
}

function drawRoot() {
    drawMenuHeader("Arranger", headerRightWithBattery("v0.6"));
    drawHeaderBattery();
    drawMenuList({
        labelX: 3,
        items: [
            { label: "Song Builder" },
            { label: "Setlists" },
            { label: "Perform" },
            { label: "Jam" },
            { label: "Options" }
        ],
        selectedIndex: menuStack.getSelectedIndex(),
        getLabel: (item) => item.label,
        getValue: () => "",
        maxVisible: 5
    });
    drawOverlay();
}

function drawFolderList() {
    const node = getTreeNode(libraryCategoryTree, folderPickerPath);
    const pathStr = folderPickerPath.map(shortSongName).join("/");
    drawMenuHeader("Source Folder", pathStr);
    const items = node ? getTreeDisplayItems(node) : [];
    if (items.length === 0 && libraryFolders.length === 0) {
        drawLibraryFoldersPlaceholder();
        return;
    }
    drawMenuList({
        items,
        selectedIndex: folderPickerSelectedIndex,
        getLabel: (item) => item.label,
        getValue: () => "",
        maxVisible: 5,
        labelX: 3,
        labelGap: 0
    });
}

/* drawMenuList row fit for lists with right-aligned values: every row shows
 * its whole label and its value takes all the room after it (keeping at
 * least three characters), instead of every value starting at one fixed
 * column (x=92 by default) -- which cut "External 3" to "Ex...", a song name
 * to "Sing Wherev..." and module names to a few letters beside short labels
 * with most of the row empty. The selected row may still give its value
 * priority (prioritizeSelectedValue). */
const LIST_ROW_FIT = { valueX: 3, minLabelChars: 99 };

/* Pixels between a list row's name and its right-hand value in Song
 * Builder's track lists (Schwung's menu default). */
const LIST_LABEL_GAP = 6;

/* "5/10" for Song Builder's section row (every track's list). While
 * builderPlayingFromTemp, currentSong is sliced to start at
 * currentSectionIndex (the shown index is forced to 0 to index into it), so
 * currentSong.sections.length is short by currentSectionIndex and would show
 * "1/6" instead of "5/10" until playback confirms -- the flash seen on
 * pressing Play. currentSectionIndex itself is never touched during this
 * window, so it is still the true original index; adding it back to the
 * sliced length recovers the true total. */
function sectionCountLabel(shownIdx) {
    if (!currentSong) return "";
    const total = builderPlayingFromTemp
        ? currentSong.sections.length + currentSectionIndex
        : currentSong.sections.length;
    const shown = builderPlayingFromTemp ? currentSectionIndex : shownIdx;
    return (shown + 1) + "/" + total;
}

function drawBuilder() {
    /* The chord and instrument tracks have their own displays. */
    if (builderTrack === TRACK_CHORD) { drawChordTrack(); return; }
    if (isItemTrack(builderTrack)) { drawItemTrack(); return; }
    const playingIdx = (playbackState === "playing" && builderDisplaySection >= 0) ? builderDisplaySection : playbackSectionIndex;
    /* builderPlayingFromTemp: currentSong is a song sliced to start at
     * currentSectionIndex while playCurrentSong's async build/play is still
     * unconfirmed (playbackState hasn't flipped to "playing" yet either) --
     * see the flag's declaration. This duplicates builderDisplaySectionIndex()
     * rather than calling it because playingIdx (the auto-follow/manual-jump
     * value once actually playing) is only needed here. */
    const displayIdx = builderPlayingFromTemp ? viewSectionIndex() : (playbackState === "playing" ? playingIdx : currentSectionIndex);
    const vSong = viewSong();
    const sec = vSong ? vSong.sections[displayIdx] : null;
    /* The clip pads are waiting on the folder scan (a song opened before
     * the library has loaded): "..." until they arrive. */
    const clipsLoading = !!pendingFolderClipLoadName;
    const drumsRight = clipsLoading ? "..." : (songIsLocked() ? "*" : "");
    drawMenuHeader(fitHeader("Drums: " + (currentSong ? shortSongName(currentSong.name) : ""), drumsRight), drumsRight);
    if (!sec) {
        print(2, LIST_TOP_Y, "No section.", 1);
        drawOverlay();
        return;
    }
    const items = [{ type: "section" }];
    for (let i = 0; i < sec.clips.length; i++) {
        items.push({ type: "clip", index: i });
    }
    /* Only show the "(add clip)" entry when the section is empty. */
    if (sec.clips.length === 0) {
        items.push({ type: "insert" });
    }
    drawMenuList({
        ...LIST_ROW_FIT,
        labelX: 3,
        items,
        selectedIndex: builderCursor + 1,
        getLabel: (item) => {
            if (item.type === "section") return sec.name || "Section";
            if (item.type === "clip") return clipShortName(sec.clips[item.index]);
            return "(pads add clips)";
        },
        getValue: (item) => {
            if (item.type === "section") return sectionCountLabel(displayIdx);
            if (item.type === "clip") {
                const c = sec.clips[item.index];
                /* Show the effective (beat-trimmed) bar count as a mixed
                 * fraction, so a clip shortened with Advanced Trim displays
                 * its real length (e.g. 3 2/4b) rather than a rounded whole
                 * bar. */
                return formatBars(Math.max(0.25, clipEffBars(c))) + "b";
            }
            return "";
        },
        valueAlignRight: true,
        /* The right-aligned value is clamped to this left edge. The global
         * LIST_VALUE_X (92) only leaves ~5 chars for a fractional bar count
         * like "3 2/4b"; lowering it lets up to 6+ chars fit while the
         * label-floor still protects long clip names from being overlapped. */
        /* Room between a long name (or its "...") and the value, so the
         * two don't read as one string. */
        labelGap: LIST_LABEL_GAP,
        listArea: { topY: LIST_TOP_Y, bottomY: LIST_INDICATOR_BOTTOM_Y }
    });
    const bpm = currentSong ? currentSong.tempo_bpm : 120;
    const num = currentSong ? currentSong.time_sig_num : 4;
    const den = currentSong ? currentSong.time_sig_den : 4;
    /* Draw any active overlay (e.g. a missing-clip warning) on top of the
     * builder display. */
    drawOverlay();
}

/* ── Chord track display ────────────────────────────────────────────── */

/* The section index the chord track is currently showing (mirrors the drum
 * track's section navigation). */
/* Mirrors builderDisplaySectionIndex's builderPlayingFromTemp guard (see its
 * declaration) -- without it, the chord/instrument tracks' step LEDs and
 * screens fell back to playbackSectionIndex/builderDisplaySection treated as
 * absolute indices into the FULL song while builderPlayingFromTemp has
 * currentSong sliced to start at the played section (that section is index
 * 0 there), showing whatever section happened to sit at that same absolute
 * offset in the full song -- typically the next one or two sections ahead,
 * briefly, until playback caught up and this self-corrected. */
function chordDisplaySectionIndex() {
    if (builderPlayingFromTemp) return 0;
    return playbackState === "playing"
        ? (builderDisplaySection >= 0 ? builderDisplaySection : playbackSectionIndex)
        : currentSectionIndex;
}

/* "b3", "b3.2", "b3.2&": where a chord starts (bar, then beat if not 1). */
function chordPosLabel(bar, beat) {
    return "b" + (bar + 1) + (beat !== 1 ? "." + formatBeat(beat) : "");
}

/* Select the list row of the chord at bar/beat (after an edit moved it). */
function selectChordListAt(sec, bar, beat) {
    const evs = sectionChordEvents(sec);
    const i = evs.findIndex(e => e.bar === bar && e.beat === beat);
    chordListCursor = i >= 0 ? i : Math.min(chordListCursor, evs.length);
    syncChordCursorBar(sec);
}

/* The bar of the row selected in a section's Chord/Inst/Click list, or -1
 * (the section row, "+ Add"). */
function listCursorBar(sec) {
    if (!sec) return -1;
    if (builderTrack === TRACK_CHORD) {
        const e = sectionChordEvents(sec)[chordListCursor];
        return e ? e.bar : -1;
    }
    if (isItemTrack(builderTrack)) {
        const it = sortItems(sectionItems(sec, builderTrack))[itemListCursor];
        return it ? it.bar : -1;
    }
    return -1;
}

/* Keep the step-LED cursor (chordCursorBar/Idx) on the selected chord. */
function syncChordCursorBar(sec) {
    const evs = sectionChordEvents(sec);
    const e = evs[chordListCursor];
    if (e) {
        chordCursorBar = e.bar;
        chordCursorIdx = e.idx;
        if (e.bar < stepScrollOffset) stepScrollOffset = e.bar;
        else if (e.bar >= stepScrollOffset + NUM_STEPS) stepScrollOffset = e.bar - NUM_STEPS + 1;
    } else {
        chordCursorBar = -1;
    }
    stepLedsDirty = true;
}

/* Draw the chord track the way the Drum track is drawn: the section row,
 * then the section's chords in order, each with where it starts (it holds
 * until the next), then "+ Add". */
function drawChordTrack() {
    /* The real song/section while a play-from build is pending (viewSong). */
    const secIndex = builderPlayingFromTemp ? viewSectionIndex() : chordDisplaySectionIndex();
    const sec = viewSong() ? viewSong().sections[secIndex] : null;
    const key = currentSong ? (currentSong.key || DEFAULT_KEY) : DEFAULT_KEY;
    drawMenuHeader(fitHeader("Chords: " + (currentSong ? shortSongName(currentSong.name) : ""), keyLabel(key)), keyLabel(key));
    if (!sec) {
        print(2, LIST_TOP_Y, "No section.", 1);
        drawOverlay();
        return;
    }
    const evs = sectionChordEvents(sec);
    if (chordListCursor > evs.length) chordListCursor = evs.length;
    const items = [{ type: "section" }];
    for (const e of evs) items.push({ type: "chord", ev: e });
    items.push({ type: "add" });
    drawMenuList({
        ...LIST_ROW_FIT,
        labelX: 3,
        items,
        selectedIndex: chordListCursor + 1,
        getLabel: (item) => {
            if (item.type === "section") return sec.name || "Section";
            if (item.type === "chord") return chordLabel(item.ev.chord, key);
            return "+ Add";
        },
        getValue: (item) => {
            if (item.type === "section") return sectionCountLabel(secIndex);
            if (item.type === "chord") return chordPosLabel(item.ev.bar, item.ev.beat);
            return "";
        },
        valueAlignRight: true,
        /* Room between a long name (or its "...") and the value, so the
         * two don't read as one string. */
        labelGap: LIST_LABEL_GAP,
        listArea: { topY: LIST_TOP_Y, bottomY: LIST_INDICATOR_BOTTOM_Y }
    });
    drawOverlay();
}

/* Chord track list: jog moves the selection, Shift+jog nudges the selected
 * chord a beat (half in Advanced) -- across bars and past other chords
 * (onto the next free beat), stopping at the section's ends. */
function chordListJog(delta) {
    const secIndex = chordDisplaySectionIndex();
    const sec = currentSong ? currentSong.sections[secIndex] : null;
    if (!sec) return;
    const n = sectionChordEvents(sec).length;
    chordListCursor = Math.max(-1, Math.min(n, chordListCursor + delta));
    syncChordCursorBar(sec);
    needsRedraw = true;
}

/* Move a position (beats from the section start) by `delta` steps, each
 * step landing on the next free position in that direction -- so it passes
 * over taken ones -- and stopping at the section's ends (0, end - step). */
function nudgePosition(pos, delta, step, end, taken) {
    const dir = Math.sign(delta);
    for (let n = Math.abs(delta); n > 0; n--) {
        let p = pos + dir * step;
        while (p >= 0 && p <= end - step && taken.has(p)) p += dir * step;
        if (p < 0 || p > end - step) break;
        pos = p;
    }
    return pos;
}

/* When no bar after the last chord/item is free, "+ Add" shares the last
 * one's bar: halfway through what's left of it (beat 1 -> 3 -> 4 in 4/4),
 * shortening it, until the bar has no beat left. `free` is the bar's free
 * beats. Returns the beat, or null. */
function splitBeatAfter(lastBeat, free, adv) {
    const step = adv ? 0.5 : 1;
    const after = free.filter(b => b > lastBeat);
    if (!after.length) return null;
    const mid = lastBeat + Math.max(step, Math.floor((beatsPerBar() + 1 - lastBeat) / 2 / step) * step);
    return after.includes(mid) ? mid : after[0];
}

function chordListNudge(delta) {
    const secIndex = chordDisplaySectionIndex();
    const sec = currentSong ? currentSong.sections[secIndex] : null;
    if (!sec) return;
    const evs = sectionChordEvents(sec);
    const e = evs[chordListCursor];
    if (!e || delta === 0) return;
    const bpb = beatsPerBar();
    const total = sectionChordBars(sec);
    const taken = new Set(evs.filter(x => x !== e).map(x => x.bar * bpb + (x.beat - 1)));
    const pos = nudgePosition(e.bar * bpb + (e.beat - 1), delta, e.chord.adv ? 0.5 : 1, total * bpb, taken);
    const bar = Math.floor(pos / bpb), beat = pos - bar * bpb + 1;
    if (bar === e.bar && beat === e.beat) return;
    removeChordEvent(sec, e.bar, e.idx);
    const moved = Object.assign({}, e.chord);
    delete moved.beat;
    if (beat !== 1) moved.beat = beat;
    insertChordEvent(sec, bar, moved);
    selectChordListAt(sec, bar, beat);
    needsRedraw = true;
}

/* The first free position after the selected chord (or the section's last
 * chord, from the "+ Add" row): the next bar's same beat, else that bar's
 * first free beat, scanning on. Null if the section is full from there. */
function nextFreeChordPos(sec, fromBar, beat) {
    const total = sectionChordBars(sec);
    for (let bar = fromBar + 1; bar < total; bar++) {
        const free = freeBeatsInBar(sec, bar, false, -1, -1);
        if (free.includes(beat)) return { bar, beat };
        if (free.length) return { bar, beat: free[0] };
    }
    return null;
}

/* Jog click: the section row renames, a chord opens its settings, "+ Add"
 * adds a chord after the last one (the next bar) and opens it. */
function chordListClick() {
    const secIndex = chordDisplaySectionIndex();
    const sec = currentSong ? currentSong.sections[secIndex] : null;
    if (!sec) return;
    const evs = sectionChordEvents(sec);
    /* A locked song's chords are read-only, as its clips are. */
    if (songIsLocked()) { lockedNotice(); return; }
    if (chordListCursor < 0) {
        renameSectionPrompt(sec);
        return;
    }
    const e = evs[chordListCursor];
    if (e) {
        openChordPick(e.bar, e.idx);
        return;
    }
    const pos = chordAppendPos(sec);
    if (!pos) {
        showPopup("Chords", "No free beat after the last chord", 2000);
        return;
    }
    openChordPick(pos.bar, -1, true, pos.beat);
}

/* Delete: remove the selected chord. */
function chordListDelete() {
    const secIndex = chordDisplaySectionIndex();
    const sec = currentSong ? currentSong.sections[secIndex] : null;
    if (!sec) return;
    const e = sectionChordEvents(sec)[chordListCursor];
    if (!e) return;
    removeChordEvent(sec, e.bar, e.idx);
    chordListCursor = Math.min(chordListCursor, sectionChordEvents(sec).length);
    syncChordCursorBar(sec);
    needsRedraw = true;
}

/* Where "+ Add" or Copy puts a new chord: the bar after the section's last
 * chord, else sharing that last bar (see splitBeatAfter), else null. */
function chordAppendPos(sec) {
    const evs = sectionChordEvents(sec);
    const last = evs[evs.length - 1];
    if (!last) return { bar: 0, beat: 1 };
    let pos = nextFreeChordPos(sec, last.bar, 1);
    if (!pos) {
        const adv = !!last.chord.adv;
        const beat = splitBeatAfter(last.beat, freeBeatsInBar(sec, last.bar, adv, -1, -1), adv);
        if (beat !== null) pos = { bar: last.bar, beat };
    }
    return pos;
}

/* Copy: duplicate the selected chord after the section's last chord, as
 * "+ Add" would add one. */
function chordListDuplicate() {
    const secIndex = chordDisplaySectionIndex();
    const sec = currentSong ? currentSong.sections[secIndex] : null;
    if (!sec) return;
    const e = sectionChordEvents(sec)[chordListCursor];
    if (!e) return;
    const pos = chordAppendPos(sec);
    if (!pos) {
        showPopup("Chords", "No free beat after the last chord", 2000);
        return;
    }
    const copy = Object.assign({}, e.chord);
    delete copy.beat;
    if (pos.beat !== 1) copy.beat = pos.beat;
    insertChordEvent(sec, pos.bar, copy);
    selectChordListAt(sec, pos.bar, pos.beat);
    needsRedraw = true;
}

/* Every chord of a section in play order: {bar, idx, beat, chord}. */
function sectionChordEvents(sec) {
    const out = [];
    const total = sectionChordBars(sec);
    for (let b = 0; b < total; b++) {
        barChords(sec, b).forEach((c, i) => out.push({ bar: b, idx: i, beat: chordBeat(c), chord: c }));
    }
    return out;
}

/* Handle a step-button press on the Chord, Inst or Click track. The step
 * buttons map to the section's bars (with the same scroll window as the drum
 * track); the list is the editor, so a step just selects that bar's first
 * chord or item in it. */
function handleStepPress(stepIndex, velocity) {
    if (velocity === 0) return;
    if (currentView !== VIEW_BUILDER && currentView !== VIEW_CHORD_PICK && currentView !== VIEW_INSTRUMENT_BAR) return;
    if (builderTrack === TRACK_DRUM) return;
    const secIndex = chordDisplaySectionIndex();
    const sec = currentSong ? currentSong.sections[secIndex] : null;
    if (!sec) return;
    const totalBars = sectionChordBars(sec);
    const barIndex = stepScrollOffset + stepIndex;
    if (barIndex < 0 || barIndex >= totalBars) return;
    /* A pad selected: the step adds it to the bar, or takes it out. */
    if (currentView === VIEW_BUILDER && harmonyStepPress(builderTrack, sec, barIndex)) return;
    if (builderTrack === TRACK_CHORD) {
        /* The list is the editor; a step selects that bar's first chord. */
        if (currentView !== VIEW_BUILDER) return;
        const i = sectionChordEvents(sec).findIndex(e => e.bar === barIndex);
        if (i >= 0) {
            chordListCursor = i;
            syncChordCursorBar(sec);
            needsRedraw = true;
        }
        return;
    }
    if (isItemTrack(builderTrack)) {
        if (currentView === VIEW_BUILDER) itemListSelectBar(barIndex);
    }
}

/* ── Chord picker ───────────────────────────────────────────────────── */

/* The chord settings page edits one chord of the section: the one the
 * Chord track list has selected (chordListCursor), or a new one from its
 * "+ Add" row. Root/Type/Bass are the chord; Bar/Beat where it starts (it
 * holds until the next chord); Advanced allows half-beat starts. */

/* Map a chord to the scale degree + quality + bass index being edited. */
function loadPickFields(chord) {
    const key = currentSong ? (currentSong.key || DEFAULT_KEY) : DEFAULT_KEY;
    chordPickBeat = chordBeat(chord);
    chordPickAdv = !!(chord && chord.adv);
    chordPickDirty = false;
    if (chord && chord.none) {
        chordPickRoot = CHORD_ROOT_NONE;
        chordPickQuality = 0;
        chordPickBass = -1;
        return;
    }
    if (chord && chord.root) {
        const keyPc = noteSemitone(key);
        const rootPc = noteSemitone(chord.root);
        chordPickRoot = keyPc >= 0 && rootPc >= 0 ? ((rootPc - keyPc) % 12 + 12) % 12 : 0;
        const qIdx = CHORD_QUALITIES.indexOf(chord.quality);
        chordPickQuality = qIdx >= 0 ? qIdx : 0;
        /* By pitch, so a bass spelled with a flat (Bb) is found too. */
        const bassPc = chord.bass ? noteSemitone(chord.bass) : -1;
        chordPickBass = bassPc >= 0 && keyPc >= 0 ? ((bassPc - keyPc) % 12 + 12) % 12 : -1;
    } else {
        /* Default to the key's base note (the "I" chord/tonic). */
        chordPickRoot = 0;
        chordPickQuality = CHORD_QUALITIES.indexOf(chordRootDefaultQuality(0));
        chordPickBass = -1;
    }
}

/* The chord currently selected in the picker (without its position). */
function chordPickChord() {
    if (chordPickRoot === CHORD_ROOT_NONE) return { none: true };
    const key = currentSong ? (currentSong.key || DEFAULT_KEY) : DEFAULT_KEY;
    const chord = { root: chordRootName(key, chordPickRoot), quality: CHORD_QUALITIES[chordPickQuality] };
    if (chordPickBass >= 0) chord.bass = bassNotesForKey(key)[chordPickBass];
    return chord;
}

/* The chord as it will be saved. One the user didn't edit keeps its original
 * object (only its position can have changed), so opening the page never
 * rewrites a chord -- e.g. one whose root isn't in the key, which the degree
 * fields can't express. */
function pickResult() {
    const base = (chordPickDirty || !chordPickOrig) ? chordPickChord() : Object.assign({}, chordPickOrig);
    delete base.beat;
    delete base.adv;
    if (chordPickBeat !== 1) base.beat = chordPickBeat;
    if (chordPickAdv) base.adv = true;
    return base;
}

function beatsPerBar() {
    return (currentSong && currentSong.time_sig_num > 0) ? currentSong.time_sig_num : 4;
}

/* Whether a bar/beat is free of other chords (ignoring the one being
 * edited, at chordPickOrigBar/Idx). */
function chordPosFree(sec, bar, beat, ignoreBar, ignoreIdx) {
    return !barChords(sec, bar).some((c, i) => !(bar === ignoreBar && i === ignoreIdx) && chordBeat(c) === beat);
}

/* Beats a chord can start on in a bar: whole beats, halves in Advanced,
 * minus those other chords use. */
function freeBeatsInBar(sec, bar, adv, ignoreBar, ignoreIdx) {
    const out = [];
    /* Whole beats, or with Advanced every half -- up to the "and" of the
     * last beat (4& in 4/4). */
    for (let b = 1; b < beatsPerBar() + 1; b += adv ? 0.5 : 1) {
        if (chordPosFree(sec, bar, b, ignoreBar, ignoreIdx)) out.push(b);
    }
    return out;
}

/* Remove / insert one chord of a section's chord list. */
function removeChordEvent(sec, bar, idx) {
    const list = barChords(sec, bar);
    list.splice(idx, 1);
    setBarChords(sec, bar, list);
}
function insertChordEvent(sec, bar, chord) {
    const list = barChords(sec, bar);
    list.push(chord);
    setBarChords(sec, bar, list);
    /* Its index once sorted by beat. */
    return barChords(sec, bar).findIndex(c => c === chord || (chordBeat(c) === chordBeat(chord)));
}

/* Open the settings page for chord `idx` of `bar` (the list's selection), or
 * for a new chord at bar/beat when `isNew`. */
function openChordPick(barIndex, idx, isNew, newBeat) {
    const secIndex = builderPlayingFromTemp ? viewSectionIndex() : chordDisplaySectionIndex();
    const song = viewSong();
    const sec = song ? song.sections[secIndex] : null;
    if (!sec) return;
    chordPickSong = song;
    chordPickSecIdx = secIndex;
    chordPickBar = barIndex;
    if (isNew) {
        chordPickOrig = null;
        chordPickOrigBar = -1;
        chordPickOrigIdx = -1;
        loadPickFields(null);
        chordPickBeat = newBeat || 1;
        chordPickDirty = true;
        chordPickFocus = 0;
        chordPickEditing = true; /* straight into choosing the root */
    } else {
        const list = barChords(sec, barIndex);
        const i = Math.max(0, Math.min(list.length - 1, idx || 0));
        chordPickOrig = list[i] || null;
        chordPickOrigBar = barIndex;
        chordPickOrigIdx = i;
        loadPickFields(chordPickOrig);
        chordPickFocus = 0;
        chordPickEditing = false;
    }
    chordPickHasChord = true;
    if (currentView !== VIEW_CHORD_PICK) {
        currentView = VIEW_CHORD_PICK;
        menuStack.push({ title: "Chord", selectedIndex: 0 });
    }
    needsRedraw = true;
}

/* The section the chord page edits (see chordPickSong). */
function chordPickSection() {
    return chordPickSong ? chordPickSong.sections[chordPickSecIdx] || null : null;
}

/* Save the page's chord: take the original out, put the result in at its
 * (possibly new) position, and select it in the list. */
function commitChordPick() {
    const sec = chordPickSection();
    if (!sec || !chordPickHasChord) return;
    if (chordPickOrigBar >= 0) removeChordEvent(sec, chordPickOrigBar, chordPickOrigIdx);
    const chord = pickResult();
    insertChordEvent(sec, chordPickBar, chord);
    selectChordListAt(sec, chordPickBar, chordBeat(chord));
}

/* Leave the page for Song Builder. */
function closeChordPick() {
    menuStack.pop();
    currentView = VIEW_BUILDER;
    stepLedsDirty = true;
    needsRedraw = true;
}

function formatBeat(b) {
    return Number.isInteger(b) ? String(b) : (Math.floor(b) + "&");
}

function chordPickItems() {
    const key = currentSong ? (currentSong.key || DEFAULT_KEY) : DEFAULT_KEY;
    const noChord = chordPickRoot === CHORD_ROOT_NONE;
    return [
        { key: "root", label: "Root", value: noChord ? "No Chord"
            : CHORD_ROOT_DEGREES[chordPickRoot] + " (" + chordRootName(key, chordPickRoot) + ")" },
        { key: "type", label: "Type", value: noChord ? "—" : (CHORD_TYPE_LABEL[CHORD_QUALITIES[chordPickQuality]] || "Major") },
        { key: "bass", label: "Bass", value: !noChord && chordPickBass >= 0 ? bassNotesForKey(key)[chordPickBass] : "—" },
        { key: "bar", label: "Bar", value: String(chordPickBar + 1) },
        { key: "beat", label: "Beat", value: formatBeat(chordPickBeat) },
        { key: "adv", label: "Advanced", value: chordPickAdv ? "On" : "Off" },
        { key: "delete", label: "Delete Chord", value: "" }
    ];
}

/* The chord being made ("= Cm7 1.1") sits in the list's last row, so the
 * list shows four rows and the footer keeps its band. It is printed (not
 * drawn in the header's face) because that face has capitals only: Cm7 would
 * read as CM7. */
const CHORD_PICK_LINE_Y = LIST_TOP_Y + 4 * 9;

function drawChordPick() {
    const key = currentSong ? (currentSong.key || DEFAULT_KEY) : DEFAULT_KEY;
    drawMenuHeader("Chord", keyLabel(key));
    const items = chordPickItems();
    if (chordPickFocus >= items.length) chordPickFocus = items.length - 1;
    drawMenuList({
        ...LIST_ROW_FIT,
        labelX: 3,
        items,
        selectedIndex: chordPickFocus,
        getLabel: (item) => item.label,
        getValue: (item) => item.value,
        valueAlignRight: true,
        editMode: chordPickEditing,
        labelGap: 2,
        prioritizeSelectedValue: true,
        /* Four rows exactly fill the space above the chord line, but the
         * list's own count (the area's height over a row's, rounded down)
         * came to three, leaving a blank row. */
        maxVisible: 4,
        listArea: { topY: LIST_TOP_Y, bottomY: CHORD_PICK_LINE_Y - 1 }
    });
    print(2, CHORD_PICK_LINE_Y, "= " + chordLabel(pickResult(), key) + " " + chordPosLabel(chordPickBar, chordPickBeat), 1);
}

function handleChordPickInput(cc, value) {
    const items = chordPickItems();
    const item = items[Math.max(0, Math.min(items.length - 1, chordPickFocus))];
    const sec = chordPickSection();
    if (cc === MoveMainKnob) {
        const delta = decodeDelta(value);
        if (chordPickEditing && sec) {
            const noChord = chordPickRoot === CHORD_ROOT_NONE;
            if (item.key === "root") {
                /* Every root by semitone, then No Chord. Changing the root
                 * re-picks the default type for it (the key's own chord's,
                 * else major) and drops any slash bass. */
                chordPickRoot = ((chordPickRoot + delta) % 13 + 13) % 13;
                chordPickQuality = chordPickRoot === CHORD_ROOT_NONE ? 0
                    : CHORD_QUALITIES.indexOf(chordRootDefaultQuality(chordPickRoot));
                chordPickBass = -1;
                chordPickDirty = true;
            } else if (noChord && (item.key === "type" || item.key === "bass")) {
                /* No Chord has no type or bass. */
            } else if (item.key === "type") {
                chordPickQuality = Math.max(0, Math.min(CHORD_QUALITIES.length - 1, chordPickQuality + delta));
                chordPickDirty = true;
            } else if (item.key === "bass") {
                chordPickBass = Math.max(-1, Math.min(11, chordPickBass + delta));
                chordPickDirty = true;
            } else if (item.key === "bar") {
                /* Step to the next bar with room, keeping the beat if it is
                 * free there, else the bar's nearest free beat. */
                const total = sectionChordBars(sec);
                let bar = chordPickBar;
                for (let n = 0; n < total; n++) {
                    bar += Math.sign(delta);
                    if (bar < 0 || bar >= total) { bar = chordPickBar; break; }
                    const free = freeBeatsInBar(sec, bar, chordPickAdv, chordPickOrigBar, chordPickOrigIdx);
                    if (free.length) {
                        if (!free.includes(chordPickBeat)) {
                            chordPickBeat = free.reduce((a, b) => Math.abs(b - chordPickBeat) < Math.abs(a - chordPickBeat) ? b : a);
                        }
                        break;
                    }
                }
                chordPickBar = bar;
            } else if (item.key === "beat") {
                const opts = freeBeatsInBar(sec, chordPickBar, chordPickAdv, chordPickOrigBar, chordPickOrigIdx);
                let i = opts.indexOf(chordPickBeat);
                if (i < 0) i = 0;
                if (opts.length) chordPickBeat = opts[Math.max(0, Math.min(opts.length - 1, i + delta))];
            }
        } else {
            chordPickFocus = Math.max(0, Math.min(items.length - 1, chordPickFocus + delta));
        }
        needsRedraw = true;
    } else if (cc === MoveMainButton && value > 0) {
        if (item.key === "adv") {
            chordPickAdv = !chordPickAdv;
            /* Off: back onto a whole beat (the nearest free one). */
            if (!chordPickAdv && sec && !Number.isInteger(chordPickBeat)) {
                const free = freeBeatsInBar(sec, chordPickBar, false, chordPickOrigBar, chordPickOrigIdx);
                if (free.length) chordPickBeat = free.reduce((a, b) => Math.abs(b - chordPickBeat) < Math.abs(a - chordPickBeat) ? b : a);
                else chordPickAdv = true; /* nowhere to go: stays Advanced */
            }
            needsRedraw = true;
            return;
        }
        if (item.key === "delete") {
            if (sec && chordPickOrigBar >= 0) removeChordEvent(sec, chordPickOrigBar, chordPickOrigIdx);
            chordPickHasChord = false;
            closeChordPick();
            return;
        }
        chordPickEditing = !chordPickEditing;
        needsRedraw = true;
    } else if (cc === MoveBack && value > 0) {
        if (chordPickEditing) {
            chordPickEditing = false;
            needsRedraw = true;
        } else {
            commitChordPick();
            closeChordPick();
        }
    }
}

/* ── Instrument track menu ──────────────────────────────────────────── */

function openInstrumentMenu(track) {
    instrumentEditTrack = track;
    instrumentFocus = 0;
    instrumentEditing = false;
    currentView = VIEW_INSTRUMENT;
    menuStack.push({ title: INST_TRACK_NAMES[instIndex(track)] || "Inst", selectedIndex: 0 });
    needsRedraw = true;
}

/* The settings Pads have: a chord on the chord grid, so no Voicing,
 * Follow Note, Pattern, Approach or Vel Follow. */
const PADS_ROW_KEYS = ["enabled", "octave", "inversion", "strum", "strum_dir", "gap", "velocity", "chance",
    "bar", "beat", "mute", "adv", "delete"];
function padsRowsOnly(track, rows) {
    return track === TRACK_PADS ? rows.filter(r => PADS_ROW_KEYS.includes(r.key)) : rows;
}

/* Instrument Settings: the rows that apply to the track's voicing. */
function instrumentRows(inst, track) {
    return padsRowsOnly(track, instrumentRowsFor(inst));
}

function instrumentRowsFor(inst) {
    const voicing = inst ? inst.voicing : "bass";
    return [
        { key: "enabled", label: "Enabled", value: inst && inst.enabled ? "On" : "Off" },
        { key: "octave", label: "Octave", value: String(inst ? inst.octave : 3) },
        { key: "follow", label: "Follow Note", value: inst && inst.follow_note > 0 ? String(inst.follow_note) : "Off" },
        { key: "voicing", label: "Voicing", value: voicingLabel(voicing) },
        ...instVarietyRows(voicing, "pattern", () => patternLabel(voicing, instVariety(inst).pattern)),
        ...arpRateRows(voicing, inst ? inst.follow_note : 0, () => ARP_RATE_LABELS[instVariety(inst).arp_rate]),
        ...instVarietyRows(voicing, "arp_range", () => arpRangeLabel(instVariety(inst).arp_range)),
        ...instVarietyRows(voicing, "arp_vel", () => arpVelLabel(instVariety(inst).arp_vel)),
        ...(voicing !== "bass" ? [{ key: "inversion", label: "Inversion", value: inversionLabel(inst ? inst.inversion : 0) }] : []),
        ...instVarietyRows(voicing, "approach", () => APPROACH_LABELS[instVariety(inst).approach]),
        ...instVarietyRows(voicing, "strum", () => strumLabel(instVariety(inst).strum)),
        ...instVarietyRows(voicing, "strum_dir", () => STRUM_DIR_LABELS[instVariety(inst).strum_dir]),
        { key: "gap", label: "Note Gap", value: noteGapLabel(inst ? inst.note_gap : 0.25) },
        { key: "velocity", label: "Velocity", value: String(instrumentVelocity(inst)) },
        { key: "vel_follow", label: "Vel Follow", value: instVariety(inst).vel_follow ? "On" : "Off" },
        { key: "chance", label: "Chance", value: chanceLabel(instVariety(inst).chance) }
    ];
}

function drawInstrument() {
    const inst = instrumentForTrack(instrumentEditTrack);
    drawMenuHeader(INST_TRACK_NAMES[instIndex(instrumentEditTrack)] || "Inst", inst && inst.enabled ? "ON" : "OFF");
    const items = instrumentRows(inst, instrumentEditTrack);
    if (instrumentFocus >= items.length) instrumentFocus = items.length - 1;
    drawMenuList({
        ...LIST_ROW_FIT,
        labelX: 3,
        items,
        selectedIndex: instrumentFocus,
        getLabel: (item) => item.label,
        getValue: (item) => item.value,
        valueAlignRight: true,
        editMode: instrumentEditing,
        labelGap: 2,
        prioritizeSelectedValue: true,
        selectedMinLabelChars: 6,
        listArea: { topY: LIST_TOP_Y, bottomY: LIST_INDICATOR_BOTTOM_Y }
    });
}

function handleInstrumentInput(cc, value) {
    const inst = instrumentForTrack(instrumentEditTrack);
    if (!inst) return;
    const rows = instrumentRows(inst, instrumentEditTrack);
    const row = rows[Math.max(0, Math.min(rows.length - 1, instrumentFocus))];
    if (cc === MoveMainKnob) {
        const delta = decodeDelta(value);
        if (instrumentEditing) {
            if (row.key === "enabled") inst.enabled = !inst.enabled;
            else stepInstrumentField(inst, row.key, delta);
            unsavedChanges = true;
            markInstrumentLive(instrumentEditTrack);
        } else {
            instrumentFocus = Math.max(0, Math.min(rows.length - 1, instrumentFocus + delta));
        }
        needsRedraw = true;
    } else if (cc === MoveMainButton && value > 0) {
        if (row.key === "enabled") {
            inst.enabled = !inst.enabled;
            unsavedChanges = true;
            markInstrumentLive(instrumentEditTrack);
        } else if (row.key === "vel_follow") {
            inst.vel_follow = !instVariety(inst).vel_follow;
            unsavedChanges = true;
            markInstrumentLive(instrumentEditTrack);
        } else {
            instrumentEditing = !instrumentEditing;
        }
        needsRedraw = true;
    } else if (cc === MoveBack && value > 0) {
        if (instrumentEditing) {
            instrumentEditing = false;
            needsRedraw = true;
        } else {
            menuStack.pop();
            currentView = VIEW_BUILDER;
            needsRedraw = true;
        }
    }
}

/* Turn one Instrument Settings field (not Enabled) by `delta` -- Song
 * Builder's tracks and Jam's instruments edit the same settings this way. */
function stepInstrumentField(inst, key, delta) {
    if (key === "octave") {
        inst.octave = Math.max(-1, Math.min(8, (typeof inst.octave === "number" ? inst.octave : 3) + delta));
    } else if (key === "follow") {
        inst.follow_note = stepFollowNote(inst.follow_note, delta, inst.voicing === "bass" || !inst.voicing);
    } else if (key === "voicing") {
        inst.voicing = stepVoicing(inst.voicing || "bass", delta);
    } else if (key === "inversion") {
        /* Inversion: root/1st/2nd/3rd/Auto. Clamped per-chord (a triad
         * has no 3rd inversion) on the DSP side; the menu just offers
         * all four so a 7th/maj7/m7/dim7 chord can use the 3rd. */
        inst.inversion = Math.max(0, Math.min(INVERSION_AUTO, (inst.inversion || 0) + delta));
    } else if (key === "gap") {
        /* Note gap: 0 = none, then 1/16, 1/8, 1/4, 1/2, 1 beat. */
        const steps = [0, 0.0625, 0.125, 0.25, 0.5, 1.0];
        const cur = (typeof inst.note_gap === "number") ? inst.note_gap : 0.25;
        const idx = steps.indexOf(cur);
        const newIdx = Math.max(0, Math.min(steps.length - 1, (idx < 0 ? 3 : idx) + delta));
        inst.note_gap = steps[newIdx];
    } else if (key === "velocity") {
        /* Note-on velocity, 1-127. */
        inst.velocity = Math.max(1, Math.min(127, instrumentVelocity(inst) + delta));
    } else {
        stepInstVariety(inst, key, delta);
    }
}

/* ── Instrument per-bar override menu ───────────────────────────────── */

/* Follow Note, turned by `delta` from `cur` (0 = Off). With Bass voicing,
 * turning up from Off jumps straight to 36 -- the kick -- which is what a
 * bass line nearly always follows, instead of 36 detents through notes no
 * drum kit uses. Down from there steps normally (35 is a kick too). */
export function stepFollowNote(cur, delta, bass) {
    const v = typeof cur === "number" ? cur : 0;
    if (bass && v === 0 && delta > 0) return Math.min(127, 36 + delta - 1);
    return Math.max(0, Math.min(127, v + delta));
}

/* Cycle an "optional integer" field (Octave, Follow Note) between an
 * explicit value in [min, max] and null ("Default"), which sits one step
 * below `min`. */
export function cycleOptionalInt(cur, delta, min, max) {
    let v = (cur === null || cur === undefined) ? (min - 1) : cur;
    v = Math.max(min - 1, Math.min(max, v + delta));
    return v < min ? null : v;
}

/* ── Inst/Click track items ─────────────────────────────────────────── */

/* The Inst 1/2 and Click tracks are edited like the Drum track: a list of
 * the section's items (see sectionItems), each starting at a bar/beat and
 * holding until the next. The list's selection: -1 = the section row,
 * 0..n-1 = items, n = "+ Add". */
let itemListCursor = 0;
/* The item settings page (VIEW_INSTRUMENT_BAR): which track/section, the
 * item being edited (null for a new one) and a working copy of it. */
let itemEditTrack = -1;
let itemEditSec = -1;
let itemEditSong = null;          /* the song it edits -- see chordPickSong */
let itemEditOrig = null;
let itemWork = null;
let itemFocus = 0;
let itemEditing = false;

function itemTrackName(track) {
    return track === TRACK_CLICK ? "Click" : (INST_TRACK_NAMES[instIndex(track)] || "Inst");
}

function isItemTrack(track) {
    return isInstTrack(track) || track === TRACK_CLICK;
}

/* A short summary of an item for its list row. */
function itemLabel(track, it) {
    if (track === TRACK_CLICK) return "Volume " + (typeof it.volume === "number" ? it.volume : 100) + "%";
    if (it.mute) return "Mute";
    const parts = [];
    if (typeof it.octave === "number") parts.push("Oct " + it.octave);
    if (typeof it.follow_note === "number") parts.push(it.follow_note > 0 ? "Fol " + it.follow_note : "Fol Off");
    if (it.voicing) parts.push(voicingLabel(it.voicing));
    if (typeof it.pattern === "number") {
        const inst = instrumentForTrack(track);
        parts.push(patternLabel(it.voicing || (inst ? inst.voicing : "bass"), it.pattern));
    }
    if (typeof it.arp_rate === "number") parts.push(ARP_RATE_LABELS[it.arp_rate] || "");
    if (typeof it.arp_range === "number") parts.push(arpRangeLabel(it.arp_range));
    if (typeof it.arp_vel === "number") parts.push("VelRng " + arpVelLabel(it.arp_vel));
    if (typeof it.inversion === "number") parts.push(inversionLabel(it.inversion));
    if (typeof it.approach === "number") parts.push("Appr " + APPROACH_LABELS[it.approach]);
    if (typeof it.strum === "number") parts.push("Strum " + strumLabel(it.strum));
    if (typeof it.strum_dir === "number") parts.push("Strum " + STRUM_DIR_LABELS[it.strum_dir]);
    if (typeof it.note_gap === "number") parts.push("Gap " + noteGapLabel(it.note_gap));
    if (typeof it.velocity === "number") parts.push("Vel " + it.velocity);
    if (typeof it.vel_follow === "boolean") parts.push(it.vel_follow ? "VelFol" : "VelFol Off");
    if (typeof it.chance === "number") parts.push(it.chance + "%");
    return parts.length ? parts.join(" ") : "Defaults";
}

/* Whether a bar/beat is free of the list's other items. */
function itemPosFree(list, bar, beat, ignore) {
    return !list.some(it => it !== ignore && it.bar === bar && chordBeat(it) === beat);
}

function freeItemBeats(list, bar, adv, ignore) {
    const out = [];
    /* Whole beats, or with Advanced every half -- up to the "and" of the
     * last beat (4& in 4/4). */
    for (let b = 1; b < beatsPerBar() + 1; b += adv ? 0.5 : 1) {
        if (itemPosFree(list, bar, b, ignore)) out.push(b);
    }
    return out;
}

/* The section's item state at the start of a bar: its latest item at or
 * before it (or null: the defaults). */
function itemAtBarStart(list, bar) {
    let last = null;
    for (const it of list) if (it.bar < bar || (it.bar === bar && chordBeat(it) === 1)) last = it;
    return last;
}

/* Whether the song has a chord anywhere: the Inst and Click tracks' items
 * play against the chords, so "+ Add" needs one. */
export function songHasChords(song) {
    if (!song || !Array.isArray(song.sections)) return false;
    return song.sections.some(sec => sec && Array.isArray(sec.chords) &&
        sec.chords.some((e, bar) => e && barChords(sec, bar).some(c => c && !c.none)));
}

function itemAddAvailable() {
    return songHasChords(viewSong() || currentSong);
}

function itemTrackSection() {
    const secIndex = chordDisplaySectionIndex();
    return { secIndex, sec: currentSong ? currentSong.sections[secIndex] : null };
}

/* Keep the step-LED cursor (chordCursorBar) on the selected item. */
function syncItemCursorBar(list) {
    const it = list[itemListCursor];
    chordCursorBar = it ? it.bar : -1;
    if (it) {
        if (it.bar < stepScrollOffset) stepScrollOffset = it.bar;
        else if (it.bar >= stepScrollOffset + NUM_STEPS) stepScrollOffset = it.bar - NUM_STEPS + 1;
    }
    stepLedsDirty = true;
}

function drawItemTrack() {
    const { secIndex, sec } = builderPlayingFromTemp
        ? { secIndex: viewSectionIndex(), sec: viewSong() ? viewSong().sections[viewSectionIndex()] : null }
        : itemTrackSection();
    const track = builderTrack;
    let right;
    if (track === TRACK_CLICK) right = clickOn ? "ON" : "OFF";
    else { const inst = instrumentForTrack(track); right = inst && inst.enabled ? "ON" : "OFF"; }
    drawMenuHeader(fitHeader(itemTrackName(track) + ": " + (currentSong ? shortSongName(currentSong.name) : ""), right), right);
    if (!sec) {
        print(2, LIST_TOP_Y, "No section.", 1);
        drawOverlay();
        return;
    }
    const list = sortItems(sectionItems(sec, track));
    if (itemListCursor > list.length) itemListCursor = list.length;
    const items = [{ type: "section" }];
    for (const it of list) items.push({ type: "item", it });
    items.push({ type: itemAddAvailable() ? "add" : "nochords" });
    drawMenuList({
        ...LIST_ROW_FIT,
        labelX: 3,
        items,
        selectedIndex: itemListCursor + 1,
        getLabel: (row) => {
            if (row.type === "section") return sec.name || "Section";
            if (row.type === "item") return itemLabel(track, row.it);
            /* Nothing to play an item against yet: say why instead. */
            if (row.type === "nochords") return "(add chords first)";
            return "+ Add";
        },
        getValue: (row) => {
            if (row.type === "section") return sectionCountLabel(secIndex);
            if (row.type === "item") return chordPosLabel(row.it.bar, chordBeat(row.it));
            return "";
        },
        valueAlignRight: true,
        /* Room between a long name (or its "...") and the value, so the
         * two don't read as one string. */
        labelGap: LIST_LABEL_GAP,
        listArea: { topY: LIST_TOP_Y, bottomY: LIST_INDICATOR_BOTTOM_Y }
    });
    drawOverlay();
}

function itemListJog(delta) {
    const { sec } = itemTrackSection();
    if (!sec) return;
    const list = sortItems(sectionItems(sec, builderTrack));
    itemListCursor = Math.max(-1, Math.min(list.length, itemListCursor + delta));
    syncItemCursorBar(list);
    needsRedraw = true;
}

/* Shift+jog: move the selected item a beat (half in Advanced), past other
 * items onto the next free beat, stopping at the section's ends. */
function itemListNudge(delta) {
    const { sec } = itemTrackSection();
    if (!sec || delta === 0) return;
    const list = sortItems(sectionItems(sec, builderTrack));
    const it = list[itemListCursor];
    if (!it) return;
    const bpb = beatsPerBar();
    const total = sectionChordBars(sec);
    const posOf = (x) => x.bar * bpb + (chordBeat(x) - 1);
    const taken = new Set(list.filter(x => x !== it).map(posOf));
    const pos = nudgePosition(posOf(it), delta, it.adv ? 0.5 : 1, total * bpb, taken);
    const bar = Math.floor(pos / bpb), beat = pos - bar * bpb + 1;
    it.bar = bar;
    if (beat !== 1) it.beat = beat; else delete it.beat;
    sortItems(list);
    itemListCursor = list.indexOf(it);
    syncItemCursorBar(list);
    unsavedChanges = true;
    markInstrumentLive(builderTrack);
    needsRedraw = true;
}

/* The next free bar after `fromBar` (same beat if free, else its first free
 * beat), or null. */
function nextFreeItemPos(list, sec, fromBar, beat) {
    const total = sectionChordBars(sec);
    for (let bar = fromBar + 1; bar < total; bar++) {
        const free = freeItemBeats(list, bar, false, null);
        if (free.includes(beat)) return { bar, beat };
        if (free.length) return { bar, beat: free[0] };
    }
    return null;
}

/* Jog click: the section row renames, an item opens its settings, "+ Add"
 * adds one after the last (the next bar) and opens it. */
function itemListClick() {
    const { secIndex, sec } = itemTrackSection();
    if (!sec) return;
    const list = sortItems(sectionItems(sec, builderTrack));
    /* A locked song's items are read-only, as its clips are. */
    if (songIsLocked()) { lockedNotice(); return; }
    if (itemListCursor < 0) { renameSectionPrompt(sec); return; }
    const it = list[itemListCursor];
    if (it) { openItemEdit(builderTrack, secIndex, it); return; }
    if (!itemAddAvailable()) {
        showPopup(itemTrackName(builderTrack), "Add a chord to the Chord track first", 2000);
        return;
    }
    const last = list[list.length - 1];
    const pos = itemAppendPos(list, sec);
    if (!pos) { showPopup(itemTrackName(builderTrack), "No free beat after the last item", 2000); return; }
    const fresh = builderTrack === TRACK_CLICK
        ? { volume: last && typeof last.volume === "number" ? last.volume : clickVolume } : {};
    fresh.bar = pos.bar;
    if (pos.beat !== 1) fresh.beat = pos.beat;
    openItemEdit(builderTrack, secIndex, null, fresh);
}

/* Where "+ Add" or Copy puts a new item: the bar after the section's last
 * item, else sharing that last bar (see splitBeatAfter), else null. */
function itemAppendPos(list, sec) {
    const last = list[list.length - 1];
    if (!last) return { bar: 0, beat: 1 };
    let pos = nextFreeItemPos(list, sec, last.bar, 1);
    if (!pos) {
        const beat = splitBeatAfter(chordBeat(last), freeItemBeats(list, last.bar, !!last.adv, null), !!last.adv);
        if (beat !== null) pos = { bar: last.bar, beat };
    }
    return pos;
}

function itemListDelete() {
    const { sec } = itemTrackSection();
    if (!sec) return;
    const list = sortItems(sectionItems(sec, builderTrack));
    if (!list[itemListCursor]) return;
    list.splice(itemListCursor, 1);
    itemListCursor = Math.min(itemListCursor, list.length);
    syncItemCursorBar(list);
    unsavedChanges = true;
    markInstrumentLive(builderTrack);
    needsRedraw = true;
}

function itemListDuplicate() {
    const { sec } = itemTrackSection();
    if (!sec) return;
    const list = sortItems(sectionItems(sec, builderTrack));
    const it = list[itemListCursor];
    if (!it) return;
    /* After the section's last item, as "+ Add" would add one. */
    const pos = itemAppendPos(list, sec);
    if (!pos) { showPopup(itemTrackName(builderTrack), "No free beat after the last item", 2000); return; }
    const copy = Object.assign({}, it, { bar: pos.bar });
    if (pos.beat !== 1) copy.beat = pos.beat; else delete copy.beat;
    list.push(copy);
    sortItems(list);
    itemListCursor = list.indexOf(copy);
    syncItemCursorBar(list);
    unsavedChanges = true;
    markInstrumentLive(builderTrack);
    needsRedraw = true;
}

/* A step press on these tracks selects that bar's first item. */
function itemListSelectBar(bar) {
    const { sec } = itemTrackSection();
    if (!sec) return;
    const list = sortItems(sectionItems(sec, builderTrack));
    const i = list.findIndex(it => it.bar === bar);
    if (i < 0) return;
    itemListCursor = i;
    syncItemCursorBar(list);
    needsRedraw = true;
}

/* ── Item settings page ─────────────────────────────────────────────── */

function openItemEdit(track, secIndex, item, fresh) {
    itemEditTrack = track;
    itemEditSong = viewSong();
    itemEditSec = builderPlayingFromTemp ? viewSectionIndex() : secIndex;
    itemEditOrig = item;
    itemWork = Object.assign({}, item || fresh || {});
    itemFocus = 0;
    itemEditing = false;
    currentView = VIEW_INSTRUMENT_BAR;
    menuStack.push({ title: itemTrackName(track), selectedIndex: 0 });
    needsRedraw = true;
}

function itemEditList() {
    const sec = itemEditSong ? itemEditSong.sections[itemEditSec] : null;
    return sec ? sectionItems(sec, itemEditTrack) : [];
}

/* "Default (3)": an unset field shows the track default it falls back to. */
function itemDefault(v, label) {
    return v === null || v === undefined ? "Default (" + label + ")" : null;
}

function itemEditRows() {
    const w = itemWork;
    const rows = [
        { key: "bar", label: "Bar", value: String(w.bar + 1) },
        { key: "beat", label: "Beat", value: formatBeat(chordBeat(w)) }
    ];
    if (itemEditTrack === TRACK_CLICK) {
        rows.push({ key: "volume", label: "Volume", value: (typeof w.volume === "number" ? w.volume : 100) + "%" });
    } else {
        const inst = instrumentForTrack(itemEditTrack);
        rows.push({ key: "mute", label: "Sound", value: w.mute ? "Mute" : "Play" });
        rows.push({ key: "octave", label: "Octave",
            value: itemDefault(w.octave, inst ? inst.octave : 3) || String(w.octave) });
        rows.push({ key: "follow", label: "Follow Note",
            value: itemDefault(w.follow_note, inst && inst.follow_note > 0 ? inst.follow_note : "Off") ||
                (w.follow_note > 0 ? String(w.follow_note) : "Off") });
        rows.push({ key: "voicing", label: "Voicing",
            value: itemDefault(w.voicing, voicingLabel(inst ? inst.voicing : "bass")) || voicingLabel(w.voicing) });
        /* The rows that apply to the voicing in effect here. */
        const voicing = w.voicing || (inst ? inst.voicing : "bass") || "bass";
        const iv = instVariety(inst);
        rows.push(...instVarietyRows(voicing, "pattern", () =>
            itemDefault(w.pattern, patternLabel(voicing, iv.pattern)) || patternLabel(voicing, w.pattern)));
        const follow = typeof w.follow_note === "number" ? w.follow_note : (inst ? inst.follow_note : 0);
        rows.push(...arpRateRows(voicing, follow, () =>
            itemDefault(w.arp_rate, ARP_RATE_LABELS[iv.arp_rate]) || ARP_RATE_LABELS[w.arp_rate]));
        rows.push(...instVarietyRows(voicing, "arp_range", () =>
            itemDefault(w.arp_range, arpRangeLabel(iv.arp_range)) || arpRangeLabel(w.arp_range)));
        rows.push(...instVarietyRows(voicing, "arp_vel", () =>
            itemDefault(w.arp_vel, arpVelLabel(iv.arp_vel)) || arpVelLabel(w.arp_vel)));
        if (voicing !== "bass") rows.push({ key: "inversion", label: "Inversion",
            value: itemDefault(w.inversion, inversionLabel(inst ? inst.inversion : 0)) || inversionLabel(w.inversion) });
        rows.push(...instVarietyRows(voicing, "approach", () =>
            itemDefault(w.approach, APPROACH_LABELS[iv.approach]) || APPROACH_LABELS[w.approach]));
        rows.push(...instVarietyRows(voicing, "strum", () =>
            itemDefault(w.strum, strumLabel(iv.strum)) || strumLabel(w.strum)));
        rows.push(...instVarietyRows(voicing, "strum_dir", () =>
            itemDefault(w.strum_dir, STRUM_DIR_LABELS[iv.strum_dir]) || STRUM_DIR_LABELS[w.strum_dir]));
        rows.push({ key: "gap", label: "Note Gap",
            value: itemDefault(w.note_gap, noteGapLabel(inst ? inst.note_gap : 0.25)) || noteGapLabel(w.note_gap) });
        rows.push({ key: "velocity", label: "Velocity",
            value: itemDefault(w.velocity, instrumentVelocity(inst)) || String(w.velocity) });
        rows.push({ key: "vel_follow", label: "Vel Follow",
            value: itemDefault(w.vel_follow, iv.vel_follow ? "On" : "Off") || (w.vel_follow ? "On" : "Off") });
        rows.push({ key: "chance", label: "Chance",
            value: itemDefault(w.chance, chanceLabel(iv.chance)) || chanceLabel(w.chance) });
    }
    rows.push({ key: "adv", label: "Advanced", value: w.adv ? "On" : "Off" });
    rows.push({ key: "delete", label: "Delete", value: "" });
    return padsRowsOnly(itemEditTrack, rows);
}

function drawInstrumentBarMenu() {
    drawMenuHeader(itemTrackName(itemEditTrack), chordPosLabel(itemWork.bar, chordBeat(itemWork)));
    const rows = itemEditRows();
    if (itemFocus >= rows.length) itemFocus = rows.length - 1;
    drawMenuList({
        ...LIST_ROW_FIT,
        labelX: 3,
        items: rows,
        selectedIndex: itemFocus,
        getLabel: (item) => item.label,
        getValue: (item) => item.value,
        valueAlignRight: true,
        editMode: itemEditing,
        labelGap: 2,
        prioritizeSelectedValue: true,
        selectedMinLabelChars: 6,
        listArea: { topY: LIST_TOP_Y, bottomY: LIST_INDICATOR_BOTTOM_Y }
    });
}

/* Save the page's item: it replaces the original (or joins the list), the
 * list is re-sorted, and the Song Builder list selects it. */
function commitItemEdit() {
    const list = itemEditList();
    const w = Object.assign({}, itemWork);
    for (const k of Object.keys(w)) if (w[k] === null || w[k] === undefined) delete w[k];
    if (chordBeat(w) === 1) delete w.beat;
    if (!w.adv) delete w.adv;
    if (!w.mute) delete w.mute;
    const i = itemEditOrig ? list.indexOf(itemEditOrig) : -1;
    if (i >= 0) list[i] = w; else list.push(w);
    sortItems(list);
    itemListCursor = list.indexOf(w);
    syncItemCursorBar(list);
    unsavedChanges = true;
}

/* While playing, an item page's change is heard at once: the item is saved
 * into its list (as Play from this page does) and the instrument sent live. */
function itemLivePreview() {
    if (!isInstTrack(itemEditTrack) || playbackState !== "playing") return;
    applyOpenEditForPlay();
    markInstrumentLive(itemEditTrack);
}

function closeItemEdit() {
    menuStack.pop();
    currentView = VIEW_BUILDER;
    stepLedsDirty = true;
    needsRedraw = true;
}

function handleInstrumentBarMenuInput(cc, value) {
    const rows = itemEditRows();
    const row = rows[Math.max(0, Math.min(rows.length - 1, itemFocus))];
    const w = itemWork;
    const list = itemEditList();
    const sec = itemEditSong ? itemEditSong.sections[itemEditSec] : null;
    if (cc === MoveMainKnob) {
        const delta = decodeDelta(value);
        if (itemEditing && sec) {
            if (row.key === "bar") {
                const total = sectionChordBars(sec);
                let bar = w.bar;
                for (let n = 0; n < total; n++) {
                    bar += Math.sign(delta);
                    if (bar < 0 || bar >= total) { bar = w.bar; break; }
                    const free = freeItemBeats(list, bar, !!w.adv, itemEditOrig);
                    if (free.length) {
                        const b = chordBeat(w);
                        const nb = free.includes(b) ? b : free.reduce((a, x) => Math.abs(x - b) < Math.abs(a - b) ? x : a);
                        if (nb !== 1) w.beat = nb; else delete w.beat;
                        break;
                    }
                }
                w.bar = bar;
            } else if (row.key === "beat") {
                const opts = freeItemBeats(list, w.bar, !!w.adv, itemEditOrig);
                let i = opts.indexOf(chordBeat(w));
                if (i < 0) i = 0;
                if (opts.length) {
                    const nb = opts[Math.max(0, Math.min(opts.length - 1, i + delta))];
                    if (nb !== 1) w.beat = nb; else delete w.beat;
                }
            } else if (row.key === "volume") {
                w.volume = Math.max(0, Math.min(100, (typeof w.volume === "number" ? w.volume : 100) + delta * 5));
            } else if (row.key === "mute") {
                w.mute = !w.mute;
            } else if (row.key === "octave") {
                w.octave = cycleOptionalInt(w.octave, delta, -1, 8);
            } else if (row.key === "velocity") {
                /* Below 1 is Default (the track's velocity). */
                w.velocity = cycleOptionalInt(w.velocity, delta, 1, 127);
            } else if (row.key === "follow") {
                const inst = instrumentForTrack(itemEditTrack);
                const voicing = w.voicing || (inst ? inst.voicing : "bass");
                w.follow_note = w.follow_note === 0 && delta > 0 && voicing === "bass"
                    ? stepFollowNote(0, delta, true)
                    : cycleOptionalInt(w.follow_note, delta, 0, 127);
            } else if (row.key === "voicing") {
                const states = [null, ...VOICINGS];
                const cur = states.indexOf(w.voicing === undefined ? null : w.voicing);
                w.voicing = states[((cur + delta) % states.length + states.length) % states.length];
            } else if (row.key === "pattern") {
                const inst = instrumentForTrack(itemEditTrack);
                const voicing = w.voicing || (inst ? inst.voicing : "bass") || "bass";
                w.pattern = cycleOptionalInt(w.pattern, delta, 0, patternList(voicing).length - 1);
            } else if (row.key === "arp_range") {
                w.arp_range = cycleOptionalInt(w.arp_range, delta, 1, 3);
            } else if (row.key === "arp_vel") {
                /* Default, Off, 10 ... 90%. */
                const steps = [null, 0, 10, 20, 30, 40, 50, 60, 70, 80, 90];
                const cur = steps.indexOf(w.arp_vel === undefined ? null : w.arp_vel);
                w.arp_vel = steps[Math.max(0, Math.min(steps.length - 1, (cur < 0 ? 0 : cur) + delta))];
            } else if (row.key === "approach") {
                w.approach = cycleOptionalInt(w.approach, delta, 0, 3);
            } else if (row.key === "arp_rate") {
                const steps = [null, ...ARP_RATES];
                const cur = steps.indexOf(w.arp_rate === undefined ? null : w.arp_rate);
                w.arp_rate = steps[Math.max(0, Math.min(steps.length - 1, (cur < 0 ? 0 : cur) + delta))];
            } else if (row.key === "strum") {
                /* Default, Off, 5 ... 100 ms. */
                const steps = [null, 0];
                for (let ms = 5; ms <= STRUM_MAX_MS; ms += 5) steps.push(ms);
                const cur = steps.indexOf(w.strum === undefined ? null : w.strum);
                w.strum = steps[Math.max(0, Math.min(steps.length - 1, (cur < 0 ? 0 : cur) + delta))];
            } else if (row.key === "strum_dir") {
                w.strum_dir = cycleOptionalInt(w.strum_dir, delta, 0, 2);
            } else if (row.key === "vel_follow") {
                const states = [null, false, true];
                const cur = states.indexOf(w.vel_follow === undefined ? null : w.vel_follow);
                w.vel_follow = states[Math.max(0, Math.min(2, (cur < 0 ? 0 : cur) + delta))];
            } else if (row.key === "chance") {
                /* Default, then 5 ... 100%. */
                const steps = [null];
                for (let c = 5; c <= 100; c += 5) steps.push(c);
                const cur = steps.indexOf(w.chance === undefined ? null : w.chance);
                w.chance = steps[Math.max(0, Math.min(steps.length - 1, (cur < 0 ? 0 : cur) + delta))];
            } else if (row.key === "inversion") {
                w.inversion = cycleOptionalInt(w.inversion, delta, 0, INVERSION_AUTO);
            } else if (row.key === "gap") {
                const steps = [null, 0, 0.0625, 0.125, 0.25, 0.5, 1.0];
                const cur = steps.indexOf(w.note_gap === undefined ? null : w.note_gap);
                w.note_gap = steps[Math.max(0, Math.min(steps.length - 1, (cur < 0 ? 0 : cur) + delta))];
            }
        } else {
            itemFocus = Math.max(0, Math.min(rows.length - 1, itemFocus + delta));
        }
        if (itemEditing && sec) itemLivePreview();
        needsRedraw = true;
    } else if (cc === MoveMainButton && value > 0) {
        if (row.key === "adv") {
            w.adv = !w.adv;
            /* Off: back onto a whole beat (the nearest free one). */
            if (!w.adv && !Number.isInteger(chordBeat(w))) {
                const free = freeItemBeats(list, w.bar, false, itemEditOrig);
                if (free.length) {
                    const b = chordBeat(w);
                    const nb = free.reduce((a, x) => Math.abs(x - b) < Math.abs(a - b) ? x : a);
                    if (nb !== 1) w.beat = nb; else delete w.beat;
                } else {
                    w.adv = true;
                }
            }
            needsRedraw = true;
            return;
        }
        if (row.key === "mute") { w.mute = !w.mute; itemLivePreview(); needsRedraw = true; return; }
        if (row.key === "delete") {
            const i = itemEditOrig ? list.indexOf(itemEditOrig) : -1;
            if (i >= 0) { list.splice(i, 1); unsavedChanges = true; markInstrumentLive(itemEditTrack); }
            itemListCursor = Math.min(itemListCursor, list.length);
            syncItemCursorBar(list);
            closeItemEdit();
            return;
        }
        itemEditing = !itemEditing;
        needsRedraw = true;
    } else if (cc === MoveBack && value > 0) {
        if (itemEditing) {
            itemEditing = false;
            needsRedraw = true;
        } else {
            commitItemEdit();
            closeItemEdit();
        }
    }
}

/* ── Jam instrument menu (live Octave/Follow Note/Voicing/Inversion/Note
 * Gap for one of the two Jam-performed instruments) ──────────────────── */

/* Seed the DSP's jam_inst[idx] the first time that instrument is enabled in
 * a session: MIDI channel/output (reusing whatever Options -> Instrument
 * 1/2 already has configured -- inst1Output/inst1Channel/inst2Output/
 * inst2Channel -- the same routing a song-authored instrument would use;
 * channel/output aren't exposed in the live Jam menu itself, Options is
 * still the place to change them) plus the rest of jamInstConfig's current
 * values. Without this, the DSP's jam_inst[] fields (follow_note
 * especially) would stay at their calloc default of 0/silent until the
 * user happened to open Shift+Row3/4 and turn a knob, even though the JS
 * side already shows non-zero defaults (see jamInstConfig). */
function pushJamInstrumentRouting(idx) {
    if (jamInstRoutingPushed[idx]) return;
    jamInstRoutingPushed[idx] = true;
    if (typeof host_module_set_param !== "function" &&
        typeof host_module_set_param_blocking !== "function") return;
    /* Several DIFFERENT keys back to back, all needed together for the
     * instrument to be usable at all (especially output/channel -- without
     * a valid destination it's silent even though everything else is
     * configured correctly). In co-run/overtake mode set_param is
     * fire-and-forget over a SINGLE shared shadow_param SHM slot, so
     * several non-blocking writes in a row race: the host drains them one
     * at a time and a later write can clobber an earlier one before it's
     * consumed. Use the blocking variant so each write is fully consumed
     * before the next -- same reasoning/pattern as pushOutputRoutingToDsp. */
    const block = typeof host_module_set_param_blocking === "function";
    const set = block ? host_module_set_param_blocking : host_module_set_param;
    const t = block ? 100 : undefined;
    /* Each takes Options' route for its namesake: Inst 1, Inst 2, Pads. */
    const output = instOutputOf(idx + 1);
    const channel = instChannelOf(idx + 1);
    const key = "jam_inst" + (idx + 1) + "_";
    set(key + "output", output, t);
    /* channel-1: inst1Channel/inst2Channel are the 1-based UI value; the
     * DSP's jam_inst<N>_channel handler (like move_channel/schwung_channel/
     * output_channel) takes an already-0-based channel directly, no
     * conversion of its own -- matching pushOutputRoutingToDsp's
     * "output_channel", String(activeOutputChannel() - 1)" just above.
     * Sending the raw 1-based value here (missed originally) put every Jam
     * instrument's MIDI channel one higher than intended -- e.g. channel 1
     * landing as 0-based 1 (channel 2) instead of 0-based 0 (channel 1) --
     * which for "move" output routes to a different internal Move slot
     * than Options -> Instrument actually configured, silencing it even
     * though every other setting was correct. */
    set(key + "channel", String(channel - 1), t);
    for (const field of ["octave", "voicing", "inversion", "gap", "follow", "velocity", ...JAM_VARIETY_FIELDS]) {
        const [param, value] = jamInstParam(idx, field);
        set(key + param, value, t);
    }
}

/* The variety settings Jam's instruments carry, as Song Builder's do. */
const JAM_VARIETY_FIELDS = ["pattern", "approach", "strum", "strum_dir", "chance", "vel_follow",
    "arp_rate", "arp_range", "arp_vel"];

/* A Jam instrument's setting `field` (a menu row key) as the engine's
 * jam_inst<N>_<param> and its value. */
function jamInstParam(idx, field) {
    const cfg = jamInstConfig[idx];
    const v = instVariety(cfg);
    switch (field) {
        case "octave": return ["octave", String(cfg.octave)];
        case "voicing": return ["voicing", cfg.voicing || "bass"];
        case "inversion": return ["inversion", String(cfg.inversion)];
        case "gap": return ["note_gap", String(cfg.note_gap)];
        case "follow": return ["follow_note", String(cfg.follow_note || 0)];
        case "velocity": return ["velocity", String(instrumentVelocity(cfg))];
        case "vel_follow": return ["vel_follow", v.vel_follow ? "1" : "0"];
        default: return [field, String(v[field])];
    }
}

function openJamInstrumentMenu(idx) {
    jamInstrumentEditIndex = idx;
    jamInstrumentFocus = 0;
    jamInstrumentEditing = false;
    currentView = VIEW_JAM_INSTRUMENT;
    menuStack.push({ title: INST_TRACK_NAMES[idx] + " (Jam)", selectedIndex: 0 });
    needsRedraw = true;
}

/* A Jam instrument's live settings: everything Song Builder's Instrument
 * Settings has (but Enabled -- its Track button is that), showing the rows
 * for its voicing. The Pads are always a chord held from bar to bar, so they
 * get the chord settings only, as Song Builder's Pads track does. */
function jamInstrumentRows(idx) {
    const rows = instrumentRowsFor(jamInstConfig[idx]).filter(r => r.key !== "enabled");
    return idx === 2 ? padsRowsOnly(TRACK_PADS, rows) : rows;
}

function drawJamInstrumentMenu() {
    drawMenuHeader(INST_TRACK_NAMES[jamInstrumentEditIndex] + " (Jam)", "");
    const items = jamInstrumentRows(jamInstrumentEditIndex);
    if (jamInstrumentFocus >= items.length) jamInstrumentFocus = items.length - 1;
    drawMenuList({
        ...LIST_ROW_FIT,
        labelX: 3,
        items,
        selectedIndex: jamInstrumentFocus,
        getLabel: (item) => item.label,
        getValue: (item) => item.value,
        valueAlignRight: true,
        editMode: jamInstrumentEditing,
        labelGap: 2,
        prioritizeSelectedValue: true,
        selectedMinLabelChars: 6,
        listArea: { topY: LIST_TOP_Y, bottomY: LIST_INDICATOR_BOTTOM_Y }
    });
}

function handleJamInstrumentMenuInput(cc, value) {
    const idx = jamInstrumentEditIndex;
    const cfg = jamInstConfig[idx];
    const rows = jamInstrumentRows(idx);
    const rowKey = (rows[Math.max(0, Math.min(rows.length - 1, jamInstrumentFocus))] || rows[0]).key;
    /* Heard at once: only the changed setting goes to the engine. */
    const send = (field) => {
        const [param, val] = jamInstParam(idx, field);
        if (typeof host_module_set_param === "function") host_module_set_param("jam_inst" + (idx + 1) + "_" + param, val);
    };
    if (cc === MoveMainKnob) {
        const delta = decodeDelta(value);
        if (jamInstrumentEditing) {
            stepInstrumentField(cfg, rowKey, delta);
            send(rowKey);
        } else {
            jamInstrumentFocus = Math.max(0, Math.min(rows.length - 1, jamInstrumentFocus + delta));
        }
        needsRedraw = true;
    } else if (cc === MoveMainButton && value > 0) {
        if (rowKey === "vel_follow") {
            cfg.vel_follow = !instVariety(cfg).vel_follow;
            send("vel_follow");
        } else {
            jamInstrumentEditing = !jamInstrumentEditing;
        }
        needsRedraw = true;
    } else if (cc === MoveBack && value > 0) {
        if (jamInstrumentEditing) {
            jamInstrumentEditing = false;
            needsRedraw = true;
        } else {
            menuStack.pop();
            currentView = VIEW_JAM;
            needsRedraw = true;
        }
    }
}

function openTrimView() {
    /* Use the displayed section (auto-followed/jumped during playback) so the
     * trim edits the live section's clip, not the stale currentSectionIndex. */
    const sec = currentSong ? currentSong.sections[builderDisplaySectionIndex()] : null;
    const clip = sec ? sec.clips[builderCursor] : null;
    if (!clip) return;
    /* Capture the clip reference so a section auto-advance during playback
     * doesn't switch the edit to a clip in the new section. */
    trimClip = clip;
    trimEditing = false;
    /* Advanced Trim persists per-clip so editing a clip again keeps the finer
     * bar/beat view on. It defaults off for clips that never used it. */
    trimAdvanced = !!(clip.advanced);
    trimOriginalGuard = clip.guard_fraction;
    trimOriginalSpeed = (clip.speed !== undefined) ? clip.speed : 1.0;
    trimOriginalVelocityScale = (clip.velocity_scale !== undefined) ? clip.velocity_scale : 1.0;
    trimOriginalSnareNote = (clip.snare_note !== undefined) ? clip.snare_note : 38;
    trimOriginalSnareVelocityScale = (clip.snare_velocity_scale !== undefined) ? clip.snare_velocity_scale : 1.0;
    trimOriginalKickNote = (clip.kick_note !== undefined) ? clip.kick_note : 36;
    trimOriginalKickTarget = (clip.kick_target !== undefined) ? clip.kick_target : 0;
    const bpb = trimBeatsPerBar();
    /* Start/End are shown and edited in EFFECTIVE song-bar units (source bars
     * ÷ speed), so they stay consistent with the speed-adjusted denominator. */
    trimOriginalStart = clip.start_bar / trimOriginalSpeed;
    trimOriginalEnd = clip.end_bar / trimOriginalSpeed;
    /* Beats are 1-based (1..beats-per-bar). Defaults: start on beat 1; end on
     * the last beat (beats-per-bar) so the whole bar plays. Stored 0 (from an
     * old/clipped file) is treated as the default. Independent of speed: the
     * DSP trims against the source grid, then speed stretches the trim. */
    trimOriginalStartBeat = (clip.start_beat !== undefined && clip.start_beat > 0) ? clip.start_beat : 1;
    trimOriginalEndBeat = (clip.end_beat !== undefined && clip.end_beat > 0) ? clip.end_beat : bpb;
    trimPendingStart = trimOriginalStart;
    trimPendingEnd = trimOriginalEnd;
    trimPendingStartBeat = trimOriginalStartBeat;
    trimPendingEndBeat = trimOriginalEndBeat;
    trimPendingGuard = trimOriginalGuard;
    trimPendingSpeed = trimOriginalSpeed;
    trimPendingVelocityScale = trimOriginalVelocityScale;
    trimPendingSnareNote = trimOriginalSnareNote;
    trimPendingSnareVelocityScale = trimOriginalSnareVelocityScale;
    trimPendingKickNote = (clip.kick_note !== undefined) ? clip.kick_note : 36;
    trimPendingKickTarget = (clip.kick_target !== undefined) ? clip.kick_target : 0;
    /* Per-clip MIDI out channel: 0 = follow the Options output channel,
     * 1-16 = explicit override for this clip only. */
    trimOriginalChannel = (clip.channel !== undefined) ? clip.channel : 0;
    trimPendingChannel = trimOriginalChannel;
    currentView = VIEW_TRIM;
    menuStack.push({ title: clipShortName(clip) || "Clip Settings", selectedIndex: 0 });
    needsRedraw = true;
}

/* Beats per bar for the current song (used for Advanced Trim beat clamps). */
function trimBeatsPerBar() {
    return (currentSong && currentSong.time_sig_num > 0) ? currentSong.time_sig_num : 4;
}

/* A clip is "full length" when Start sits at the clip's first playable bar and
 * End extends to the last bar. Shortening a clip from full length auto-applies
 * a 13% guard interval; widening it back to full length clears the guard.
 * Only the length (Start/End) drives this; the Guard field remains manual.
/* A clip is "full length" when End extends to the last bar. Shortening a clip
 * from full length auto-applies a 13% guard interval; widening the END back to
 * the last bar removes the guard. Only the END length drives the guard — the
 * Start position does not. The Guard field itself remains manual.
 *
 * For beat-level edits the guard is only cleared when the end beat returns to
 * the final beat of the bar AND advanced trimming is disabled (beats snap back
 * to the full-bar defaults) AND the end bar is at the clip's full length.
 */
function trimAutoApplyGuard(effMaxBar, beatEdit = false) {
    if (!trimClip) return;
    if (beatEdit) {
        /* In Advanced Trim the guard is a manual field the user controls; a
         * beat-level edit must NOT overwrite it. Leave it as the user set it. */
        if (trimAdvanced) return;
        const bpb = trimBeatsPerBar();
        const atFullBarEnd = (trimPendingEnd === effMaxBar) && (trimPendingEndBeat === bpb);
        /* Only clear when genuinely back to a full-length bar (advanced mode
         * off, so beats snap to the full-bar defaults). */
        trimPendingGuard = atFullBarEnd ? 0 : 0.13;
        return;
    }
    /* Guard is applied only when the END is shortened. If the end reaches the
     * full length the guard is cleared, regardless of the start position. */
    trimPendingGuard = (trimPendingEnd === effMaxBar) ? 0 : 0.13;
}

/* Toggle Advanced Trim. Start/End stay in effective song-bar units (source ÷
 * speed) in both modes; Advanced mode just reveals the sub-bar beat fields. */
function trimToggleAdvanced() {
    const bpb = trimBeatsPerBar();
    if (trimAdvanced) {
        /* Leaving advanced: reset beats to full-bar defaults. */
        trimPendingStartBeat = 1;
        trimPendingEndBeat = bpb;
        trimAdvanced = false;
        /* With advanced off, the end beat snaps to the full bar. If the end bar
         * is the clip's full length, clear the auto-guard. */
        if (trimClip) {
            const maxBar = clipTrueBars(trimClip);
            const effMaxBar = Math.max(1, Math.round(maxBar / trimPendingSpeed));
            trimAutoApplyGuard(effMaxBar, true);
        }
    } else {
        trimPendingStartBeat = Math.max(1, Math.min(bpb, trimPendingStartBeat));
        trimPendingEndBeat = Math.max(1, Math.min(bpb, trimPendingEndBeat));
        trimAdvanced = true;
    }
}

function drawTrim() {
    const clip = trimClip;
    drawMenuHeader(scrollHeader("Edit: " + (clip ? clipShortName(clip) : "Clip Settings"), songIsLocked() ? 27 : 28), trimAdvanced ? "A" : "");
    if (!clip) {
        print(2, LIST_TOP_Y, "No clip selected", 1);
        return;
    }
    /* Show the clip's source folder (read-only) at the top of the trim view.
     * The effective folder is the per-clip source_folder if set, else the
     * song's primary source_folder. Long paths marquee via a scroller. */
    const srcFolder = (clip.source_folder) ? clip.source_folder : (currentSong ? currentSong.source_folder : "");
    const srcLabel = srcFolder ? ("Src: " + srcFolder) : "";
    trimSrcScroller.setSelected(srcLabel);
    trimSrcScroller.tick();
    let srcText = srcLabel;
    if (srcText.length > 21) srcText = trimSrcScroller.getScrolledText(srcText, 21);
    print(2, LIST_TOP_Y, srcText, 1);
    const maxBar = clipTrueBars(clip);
    /* The denominator and Start/End are always in EFFECTIVE song-bar units
     * (source bars ÷ speed), so the total shown updates when Speed changes.
     * In Advanced mode only the beat fields differ from standard mode. */
    const effMaxBar = Math.max(1, Math.round(maxBar / trimPendingSpeed));
    const bpb = trimBeatsPerBar();
    const selectedIndex = menuStack.getSelectedIndex();
    const items = [
        { key: "advanced", label: "Advanced Trim", value: trimAdvanced ? "On" : "Off" }
    ];
    if (trimAdvanced) {
        items.push({ key: "start", label: "Start Bar", value: trimPendingStart + "/" + effMaxBar });
        items.push({ key: "start_beat", label: "Start Beat", value: trimPendingStartBeat + "/" + bpb });
        items.push({ key: "end", label: "End Bar", value: trimPendingEnd + "/" + effMaxBar });
        items.push({ key: "end_beat", label: "End Beat", value: trimPendingEndBeat + "/" + bpb });
    } else {
        items.push({ key: "start", label: "Start", value: trimPendingStart + "/" + effMaxBar });
        items.push({ key: "end", label: "End", value: trimPendingEnd + "/" + effMaxBar });
    }
    items.push({ key: "guard", label: "Guard", value: Math.round(trimPendingGuard * 100) + "%" });
    items.push({ key: "speed", label: "Speed", value: trimPendingSpeed + "x" });
    items.push({ key: "velocity", label: "Velocity", value: Math.round(trimPendingVelocityScale * 100) + "%" });
    items.push({ key: "snare_note", label: "Single Note", value: String(trimPendingSnareNote) });
    items.push({ key: "snare_velocity", label: "Single Note Vel", value: Math.round(trimPendingSnareVelocityScale * 100) + "%" });
    items.push({ key: "kick_note", label: "Limit Note", value: trimPendingKickNote === 0 ? "Off" : String(trimPendingKickNote) });
    items.push({ key: "kick_target", label: "Limit Notes/Bar", value: trimPendingKickTarget === 0 ? "Off" : String(trimPendingKickTarget) });
    items.push({ key: "channel", label: "MIDI Channel", value: trimPendingChannel === 0 ? "Default" : String(trimPendingChannel) });
    drawMenuList({
        ...LIST_ROW_FIT,
        labelX: 3,
        items,
        selectedIndex,
        getLabel: (item) => item.label,
        getValue: (item) => item.value,
        valueAlignRight: true,
        editMode: trimEditing,
        /* The source-folder line occupies LIST_TOP_Y, so the list starts one
         * row lower. */
        listArea: { topY: LIST_TOP_Y + 9, bottomY: LIST_INDICATOR_BOTTOM_Y }
    });
}

function commitTrim(pending) {
    const clip = trimClip;
    if (!clip) return;
    const p = pending || {
        start: trimPendingStart,
        startBeat: trimPendingStartBeat,
        end: trimPendingEnd,
        endBeat: trimPendingEndBeat,
        advanced: trimAdvanced,
        guard: trimPendingGuard,
        speed: trimPendingSpeed,
        velocity: trimPendingVelocityScale,
        snare_note: trimPendingSnareNote,
        snare_velocity: trimPendingSnareVelocityScale,
        kick_note: trimPendingKickNote,
        kick_target: trimPendingKickTarget,
        channel: trimPendingChannel
    };
    clip.guard_fraction = Math.max(0, Math.min(0.5, p.guard));
    clip.speed = Math.max(0.25, Math.min(4.0, p.speed));
    clip.advanced = !!p.advanced;
    if (p.advanced) {
        /* Advanced mode: Start/End are effective bars (source ÷ speed). Convert
         * back to source bars, then attach each 1-based beat offset. Keep start
         * before end. */
        const bpb = trimBeatsPerBar();
        let sB = Math.round(p.start * clip.speed), sBt = Math.max(1, Math.min(bpb, Math.round(p.startBeat)));
        let eB = Math.round(p.end * clip.speed), eBt = Math.max(1, Math.min(bpb, Math.round(p.endBeat)));
        if (sB > eB || (sB === eB && sBt >= eBt)) {
            const tb = sB, tbt = sBt;
            sB = eB; sBt = eBt;
            eB = tb; eBt = tbt;
        }
        clip.start_bar = sB;
        clip.start_beat = sBt;
        clip.end_bar = eB;
        clip.end_beat = eBt;
    } else {
        /* Standard mode: convert effective song-bar positions back to source
         * bars; beats reset to defaults (start=1, end=bpb). */
        const srcStart = Math.round(p.start * clip.speed);
        const srcEnd = Math.round(p.end * clip.speed);
        clip.start_bar = Math.min(srcStart, srcEnd);
        clip.end_bar = Math.max(srcStart, srcEnd);
        clip.start_beat = 1;
        clip.end_beat = trimBeatsPerBar();
    }
    clip.velocity_scale = Math.max(0.0, Math.min(2.0, p.velocity));
    clip.snare_note = Math.max(0, Math.min(127, Math.round(p.snare_note)));
    clip.snare_velocity_scale = Math.max(0.0, Math.min(2.0, p.snare_velocity));
    clip.kick_note = Math.max(0, Math.min(127, Math.round(p.kick_note)));
    clip.kick_target = Math.max(0, Math.min(16, Math.round(p.kick_target)));
    /* Per-clip MIDI out channel: 0 = follow the Options output channel,
     * 1-16 = explicit override for this clip only. */
    clip.channel = Math.max(0, Math.min(16, Math.round(p.channel)));
    logDebug("commitTrim: clip=" + clipShortName(clip) + " start=" + clip.start_bar + "." + clip.start_beat + " end=" + clip.end_bar + "." + clip.end_beat + " adv=" + (p.advanced ? 1 : 0) + " guard=" + clip.guard_fraction + " speed=" + clip.speed + " vel=" + clip.velocity_scale + " snare=" + clip.snare_note + " snareVel=" + clip.snare_velocity_scale + " kick=" + clip.kick_note + "/" + clip.kick_target + " ch=" + clip.channel);
    unsavedChanges = true;
    menuStack.pop();
    currentView = VIEW_BUILDER;
    stepLedsDirty = true;
    needsRedraw = true;
}

function handleTrimInput(cc, value) {
    const clip = trimClip;
    if (!clip) return;
    const maxBar = clipTrueBars(clip);
    const effMaxBar = Math.max(1, Math.round(maxBar / trimPendingSpeed));
    const bpb = trimBeatsPerBar();
    let selectedIndex = menuStack.getSelectedIndex();
    const fields = trimAdvanced
        ? ["advanced", "start", "start_beat", "end", "end_beat", "guard", "speed", "velocity", "snare_note", "snare_velocity", "kick_note", "kick_target", "channel"]
        : ["advanced", "start", "end", "guard", "speed", "velocity", "snare_note", "snare_velocity", "kick_note", "kick_target", "channel"];
    let field = fields[selectedIndex];
    if (cc === MoveMainKnob) {
        const delta = decodeDelta(value);
        if (trimEditing) {
            if (field === "start") {
                trimPendingStart = Math.max(0, Math.min(effMaxBar - 1, trimPendingStart + delta));
            } else if (field === "start_beat") {
                trimPendingStartBeat = Math.max(1, Math.min(bpb, trimPendingStartBeat + delta));
            } else if (field === "end") {
                trimPendingEnd = Math.max(trimPendingStart + 1, Math.min(effMaxBar, trimPendingEnd + delta));
                /* Shortening the END from full length auto-adds a 13% guard;
                 * widening it back to full length clears it. */
                trimAutoApplyGuard(effMaxBar);
            } else if (field === "end_beat") {
                trimPendingEndBeat = Math.max(1, Math.min(bpb, trimPendingEndBeat + delta));
                /* Changing the end beat also shortens/widens the end, so apply
                 * the same auto-guard based on the END position. */
                trimAutoApplyGuard(effMaxBar, true);
            } else if (field === "guard") {
                const steps = [0, 0.03125, 0.0625, 0.125, 0.25, 0.5];
                const idx = steps.indexOf(trimPendingGuard);
                const newIdx = Math.max(0, Math.min(steps.length - 1, (idx < 0 ? 2 : idx) + delta));
                trimPendingGuard = steps[newIdx];
            } else if (field === "speed") {
                /* Cycle through 0.5x, 1x, 2x. */
                const steps = [0.5, 1.0, 2.0];
                const idx = steps.indexOf(trimPendingSpeed);
                const newIdx = Math.max(0, Math.min(steps.length - 1, (idx < 0 ? 1 : idx) + delta));
                trimPendingSpeed = steps[newIdx];
                /* The clip's new duration is the source length ÷ speed; clamp
                 * Start/End (effective units) to the new total bar length. */
                const newEffMax = Math.max(1, Math.round(maxBar / trimPendingSpeed));
                trimPendingEnd = Math.min(newEffMax, trimPendingEnd);
                trimPendingStart = Math.min(newEffMax - 1, trimPendingStart);
            } else if (field === "velocity") {
                const deltaPct = Math.round(delta * 5) * 0.01;
                trimPendingVelocityScale = Math.max(0.0, Math.min(2.0, trimPendingVelocityScale + deltaPct));
            } else if (field === "snare_note") {
                trimPendingSnareNote = Math.max(0, Math.min(127, trimPendingSnareNote + delta));
            } else if (field === "snare_velocity") {
                const deltaPct = Math.round(delta * 5) * 0.01;
                trimPendingSnareVelocityScale = Math.max(0.0, Math.min(2.0, trimPendingSnareVelocityScale + deltaPct));
            } else if (field === "kick_note") {
                trimPendingKickNote = Math.max(0, Math.min(127, trimPendingKickNote + delta));
            } else if (field === "kick_target") {
                trimPendingKickTarget = Math.max(0, Math.min(16, trimPendingKickTarget + delta));
            } else if (field === "channel") {
                /* Per-clip MIDI out channel: 0 = follow the Options output
                 * channel, 1-16 = explicit override for this clip only. */
                trimPendingChannel = Math.max(0, Math.min(16, trimPendingChannel + delta));
            }
        } else {
            const newIdx = Math.max(0, Math.min(fields.length - 1, selectedIndex + delta));
            menuStack.setSelectedIndex(newIdx);
        }
        needsRedraw = true;
    } else if (cc === MoveMainButton && value > 0) {
        if (field === "advanced") {
            /* Toggle Advanced Trim directly. */
            trimToggleAdvanced();
            needsRedraw = true;
            return;
        }
        trimEditing = !trimEditing;
        needsRedraw = true;
    } else if (cc === MoveBack && value > 0) {
        if (trimEditing) {
            /* Cancel the current field edit and restore its original value. */
            if (field === "start") trimPendingStart = trimOriginalStart;
            else if (field === "start_beat") trimPendingStartBeat = trimOriginalStartBeat;
            else if (field === "end") trimPendingEnd = trimOriginalEnd;
            else if (field === "end_beat") trimPendingEndBeat = trimOriginalEndBeat;
            else if (field === "guard") trimPendingGuard = trimOriginalGuard;
            else if (field === "speed") {
                /* Changing speed clamps Start/End to the new length, so cancelling
                 * the speed edit must restore them too. */
                trimPendingSpeed = trimOriginalSpeed;
                trimPendingStart = trimOriginalStart;
                trimPendingEnd = trimOriginalEnd;
            }
            else if (field === "velocity") trimPendingVelocityScale = trimOriginalVelocityScale;
            else if (field === "snare_note") trimPendingSnareNote = trimOriginalSnareNote;
            else if (field === "snare_velocity") trimPendingSnareVelocityScale = trimOriginalSnareVelocityScale;
            else if (field === "kick_note") trimPendingKickNote = trimOriginalKickNote;
            else if (field === "kick_target") trimPendingKickTarget = trimOriginalKickTarget;
            else if (field === "channel") trimPendingChannel = trimOriginalChannel;
            trimEditing = false;
            needsRedraw = true;
        } else {
            /* Back from trim view commits all pending changes and saves. */
            const pending = {
                start: trimPendingStart,
                startBeat: trimPendingStartBeat,
                end: trimPendingEnd,
                endBeat: trimPendingEndBeat,
                advanced: trimAdvanced,
                guard: trimPendingGuard,
                speed: trimPendingSpeed,
                velocity: trimPendingVelocityScale,
                snare_note: trimPendingSnareNote,
                snare_velocity: trimPendingSnareVelocityScale,
                kick_note: trimPendingKickNote,
                kick_target: trimPendingKickTarget,
                channel: trimPendingChannel
            };
            commitTrim(pending);
            saveCurrentSong();
        }
    }
}

function openSongSettings() {
    if (!currentSong) return;
    songSettingsFocus = 0;
    songSettingsEditing = false;
    songSettingsPendingBpm = currentSong.tempo_bpm || 120;
    songSettingsPendingNum = currentSong.time_sig_num || 4;
    songSettingsPendingDen = currentSong.time_sig_den || 4;
    songSettingsPendingKey = currentSong.key || DEFAULT_KEY;
    songSettingsBackupCount = listSongBackups(currentSong.name).length;
    currentView = VIEW_SONG_SETTINGS;
    menuStack.push({ title: "Settings", selectedIndex: 0 });
    needsRedraw = true;
}

/* A jog click or pad a locked song refuses says why, rather than doing
 * nothing (the footer offers Menu, where Lock Song is). */
function lockedNotice() {
    showPopup("Song locked", "Unlock: Menu > Lock Song", 2000);
    needsRedraw = true;
}

/* True when the current song is locked and therefore its settings cannot be
 * edited (rename, tempo, time signature, clips, sections, etc.). */
function songIsLocked() {
    return !!(currentSong && currentSong.locked);
}

function drawSongSettings() {
    drawMenuHeader("Song Settings", songIsLocked() ? "*" : "");
    const items = [
        { key: "name", label: "Name", value: currentSong ? shortSongName(currentSong.name) : "" },
        { key: "bpm", label: "Tempo", value: String(songSettingsPendingBpm) },
        { key: "num", label: "Time Signature", value: songSettingsPendingNum + "/" + songSettingsPendingDen },
        { key: "key", label: "Key", value: keyLabel(songSettingsPendingKey) },
        { key: "lock", label: "Lock Song", value: songIsLocked() ? "On" : "Off" },
        { key: "restore", label: "Restore Backup", value: String(songSettingsBackupCount) },
        { key: "click", label: "Click", value: clickOn ? "On" : "Off" }
    ];
    drawMenuList({
        ...LIST_ROW_FIT,
        labelX: 3,
        items,
        selectedIndex: songSettingsFocus,
        getLabel: (item) => item.label,
        getValue: (item) => item.value,
        valueAlignRight: true,
        editMode: songSettingsEditing,
        labelGap: 2,
        prioritizeSelectedValue: true,
        selectedMinLabelChars: 6,
        listArea: { topY: LIST_TOP_Y, bottomY: LIST_INDICATOR_BOTTOM_Y }
    });
}

function commitSongSettings() {
    if (!currentSong) return;
    /* Only mark the song dirty when a value actually changed, so opening Song
     * Settings and backing out without editing doesn't trigger a save/backup. */
    const newBpm = Math.max(20, Math.min(300, Math.round(songSettingsPendingBpm)));
    const newNum = Math.max(1, Math.min(16, songSettingsPendingNum));
    const newDen = [1, 2, 4, 8, 16].includes(songSettingsPendingDen) ? songSettingsPendingDen : 4;
    const newKey = KEYS.includes(songSettingsPendingKey) ? songSettingsPendingKey : DEFAULT_KEY;
    if (newBpm !== currentSong.tempo_bpm || newNum !== currentSong.time_sig_num || newDen !== currentSong.time_sig_den) {
        currentSong.tempo_bpm = newBpm;
        currentSong.time_sig_num = newNum;
        currentSong.time_sig_den = newDen;
        unsavedChanges = true;
    }
    /* Changing the key transposes existing chords so the song stays in the
     * same relative harmony. */
    const oldKey = currentSong.key || DEFAULT_KEY;
    if (newKey !== oldKey) {
        transposeSongChords(currentSong, oldKey, newKey);
        currentSong.key = newKey;
        unsavedChanges = true;
    }
    menuStack.pop();
    currentView = VIEW_BUILDER;
    stepLedsDirty = true;
    needsRedraw = true;
}

function handleSongSettingsInput(cc, value) {
    const locked = songIsLocked();
    if (cc === MoveMainKnob) {
        const delta = decodeDelta(value);
        if (songSettingsEditing) {
            if (songSettingsFocus === 0) {
                /* Name editing handled via text entry, not jog. */
            } else if (songSettingsFocus === 1) {
                songSettingsPendingBpm = Math.max(20, Math.min(300, songSettingsPendingBpm + delta));
            } else if (songSettingsFocus === 2) {
                if (delta > 0) {
                    const steps = [1, 2, 4, 8, 16];
                    const idx = steps.indexOf(songSettingsPendingDen);
                    if (idx < steps.length - 1) {
                        songSettingsPendingDen = steps[idx + 1];
                    } else {
                        songSettingsPendingNum = Math.max(1, Math.min(16, songSettingsPendingNum + 1));
                    }
                } else if (delta < 0) {
                    const steps = [1, 2, 4, 8, 16];
                    const idx = steps.indexOf(songSettingsPendingDen);
                    if (idx > 0) {
                        songSettingsPendingDen = steps[idx - 1];
                    } else {
                        songSettingsPendingNum = Math.max(1, Math.min(16, songSettingsPendingNum - 1));
                    }
                }
            } else if (songSettingsFocus === 3) {
                const idx = KEYS.indexOf(songSettingsPendingKey);
                const next = ((idx + delta) % KEYS.length + KEYS.length) % KEYS.length;
                songSettingsPendingKey = KEYS[next];
            }
        } else {
            songSettingsFocus = Math.max(0, Math.min(SONG_SETTINGS_CLICK_ROW, songSettingsFocus + delta));
        }
        needsRedraw = true;
    } else if (cc === MoveMainButton && value > 0) {
        if (songSettingsFocus === SONG_SETTINGS_CLICK_ROW) {
            /* The click on or off (it was Track 4 on the Click track). Not
             * part of the song, so a locked song allows it too. */
            toggleClick();
            return;
        }
        if (songSettingsFocus === SONG_SETTINGS_RESTORE_ROW) {
            /* A locked song cannot be edited, and a restore replaces it. */
            if (!locked) openSongBackups();
            needsRedraw = true;
            return;
        }
        if (songSettingsFocus === 4) {
            /* Lock Song row: toggle the lock. Toggling is always allowed
             * (so a locked song can be unlocked here). */
            currentSong.locked = !locked;
            songSettingsEditing = false;
            unsavedChanges = true;
            saveCurrentSong();
        } else if (locked) {
            /* A locked song's other settings are read-only until unlocked. */
            needsRedraw = true;
        } else if (songSettingsFocus === 0) {
            /* Rename song via text entry. */
            openTextEntry({
                title: "Rename",
                initialText: currentSong ? currentSong.name : "",
                onConfirm: (newName) => {
                    if (!newName || newName.trim().length === 0) return;
                    const trimmed = newName.trim();
                    if (currentSong) {
                        currentSong.name = trimmed;
                        unsavedChanges = true;
                    }
                    saveCurrentSong();
                    needsRedraw = true;
                },
                onCancel: () => { needsRedraw = true; }
            });
        } else {
            songSettingsEditing = !songSettingsEditing;
        }
        needsRedraw = true;
    } else if (cc === MoveBack && value > 0) {
        if (songSettingsEditing) {
            songSettingsEditing = false;
            needsRedraw = true;
        } else {
            commitSongSettings();
            saveCurrentSong();
        }
    }
}

/* ── Song Settings > Restore Backup ────────────────────────────────────── */

const SONG_SETTINGS_RESTORE_ROW = 5;
const SONG_SETTINGS_CLICK_ROW = 6;
let songSettingsBackupCount = 0;
let songBackupList = [];      /* [{ file, path, label, sections }] newest first */
let songBackupSelected = 0;

/* This song's backups, newest first. Backup files are named by their UTC
 * time (2026-09-30T10-03-47-882Z.json, with "-2" etc. appended for a second
 * one in the same millisecond); shown in the Move's local time. */
function listSongBackups(name) {
    if (typeof os.readdir !== "function") return [];
    const dir = songBackupDir(name);
    let names = [];
    try {
        const raw = os.readdir(dir);
        const list = Array.isArray(raw) ? (Array.isArray(raw[0]) ? raw[0] : raw) : [];
        names = list.filter(nm => typeof nm === "string" && nm.endsWith(".json"));
    } catch (e) { return []; }
    names.sort().reverse();
    const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const pad = n => (n < 10 ? "0" : "") + n;
    /* "5 Oct 08:04" -- the seconds only where two backups share a minute,
     * to leave room for the section count spelled out ("12 sections"; "sec"
     * read as seconds). */
    const list = names.map(file => {
        const m = file.match(/^(\d{4})-(\d\d)-(\d\d)T(\d\d)-(\d\d)-(\d\d)/);
        let label = file.replace(/\.json$/, ""), secs = "";
        if (m) {
            const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
            label = d.getDate() + " " + MONTHS[d.getMonth()] + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
            secs = ":" + pad(d.getSeconds());
        }
        return { file, path: dir + "/" + file, label, secs, sections: null };
    });
    for (const e of list) {
        if (e.secs && list.filter(o => o.label === e.label).length > 1) e.dup = true;
    }
    for (const e of list) {
        if (e.dup) e.label += e.secs;
        delete e.secs;
        delete e.dup;
    }
    return list;
}

function openSongBackups() {
    if (!currentSong || !activeSongFile) return;
    songBackupList = listSongBackups(currentSong.name);
    songBackupSelected = 0;
    currentView = VIEW_SONG_BACKUPS;
    menuStack.push({ title: "Restore Backup", selectedIndex: 0 });
    needsRedraw = true;
}

function closeSongBackups() {
    menuStack.pop();
    currentView = VIEW_SONG_SETTINGS;
    songSettingsBackupCount = listSongBackups(currentSong ? currentSong.name : "").length;
    needsRedraw = true;
}

/* Section count of a backup, read once when its row is first drawn: the
 * quickest way to tell a good version from a damaged one. */
function songBackupSections(entry) {
    if (entry.sections === null) {
        const obj = readJson(entry.path);
        entry.sections = (obj && Array.isArray(obj.sections)) ? obj.sections.length : -1;
    }
    return entry.sections;
}

function drawSongBackups() {
    drawMenuHeader("Restore Backup", "");
    if (songBackupList.length === 0) {
        print(4, LIST_TOP_Y, "No backups yet", 1);
        return;
    }
    drawMenuList({
        ...LIST_ROW_FIT,
        labelX: 3,
        items: songBackupList,
        selectedIndex: songBackupSelected,
        getLabel: (item) => item.label,
        getValue: (item) => {
            const n = songBackupSections(item);
            return n < 0 ? "?" : n + (n === 1 ? " section" : " sections");
        },
        valueAlignRight: true,
        labelGap: 2,
        listArea: { topY: LIST_TOP_Y, bottomY: LIST_INDICATOR_BOTTOM_Y }
    });
}

/* Make the chosen backup the song. The state being replaced -- including any
 * edit not yet saved -- is first kept as a new backup of its own, so a
 * restore can itself be undone from this same list. */
function restoreSongBackup(entry) {
    if (!currentSong || !activeSongFile) return;
    let text = null;
    try { text = host_read_file(entry.path); } catch (e) { text = null; }
    let obj = null;
    try { obj = text ? JSON.parse(text) : null; } catch (e) { obj = null; }
    if (!obj || !Array.isArray(obj.sections)) {
        showPopup("Restore failed", "Unreadable backup", 3000);
        logDebug("restoreSongBackup: unreadable " + entry.path);
        return;
    }
    const path = activeSongFile;
    const name = currentSong.name;
    /* Read before writing: the new backup below trims the folder to
     * MAX_SONG_BACKUPS, which could remove the oldest -- the chosen one. */
    const current = tempSongOrigin.get(currentSong) || currentSong;
    normalizeSongForSave(current);
    writeSongBackup(name, JSON.stringify(current, null, 2));
    host_write_file(path, text);
    logDebug("restoreSongBackup: " + entry.file + " -> " + path + " (sections=" + obj.sections.length + ")");
    if (!loadSongFile(path)) return;
    if (!currentSong.sections || currentSong.sections.length === 0) {
        currentSong.sections = [newSection("Section 1")];
        unsavedChanges = true;
    }
    /* Back to the builder, as if the song had just been opened. */
    builderPage = 0;
    builderCursor = 0;
    loadFolderClips(folderIndexForPath(currentSong.source_folder));
    pendingFolderClipLoadName = (folderClips.length === 0) ? currentSong.source_folder : null;
    requestSongRescan();
    menuStack.pop();   /* Restore Backup */
    menuStack.pop();   /* Settings */
    currentView = VIEW_BUILDER;
    stepLedsDirty = true;
    ledDirtyAll = true;
    needsRedraw = true;
    showPopup("Backup restored", entry.label, 3000);
}

function handleSongBackupsInput(cc, value) {
    if (cc === MoveMainKnob) {
        const delta = decodeDelta(value);
        if (songBackupList.length > 0) {
            songBackupSelected = Math.max(0, Math.min(songBackupList.length - 1, songBackupSelected + delta));
        }
        needsRedraw = true;
    } else if (cc === MoveMainButton && value > 0) {
        const entry = songBackupList[songBackupSelected];
        if (!entry) return;
        const n = songBackupSections(entry);
        openConfirm({
            title: "Restore Backup?",
            name: entry.label + (n >= 0 ? " (" + n + " sec)" : ""),
            onConfirm: () => restoreSongBackup(entry),
            onCancel: () => { needsRedraw = true; }
        });
    } else if (cc === MoveBack && value > 0) {
        closeSongBackups();
    }
}

function drawSongBank() {
    /* Still scanning with songs already listed: they are the previous scan's,
     * so say a refresh is on its way. */
    const loading = listLoading("songs");
    drawMenuHeader("Song Bank", loading && songFiles.length > 0 ? "..." : "");
    const items = [{ label: "+ New Song" }].concat(songFiles.map(f => ({ label: shortSongName(f.name || f) })));
    /* Display only: selection is bounded by songFiles, so it cannot land here. */
    if (loading && songFiles.length === 0) items.push({ label: loadingText("songs") });
    /* Mark locked songs with "*" in the value column. */
    const lockMap = new Map();
    for (const f of songFiles) {
        const obj = readJson(f.path);
        if (obj && obj.locked) lockMap.set(f.name, true);
    }
    drawMenuList({
        ...LIST_ROW_FIT,
        labelX: 3,
        items,
        selectedIndex: selectedSongIndex,
        getLabel: (item) => item.label,
        getValue: (item) => (item.label && lockMap.has(item.label)) ? "*" : "",
        valueAlignRight: true,
        labelGap: 2,
        maxVisible: 5
    });
}

/* The Options list. Rows up to Chains open a submenu; the rest edit in place. */
function optionsRows() {
    const route = (o, ch) => (OUTPUT_LABELS[o] || o) + " " + ch;
    return [
        { key: "drums", label: "Drums", value: currentOutputLabel() + " " + activeOutputChannel() },
        { key: "inst1", label: "Inst 1", value: route(inst1Output, inst1Channel) },
        { key: "inst2", label: "Inst 2", value: route(inst2Output, inst2Channel) },
        { key: "inst3", label: "Pads", value: route(inst3Output, inst3Channel) },
        { key: "click", label: "Click", value: route(clickOutput, clickMidiChannel) },
        { key: "keys", label: "Keys", value: route(keysOutput, keysChannel) },
        { key: "chains", label: "Chains", value: "Chain " + (optionsChainIndex + 1) },
        { key: "swapguard", label: "Swap Guard", value: Math.round(swapGuardFraction * 100) + "%" },
        { key: "clock", label: "Schwung Clock", value: sendClock ? "On" : "Off" },
        { key: "dspdebug", label: "DSP Debug", value: dspDebugEnabled ? "On" : "Off" }
    ];
}

function drawOptions() {
    drawMenuHeader("Options", "");
    const items = optionsRows();
    drawMenuList({
        ...LIST_ROW_FIT,
        labelX: 3,
        items,
        selectedIndex: optionsFocus,
        getLabel: (item) => item.label,
        getValue: (item) => item.value,
        valueAlignRight: true,
        editMode: optionsEditing,
        labelGap: 2,
        prioritizeSelectedValue: true,
        selectedMinLabelChars: 7,
        listArea: { topY: LIST_TOP_Y, bottomY: LIST_INDICATOR_BOTTOM_Y }
    });
}

/* Drums and Instrument 1/2 are Output + MIDI Channel submenus off the
 * Options list; Drums has a 3rd row, Drop Note-Offs (see dropNoteOffs's
 * declaration). Drums edits the existing global output/channel state used
 * for the drum track; the instrument submenus edit inst1Output/inst1Channel
 * or inst2Output/inst2Channel depending on optionsInstIndex. */
function drawOptionsDrums() {
    drawMenuHeader("Drums", "");
    const items = [
        { key: "output", label: "Output", value: currentOutputLabel() },
        { key: "channel", label: "MIDI Channel", value: String(activeOutputChannel()) },
        { key: "dropnoteoffs", label: "Drop Note-Offs", value: dropNoteOffs ? "On" : "Off" }
    ];
    drawMenuList({
        ...LIST_ROW_FIT,
        labelX: 3,
        items,
        selectedIndex: optionsSubFocus,
        getLabel: (item) => item.label,
        getValue: (item) => item.value,
        valueAlignRight: true,
        editMode: optionsSubEditing,
        labelGap: 2,
        prioritizeSelectedValue: true,
        selectedMinLabelChars: 7,
        listArea: { topY: LIST_TOP_Y, bottomY: LIST_INDICATOR_BOTTOM_Y }
    });
}

/* Instrument i's (1 Inst 1, 2 Inst 2, 3 Pads) output route. */
function instOutputOf(i) { return i === 1 ? inst1Output : i === 2 ? inst2Output : inst3Output; }
function instChannelOf(i) { return i === 1 ? inst1Channel : i === 2 ? inst2Channel : inst3Channel; }
function setInstRoute(i, output, channel) {
    if (i === 1) { inst1Output = output; inst1Channel = channel; }
    else if (i === 2) { inst2Output = output; inst2Channel = channel; }
    else { inst3Output = output; inst3Channel = channel; }
}

function drawOptionsInst() {
    const output = instOutputOf(optionsInstIndex);
    const channel = instChannelOf(optionsInstIndex);
    drawMenuHeader(INST_TRACK_NAMES[optionsInstIndex - 1] || "Inst", "");
    const items = [
        { key: "output", label: "Output", value: OUTPUT_LABELS[output] || output },
        { key: "channel", label: "MIDI Channel", value: String(channel) }
    ];
    drawMenuList({
        ...LIST_ROW_FIT,
        labelX: 3,
        items,
        selectedIndex: optionsSubFocus,
        getLabel: (item) => item.label,
        getValue: (item) => item.value,
        valueAlignRight: true,
        editMode: optionsSubEditing,
        labelGap: 2,
        prioritizeSelectedValue: true,
        selectedMinLabelChars: 7,
        listArea: { topY: LIST_TOP_Y, bottomY: LIST_INDICATOR_BOTTOM_Y }
    });
}

function openOptionsDrums() {
    optionsSubFocus = 0;
    optionsSubEditing = false;
    currentView = VIEW_OPTIONS_DRUMS;
    menuStack.push({ title: "Drums", selectedIndex: 0 });
    needsRedraw = true;
}

/* Options > Click: the click track's Output, MIDI Channel and the notes it
 * sends -- Accent on beat 1, Normal on the other beats. */
function openOptionsClick() {
    optionsSubFocus = 0;
    optionsSubEditing = false;
    currentView = VIEW_OPTIONS_CLICK;
    menuStack.push({ title: "Click", selectedIndex: 0 });
    needsRedraw = true;
}

function midiNoteLabel(n) {
    return n + " " + NOTE_NAMES[n % 12] + (Math.floor(n / 12) - 1);
}

function drawOptionsClick() {
    drawMenuHeader("Click", "");
    const items = [
        { key: "output", label: "Output", value: OUTPUT_LABELS[clickOutput] || clickOutput },
        { key: "channel", label: "MIDI Channel", value: String(clickMidiChannel) },
        { key: "accent", label: "Accent Note", value: midiNoteLabel(clickAccentNote) },
        { key: "normal", label: "Normal Note", value: midiNoteLabel(clickNormalNote) },
        { key: "volume", label: "Volume", value: clickVolume + "%" }
    ];
    drawMenuList({
        ...LIST_ROW_FIT,
        labelX: 3,
        items,
        selectedIndex: optionsSubFocus,
        getLabel: (item) => item.label,
        getValue: (item) => item.value,
        valueAlignRight: true,
        editMode: optionsSubEditing,
        labelGap: 2,
        prioritizeSelectedValue: true,
        selectedMinLabelChars: 7,
        listArea: { topY: LIST_TOP_Y, bottomY: LIST_INDICATOR_BOTTOM_Y }
    });
}

function handleOptionsClickInput(cc, value) {
    if (cc === MoveMainKnob) {
        const delta = decodeDelta(value);
        if (optionsSubEditing) {
            if (optionsSubFocus === 0) {
                const idx = Math.max(0, Math.min(OUTPUT_TARGETS.length - 1, OUTPUT_TARGETS.indexOf(clickOutput) + delta));
                clickOutput = OUTPUT_TARGETS[idx];
            } else if (optionsSubFocus === 1) {
                clickMidiChannel = Math.max(1, Math.min(16, clickMidiChannel + delta));
            } else if (optionsSubFocus === 2) {
                clickAccentNote = Math.max(0, Math.min(127, clickAccentNote + delta));
            } else if (optionsSubFocus === 3) {
                clickNormalNote = Math.max(0, Math.min(127, clickNormalNote + delta));
            } else {
                clickVolume = Math.max(0, Math.min(100, clickVolume + delta * 5));
            }
            saveOutputSettings();
            pushClickToDsp();
        } else {
            const newIdx = Math.max(0, Math.min(4, optionsSubFocus + delta));
            if (newIdx !== optionsSubFocus) optionsSubFocus = newIdx;
        }
        needsRedraw = true;
    } else if (cc === MoveMainButton && value > 0) {
        optionsSubEditing = !optionsSubEditing;
        needsRedraw = true;
    } else if (cc === MoveBack && value > 0) {
        if (optionsSubEditing) {
            optionsSubEditing = false;
            needsRedraw = true;
        } else {
            menuStack.pop();
            currentView = VIEW_OPTIONS;
            needsRedraw = true;
        }
    }
}

function openOptionsInst(index) {
    optionsInstIndex = index;
    optionsSubFocus = 0;
    optionsSubEditing = false;
    currentView = VIEW_OPTIONS_INST;
    menuStack.push({ title: INST_TRACK_NAMES[index - 1] || "Inst", selectedIndex: 0 });
    needsRedraw = true;
}

/* Options > Keys: where Perform/Jam's playable pads (Capture) send, and how
 * they are laid out. */
function keysOptionRows() {
    return [
        { key: "output", label: "Output", value: OUTPUT_LABELS[keysOutput] || keysOutput },
        { key: "channel", label: "MIDI Channel", value: String(keysChannel) },
        { key: "layout", label: "Layout", value: KEYS_LAYOUTS[keysLayout] },
        { key: "scale", label: "Scale", value: KEYS_SCALES[keysScale].name },
        { key: "octave", label: "Octave", value: String(keysStartOctave) }
    ];
}

function openOptionsKeys() {
    optionsSubFocus = 0;
    optionsSubEditing = false;
    currentView = VIEW_OPTIONS_KEYS;
    menuStack.push({ title: "Keys", selectedIndex: 0 });
    needsRedraw = true;
}

function drawOptionsKeys() {
    drawMenuHeader("Keys", "");
    drawMenuList({
        ...LIST_ROW_FIT,
        labelX: 3,
        items: keysOptionRows(),
        selectedIndex: optionsSubFocus,
        getLabel: (item) => item.label,
        getValue: (item) => item.value,
        valueAlignRight: true,
        editMode: optionsSubEditing,
        labelGap: 2,
        prioritizeSelectedValue: true,
        selectedMinLabelChars: 6,
        listArea: { topY: LIST_TOP_Y, bottomY: LIST_INDICATOR_BOTTOM_Y }
    });
}

function handleOptionsKeysInput(cc, value) {
    const rows = keysOptionRows();
    const key = (rows[optionsSubFocus] || rows[0]).key;
    if (cc === MoveMainKnob) {
        const delta = decodeDelta(value);
        if (optionsSubEditing) {
            const clampStep = (v, lo, hi) => Math.max(lo, Math.min(hi, v + delta));
            if (key === "output") keysOutput = OUTPUT_TARGETS[clampStep(OUTPUT_TARGETS.indexOf(keysOutput), 0, OUTPUT_TARGETS.length - 1)];
            else if (key === "channel") keysChannel = clampStep(keysChannel, 1, 16);
            else if (key === "layout") keysLayout = clampStep(keysLayout, 0, KEYS_LAYOUTS.length - 1);
            else if (key === "scale") keysScale = clampStep(keysScale, 0, KEYS_SCALES.length - 1);
            else if (key === "octave") keysStartOctave = clampStep(keysStartOctave, -1, 8);
            saveOutputSettings();
            pushKeysToDsp();
        } else {
            optionsSubFocus = Math.max(0, Math.min(rows.length - 1, optionsSubFocus + delta));
        }
        needsRedraw = true;
    } else if (cc === MoveMainButton && value > 0) {
        optionsSubEditing = !optionsSubEditing;
        needsRedraw = true;
    } else if (cc === MoveBack && value > 0) {
        if (optionsSubEditing) {
            optionsSubEditing = false;
        } else {
            menuStack.pop();
            currentView = VIEW_OPTIONS;
        }
        needsRedraw = true;
    }
}

/* Options > Chains: Schwung's chain slots as Arranger sees them. Rows: the
 * chain (1-4), its receive channel (editable here), and Edit Chain, which
 * opens Schwung's editor for it alongside Arranger (the same as holding its
 * Track button). Point a track's Output at Schwung on a chain's channel to
 * play that chain. Reads and writes go to the SHIM's slot keys
 * (slot:receive_channel, synth:name) through the shared shadow_ui bindings,
 * the same keys Schwung's Slot Settings and Schwung Manager use -- no DSP
 * round trip and no host patch. */
function readChainSlotParam(slot, key) {
    if (typeof shadow_get_param !== "function") return null;
    try {
        const v = shadow_get_param(slot, key);
        return typeof v === "string" ? v : null;
    } catch (e) {
        return null;
    }
}

function readChainChannel(slot) {
    const raw = readChainSlotParam(slot, "slot:receive_channel");
    const n = raw ? parseInt(raw, 10) : NaN;
    return (Number.isFinite(n) && n >= 0 && n <= 16) ? n : null;
}

function refreshChainInfo() {
    chainInfoChannel = readChainChannel(optionsChainIndex);
    /* synth_module is "" for an empty chain; synth:name is the module's
     * display name, with the id as the fallback. */
    const moduleId = readChainSlotParam(optionsChainIndex, "synth_module");
    if (moduleId === null) {
        chainInfoSynth = null;
    } else if (moduleId === "") {
        chainInfoSynth = "";
    } else {
        const name = readChainSlotParam(optionsChainIndex, "synth:name");
        chainInfoSynth = name ? name : moduleId;
    }
    needsRedraw = true;
}

/* A receive channel write, then a read-back: the slot is the authority, and
 * under overtake a plain shadow_set_param is fire-and-forget (dropped when
 * the param channel is busy -- which Arranger's own DSP polling makes it
 * often), so the blocking variant is used where the host has it. */
function writeChainChannel(slot, channel) {
    const val = String(channel);
    try {
        if (typeof shadow_set_param_timeout === "function") {
            shadow_set_param_timeout(slot, "slot:receive_channel", val, 200);
        } else if (typeof shadow_set_param === "function") {
            shadow_set_param(slot, "slot:receive_channel", val);
        }
    } catch (e) {
        logDebug("chains: write failed " + e);
    }
    if (slot === optionsChainIndex) {
        chainInfoChannel = readChainChannel(slot);
        needsRedraw = true;
    }
}

function chainChannelLabel(ch) {
    if (ch === null) return "\u2014";
    return ch === 0 ? "All" : String(ch);
}

function drawOptionsChains() {
    drawMenuHeader("Chain " + (optionsChainIndex + 1), "");
    const synth = chainInfoSynth === null ? "\u2014" : (chainInfoSynth === "" ? "Empty" : chainInfoSynth);
    const items = [
        { key: "chain", label: "Chain", value: String(optionsChainIndex + 1) },
        { key: "channel", label: "MIDI Channel", value: chainChannelLabel(chainInfoChannel) },
        { key: "edit", label: "Edit Chain", value: synth }
    ];
    drawMenuList({
        ...LIST_ROW_FIT,
        labelX: 3,
        items,
        selectedIndex: optionsSubFocus,
        getLabel: (item) => item.label,
        getValue: (item) => item.value,
        valueAlignRight: true,
        editMode: optionsSubEditing,
        labelGap: 2,
        prioritizeSelectedValue: true,
        selectedMinLabelChars: 7,
        listArea: { topY: LIST_TOP_Y, bottomY: LIST_INDICATOR_BOTTOM_Y }
    });
}

function openOptionsChains() {
    optionsSubFocus = 0;
    optionsSubEditing = false;
    currentView = VIEW_OPTIONS_CHAINS;
    menuStack.push({ title: "Chain " + (optionsChainIndex + 1), selectedIndex: 0 });
    refreshChainInfo();
}

function drawSetlistBank() {
    drawMenuHeader("Setlists", "");
    const items = [{ label: "+ New Setlist" }].concat(setlistFiles.map(f => ({ label: f.name || f })));
    drawMenuList({
        labelX: 3,
        items,
        selectedIndex: selectedSetlistIndex,
        getLabel: (item) => item.label,
        getValue: () => "",
        maxVisible: 5
    });
}

function drawSetlistEdit() {
    drawMenuHeader(scrollHeader("Edit: " + (currentSetlist ? currentSetlist.name : ""), 28), "");
    const songs = currentSetlist ? currentSetlist.songs : [];
    const items = songs.map((s, i) => ({ type: "song", index: i, name: shortSongName(s.name) || "" }));
    items.push({ type: "add" });
    items.push({ type: "knobs" });
    drawMenuList({
        labelX: 3,
        items,
        selectedIndex: setlistSongIndex,
        getLabel: (item) => {
            if (item.type === "add") return "(add song)";
            if (item.type === "knobs") return "(knobs)";
            /* Return the full name so the shared list scroller marquees the
             * selected row instead of hard-truncating it. */
            return item.name || "";
        },
        getValue: (item) => {
            if (item.type === "knobs") return knobMappedCount(currentSetlist && currentSetlist.knobs) + "/" + KNOB_SLOTS;
            return "";
        },
        maxVisible: 5
    });
}

function drawSetlistPick() {
    drawMenuHeader(scrollHeader("Add Song: " + (currentSetlist ? shortSongName(currentSetlist.name) : ""), 24), "");
    const items = songFiles.map(f => ({ label: shortSongName(f.name || f) }));
    if (items.length === 0) {
        print(4, LIST_TOP_Y, listLoading("songs") ? loadingText("songs") : "No songs yet", 1);
        return;
    }
    drawMenuList({
        labelX: 3,
        items,
        selectedIndex: setlistPickIndex,
        getLabel: (item) => item.label,
        getValue: () => "",
        maxVisible: 5
    });
}

function sectionPickNames() {
    return sectionPickRename ? ["Custom..."].concat(SECTION_NAMES) : SECTION_NAMES;
}

function drawSectionPick() {
    drawMenuHeader(sectionPickRename ? "Rename Section" : "New Section Name", "");
    const items = sectionPickNames().map(n => ({ label: n }));
    drawMenuList({
        labelX: 3,
        items,
        selectedIndex: sectionPickIndex,
        getLabel: (item) => item.label,
        getValue: () => "",
        maxVisible: 5
    });
}

/* Setlist Edit > a song: how this setlist plays it. Key, Tempo and Sections
 * change the song for this setlist only (see applySetlistEdits); Sections
 * and Knobs open their own screens. */
const SETLIST_SONG_ROWS = [
    { key: "bars", label: "Click Bars" },
    { key: "sound", label: "Click Sound" },
    { key: "stop", label: "Stop At End" },
    { key: "skey", label: "Key" },
    { key: "tempo", label: "Tempo" },
    { key: "sections", label: "Sections", opens: true },
    { key: "knobs", label: "Knobs", opens: true }
];

/* The setlist song's file, read once per visit to its screens: its own key,
 * tempo and sections, which the setlist's edits are shown against. */
let setlistSongFileCache = null;   /* { path, song } */
function setlistSongFile(entry) {
    if (!entry) return null;
    if (!setlistSongFileCache || setlistSongFileCache.path !== entry.path) {
        setlistSongFileCache = { path: entry.path, song: readJson(entry.path) };
    }
    return setlistSongFileCache.song;
}

function setlistEntry() {
    return currentSetlist ? currentSetlist.songs[setlistSongIndex] : null;
}

function setlistSongRowValue(entry, key) {
    const song = setlistSongFile(entry);
    if (key === "bars") { const bars = entry ? (entry.click_bars || 0) : 0; return bars === 0 ? "Off" : String(bars); }
    if (key === "sound") return clickSoundOn(entry) ? "On" : "Off";
    if (key === "stop") return entry && entry.stop_after_finish ? "Yes" : "No";
    if (key === "skey") return entry && entry.key ? keyLabel(entry.key) : "Song (" + keyLabel((song && song.key) || DEFAULT_KEY) + ")";
    if (key === "tempo") return entry && entry.tempo_bpm ? String(entry.tempo_bpm) : "Song (" + ((song && song.tempo_bpm) || 120) + ")";
    if (key === "sections") return entry && Array.isArray(entry.sections) ? setlistSectionIndices(song, entry).length + " set" : "Song";
    if (key === "knobs") return knobOverrideCount(entry) ? knobOverrideCount(entry) + " own" : "Setlist";
    return "";
}

function drawSetlistClick() {
    const entry = setlistEntry();
    drawMenuHeader(scrollHeader("Edit: " + (entry ? shortSongName(entry.name) : ""), 28), "");
    drawMenuList({
        ...LIST_ROW_FIT,
        labelX: 3,
        items: SETLIST_SONG_ROWS,
        selectedIndex: clickSettingsFocus,
        getLabel: (item) => item.label,
        getValue: (item) => setlistSongRowValue(entry, item.key),
        valueAlignRight: true,
        editMode: clickSettingsEditing,
        labelGap: 2,
        listArea: { topY: LIST_TOP_Y, bottomY: LIST_INDICATOR_BOTTOM_Y }
    });
}

/* Key: the song's own, then each key; landing on the song's key is the
 * song's own again (no edit). */
function stepSetlistKey(entry, delta) {
    const song = setlistSongFile(entry);
    const own = (song && song.key) || DEFAULT_KEY;
    const cur = entry.key || own;
    const idx = KEYS.indexOf(cur);
    const next = KEYS[(((idx < 0 ? 0 : idx) + delta) % KEYS.length + KEYS.length) % KEYS.length];
    if (next === own) delete entry.key; else entry.key = next;
}

/* Tempo: from the song's own, 20-300; back at the song's is no edit. */
function stepSetlistTempo(entry, delta) {
    const song = setlistSongFile(entry);
    const own = (song && song.tempo_bpm) || 120;
    const next = Math.max(20, Math.min(300, (entry.tempo_bpm || own) + delta));
    if (next === own) delete entry.tempo_bpm; else entry.tempo_bpm = next;
}

/* The Menu Header's proportional 4x5 face, drawn through the device's
 * fill_rect. The performance display uses it so its text matches the Menu
 * Header chrome. font4x5 is uppercase-only, so text is ascii-folded and
 * uppercased (the same register the Menu Header uses) before drawing. */
const perfCtx = {
    fillRect: (x, y, w, h, color) => fill_rect(x, y, w, h, color)
};
function perfPrint(x, y, text, color) {
    fontPrint4x5(perfCtx, x, y, asciiFold(String(text)).toUpperCase(), color);
}

/* A key in the same face, which has capitals only: its flat is drawn as a
 * small b (a 3x5 b), so Bb does not read as BB. The text between flats is
 * drawn as runs, so the face's own spacing holds. */
function perfKeyRuns(text) {
    /* A "b" after the first character is a flat. */
    const t = String(text), runs = [];
    let cur = "";
    for (let i = 0; i < t.length; i++) {
        if (t[i] === "b" && i > 0) { if (cur) runs.push(cur); runs.push(null); cur = ""; }
        else cur += t[i];
    }
    if (cur) runs.push(cur);
    return runs;
}
const PERF_FLAT_W = 3;
/* Pixel width, as perfTextWidth: the last glyph's trailing gap left out. */
function perfKeyWidth(text) {
    const runs = perfKeyRuns(text);
    let w = 0;
    runs.forEach((r, i) => { w += (r === null ? PERF_FLAT_W : perfTextWidth(r)) + (i < runs.length - 1 ? 1 : 0); });
    return w;
}
function perfPrintKey(x, y, text) {
    for (const r of perfKeyRuns(text)) {
        if (r === null) {
            /* #.. / #.. / ### / #.# / ### */
            fill_rect(x, y, 1, 5, 1);
            fill_rect(x + 1, y + 2, 2, 1, 1);
            fill_rect(x + 1, y + 4, 2, 1, 1);
            fill_rect(x + 2, y + 3, 1, 1, 1);
            x += PERF_FLAT_W + 1;
        } else {
            perfPrint(x, y, r, 1);
            x += perfTextWidth(r) + 1;
        }
    }
}

/* Pixel width of `text` as perfPrint draws it. */
function perfTextWidth(text) {
    return fontWidth4x5(asciiFold(String(text)).toUpperCase());
}

/* Trim `text` from the end until it fits in `px` pixels. The face is
 * proportional (an M or W is wider than an I), so a character count alone
 * doesn't keep a line on screen. */
function perfFitText(text, px) {
    let t = String(text);
    while (t.length > 0 && perfTextWidth(t) > px) t = t.substring(0, t.length - 1);
    return t;
}

/* How many leading characters of `text` fit in `px` pixels. */
function perfCharsThatFit(text, px) {
    return perfFitText(text, px).length;
}

/* Resolve the effective current song for the performance display, falling
 * back to the setlist entry when no song has been loaded yet. */
function getPerfDisplaySong() {
    if (currentSong) return currentSong;
    if (!currentSetlist || perfSongIndex < 0 || perfSongIndex >= currentSetlist.songs.length) return null;
    const path = currentSetlist.songs[perfSongIndex].path;
    const obj = path ? readJson(path) : null;
    return obj ? toUiSong(obj) : null;
}

function drawPerformance() {
    /* Always base the performance display on the full original song. The
     * live `currentSong` may be a sliced one-shot (after a section jump), which
     * shifts section indices and breaks stopped-state preview names. */
    const fullSong = perfFullSong || getPerfDisplaySong() || currentSong;
    const displaySong = perfClickPlaying ? (perfFullSong || fullSong) : fullSong;
    /* Pass the FULL name to the scroller (no pre-truncation) so long song
     * names marquee and reveal their whole text. */
    const songName = displaySong ? shortSongName(displaySong.name) : "No song";

    const hasClick = currentSetlist && perfSongIndex >= 0 &&
        (currentSetlist.songs[perfSongIndex]?.click_bars || 0) > 0;

    /* During the click track, the current section is the click. When stopped
     * on a song that has a count-in, also show "Click" as the default current
     * section. A manually selected section overrides this. */
    let secName = "";
    if (perfClickPlaying) {
        secName = "Click";
    } else if (!perfPlaying && hasClick && perfSelectedSection < 0) {
        secName = "Click";
    } else if (!perfPlaying && perfSelectedSection >= 0 && fullSong) {
        secName = fullSong.sections[perfSelectedSection]?.name || "";
    } else if (fullSong) {
        secName = fullSong.sections[playbackSectionIndex]?.name || "";
    }

    /* Next song in the setlist. */
    let nextSongName = "";
    if (currentSetlist) {
        const nextSong = currentSetlist.songs[perfSongIndex + 1];
        nextSongName = nextSong ? shortSongName(nextSong.name) : "";
    }

    /* Next section: during click it's the first real section; when stopped
     * with a manual section selection, preview the section after the selection;
     * otherwise the next section in the current song, or the next song at the end.
     * A queued section jump takes priority and shows the target section's name. */
    let nextSecName = "";
    const stoppedSelection = !perfPlaying && perfSelectedSection >= 0 ? perfSelectedSection : -1;
    if (fullSong) {
        if (perfQueuedSection >= 0 && perfQueuedSection !== playbackSectionIndex && perfQueuedSection < fullSong.sections.length) {
            /* A jump to a different section: show that target. */
            nextSecName = fullSong.sections[perfQueuedSection]?.name || "";
        } else if (perfQueuedSection >= 0 && perfQueuedSection === playbackSectionIndex) {
            /* A repeat of the current section: it plays again, so Nsec shows
             * the current section's name. */
            nextSecName = fullSong.sections[playbackSectionIndex]?.name || "";
        } else if (perfClickPlaying || (!perfPlaying && hasClick && perfSelectedSection < 0)) {
            nextSecName = fullSong.sections[0]?.name || "";
        } else if (stoppedSelection >= 0) {
            if (stoppedSelection + 1 < fullSong.sections.length) {
                nextSecName = fullSong.sections[stoppedSelection + 1]?.name || "";
            } else if (currentSetlist && currentSetlist.songs[perfSongIndex + 1]) {
                nextSecName = "Next song";
            }
        } else if (playbackSectionIndex + 1 < fullSong.sections.length) {
            nextSecName = fullSong.sections[playbackSectionIndex + 1]?.name || "";
        } else if (currentSetlist && currentSetlist.songs[perfSongIndex + 1]) {
            nextSecName = "Next song";
        }
    }
    /* Log only on change, not every tick (drawPerformance runs every tick
     * while this view is shown). Unconditional logging here was firing ~25x/
     * sec at idle -- and logDebug then read the WHOLE log file, truncated it
     * to the last 20000 characters and rewrote it on every single call (it
     * appends now, see appendLogLine, but the window is the same size). At that
     * rate the 20KB window was pure idle PERFDISP spam within a few seconds,
     * permanently evicting whatever happened moments earlier -- which is
     * exactly why every attempt to read this log after a reported bug (a
     * stop-at-end-then-Play sequence, in particular) came back with nothing
     * but PERFDISP lines showing an unchanged idle state. */
    const perfDispKey = songName + "|" + secName + "|" + nextSecName + "|" + hasClick +
        "|" + perfClickPlaying + "|" + perfPlaying + "|" + perfSelectedSection + "|" + playbackSectionIndex;
    if (perfDispKey !== lastPerfDispKey) {
        lastPerfDispKey = perfDispKey;
        logDebug("PERFDISP song=" + songName + " sec=" + secName + " nextSec=" + nextSecName +
            " hasClick=" + hasClick + " clickPlaying=" + perfClickPlaying + " perfPlaying=" + perfPlaying +
            " perfSelected=" + perfSelectedSection + " playbackSection=" + playbackSectionIndex);
    }

    /* The header: Perform, and at its right the key the song plays in (a
     * setlist's own key for it, if set) and the battery. */
    const entry = currentSetlist && perfSongIndex >= 0 ? currentSetlist.songs[perfSongIndex] : null;
    const playKey = entry && KEYS.indexOf(entry.key) >= 0 ? entry.key : ((displaySong && displaySong.key) || DEFAULT_KEY);
    drawMenuHeader("Perform", headerRightWithBattery(""));
    drawHeaderBattery();
    const keyText = "Key " + keyLabel(playKey);
    const keyRight = SCREEN_WIDTH - 3 - (batteryLevel !== null ? batteryBadgeWidth() + 4 : 0);
    perfPrintKey(keyRight - perfKeyWidth(keyText) + 1, 1, keyText);

    /* Below it the song; the section playing > the next one; the next song.
     * Each line scrolls on its own so long names marquee instead of being
     * hard-truncated, and the values line up after their labels. */
    const secLine = secName && nextSecName ? secName + " > " + nextSecName : (secName || nextSecName || "—");
    const perfLines = [songName, secLine, nextSongName || "—"];
    const perfPrefixes = ["", "Sec:", "Next:"];
    const valueX = 2 + Math.max(perfTextWidth("Sec:"), perfTextWidth("Next:")) + 4;
    /* 11px line pitch: the header's text on row 1, then rows 12-45, leaving
     * a clear gap above the button-hint footer (rows 57-63). */
    const perfYs = [12, 23, 34];
    for (let i = 0; i < 3; i++) {
        const scroller = perfLineScrollers[i];
        scroller.setSelected(perfLines[i]);
        scroller.tick();
        /* Fit by pixels, not characters: the space left after the label,
         * and when the name is wider than that, a scrolled window trimmed to
         * fit -- the face is proportional, so a fixed character count let
         * wide names run off the right edge, scrolled or not. */
        const x = perfPrefixes[i] ? valueX : 2;
        const avail = SCREEN_WIDTH - 1 - x;
        let text = perfLines[i];
        if (perfTextWidth(text) > avail) {
            const n = Math.max(1, perfCharsThatFit(text, avail));
            text = perfFitText(scroller.getScrolledText(text, n), avail);
        }
        if (perfPrefixes[i]) perfPrint(2, perfYs[i], perfPrefixes[i], 1);
        perfPrint(x, perfYs[i], text, 1);
    }
    /* Song time as it progresses, plus the total song and set durations. The
     * current position comes from the DSP transport's 0-based fractional bar
     * (bar_frac) mapped against the full song; during the count-in click the
     * song has not started, so it reads 0:00. */
    const songTotal = fullSong ? songDurationSec(fullSong) : 0;
    let curSec = 0;
    if (perfPlaying && !perfClickPlaying && lastDspTransport && lastDspTransport.running) {
        const dspBarFrac = (typeof lastDspTransport.bar_frac === "number")
            ? lastDspTransport.bar_frac : ((lastDspTransport.bar || 1) - 1);
        const fullBarFrac = dspBarFrac + previewBarOffset;
        const bpm = lastDspTransport.bpm || (fullSong ? (fullSong.tempo_bpm || 120) : 120);
        /* Quarter-note beats per bar, not time_sig_num: 6/8 has 3 quarter
         * notes per bar, so a bar lasts 3*(60/bpm) seconds. */
        const qbpb = qtrBeatsPerBar(fullSong || { time_sig_num: lastDspTransport.time_sig_num, time_sig_den: lastDspTransport.time_sig_den });
        curSec = fullBarFrac * qbpb * (60 / bpm);
    }
    const setKey = perfSetTotalKey();
    if (setKey !== perfSetTotalKeyCached) {
        perfSetTotalKeyCached = setKey;
        perfSetTotalSec = computeSetTotalSec();
    }
    const timeLine = "Time: " + formatTime(curSec) + "/" + formatTime(songTotal) +
        "  Set: " + formatTime(perfSetTotalSec);
    perfPrint(2, 45, perfFitText(timeLine, SCREEN_WIDTH - 3), 1);
    /* Draw any active overlay (e.g. a missing-clip warning) on top of the
     * performance display. */
    drawOverlay();
    drawPerfKnobFeedback();
}

function drawPerfSetlist() {
    drawMenuHeader("Select Setlist", "");
    const items = setlistFiles.map(f => ({ label: f.name || f }));
    drawMenuList({
        labelX: 3,
        items,
        selectedIndex: perfSetlistIndex,
        getLabel: (item) => item.label,
        getValue: () => "",
        maxVisible: 5
    });
}

/* ── Jam mode ───────────────────────────────────────────────────────── */

/* Load the clips for the given folder index into the Jam groove/fill lists. */
let jamFolderLabel = "";   /* the Jam folder's name, for recordings */
function jamLoadFolder(folderIndex) {
    jamFolderLabel = String(libraryFolders[folderIndex] || "jam").split("/").pop();
    jamGrooves = [];
    jamFills = [];
    jamVisibleFillList = [];
    if (typeof host_module_get_param !== "function") return;
    const clipsJson = host_module_get_param("folder_clips_json_" + folderIndex);
    if (!clipsJson) return;
    try {
        const raw = JSON.parse(clipsJson);
        const clips = raw.map(c => {
            const path = (typeof c === "string") ? c : (c.source || c);
            const type = inferPartTypeFromFilename(path);
            return {
                path: path,
                name: (typeof c === "string") ? clipDisplayName(c) : (c.display || c.name || clipDisplayName(path)),
                bars: (typeof c === "string") ? clipDisplayBars(c) : (c.bars || clipDisplayBars(path)),
                type: type,
                /* For fills, the section keyword (intro/verse/chorus/...) that
                 * this fill belongs to, so it can be matched to a groove type. */
                section: (type === "fill") ? inferSectionFromFilename(path) : "",
                /* Instrument keyword (hat/stick/ride) for fills, so fills
                 * organised under a Hat/Stick/Ride subfolder can be matched to
                 * a groove of the same instrument. */
                instrument: (type === "fill") ? inferInstrumentFromFilename(path) : ""
            };
        });
        jamGrooves = clips.filter(c => c.type !== "fill");
        jamFills = clips.filter(c => c.type === "fill");
        /* Order grooves and fills by section (intro → verse → prechorus →
         * chorus → bridge → outro), then by simplest name first (e.g. "Verse"
         * before "Verse ALT"). */
        jamGrooves.sort(clipOrderCompare);
        jamFills.sort(clipOrderCompare);
    } catch (e) { jamGrooves = []; jamFills = []; }
}

/* Fills shown on the right, in order:
 *  1. fills whose section keyword matches the current groove type (e.g. a
 *     "Verse Fill" shows while a Verse groove plays)
 *  2. Break fills (generic, usable under every part type)
 *  3. fills with no section keyword (e.g. "Clap Fill 1") — these have no
 *     corresponding groove type, so they are always shown while playing
 * A fill associated with a different groove (e.g. a Chorus fill while a Verse
 * groove is playing) is NOT shown. No fills are shown until a groove is
 * selected and playing. */
function jamVisibleFills() {
    if (!jamPlaying) {
        /* When stopped, show intro fills so the user can start playback
         * with an intro fill. */
        jamVisibleFillList = jamFills.filter(f => f.section === "intro");
        return jamVisibleFillList;
    }
    /* Only recompute the fill list while a GROOVE is playing. When a fill is
     * queued or playing (including an intro fill that started playback), the
     * fills should stay frozen on the current groove's set — do NOT re-filter
     * or update them based on the fill clip. */
    if (jamCurrentClip && jamCurrentClip.type === "fill") {
        return jamVisibleFillList;
    }
    const activeType = jamCurrentType;
    if (!activeType) { jamVisibleFillList = []; return jamVisibleFillList; }
    const sectionFills = jamFills.filter(f => f.section === activeType);
    const breakFills = jamFills.filter(f => f.section === "break");
    /* Fills with no section keyword have no corresponding groove type, so they
     * are always shown while playing. */
    const genericFills = jamFills.filter(f => f.section === "");
    jamVisibleFillList = sectionFills.concat(breakFills, genericFills);
    return jamVisibleFillList;
}

function drawJamFolder() {
    const node = getTreeNode(libraryCategoryTree, jamFolderPickerPath);
    const pathStr = jamFolderPickerPath.map(shortSongName).join("/");
    drawMenuHeader("Jam Folder", pathStr);
    const items = node ? getTreeDisplayItems(node) : [];
    if (items.length === 0 && libraryFolders.length === 0) {
        drawLibraryFoldersPlaceholder();
        return;
    }
    drawMenuList({
        items,
        selectedIndex: jamFolderPickerSelectedIndex,
        getLabel: (item) => item.label,
        getValue: () => "",
        labelX: 3,
        labelGap: 0,
        maxVisible: 5
    });
}

function drawJam() {
    const folderName = libraryFolders[currentJamFolderIndex()] || "";
    const shortFolder = shortSongName(folderName);
    jamHeaderScroller.setSelected(shortFolder);
    jamHeaderScroller.tick();
    /* The folder name gets what the "Jam: " prefix and the right side (the
     * play indicator and the battery) leave, measured in the header's face;
     * a longer name scrolls within that. */
    const jamRight = headerRightWithBattery(jamPlaying ? "*" : (pendingJamFolderClipLoadIndex >= 0 ? "..." : ""));
    const maxName = headerFitChars(shortFolder, headerTitleRoom(jamRight) - fontWidth4x5("JAM: "));
    let header = shortFolder;
    if (header.length > maxName) header = jamHeaderScroller.getScrolledText(header, maxName);
    drawMenuHeader("Jam: " + header, jamRight);
    drawHeaderBattery();

    const grooveCols = 4;
    const fillCols = 4;
    const rows = 4;
    const groovePerPage = grooveCols * rows; /* 16 */
    const fillPerPage = fillCols * rows;     /* 16 */

    /* Compact text summary of the current/queued state. */
    const curName = jamCurrentClip ? clipShortName(jamCurrentClip) : "—";
    print(2, LIST_TOP_Y, "Now: " + scrollHeader(curName, 16), 1);
    /* Next item: a queued clip, a queued groove, or the fill's return groove. */
    let nextClip = null;
    if (jamQueue.length > 0) {
        nextClip = jamQueue[0];
    } else if (jamQueuedGroove) {
        nextClip = jamQueuedGroove;
    } else if (jamCurrentClip && jamCurrentClip.type === "fill" && jamReturnGroove) {
        nextClip = jamReturnGroove;
    }
    if (nextClip) {
        /* "Q: " prefix is 3 chars, so the name gets 18. */
        print(2, LIST_TOP_Y + 9, "Q: " + scrollHeader(clipShortName(nextClip), 18), 1);
    } else {
        print(2, LIST_TOP_Y + 9, "Q: —", 1);
    }
    print(2, LIST_TOP_Y + 18, "Grooves: " + jamGrooves.length + "  Fills: " + jamVisibleFills().length, 1);
    const [tsNum, tsDen] = inferTimeSigFromFolder(folderName);
    print(2, LIST_TOP_Y + 27, "BPM: " + jamBpm + "  " + tsNum + "/" + tsDen, 1);
    if (jamChordModeActive()) {
        /* Key, the chord that's sounding/queued-to-resume, and (while
         * playing, when they differ) a not-yet-promoted queued change, on
         * their own bottom line -- see jamChordDegreeLabel/
         * jamQueuedChordDegree, which also drive the pad LED highlight in
         * drawJamLEDs, so the text and the pads always agree. */
        let chordText;
        if (jamPlaying) {
            const liveText = jamChordDegreeLabel(jamChordLiveDegree, jamChordLiveKey);
            const pendingText = jamChordDegreeLabel(jamChordPendingDegree, jamChordPendingKey);
            if (liveText && pendingText) chordText = liveText + ">" + pendingText;
            else if (liveText) chordText = liveText;
            else if (pendingText) chordText = ">" + pendingText;
            else chordText = "—";
        } else {
            chordText = jamChordDegreeLabel(jamQueuedChordDegree(),
                jamChordPendingDegree >= 0 ? jamChordPendingKey : jamChordLiveKey) || "—";
        }
        print(2, LIST_TOP_Y + 36, "Key: " + keyLabel(jamKey) + "  Chord: " + chordText, 1);
    }
}

/* ── Input handling ─────────────────────────────────────────────────── */

/* Exiting from the root menu takes two Back presses: the first shows a popup
 * asking for the second, which must come within EXIT_CONFIRM_MS. Any other
 * input on the root menu cancels it. */
const EXIT_CONFIRM_MS = 3000;
let exitConfirmUntil = 0;

function handleRootInput(cc, value) {
    const items = ["Song Builder", "Setlists", "Perform", "Jam", "Output"];
    if (value > 0 && cc !== MoveBack && exitConfirmUntil) {
        exitConfirmUntil = 0;
        hidePopup();
    }
    if (cc === MoveMainKnob) {
        const delta = decodeDelta(value);
        const idx = menuStack.getSelectedIndex();
        const newIdx = Math.max(0, Math.min(items.length - 1, idx + delta));
        if (newIdx !== idx) {
            menuStack.setSelectedIndex(newIdx);
            needsRedraw = true;
        }
    } else if (cc === MoveBack && value > 0) {
        /* A tap closes the module from the root menu -- this is as far back
         * as our own navigation goes, so there's nowhere left for Back to
         * navigate to. Suspending (parking in the background, keeping
         * playback running) now lives on a long-press of Back instead, from
         * any view -- see backHoldActive's declaration in onMidiMessageInternal
         * for why it could not stay on this tap: every view's Back already
         * stops playback before the user could ever navigate here, which
         * made a plain-tap suspend here pointless (there was never anything
         * left running to keep alive by the time it fired). Shift+Back
         * reaches the same exitOvertakeMode() the host itself calls
         * unconditionally for Shift+Back anyway -- this tap path is what a
         * host without that interception, or one that hasn't yet seen
         * Shift+Back, falls back to. */
        if (Date.now() >= exitConfirmUntil) {
            exitConfirmUntil = Date.now() + EXIT_CONFIRM_MS;
            showPopup("Exit Arranger?", "Press Back again to exit", EXIT_CONFIRM_MS);
            needsRedraw = true;
            return;
        }
        exitConfirmUntil = 0;
        hidePopup();
        if (typeof host_exit_module === "function") {
            host_exit_module();
        } else if (typeof host_return_to_menu === "function") {
            host_return_to_menu();
        }
    } else if (cc === MoveMainButton && value > 0) {
        const idx = menuStack.getSelectedIndex();
        if (idx === 0) {
            currentMode = MODE_BUILDER;
            currentView = VIEW_SONG_BANK;
            menuStack.push({ title: "Song Bank", selectedIndex: 0 });
            songFiles = listSongFiles();
            selectedSongIndex = 0;
            needsRedraw = true;
        } else if (idx === 1) {
            currentView = VIEW_SETLIST_BANK;
            menuStack.push({ title: "Setlists", selectedIndex: 0 });
            setlistFiles = listSetlistFiles();
            needsRedraw = true;
        } else if (idx === 2) {
            currentMode = MODE_PERFORMANCE;
            currentView = VIEW_PERF_SETLIST;
            menuStack.push({ title: "Select Setlist", selectedIndex: 0 });
            setlistFiles = listSetlistFiles();
            perfSetlistIndex = 0;
            needsRedraw = true;
        } else if (idx === 3) {
            currentMode = MODE_JAM;
            currentView = VIEW_JAM_FOLDER;
            menuStack.push({ title: "Jam Folder", selectedIndex: 0 });
            loadLibraryFolders();
            jamFolderPickerPath = [];
            jamFolderPickerSelectedIndex = 0;
            jamFolderPickerSelectedStack = [];
            needsRedraw = true;
        } else if (idx === 4) {
            currentView = VIEW_OPTIONS;
            menuStack.push({ title: "Options", selectedIndex: 0 });
            optionsFocus = 0;
            needsRedraw = true;
        }
    }
}

function handleFolderListInput(cc, value) {
    const node = getTreeNode(libraryCategoryTree, folderPickerPath);
    const items = node ? getTreeDisplayItems(node) : [];
    if (cc === MoveMainKnob) {
        const delta = decodeDelta(value);
        const newIdx = Math.max(0, Math.min(items.length - 1, folderPickerSelectedIndex + delta));
        if (newIdx !== folderPickerSelectedIndex) {
            folderPickerSelectedIndex = newIdx;
            needsRedraw = true;
        }
    } else if (cc === MoveMainButton && value > 0) {
        const item = items[folderPickerSelectedIndex];
        if (!item) return;
        if (item.type === "category") {
            /* Drill into the selected sub-category. Remember the current
             * cursor so Back can return to it. */
            folderPickerSelectedStack.push(folderPickerSelectedIndex);
            folderPickerPath = folderPickerPath.concat([item.name]);
            folderPickerSelectedIndex = 0;
            needsRedraw = true;
            return;
        }
        const folderIndex = item.index;
        const folder = libraryFolders[folderIndex];
        if (builderChangeFolder) {
            /* Re-selecting the source folder for the current song: update the
             * song's source_folder (full path) and reload the clip palette. */
            builderChangeFolder = false;
            if (currentSong) {
                currentSong.source_folder = folderFullPath(folderIndex);
                unsavedChanges = true;
            }
            currentView = VIEW_BUILDER;
            menuStack.pop();
            builderPage = 0;
            loadFolderClips(folderIndex);
            stepLedsDirty = true;
            ledDirtyAll = true;
            needsRedraw = true;
            return;
        }
        openTextEntry({
            title: "Name",
            initialText: folder,
            onConfirm: (name) => {
                const trimmed = (name || "").trim();
                let songName = trimmed || folder;
                let newPath = songPath(songName);
                /* If name collides, append a counter. */
                if (host_file_exists(newPath)) {
                    let counter = 2;
                    while (host_file_exists(newPath) && counter < 100) {
                        songName = trimmed + " " + counter;
                        newPath = songPath(songName);
                        counter++;
                    }
                }
                currentMode = MODE_BUILDER;
                activeSongFile = newPath;
                currentSong = newSong(folder);
                activeSongObj = currentSong;
                currentSong.name = songName;
                unsavedChanges = false;
                currentSectionIndex = 0;
                builderCursor = 0;
                currentView = VIEW_BUILDER;
                menuStack.push({ title: "Arrange", selectedIndex: 0 });
                builderPage = 0;
                loadFolderClips(folderIndex);
                stepLedsDirty = true;
                needsRedraw = true;
            },
            onCancel: () => {
                startNewSong(folder);
            }
        });
        needsRedraw = true;
    } else if (cc === MoveBack && value > 0) {
        if (folderPickerPath.length > 0) {
            /* Back out to the parent category, restoring the cursor the user
             * was on before drilling in. */
            folderPickerPath = folderPickerPath.slice(0, folderPickerPath.length - 1);
            folderPickerSelectedIndex = folderPickerSelectedStack.length > 0
                ? folderPickerSelectedStack.pop()
                : 0;
            needsRedraw = true;
            return;
        }
        menuStack.pop();
        if (builderChangeFolder) {
            builderChangeFolder = false;
            currentView = VIEW_BUILDER;
        } else {
            currentView = VIEW_SONG_BANK;
        }
        needsRedraw = true;
    }
}

function handleBuilderInput(cc, value) {
    const locked = songIsLocked();
    /* Track buttons only choose the track shown: Track 1 Drum <-> Chord
     * (from another track, Drum), Track 2/3 Inst 1/Inst 2, Track 4 Pads <->
     * Click (from another track, Pads). None turns anything on or off: an
     * instrument's Enabled is in its settings (Menu), the click's in Song
     * Settings. */
    if ((cc === MoveRow1 || cc === MoveRow2 || cc === MoveRow3 || cc === MoveRow4) && value > 0) {
        if (cc === MoveRow1) {
            builderTrack = builderTrack === TRACK_DRUM ? TRACK_CHORD : TRACK_DRUM;
            if (builderTrack === TRACK_CHORD) { chordCursorBar = 0; chordCursorIdx = 0; chordListCursor = 0; }
        } else {
            builderTrack = cc === MoveRow2 ? TRACK_INSTRUMENT_1
                         : cc === MoveRow3 ? TRACK_INSTRUMENT_2
                         : builderTrack === TRACK_PADS ? TRACK_CLICK : TRACK_PADS;
            itemListCursor = 0;
            chordCursorBar = -1;
        }
        stepLedsDirty = true;
        ledDirtyAll = true;
        needsRedraw = true;
        return;
    }
    /* The Chord, Inst and Click tracks don't use the Drum track's other
     * clip-editing controls (loop, page up/down) or Record (changing the
     * source folder is a Drum-track concept) — only section navigation,
     * their item lists (see chordListJog/itemListJog), the settings menu,
     * and transport apply there. */
    if (builderTrack !== TRACK_DRUM) {
        const allowed = cc === MoveLeft || cc === MoveRight || cc === MoveMenu ||
            cc === MoveBack || cc === MovePlay || cc === MoveShift || cc === MoveMute ||
            (!shiftHeld && (cc === MoveMainKnob || cc === MoveMainButton)) ||
            /* The Chord, Inst and Click tracks' lists edit like the Drum
             * track's: Shift+jog nudges, Delete removes, Copy duplicates. */
            cc === MoveMainKnob || (!shiftHeld && (cc === MoveDelete || cc === MoveCopy)) ||
            /* Loop copies the track's section to its same-named sections. */
            (!shiftHeld && cc === MoveLoop);
        if (!allowed) return;
    }
    if (builderTrack !== TRACK_DRUM && cc === MoveLoop && value > 0) {
        if (locked) lockedNotice(); else copyTrackToSameNamedSections();
        return;
    }
    if (cc === MoveMute && value > 0) {
        /* Mute merges this section with the next; Shift+Mute splits it at
         * the selected clip (Drum track). */
        builderMergeOrSplit(shiftHeld);
        return;
    }
    if (isItemTrack(builderTrack)) {
        /* The Inst and Click tracks' lists edit like the Chord track's. */
        if (cc === MoveMainKnob) {
            const delta = decodeDelta(value);
            if (shiftHeld) { if (locked) lockedNotice(); else itemListNudge(delta); }
            else itemListJog(delta);
            return;
        }
        if (cc === MoveMainButton && value > 0) { itemListClick(); return; }
        if (cc === MoveDelete && value > 0) { if (locked) lockedNotice(); else itemListDelete(); return; }
        if (cc === MoveCopy && value > 0) { if (locked) lockedNotice(); else itemListDuplicate(); return; }
    }
    if (builderTrack === TRACK_CHORD) {
        if (cc === MoveMainKnob) {
            const delta = decodeDelta(value);
            if (shiftHeld) { if (locked) lockedNotice(); else chordListNudge(delta); }
            else chordListJog(delta);
            return;
        }
        if (cc === MoveMainButton && value > 0) { chordListClick(); return; }
        if (cc === MoveDelete && value > 0) { if (locked) lockedNotice(); else chordListDelete(); return; }
        if (cc === MoveCopy && value > 0) { if (locked) lockedNotice(); else chordListDuplicate(); return; }
    }
    if (cc === MoveMainKnob) {
        const delta = decodeDelta(value);
        if (shiftHeld) {
            if (builderCursor >= 0) {
                if (locked) { lockedNotice(); return; } /* no reordering clips in a locked song */
                moveClipAtCursor(delta);
            } else {
                changeBuilderPage(delta);
            }
        } else {
            moveCursor(delta);
        }
    } else if (cc === MoveShift) {
        shiftHeld = value > 0;
    } else if (cc === MoveMenu && value > 0) {
        if (isInstTrack(builderTrack)) {
            openInstrumentMenu(builderTrack);
        } else {
            openSongSettings();
        }
    } else if (cc === MoveMainButton && value > 0) {
        if (shiftHeld) {
            openSongSettings();
            return;
        }
        /* Use the displayed section (the auto-followed/jumped one during
         * playback), matching drawBuilder and moveCursor, so editing targets
         * the live section rather than the stale currentSectionIndex. */
        const sec = currentSong ? currentSong.sections[builderDisplaySectionIndex()] : null;
        if (!sec) return;
        if (locked && builderCursor < sec.clips.length) {
            /* Rename and trim are blocked on a locked song: say so. */
            lockedNotice();
        } else if (builderCursor === -1) {
            /* Section header -> rename. */
            renameSectionPrompt(sec);
        } else if (builderCursor < sec.clips.length) {
            /* Clip -> open trim (blocked when locked; a placeholder has
             * nothing to trim). */
            if (!locked && !sec.clips[builderCursor].placeholder) openTrimView();
        }
        /* Otherwise the cursor is on the "(add clip)" row of an empty section,
         * which is not clickable. */
    } else if (cc === MoveDelete && value > 0) {
        if (locked) { lockedNotice(); return; } /* cannot delete sections/clips in a locked song */
        if (shiftHeld) {
            /* Shift+Delete removes the current section. */
            if (currentSong && currentSong.sections.length > 1) {
                currentSong.sections.splice(currentSectionIndex, 1);
                if (currentSectionIndex >= currentSong.sections.length) {
                    currentSectionIndex = currentSong.sections.length - 1;
                }
                builderCursor = 0;
                unsavedChanges = true;
                needsRedraw = true;
            }
        } else {
            deleteClipAtCursor();
        }
    } else if (cc === MoveBack && value > 0) {
        if (previewingClip) {
            stopPreview();
            previewingClip = null;
        }
        stopPlayback();
        saveCurrentSong();
        menuStack.pop();
        currentView = VIEW_SONG_BANK;
        needsRedraw = true;
    } else if (cc === MovePlay && value > 0) {
        builderPlayPress();
    } else if (cc === MoveCopy && value > 0) {
        if (locked) { lockedNotice(); return; } /* cannot duplicate in a locked song */
        if (shiftHeld) {
            duplicateCurrentSection();
        } else {
            duplicateClipAtCursor();
        }
    } else if (cc === MoveLoop && value > 0) {
        if (locked) { if (shiftHeld) lockedNotice(); return; } /* cannot add sections in a locked song */
        if (shiftHeld) {
            /* Shift + Loop opens a picker of common section names, then adds
             * a new empty section with the chosen name after the current one. */
            sectionPickIndex = 0;
            sectionPickRename = false;
            menuStack.push({ title: "New Section", selectedIndex: 0 });
            currentView = VIEW_SECTION_PICK;
            needsRedraw = true;
        }
    } else if (cc === MoveUp && value > 0) {
        /* Up/Down browse the clip pages, matching Shift+Jog behaviour.
         * Reversed: Up moves to the next page, Down to the previous. */
        changeBuilderPage(1);
    } else if (cc === MoveDown && value > 0) {
        changeBuilderPage(-1);
    } else if (cc === MoveLeft && value > 0) {
        if (shiftHeld) {
            if (locked) { lockedNotice(); return; } /* cannot reorder sections in a locked song */
            moveSectionInSong(-1);
        } else {
            /* During playback, navigate relative to the section actually being
             * displayed (the auto-followed playbackSectionIndex, or the section
             * the user last jumped to via builderDisplaySection) — NOT the
             * stale currentSectionIndex, which the auto-follow leaves behind. */
            const navBase = playbackState === "playing"
                ? (builderDisplaySection >= 0 ? builderDisplaySection : playbackSectionIndex)
                : currentSectionIndex;
            if (navBase > 0) {
                currentSectionIndex = navBase - 1;
                builderCursor = 0;
                chordListCursor = 0;
                itemListCursor = 0;
                stepScrollOffset = 0;
                builderDisplaySection = playbackState === "playing" ? currentSectionIndex : -1;
                stepLedsDirty = true;
                needsRedraw = true;
            }
        }
    } else if (cc === MoveRight && value > 0) {
        if (shiftHeld) {
            if (locked) { lockedNotice(); return; } /* cannot reorder sections in a locked song */
            moveSectionInSong(1);
        } else if (currentSong) {
            const navBase = playbackState === "playing"
                ? (builderDisplaySection >= 0 ? builderDisplaySection : playbackSectionIndex)
                : currentSectionIndex;
            if (navBase < currentSong.sections.length - 1) {
                currentSectionIndex = navBase + 1;
                builderCursor = 0;
                chordListCursor = 0;
                itemListCursor = 0;
                stepScrollOffset = 0;
                builderDisplaySection = playbackState === "playing" ? currentSectionIndex : -1;
                stepLedsDirty = true;
                needsRedraw = true;
            }
        }
    } else if (cc === MoveRecord && value > 0) {
        /* Reopen the Source Folder list to change the current song's folder.
         * Blocked on a locked song. */
        if (locked) { lockedNotice(); return; }
        builderChangeFolder = true;
        currentView = VIEW_FOLDER_LIST;
        menuStack.push({ title: "Source Folder", selectedIndex: 0 });
        loadLibraryFolders();
        folderPickerSelectedStack = [];
        const curIdx = folderIndexForPath(currentSong ? currentSong.source_folder : "");
        if (curIdx >= 0) {
            setFolderPickerToFolder(curIdx);
        } else {
            folderPickerPath = [];
            folderPickerSelectedIndex = 0;
        }
        needsRedraw = true;
    }
}

/* Play in Song Builder: stop while playing; Shift + Play plays the song from
 * the start; Play plays from the clip at the cursor. */
function builderPlayPress() {
    /* A pad preview still starting gives way to the song. */
    if (harmonyPreviewing && playbackState !== "playing") endHarmonyPreview();
    if (playbackState === "playing") {
        stopPlayback();
    } else if (shiftHeld) {
        /* Shift + Play starts playback from the beginning of the song,
         * playing through to the end without looping. */
        saveCurrentSong();
        const savedLoop = dspLoopEnabled;
        dspLoopEnabled = false;
        /* Restore inside onConfirmed, not synchronously after this call
         * returns -- playCurrentSong is async (the build/play happen on
         * the DSP worker thread and land later, once
         * primary_published_gen confirms); the actual
         * set("loop", dspLoopEnabled ? "1" : "0") read of this flag
         * happens inside that deferred callback, not before
         * playCurrentSong() returns. Restoring synchronously here (the
         * old code) put the flag back to its previous value (loop
         * enabled, by default) before that read ever happened, so the
         * "no looping" request was silently dropped and the song looped
         * anyway. */
        playCurrentSong(false, function () { dspLoopEnabled = savedLoop; });
    } else {
        previewClipAtCursor();
    }
}

/* Song Builder's settings pages, where Play works as in Song Builder. */
const SONG_BUILDER_SUBVIEWS = new Set([VIEW_CHORD_PICK, VIEW_INSTRUMENT_BAR, VIEW_INSTRUMENT,
    VIEW_TRIM, VIEW_SONG_SETTINGS, VIEW_SONG_BACKUPS]);

/* Before Play starts from a settings page, save what the page is editing --
 * without leaving it -- so you hear it. The chord and item pages then carry
 * on editing the saved chord/item. */
function applyOpenEditForPlay() {
    if (currentView === VIEW_CHORD_PICK) {
        const sec = chordPickSection();
        if (!sec) return;
        commitChordPick();
        const list = barChords(sec, chordPickBar);
        const i = list.findIndex(c => chordBeat(c) === chordPickBeat);
        if (i >= 0) {
            chordPickOrig = list[i];
            chordPickOrigBar = chordPickBar;
            chordPickOrigIdx = i;
            chordPickDirty = false;
        }
    } else if (currentView === VIEW_INSTRUMENT_BAR) {
        commitItemEdit();
        const list = itemEditList();
        if (list[itemListCursor]) {
            itemEditOrig = list[itemListCursor];
            itemWork = Object.assign({}, itemEditOrig);
        }
    } else if (currentView === VIEW_TRIM) {
        commitTrim();
    }
}

/* Rename a section (Song Builder's section row; blocked when locked). */
/* Rename a section: pick one of the section names (as for a new section), or
 * "Custom..." for the keyboard. */
function renameSectionPrompt(section) {
    if (!section || songIsLocked()) return;
    sectionPickRename = true;
    sectionPickTarget = section;
    const i = SECTION_NAMES.indexOf(section.name);
    sectionPickIndex = i >= 0 ? i + 1 : 0;
    menuStack.push({ title: "Rename Section", selectedIndex: 0 });
    currentView = VIEW_SECTION_PICK;
    needsRedraw = true;
}

/* Name a section with the keyboard. */
function renameSectionKeyboard(section) {
    if (!section || songIsLocked()) return;
    openTextEntry({
        title: "Rename",
        initialText: section.name || "Section",
        onConfirm: (newName) => {
            const trimmed = (newName || "").trim();
            if (trimmed.length === 0 || !section) return;
            section.name = trimmed;
            unsavedChanges = true;
            needsRedraw = true;
        },
        onCancel: () => { needsRedraw = true; }
    });
    needsRedraw = true;
}

function startNewSong(folderName) {
    currentMode = MODE_BUILDER;
    activeSongFile = null;
    currentSong = newSong(folderName);
    activeSongObj = currentSong;
    unsavedChanges = false;
    currentSectionIndex = 0;
    currentView = VIEW_BUILDER;
    menuStack.push({ title: "Arrange", selectedIndex: 0 });
    builderPage = 0;
    builderCursor = 0;
    const folderIndex = libraryFolders.indexOf(folderName);
    loadFolderClips(folderIndex >= 0 ? folderIndex : 0);
    pendingFolderClipLoadName = (folderClips.length === 0) ? (libraryFolders[folderIndex >= 0 ? folderIndex : 0] || null) : null;
    stepLedsDirty = true;
    ledDirtyAll = true;
    needsRedraw = true;
}

function startRenameSelectedSong() {
    const entry = songFiles[selectedSongIndex - 1];
    if (!entry) return;
    const obj = readJson(entry.path);
    if (obj && obj.locked) return; /* a locked song cannot be renamed */
    openTextEntry({
        title: "Rename",
        initialText: entry.name,
        onConfirm: (newName) => {
            if (!newName || newName.trim().length === 0) return;
            const trimmed = newName.trim();
            const obj = readJson(entry.path);
            if (!obj) return;
            obj.name = trimmed;
            const newPath = songPath(trimmed);
            /* Avoid overwriting an unrelated existing song. */
            if (newPath !== entry.path && host_file_exists(newPath)) {
                return;
            }
            if (newPath !== entry.path) {
                try {
                    os.remove(entry.path);
                } catch (e) {
                    logDebug("startRenameSelectedSong: failed to remove old file " + entry.path + " " + e);
                }
                /* Repoint any setlist entries at the new path/name -- the
                 * song still exists, just moved, so unlike a delete these
                 * are updated in place rather than dropped. */
                renameSongInAllSetlists(entry.path, newPath, trimmed);
            }
            writeJson(newPath, obj);
            if (activeSongFile === entry.path) activeSongFile = newPath;
            /* Request a DSP rescan and poll until the renamed path actually
             * shows up in its cached song list -- reloadSongBankAndPreserve
             * Selection alone (the old code here) only re-reads that cache
             * as it already stood, without ever asking the DSP to refresh
             * it, so the bank kept showing the pre-rename name until some
             * unrelated later action happened to trigger a rescan. Matches
             * duplicateSelectedSong's/deleteSelectedSong's own pattern. */
            requestSongBankSync(newPath, true, true);
        },
        onCancel: () => { needsRedraw = true; }
    });
}

function openConfirm({ title, name, detail, labels, onConfirm, onCancel }) {
    confirmState = {
        title,
        name,
        detail: detail || "",
        labels: labels || ["No", "Yes"],
        selectedIndex: 0, /* default to "No" (safe) */
        onConfirm,
        onCancel
    };
    needsRedraw = true;
}

function closeConfirm(confirmed) {
    if (!confirmState) return;
    const cb = confirmed ? confirmState.onConfirm : confirmState.onCancel;
    confirmState = null;
    if (cb) cb();
}

function drawConfirm() {
    if (!confirmState) return;
    const { title, name, detail, selectedIndex, labels } = confirmState;
    drawMenuHeader(title);
    /* Draw the quoted name locally (instead of the shared drawConfirmModal) so
     * long Song/Setlist names marquee rather than being hard-truncated. */
    if (name !== undefined && name !== null && name !== "") {
        const displayName = scrollHeader('"' + String(name) + '"', 20);
        print(4, LIST_TOP_Y, displayName, 1);
    }
    if (detail) print(4, LIST_TOP_Y + 9, scrollHeader(detail, 20), 1);
    const listY = LIST_TOP_Y + (detail ? 20 : 16);
    for (let i = 0; i < labels.length; i++) {
        const rowY = listY + i * 9;
        const isSelected = i === selectedIndex;
        if (isSelected) {
            fill_rect(0, rowY - 1, 128, 9, 1);
        }
        print(4, rowY, labels[i], isSelected ? 0 : 1);
    }
}

function handleConfirmInput(cc, value) {
    if (!confirmState) return;
    if (cc === MoveMainKnob) {
        const delta = decodeDelta(value);
        confirmState.selectedIndex = Math.max(0, Math.min(confirmState.labels.length - 1, confirmState.selectedIndex + delta));
        needsRedraw = true;
    } else if (cc === MoveMainButton && value > 0) {
        /* Confirm the highlighted choice. */
        closeConfirm(confirmState.selectedIndex === 1);
    } else if (cc === MoveBack && value > 0) {
        closeConfirm(false);
    }
}

function deleteSelectedSong() {
    const entry = songFiles[selectedSongIndex - 1];
    if (!entry) return;
    const obj = readJson(entry.path);
    if (obj && obj.locked) {
        /* A locked song cannot be deleted: say so, and where to unlock it. */
        showPopup("Song locked", "Unlock it in its Song Settings to delete", 2500);
        needsRedraw = true;
        return;
    }
    openConfirm({
        title: "Delete Song?",
        name: entry.name,
        onConfirm: () => {
            if (host_file_exists(entry.path)) {
                logDebug("deleteSelectedSong: removing " + entry.path);
                try {
                    const ret = os.remove(entry.path);
                    logDebug("deleteSelectedSong: os.remove returned " + ret);
                } catch (e) {
                    logDebug("deleteSelectedSong: os.remove failed " + e);
                }
            }
            if (activeSongFile === entry.path) activeSongFile = null;
            /* Drop any setlist entries pointing at the now-deleted file --
             * otherwise they'd linger as dangling references forever. */
            removeSongFromAllSetlists(entry.path);
            /* Invalidate the DSP's cached song scan so the deleted song is
             * dropped from the bank list. The scan runs on the DSP's worker
             * thread, so it isn't done by the time this call returns —
             * requestSongBankSync polls each tick until the deleted path is
             * actually gone from the list. */
            requestSongBankSync(entry.path, false, false);
        },
        onCancel: () => { needsRedraw = true; }
    });
}

function normalizePath(path) {
    if (!path) return path;
    const parts = path.split("/");
    const out = [];
    for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        if (p === "" || p === ".") continue;
        if (p === "..") {
            if (out.length > 0 && out[out.length - 1] !== "..") {
                out.pop();
            } else {
                out.push("..");
            }
        } else {
            out.push(p);
        }
    }
    return path.startsWith("/") ? "/" + out.join("/") : out.join("/");
}

function loadSelectedSongIntoBuilder() {
    logDebug("loadSelectedSongIntoBuilder: selectedSongIndex=" + selectedSongIndex);
    if (selectedSongIndex === 0) {
        /* New song: pick source folder, then name it. */
        currentMode = MODE_BUILDER;
        currentView = VIEW_FOLDER_LIST;
        menuStack.push({ title: "Source Folder", selectedIndex: 0 });
        folderPickerPath = [];
        folderPickerSelectedIndex = 0;
        folderPickerSelectedStack = [];
        loadLibraryFolders();
        needsRedraw = true;
        return;
    }
    const entry = songFiles[selectedSongIndex - 1];
    if (!entry) { logDebug("loadSelectedSongIntoBuilder: no entry"); return; }
    let path = entry.path || (SONGS_DIR + "/" + entry);
    path = normalizePath(path);
    logDebug("loadSelectedSongIntoBuilder: path=" + path);
    if (!loadSongFile(path)) { logDebug("loadSelectedSongIntoBuilder: loadSongFile failed"); return; }
    if (!currentSong.sections || currentSong.sections.length === 0) {
        currentSong.sections = [newSection("Section 1")];
        unsavedChanges = true;
    }
    currentMode = MODE_BUILDER;
    currentView = VIEW_BUILDER;
    menuStack.push({ title: "Arrange", selectedIndex: 0 });
    builderPage = 0;
    builderCursor = 0;
    const srcFolder = currentSong.source_folder;
    loadFolderClips(folderIndexForPath(srcFolder));
    /* If the DSP folder scan isn't ready yet (fresh boot), retry until the
     * clips arrive, then repaint the pads. Track the folder PATH so the retry
     * can re-resolve its index once libraryFolders is populated. */
    pendingFolderClipLoadName = (folderClips.length === 0) ? srcFolder : null;
    stepLedsDirty = true;
    ledDirtyAll = true;
    needsRedraw = true;
    logDebug("loadSelectedSongIntoBuilder: loaded " + (currentSong ? currentSong.name : "?"));
}

function handleSongBankInput(cc, value) {
    logDebug("handleSongBankInput cc=" + cc + " val=" + value + " view=" + currentView);
    const itemsCount = songFiles.length + 1;
    if (cc === MoveMainKnob) {
        const delta = decodeDelta(value);
        const newIdx = Math.max(0, Math.min(itemsCount - 1, selectedSongIndex + delta));
        if (newIdx !== selectedSongIndex) {
            selectedSongIndex = newIdx;
            needsRedraw = true;
        }
    } else if (cc === MoveMainButton && value > 0) {
        if (shiftHeld && selectedSongIndex > 0) {
            /* Shift + jogclick renames the selected song. */
            startRenameSelectedSong();
        } else {
            logDebug("handleSongBankInput: select via " + cc);
            loadSelectedSongIntoBuilder();
        }
    } else if (cc === MoveDelete && value > 0 && selectedSongIndex > 0) {
        deleteSelectedSong();
    } else if (cc === MoveCopy && value > 0 && selectedSongIndex > 0) {
        duplicateSelectedSong();
    } else if (cc === MoveBack && value > 0) {
        menuStack.pop();
        currentView = VIEW_ROOT;
        needsRedraw = true;
    }
}

function reloadSongBankAndPreserveSelection() {
    const oldIndex = selectedSongIndex;
    const oldActive = activeSongFile;
    songFiles = listSongFiles();
    if (oldActive) {
        const idx = songFiles.findIndex(f => f.path === oldActive);
        if (idx >= 0) {
            selectedSongIndex = idx + 1;
            return;
        }
    }
    if (oldIndex >= 0 && oldIndex <= songFiles.length) {
        selectedSongIndex = oldIndex;
    } else {
        selectedSongIndex = 0;
    }
}

/* Request a rescan after adding/removing a song file on disk, and start
 * polling (see the pendingSongBankSync tick handler) until `path`
 * appears/disappears from the DSP's cached song list. */
function requestSongBankSync(path, shouldExist, selectOnArrive) {
    requestSongRescan();
    pendingSongBankSync = { path, shouldExist, selectOnArrive: !!selectOnArrive };
    reloadSongBankAndPreserveSelection();
    needsRedraw = true;
}

/* Duplicate the selected song under a new name ("<name> copy", "<name> copy
 * 2", ...), unlocked regardless of whether the original is locked. */
function duplicateSelectedSong() {
    const entry = songFiles[selectedSongIndex - 1];
    if (!entry) return;
    const obj = readJson(entry.path);
    if (!obj) return;
    const baseName = (obj.name || entry.name || "Song").replace(/ copy( \d+)?$/, "");
    let newName = baseName + " copy";
    let n = 2;
    while (songFiles.some(f => f.name === newName)) {
        newName = baseName + " copy " + n;
        n++;
    }
    const newPath = songPath(newName);
    if (host_file_exists(newPath)) return; /* name collision despite the loop above */
    const copy = Object.assign({}, obj, { name: newName, locked: false });
    writeJson(newPath, copy);
    requestSongBankSync(newPath, true, true);
}

function handleOptionsInput(cc, value) {
    const rows = optionsRows();
    const key = (rows[optionsFocus] || rows[0]).key;
    if (cc === MoveMainKnob) {
        const delta = decodeDelta(value);
        if (optionsEditing) {
            if (key === "swapguard") {
                /* Adjust the mid-clip swap guard (0-100%, in 5% steps). */
                const newG = Math.max(0, Math.min(1, swapGuardFraction + delta * 0.05));
                if (newG !== swapGuardFraction) {
                    swapGuardFraction = newG;
                    saveOutputSettings();
                    pushSwapGuardToDsp();
                }
            } else if (key === "clock") {
                /* Toggle the MIDI clock to Schwung. */
                sendClock = !sendClock;
                saveOutputSettings();
                pushSendClockToDsp();
            } else if (key === "dspdebug") {
                /* Toggle the DSP debug log. */
                dspDebugEnabled = !dspDebugEnabled;
                saveOutputSettings();
                pushDspDebugToDsp();
                /* When debug logging is turned off, delete the accumulated
                 * log files so they don't linger on the device. */
                if (!dspDebugEnabled) {
                    deleteLogFiles();
                }
            }
        } else {
            optionsFocus = Math.max(0, Math.min(rows.length - 1, optionsFocus + delta));
        }
        needsRedraw = true;
    } else if (cc === MoveMainButton && value > 0) {
        if (key === "drums") openOptionsDrums();
        else if (key === "inst1") openOptionsInst(1);
        else if (key === "inst2") openOptionsInst(2);
        else if (key === "inst3") openOptionsInst(3);
        else if (key === "click") openOptionsClick();
        else if (key === "keys") openOptionsKeys();
        else if (key === "chains") openOptionsChains();
        else {
            optionsEditing = !optionsEditing;
            needsRedraw = true;
        }
    } else if (cc === MoveBack && value > 0) {
        if (optionsEditing) {
            optionsEditing = false;
            needsRedraw = true;
        } else {
            menuStack.pop();
            currentView = VIEW_ROOT;
            needsRedraw = true;
        }
    }
}

function handleOptionsDrumsInput(cc, value) {
    if (cc === MoveMainKnob) {
        const delta = decodeDelta(value);
        if (optionsSubEditing) {
            if (optionsSubFocus === 0) {
                /* Cycle through output targets. */
                const newIdx = Math.max(0, Math.min(OUTPUT_TARGETS.length - 1, selectedOutputIndex + delta));
                if (newIdx !== selectedOutputIndex) {
                    selectedOutputIndex = newIdx;
                    setOutputTarget(OUTPUT_TARGETS[selectedOutputIndex]);
                }
            } else if (optionsSubFocus === 1) {
                /* Adjust the active MIDI channel. */
                const newCh = Math.max(1, Math.min(16, activeOutputChannel() + delta));
                if (newCh !== activeOutputChannel()) {
                    if (outputTarget === "move") moveChannel = newCh;
                    else if (outputTarget === "schwung") schwungChannel = newCh;
                    else outputChannel = newCh;
                    saveOutputSettings();
                    if (typeof host_module_set_param === "function") {
                        host_module_set_param("output_channel", String(activeOutputChannel() - 1));
                        host_module_set_param("move_channel", String(moveChannel - 1));
                        host_module_set_param("schwung_channel", String(schwungChannel - 1));
                    }
                }
            } else {
                /* Toggle Drop Note-Offs. */
                dropNoteOffs = !dropNoteOffs;
                saveOutputSettings();
                pushDropNoteOffsToDsp();
            }
        } else {
            const newIdx = Math.max(0, Math.min(2, optionsSubFocus + delta));
            if (newIdx !== optionsSubFocus) optionsSubFocus = newIdx;
        }
        needsRedraw = true;
    } else if (cc === MoveMainButton && value > 0) {
        optionsSubEditing = !optionsSubEditing;
        needsRedraw = true;
    } else if (cc === MoveBack && value > 0) {
        if (optionsSubEditing) {
            optionsSubEditing = false;
            needsRedraw = true;
        } else {
            menuStack.pop();
            currentView = VIEW_OPTIONS;
            needsRedraw = true;
        }
    }
}

function handleOptionsInstInput(cc, value) {
    const i = optionsInstIndex;
    if (cc === MoveMainKnob) {
        const delta = decodeDelta(value);
        if (optionsSubEditing) {
            if (optionsSubFocus === 0) {
                const idx = Math.max(0, Math.min(OUTPUT_TARGETS.length - 1, OUTPUT_TARGETS.indexOf(instOutputOf(i)) + delta));
                setInstRoute(i, OUTPUT_TARGETS[idx], instChannelOf(i));
                saveOutputSettings();
            } else {
                setInstRoute(i, instOutputOf(i), Math.max(1, Math.min(16, instChannelOf(i) + delta)));
                saveOutputSettings();
            }
        } else {
            const newIdx = Math.max(0, Math.min(1, optionsSubFocus + delta));
            if (newIdx !== optionsSubFocus) optionsSubFocus = newIdx;
        }
        needsRedraw = true;
    } else if (cc === MoveMainButton && value > 0) {
        optionsSubEditing = !optionsSubEditing;
        needsRedraw = true;
    } else if (cc === MoveBack && value > 0) {
        if (optionsSubEditing) {
            optionsSubEditing = false;
            needsRedraw = true;
        } else {
            menuStack.pop();
            currentView = VIEW_OPTIONS;
            needsRedraw = true;
        }
    }
}

function handleOptionsChainsInput(cc, value) {
    if (cc === MoveMainKnob) {
        const delta = decodeDelta(value);
        if (optionsSubEditing) {
            if (optionsSubFocus === 0) {
                /* Page to another chain and read it. */
                const newIdx = Math.max(0, Math.min(chainSlotCount() - 1, optionsChainIndex + delta));
                if (newIdx !== optionsChainIndex) {
                    optionsChainIndex = newIdx;
                    const frame = menuStack.current();
                    if (frame) frame.title = "Chain " + (optionsChainIndex + 1);
                    refreshChainInfo();
                }
            } else if (optionsSubFocus === 1 && chainInfoChannel !== null) {
                /* The chain's receive channel. 0 = All. */
                const newCh = Math.max(0, Math.min(16, chainInfoChannel + delta));
                if (newCh !== chainInfoChannel) writeChainChannel(optionsChainIndex, newCh);
            }
        } else {
            const newIdx = Math.max(0, Math.min(2, optionsSubFocus + delta));
            if (newIdx !== optionsSubFocus) optionsSubFocus = newIdx;
        }
        needsRedraw = true;
    } else if (cc === MoveMainButton && value > 0) {
        if (optionsSubFocus === 2) {
            optionsSubEditing = false;
            openChainView(optionsChainIndex);
        } else if (optionsSubFocus === 1 && chainInfoChannel === null) {
            /* Nothing to edit until a read completes; try again. */
            refreshChainInfo();
        } else {
            optionsSubEditing = !optionsSubEditing;
        }
        needsRedraw = true;
    } else if (cc === MoveBack && value > 0) {
        if (optionsSubEditing) {
            optionsSubEditing = false;
            needsRedraw = true;
        } else {
            menuStack.pop();
            currentView = VIEW_OPTIONS;
            needsRedraw = true;
        }
    }
}

function handleSetlistBankInput(cc, value) {
    const itemsCount = setlistFiles.length + 1;
    if (cc === MoveMainKnob) {
        const delta = decodeDelta(value);
        const newIdx = Math.max(0, Math.min(itemsCount - 1, selectedSetlistIndex + delta));
        if (newIdx !== selectedSetlistIndex) {
            selectedSetlistIndex = newIdx;
            needsRedraw = true;
        }
    } else if (cc === MoveMainButton && value > 0) {
        if (shiftHeld && selectedSetlistIndex > 0) {
            /* Shift + jogclick renames the selected setlist. */
            const entry = setlistFiles[selectedSetlistIndex - 1];
            if (entry) {
                openTextEntry({
                    title: "Rename",
                    initialText: entry.name,
                    onConfirm: (newName) => {
                        const obj = readJson(entry.path);
                        if (obj) {
                            obj.path = entry.path;
                            renameSetlist(obj, newName);
                        }
                        needsRedraw = true;
                    },
                    onCancel: () => { needsRedraw = true; }
                });
            }
            needsRedraw = true;
        } else if (selectedSetlistIndex === 0) {
            /* New setlist: name it, then open the empty editor. */
            openTextEntry({
                title: "New Setlist",
                initialText: "My Setlist",
                onConfirm: (name) => {
                    const trimmed = (name || "").trim() || "My Setlist";
                    currentSetlist = newSetlist(trimmed);
                    saveSetlist(currentSetlist);
                    setlistSongIndex = 0;
                    currentView = VIEW_SETLIST_EDIT;
                    menuStack.push({ title: "Edit", selectedIndex: 0 });
                    needsRedraw = true;
                },
                onCancel: () => { needsRedraw = true; }
            });
            needsRedraw = true;
        } else {
            const entry = setlistFiles[selectedSetlistIndex - 1];
            const path = entry ? entry.path : null;
            const obj = path ? readJson(path) : null;
            if (obj) {
                obj.path = path;
                currentSetlist = obj;
                /* Ensure each song's count-in click MIDI file exists so it is
                 * ready before playback. */
                regenerateSetlistClicks(currentSetlist);
                setlistSongIndex = 0;
                currentView = VIEW_SETLIST_EDIT;
                menuStack.push({ title: "Edit", selectedIndex: 0 });
                needsRedraw = true;
            }
        }
    } else if (cc === MoveCopy && value > 0 && selectedSetlistIndex > 0) {
        duplicateSelectedSetlist();
    } else if (cc === MoveDelete && value > 0 && selectedSetlistIndex > 0) {
        const entry = setlistFiles[selectedSetlistIndex - 1];
        if (entry) {
            openConfirm({
                title: "Delete Setlist?",
                name: entry.name,
                onConfirm: () => {
                    deleteSetlist({ name: entry.name, path: entry.path });
                    selectedSetlistIndex = Math.max(0, Math.min(selectedSetlistIndex, setlistFiles.length));
                    needsRedraw = true;
                },
                onCancel: () => { needsRedraw = true; }
            });
        }
    } else if (cc === MoveBack && value > 0) {
        menuStack.pop();
        currentView = VIEW_ROOT;
        needsRedraw = true;
    }
}

/* Copy: duplicate the selected setlist -- its songs, their settings and its
 * knobs -- as "<name> copy" ("<name> copy 2", ...), and select it. */
function duplicateSelectedSetlist() {
    const entry = setlistFiles[selectedSetlistIndex - 1];
    if (!entry) return;
    const obj = readJson(entry.path);
    if (!obj) return;
    const baseName = (obj.name || entry.name || "Setlist").replace(/ copy( \d+)?$/, "");
    let newName = baseName + " copy";
    for (let n = 2; setlistFiles.some(f => f.name === newName); n++) newName = baseName + " copy " + n;
    const newPath = setlistPath(newName);
    if (host_file_exists(newPath)) return; /* name collision despite the loop above */
    const now = new Date().toISOString();
    const copy = Object.assign(JSON.parse(JSON.stringify(obj)),
        { id: "setlist-" + Date.now(), name: newName, created: now, path: newPath });
    saveSetlist(copy);
    const idx = setlistFiles.findIndex(f => f.path === newPath);
    if (idx >= 0) selectedSetlistIndex = idx + 1;
    showPopup("Setlist", "Copied as " + newName, 2000);
    needsRedraw = true;
}

function handleSetlistEditInput(cc, value) {
    if (!currentSetlist) return;
    const itemCount = currentSetlist.songs.length + 2; /* songs + add entry + knobs */
    if (cc === MoveMainKnob) {
        const delta = decodeDelta(value);
        if (shiftHeld) {
            /* Shift + Jog moves the selected song up/down in the set. */
            if (setlistSongIndex < currentSetlist.songs.length) {
                moveSetlistSong(currentSetlist, setlistSongIndex, delta);
            }
            needsRedraw = true;
        } else {
            const newIdx = Math.max(0, Math.min(itemCount - 1, setlistSongIndex + delta));
            if (newIdx !== setlistSongIndex) {
                setlistSongIndex = newIdx;
                needsRedraw = true;
            }
        }
    } else if (cc === MoveMainButton && value > 0) {
        if (setlistSongIndex === currentSetlist.songs.length + 1) {
            /* Jog click on "(knobs)": the setlist's knob mappings. */
            openKnobMap("setlist", VIEW_SETLIST_EDIT);
        } else if (setlistSongIndex >= currentSetlist.songs.length) {
            /* Jog click on "(add song)" opens the Song Bank picker. */
            songFiles = listSongFiles();
            setlistPickIndex = 0;
            currentView = VIEW_SETLIST_PICK;
            menuStack.push({ title: "Add Song", selectedIndex: 0 });
            needsRedraw = true;
        } else {
            /* Jog click on a song opens Transition settings directly. */
            clickSettingsFocus = 0;
            clickSettingsEditing = false;
            currentView = VIEW_SETLIST_CLICK;
            menuStack.push({ title: "Transitions", selectedIndex: 0 });
            needsRedraw = true;
        }
    } else if (cc === MoveDelete && value > 0 && setlistSongIndex < currentSetlist.songs.length) {
        removeSetlistSong(currentSetlist, setlistSongIndex);
        setlistSongIndex = Math.max(0, Math.min(setlistSongIndex, currentSetlist.songs.length - 1));
        needsRedraw = true;
    } else if (cc === MoveBack && value > 0) {
        menuStack.pop();
        currentView = VIEW_SETLIST_BANK;
        needsRedraw = true;
    }
}

function handleSetlistPickInput(cc, value) {
    if (cc === MoveMainKnob) {
        const delta = decodeDelta(value);
        const newIdx = Math.max(0, Math.min(songFiles.length - 1, setlistPickIndex + delta));
        if (newIdx !== setlistPickIndex) {
            setlistPickIndex = newIdx;
            needsRedraw = true;
        }
    } else if (cc === MoveMainButton && value > 0) {
        const entry = songFiles[setlistPickIndex];
        if (entry && currentSetlist) {
            addSongToSetlist(currentSetlist, entry);
            menuStack.pop();
            currentView = VIEW_SETLIST_EDIT;
            needsRedraw = true;
        }
    } else if (cc === MoveBack && value > 0) {
        menuStack.pop();
        currentView = VIEW_SETLIST_EDIT;
        needsRedraw = true;
    }
}

function handleSectionPickInput(cc, value) {
    const names = sectionPickNames();
    if (cc === MoveMainKnob) {
        const delta = decodeDelta(value);
        const newIdx = Math.max(0, Math.min(names.length - 1, sectionPickIndex + delta));
        if (newIdx !== sectionPickIndex) {
            sectionPickIndex = newIdx;
            needsRedraw = true;
        }
    } else if (cc === MoveMainButton && value > 0 && sectionPickRename) {
        const section = sectionPickTarget;
        sectionPickRename = false;
        sectionPickTarget = null;
        menuStack.pop();
        currentView = VIEW_BUILDER;
        if (sectionPickIndex === 0) {
            renameSectionKeyboard(section);
        } else if (section && names[sectionPickIndex]) {
            section.name = names[sectionPickIndex];
            unsavedChanges = true;
        }
        needsRedraw = true;
    } else if (cc === MoveMainButton && value > 0) {
        const name = SECTION_NAMES[sectionPickIndex];
        if (name && currentSong) {
            const newSec = newSection(name);
            currentSong.sections.splice(currentSectionIndex + 1, 0, newSec);
            currentSectionIndex++;
            builderCursor = 0;
            unsavedChanges = true;
            stepLedsDirty = true;
        }
        menuStack.pop();
        currentView = VIEW_BUILDER;
        needsRedraw = true;
    } else if (cc === MoveBack && value > 0) {
        sectionPickRename = false;
        sectionPickTarget = null;
        menuStack.pop();
        currentView = VIEW_BUILDER;
        needsRedraw = true;
    }
}

function handleSetlistClickInput(cc, value) {
    if (!currentSetlist) return;
    const entry = setlistEntry();
    const row = SETLIST_SONG_ROWS[clickSettingsFocus];
    if (cc === MoveMainKnob) {
        const delta = decodeDelta(value);
        if (clickSettingsEditing && entry && row) {
            if (row.key === "bars") {
                setSetlistClickBars(currentSetlist, setlistSongIndex, (entry.click_bars || 0) + delta);
            } else if (row.key === "sound") {
                setSetlistClickSound(currentSetlist, setlistSongIndex, !clickSoundOn(entry));
            } else if (row.key === "stop") {
                setSetlistStopAfterFinish(currentSetlist, setlistSongIndex, !(entry.stop_after_finish || false));
            } else if (row.key === "skey") {
                stepSetlistKey(entry, delta);
                saveSetlist(currentSetlist);
            } else if (row.key === "tempo") {
                stepSetlistTempo(entry, delta);
                saveSetlist(currentSetlist);
            }
        } else {
            clickSettingsFocus = Math.max(0, Math.min(SETLIST_SONG_ROWS.length - 1, clickSettingsFocus + delta));
        }
        needsRedraw = true;
    } else if (cc === MoveMainButton && value > 0) {
        if (row && row.key === "knobs") {
            /* This song's knobs: overrides of the setlist's. */
            clickSettingsEditing = false;
            openKnobMap("song", VIEW_SETLIST_CLICK);
            return;
        }
        if (row && row.key === "sections") {
            clickSettingsEditing = false;
            openSetlistSections();
            return;
        }
        clickSettingsEditing = !clickSettingsEditing;
        needsRedraw = true;
    } else if (cc === MoveBack && value > 0) {
        if (clickSettingsEditing) {
            clickSettingsEditing = false;
            needsRedraw = true;
        } else {
            setlistSongFileCache = null;
            menuStack.pop();
            currentView = VIEW_SETLIST_EDIT;
            needsRedraw = true;
        }
    }
}

/* ── Setlist song > Sections: the order this setlist plays them in ────
 *
 * The rows are the sections in play order, then "+ Add" (any of the song's
 * sections, after the selected one) and, once the order is the setlist's
 * own, "Reset" (back to the song's). Shift + jog moves the selected
 * section, Copy repeats it, Delete leaves it out. The first change makes the
 * order the setlist's own (entry.sections). */
let setlistSecCursor = 0;
let setlistSecPickIndex = 0;

/* The current order as references: the setlist's, else the song's own. */
function setlistSecRefs() {
    const entry = setlistEntry();
    const song = setlistSongFile(entry);
    const secs = song && Array.isArray(song.sections) ? song.sections : [];
    return setlistSectionIndices(song, entry).map(i => ({ i, name: secs[i] ? (secs[i].name || "") : "" }));
}

function setlistSectionRows() {
    const entry = setlistEntry();
    const rows = setlistSecRefs().map((ref, k) => ({ type: "section", ref, k }));
    rows.push({ type: "add" });
    if (entry && Array.isArray(entry.sections)) rows.push({ type: "reset" });
    return rows;
}

/* Make the order the setlist's own and save it. */
function setSetlistSecRefs(refs) {
    const entry = setlistEntry();
    if (!entry) return;
    entry.sections = refs.map(r => ({ i: r.i, name: r.name }));
    saveSetlist(currentSetlist);
    needsRedraw = true;
}

function openSetlistSections() {
    setlistSongFileCache = null;
    setlistSecCursor = 0;
    currentView = VIEW_SETLIST_SECTIONS;
    menuStack.push({ title: "Sections", selectedIndex: 0 });
    needsRedraw = true;
}

function drawSetlistSections() {
    const entry = setlistEntry();
    drawMenuHeader(scrollHeader("Sections: " + (entry ? shortSongName(entry.name) : ""), 28),
        entry && Array.isArray(entry.sections) ? "SET" : "");
    const rows = setlistSectionRows();
    if (setlistSecCursor >= rows.length) setlistSecCursor = rows.length - 1;
    drawMenuList({
        ...LIST_ROW_FIT,
        labelX: 3,
        items: rows,
        selectedIndex: setlistSecCursor,
        getLabel: (row) => row.type === "section" ? (row.ref.name || "Section") : (row.type === "add" ? "+ Add" : "Reset to Song"),
        /* Where it is in the song, so repeats and moves read plainly. */
        getValue: (row) => row.type === "section" ? "#" + (row.ref.i + 1) : "",
        valueAlignRight: true,
        labelGap: LIST_LABEL_GAP,
        listArea: { topY: LIST_TOP_Y, bottomY: LIST_INDICATOR_BOTTOM_Y }
    });
}

function handleSetlistSectionsInput(cc, value) {
    const rows = setlistSectionRows();
    const row = rows[setlistSecCursor];
    const refs = setlistSecRefs();
    if (cc === MoveMainKnob) {
        const delta = decodeDelta(value);
        if (shiftHeld && row && row.type === "section") {
            /* Move the selected section earlier / later. */
            const to = Math.max(0, Math.min(refs.length - 1, row.k + delta));
            if (to !== row.k) {
                const [moved] = refs.splice(row.k, 1);
                refs.splice(to, 0, moved);
                setSetlistSecRefs(refs);
                setlistSecCursor = to;
            }
        } else {
            setlistSecCursor = Math.max(0, Math.min(rows.length - 1, setlistSecCursor + delta));
        }
        needsRedraw = true;
    } else if (cc === MoveCopy && value > 0 && row && row.type === "section") {
        /* Repeat: the same section again, right after it. */
        refs.splice(row.k + 1, 0, Object.assign({}, refs[row.k]));
        setSetlistSecRefs(refs);
        setlistSecCursor = row.k + 1;
        showPopup("Sections", "Repeated " + (row.ref.name || "Section"), 1500);
    } else if (cc === MoveDelete && value > 0 && row && row.type === "section") {
        if (refs.length <= 1) {
            showPopup("Sections", "A song plays at least one section", 2000);
            needsRedraw = true;
            return;
        }
        refs.splice(row.k, 1);
        setSetlistSecRefs(refs);
        setlistSecCursor = Math.min(row.k, refs.length - 1);
    } else if (cc === MoveMainButton && value > 0 && row) {
        if (row.type === "add") {
            setlistSecPickIndex = 0;
            currentView = VIEW_SETLIST_SECTION_PICK;
            menuStack.push({ title: "Add Section", selectedIndex: 0 });
            needsRedraw = true;
        } else if (row.type === "reset") {
            const entry = setlistEntry();
            if (entry) delete entry.sections;
            saveSetlist(currentSetlist);
            setlistSecCursor = 0;
            showPopup("Sections", "Back to the song's order", 1500);
            needsRedraw = true;
        }
    } else if (cc === MoveBack && value > 0) {
        menuStack.pop();
        currentView = VIEW_SETLIST_CLICK;
        needsRedraw = true;
    }
}

/* + Add: one of the song's sections, inserted after the selected one (at
 * the end from "+ Add"). */
function songSectionsOfEntry() {
    const song = setlistSongFile(setlistEntry());
    return song && Array.isArray(song.sections) ? song.sections : [];
}

function drawSetlistSectionPick() {
    drawMenuHeader("Add Section", "");
    const secs = songSectionsOfEntry();
    drawMenuList({
        ...LIST_ROW_FIT,
        labelX: 3,
        items: secs.map((sec, i) => ({ name: sec.name || ("Section " + (i + 1)), i })),
        selectedIndex: setlistSecPickIndex,
        getLabel: (it) => it.name,
        getValue: (it) => "#" + (it.i + 1),
        valueAlignRight: true,
        labelGap: LIST_LABEL_GAP,
        listArea: { topY: LIST_TOP_Y, bottomY: LIST_INDICATOR_BOTTOM_Y }
    });
}

function handleSetlistSectionPickInput(cc, value) {
    const secs = songSectionsOfEntry();
    if (cc === MoveMainKnob) {
        setlistSecPickIndex = Math.max(0, Math.min(secs.length - 1, setlistSecPickIndex + decodeDelta(value)));
        needsRedraw = true;
    } else if (cc === MoveMainButton && value > 0 && secs[setlistSecPickIndex]) {
        const refs = setlistSecRefs();
        const at = Math.min(setlistSecCursor + 1, refs.length);
        refs.splice(at, 0, { i: setlistSecPickIndex, name: secs[setlistSecPickIndex].name || "" });
        setSetlistSecRefs(refs);
        setlistSecCursor = at;
        menuStack.pop();
        currentView = VIEW_SETLIST_SECTIONS;
        needsRedraw = true;
    } else if (cc === MoveBack && value > 0) {
        menuStack.pop();
        currentView = VIEW_SETLIST_SECTIONS;
        needsRedraw = true;
    }
}

function handlePerformanceInput(cc, value) {
    /* Main knob is intentionally unused in performance view: song/section
     * selection is done with pads, and the display uses plain print(). The
     * 8 knobs drive the setlist's Schwung parameters (see KNOB_COUNT). */
    if (cc === MoveCapture) { if (value > 0) setKeys(!keysOn); return; }
    if (keysOn && (cc === MoveUp || cc === MoveDown)) { if (value > 0) shiftKeysOctave(cc === MoveUp ? 1 : -1); return; }
    if (cc >= 71 && cc <= 78) {
        turnPerfKnob(cc - 71, decodeDelta(value));
    } else if (cc === MoveUp && value > 0) {
        /* Scroll the pad window up one row (reveal higher sections).
         * Reversed: Up scrolls down (reveal lower sections). */
        const maxRow = Math.max(0, Math.ceil(perfSongSections.length / 8) - 4);
        perfScrollRow = Math.min(maxRow, perfScrollRow + 1);
        perfManualScroll = true; /* user took over; stop auto-follow */
        needsRedraw = true;
        ledDirtyAll = true;
    } else if (cc === MoveDown && value > 0) {
        /* Scroll the pad window down one row (reveal lower sections).
         * Reversed: Down scrolls up (reveal higher sections). */
        perfScrollRow = Math.max(0, perfScrollRow - 1);
        perfManualScroll = true; /* user took over; stop auto-follow */
        needsRedraw = true;
        ledDirtyAll = true;
    } else if (cc === MovePlay && value > 0) {
        if (perfPlaying) {
            perfStop();
        } else {
            /* If a different song was selected while stopped, switch to it.
             * Leave section selection intact so perfStart can jump to it. */
            if (perfSelectedSong >= 0 && perfSelectedSong !== perfSongIndex) {
                logDebug("PERFPLAY switch to selected song=" + perfSelectedSong);
                if (perfLoadSong(perfSelectedSong)) {
                    perfSongIndex = perfSelectedSong;
                    perfSelectedSong = -1;
                }
            }
            logDebug("PERFPLAY start selectedSection=" + perfSelectedSection + " selectedSong=" + perfSelectedSong + " songIndex=" + perfSongIndex);
            perfStart();
        }
    } else if (cc === MoveRow4 && value > 0) {
        /* Track 4: the Pads, live, as Track 1-3 mute the others -- as in
         * Jam. The click moved to Shift + Track 4. */
        if (shiftHeld) {
            toggleClick();
        } else {
            perfInst3Enabled = !perfInst3Enabled;
            showPopup("Pads", perfInst3Enabled ? "On" : "Off", 2000);
            if (typeof host_module_set_param === "function") host_module_set_param("inst3_enabled", perfInst3Enabled ? "1" : "0");
            needsRedraw = true;
            ledDirtyAll = true;
        }
    } else if ((cc === MoveRow1 || cc === MoveRow2 || cc === MoveRow3) && value > 0) {
        /* Live mute toggle for drums/Inst 1/Inst 2 (Track 1/2/3, same as
         * Song Builder's track buttons). */
        if (cc === MoveRow1) {
            perfDrumEnabled = !perfDrumEnabled;
            showPopup("Drums", perfDrumEnabled ? "On" : "Off", 2000);
            if (typeof host_module_set_param === "function") {
                host_module_set_param("drum_enabled", perfDrumEnabled ? "1" : "0");
            }
        } else if (cc === MoveRow2) {
            perfInst1Enabled = !perfInst1Enabled;
            showPopup("Inst 1", perfInst1Enabled ? "On" : "Off", 2000);
            if (typeof host_module_set_param === "function") {
                host_module_set_param("inst1_enabled", perfInst1Enabled ? "1" : "0");
            }
        } else {
            perfInst2Enabled = !perfInst2Enabled;
            showPopup("Inst 2", perfInst2Enabled ? "On" : "Off", 2000);
            if (typeof host_module_set_param === "function") {
                host_module_set_param("inst2_enabled", perfInst2Enabled ? "1" : "0");
            }
        }
        needsRedraw = true;
    } else if (cc === MoveRec && value > 0) {
        perfToggleRecording(currentSetlist ? currentSetlist.name : "");
    } else if (cc === MoveRecord && value > 0) {
        /* Sample: the next bank of knob mappings. */
        perfKnobBank = nextKnobBank(perfKnobBank);
    } else if (cc === MoveBack && value > 0) {
        perfStopRecording();
        perfStop();
        flushKnobSave();
        menuStack.pop();
        currentView = VIEW_ROOT;
        needsRedraw = true;
    }
}

function handlePerfSetlistInput(cc, value) {
    if (cc === MoveMainKnob) {
        const delta = decodeDelta(value);
        const newIdx = Math.max(0, Math.min(setlistFiles.length - 1, perfSetlistIndex + delta));
        if (newIdx !== perfSetlistIndex) {
            perfSetlistIndex = newIdx;
            needsRedraw = true;
        }
    } else if (cc === MoveMainButton && value > 0) {
        const entry = setlistFiles[perfSetlistIndex];
        const path = entry ? entry.path : null;
        const obj = path ? readJson(path) : null;
        if (obj) {
            obj.path = path;
            /* The Move Set first: the setlist's knobs were mapped against the
             * chains of the Set it was last played with. Back stays here. */
            checkMoveSet(obj, () => enterPerformanceSetlist(obj), null);
        }
    } else if (cc === MoveBack && value > 0) {
        menuStack.pop();
        currentView = VIEW_ROOT;
        needsRedraw = true;
    }
}

/* Open a setlist in Performance (after the Move Set check). */
function enterPerformanceSetlist(obj) {
    currentSetlist = obj;
    perfKnobsKey = "";
    perfSongLoaded = false;
    perfSongIndex = 0;
    perfPlaying = false;
    perfDisplayIndex = 0;
    /* Re-entering perform mode starts the pad window at the top. */
    perfScrollRow = 0;
    perfManualScroll = false;
    /* Load the first playable song immediately so the display and step
     * LEDs reflect real section data before Play is pressed. */
    const firstPlayable = perfNextPlayable(0);
    if (firstPlayable >= 0) {
        perfLoadSong(firstPlayable, true); /* entering Perform: fresh mutes */
    }
    perfSongSections = buildPerfLayout();
    currentView = VIEW_PERFORMANCE;
    menuStack.push({ title: "Performance", selectedIndex: 0 });
    needsRedraw = true;
    stepLedsDirty = true;
    ledDirtyAll = true;
}

/* ── Jam input handling ────────────────────────────────────────────── */

function handleJamFolderInput(cc, value) {
    const node = getTreeNode(libraryCategoryTree, jamFolderPickerPath);
    const items = node ? getTreeDisplayItems(node) : [];
    if (cc === MoveMainKnob) {
        const delta = decodeDelta(value);
        const newIdx = Math.max(0, Math.min(items.length - 1, jamFolderPickerSelectedIndex + delta));
        if (newIdx !== jamFolderPickerSelectedIndex) {
            jamFolderPickerSelectedIndex = newIdx;
            needsRedraw = true;
        }
    } else if (cc === MoveMainButton && value > 0) {
        const item = items[jamFolderPickerSelectedIndex];
        if (!item) return;
        if (item.type === "category") {
            /* Drill into the selected sub-category. Remember the current
             * cursor so Back can return to it. */
            jamFolderPickerSelectedStack.push(jamFolderPickerSelectedIndex);
            jamFolderPickerPath = jamFolderPickerPath.concat([item.name]);
            jamFolderPickerSelectedIndex = 0;
            needsRedraw = true;
            return;
        }
        const folderIndex = item.index;
        /* Enter the selected folder into the Jam screen. */
        jamLoadFolder(folderIndex);
        /* If the DSP folder scan isn't ready yet (fresh boot), retry loading
         * the clips each tick until they arrive, so the Jam pads aren't left
         * empty on first entry. */
        pendingJamFolderClipLoadIndex = (jamGrooves.length === 0 && jamFills.length === 0) ? folderIndex : -1;
        jamGrooveScroll = 0;
        jamCurrentClip = null;
        jamReturnGroove = null;
        jamQueue = [];
        jamPlaying = false;
        jamQueuedGroove = null;
        jamQueuedGrooveEscalated = false;
        jamFillQueued = false;
        jamCurrentType = "";
        /* Read the BPM from the folder name (e.g. "Song 13 4-4 120 BPM"). */
        jamBpm = inferTempoFromFolder(libraryFolders[folderIndex] || "");
        currentView = VIEW_JAM;
        menuStack.push({ title: "Jam", selectedIndex: 0 });
        /* Live mute toggles and the chord register are a per-session
         * performance control, not a saved preference -- reset on every
         * (re)entry and push that to the DSP in case a previous Perform/Jam
         * session left something in place (drum_enabled and the jam_inst/
         * jam_chord state aren't part of any song JSON, so they persist on
         * the engine instance until explicitly reset). Drums default ON
         * (Jam is drum-clip-centric); the two instruments default OFF --
         * unlike Perform, there's no baked song to inherit an "on" state
         * from, and defaulting them on would force the chord-pad grid to
         * appear the instant Jam is entered, before the user has asked for
         * it (see jamChordModeActive/drawJamLEDs). */
        jamDrumEnabled = true;
        jamInst1Enabled = false;
        jamInst2Enabled = false;
        jamPadsEnabled = false;
        jamChordPendingDegree = -1;
        jamChordLiveDegree = -1;
        jamLastBarCounterForChord = -1;
        jamLastSwapCounterForChord = -1;
        jamChordHoldDegree = -1;
        jamChordHoldShown = false;
        jamKeyChangePending = false;
        jamInstConfig = jamInstDefaults();
        jamInstRoutingPushed = [false, false, false];
        /* Three different keys back to back -- use the blocking variant so
         * none of them can be clobbered by the next before the DSP
         * consumes it (see pushJamInstrumentRouting's comment). */
        if (typeof host_module_set_param === "function" ||
            typeof host_module_set_param_blocking === "function") {
            const block = typeof host_module_set_param_blocking === "function";
            const set = block ? host_module_set_param_blocking : host_module_set_param;
            const t = block ? 100 : undefined;
            set("drum_enabled", "1", t);
            set("jam_inst1_enabled", "0", t);
            set("jam_inst2_enabled", "0", t);
            set("jam_inst3_enabled", "0", t);
            /* Clear the DSP's own jam_chord_live/pending too -- they're
             * engine-level state that outlives a song_json reload (see the
             * comment above), so without this a chord selected in a
             * previous Jam visit kept sounding the instant an instrument
             * was re-enabled here, even though the pad grid (reset just
             * above) showed nothing selected. A real bug: leaving Jam and
             * coming back must fully reset the chord, not just its display. */
            set("jam_chord", "off", t);
        }
        needsRedraw = true;
        stepLedsDirty = true;
        ledDirtyAll = true;
    } else if (cc === MoveBack && value > 0) {
        if (jamFolderPickerPath.length > 0) {
            /* Back out to the parent category, restoring the cursor the user
             * was on before drilling in. */
            jamFolderPickerPath = jamFolderPickerPath.slice(0, jamFolderPickerPath.length - 1);
            jamFolderPickerSelectedIndex = jamFolderPickerSelectedStack.length > 0
                ? jamFolderPickerSelectedStack.pop()
                : 0;
            needsRedraw = true;
            return;
        }
        menuStack.pop();
        currentView = VIEW_ROOT;
        needsRedraw = true;
    }
}

/* Build a one-section engine song JSON for a single clip. */
function jamClipToSongJson(clip) {
    const base = newSong(libraryFolders[currentJamFolderIndex()] || "");
    const temp = JSON.parse(JSON.stringify(base));
    temp.tempo_bpm = jamBpm; /* use the Jam BPM (folder-derived, jog-adjustable) */
    temp.sections = [{
        id: "jam-" + Date.now(),
        name: "Jam",
        clips: [{
            source: clip.path,
            name: clip.name,
            start_bar: clipStartBar(clip),
            end_bar: clip.bars || 1,
            guard_fraction: 0.125, /* ~13% guard on shortened clips */
            velocity_scale: 1.0
        }]
    }];
    return toEngineSongJson(temp);
}

/* Preload a clip into the DSP staging timeline so it can be swapped in
 * instantly at the next musical boundary. Use the blocking set_param path so
 * the preload value is guaranteed to reach the DSP before the next
 * fire-and-forget call can overwrite the shared shadow-param slot. `resumeTick`
 * is the position (in ticks) at which the staged clip should start when it is
 * swapped in (0 = from the start). */
function jamPreloadClip(clip, resumeTick, onConfirmed) {
    if (!clip) return;
    if (typeof host_module_set_param !== "function") return;
    const json = jamClipToSongJson(clip);
    const isFill = clip.type === "fill";
    const nonLoop = isNonLoopingClip(clip);
    const loopVal = nonLoop ? "0" : "1";
    const rTick = resumeTick || 0;
    logJam("PRELOAD clip=" + (clip.name || clip.path) + " type=" + (clip.type || "?") + " bpm=" + jamBpm + " loop=" + loopVal + " resume=" + rTick + " json_len=" + json.length);
    /* preload_song_json now builds asynchronously on the DSP's worker thread
     * and returns instantly -- the blocking write still guarantees delivery
     * into the single shared shadow_param slot (it just no longer also waits
     * out a build), so it keeps a short 100ms delivery-only budget instead of
     * the old 500ms build-covering one. jamStagedClip (and every downstream
     * consumer chained off it: jamStartClip's canSwap, jamSwapStaged,
     * jamFireNext) is set only once the DSP confirms staging_published_gen
     * actually advanced, not the instant this call returns -- see
     * requestStagingBuild. */
    requestStagingBuild(function () {
        if (typeof host_module_set_param_blocking === "function") {
            host_module_set_param_blocking("preload_song_json", json, 100);
            host_module_set_param_blocking("staging_loop", loopVal, 100);
            host_module_set_param_blocking("swap_resume", String(rTick), 100);
        } else {
            host_module_set_param("preload_song_json", json);
            host_module_set_param("staging_loop", loopVal);
            host_module_set_param("swap_resume", String(rTick));
        }
    }, function () {
        jamStagedClip = clip;
        jamStagedIsFill = isFill;
        jamStagedResumeTick = rTick;
        if (onConfirmed) onConfirmed();
    });
}

/* Swap the staged timeline into the active DSP playback at the current musical
 * boundary. Use the blocking path because swap must not be dropped by the
 * fire-and-forget shadow param slot. Encode the target tick so the DSP can
 * apply the swap sample-accurately inside the audio callback. */
function jamSwapStaged(clip) {
    if (!clip) return;
    if (typeof host_module_set_param !== "function") return;
    let targetTick = "1";
    if (lastDspTransport && lastDspTransport.ticks_per_bar > 0) {
        /* This is called from jamFireNext at a fire boundary, where the
         * playhead has ALREADY reached the start of the current bar. So the
         * swap should happen now (at the current bar), not at the end of the
         * current bar. If we targeted the bar's end the clip would play one
         * bar late. Target the current bar's start (bar-1)*tpb; the DSP sees
         * a target at/below the playhead and applies the swap immediately in
         * the next render block. */
        const bar = lastDspTransport.bar || 1;
        let tick = (bar - 1) * lastDspTransport.ticks_per_bar;
        /* Never schedule before tick 0. */
        if (tick < 0) tick = 0;
        targetTick = String(tick);
    }
    logJam("SWAP -> clip=" + (clip.name || clip.path) + " type=" + (clip.type || "?") + " tick=" + targetTick);
    /* Re-assert the clip's loop mode right before the swap. The return-groove
     * preload that follows (in jamStartClip) sets loop=1 on the staging, which
     * would otherwise overwrite a fill's non-looping flag before the swap
     * fires — leaving the fill looping forever instead of auto-swapping back
     * to the groove. Sending loop here guarantees the swapped-in clip uses
     * the correct loop mode. */
    const swapLoop = isNonLoopingClip(clip) ? "0" : "1";
    const rejectedBefore = (lastDspState && lastDspState.staging_swap_rejected) || 0;
    if (typeof host_module_set_param_blocking === "function") {
        host_module_set_param_blocking("staging_loop", swapLoop, 100);
        host_module_set_param_blocking("swap", targetTick, 500);
    } else {
        host_module_set_param("staging_loop", swapLoop);
        host_module_set_param("swap", targetTick);
    }
    /* Confirm the mid-clip swap guard was applied: read the DSP's count of
     * note-ons suppressed by the guard. A non-zero value means the guard
     * window is active at the swap boundary. */
    if (typeof host_module_get_param === "function") {
        try {
            const suppressed = host_module_get_param("swap_guard_suppressed");
            logJam("SWAP guard_suppressed=" + (suppressed || "0") + " fraction=" + swapGuardFraction);
        } catch (e) {}
    }
    /* Regression tripwire: jamSwapStaged is only reachable via a confirmed
     * canSwap (jamStagedClip is set only once preload_song_json's build is
     * DSP-confirmed -- see jamPreloadClip), so this swap should never be
     * rejected for lack of staging. If it is, something upstream is calling
     * swap without waiting for confirmation -- exactly the class of bug that
     * broke Jam mode before this rearchitecture. */
    if (typeof host_module_get_param === "function") {
        try {
            const state = JSON.parse(host_module_get_param("state") || "{}");
            if ((state.staging_swap_rejected || 0) > rejectedBefore) {
                logJam("SWAP WARNING: staging_swap_rejected advanced -- swap fired without confirmed staging");
            }
        } catch (e) {}
    }
    jamCurrentClip = clip;
    jamCurrentType = clip.type || "groove";
    jamLastBarCounter = -1;
    jamLastWrapCounter = -1;
    jamLastSwapCounter = -1;
    jamSettling = true;
    jamStagedClip = null;
    playbackSectionIndex = 0;
    resetStepFlash();
    needsRedraw = true;
    stepLedsDirty = true;
}

/* Play a single clip looped through the DSP synchronously (used for the first
 * clip before any active timeline exists, or as a fallback). */
function jamPlayClip(clip, forceNonLoop) {
    if (!clip) return;
    const saved = currentSong;
    const savedLoop = dspLoopEnabled;
    currentSong = null; /* playCurrentSong will receive pendingSongJson from the temp song below */
    previewBarOffset = 0;
    dspLoopEnabled = true; /* always loop in Jam mode */

    const temp = newSong(libraryFolders[currentJamFolderIndex()] || "");
    temp.tempo_bpm = jamBpm;
    temp.sections = [{
        id: "jam-" + Date.now(),
        name: "Jam",
        clips: [{
            source: clip.path,
            name: clip.name,
            start_bar: clipStartBar(clip),
            end_bar: clip.bars || 1,
            guard_fraction: 0.125,
            velocity_scale: 1.0
        }]
    }];
    currentSong = temp;
    /* currentSong/dspLoopEnabled are restored right after issuing the
     * request (below), not after it confirms -- playCurrentSong already
     * captures everything it needs (the JSON, via `json`) before this
     * function returns, so restoring the caller's state immediately is
     * safe. The "this clip is now actually playing" state (jamCurrentClip
     * etc.), however, must wait for DSP confirmation -- see onConfirmed. */
    playCurrentSong(false, function () {
        /* Re-assert the correct loop mode on the DSP after playback starts.
         * The DSP's song_json handler resets e->loop to 0, and this must
         * happen after song_json is confirmed built, or it could be applied
         * before the build (harmless, since e->loop is a plain scalar) but
         * logically belongs with "the build just landed". forceNonLoop lets a
         * caller (e.g. the Jam preview hold, a temporary one-shot audition)
         * override the clip's own loop type -- it must go through here rather
         * than as a separate write at the call site, since a separate write
         * issued right after jamPlayClip() returns would run BEFORE this
         * confirmed reassert and get overwritten by it. */
        if (typeof host_module_set_param === "function") {
            host_module_set_param("loop", forceNonLoop ? "0" : (isNonLoopingClip(clip) ? "0" : "1"));
        }
        jamCurrentClip = clip;
        jamCurrentType = clip.type || "groove";
        jamLastBarCounter = -1;
        jamLastWrapCounter = -1;
        jamLastSwapCounter = -1;
        /* Every path through here issues a fresh "play" (a full restart to
         * tick 0, not a smooth staged swap -- see jamSwapStaged, which never
         * calls jamPlayClip), and the DSP's own "play" handler now promotes
         * any pending Jam chord to live immediately for exactly that reason
         * (see apply_pending_jam_chord's call site in arranger_engine.c).
         * Mirror that promotion here so the pad LEDs/status line don't lag
         * behind by a transport poll. jamLastBarCounterForChord is rebased
         * so the ordinary bar_counter-change promotion (mid-performance
         * pad presses -- see updateDspState) doesn't also fire for this
         * same change. */
        if (jamChordPendingDegree >= 0) {
            jamChordLiveDegree = jamChordPendingDegree;
            jamChordLiveKey = jamChordPendingKey;
            jamChordPendingDegree = -1;
        }
        jamLastBarCounterForChord = -1;
        jamLastSwapCounterForChord = -1;
        /* Wait one tick after starting a clip before evaluating boundaries, so
         * the first bar=1 (which the DSP always reports at playback start)
         * isn't mistaken for a loop wrap / groove finish. Without this, fills
         * are cut instantly and a just-started groove immediately tries to
         * "finish". */
        jamSettling = true;
        jamStagedClip = null;
        playbackSectionIndex = 0;
        resetStepFlash();
        needsRedraw = true;
        stepLedsDirty = true;
        logJam("PLAY clip=" + (clip.name || clip.path) + " bars=" + (clip.bars || 1) +
            " type=" + (clip.type || "?") + " loop=true (always loop in Jam mode) bpm=" + jamBpm);
    });
    dspLoopEnabled = savedLoop;
    currentSong = saved;
}

/* Stop Jam playback and reset all Jam state, so the display/pads/buttons
 * reflect the stopped state. */
function jamStopPlayback() {
    jamPlaying = false;
    jamCurrentClip = null;
    jamReturnGroove = null;
    jamReturnFromStart = false;
    jamStandaloneFill = false;
    jamQueue = [];
    jamQueuedGroove = null;
    jamQueuedGrooveEscalated = false;
    jamFillQueued = false;
    jamFillBaseBar = 1;
    jamFillsPlayedBars = 0;
    jamStagedClip = null;
    jamScheduledSwap = null;
    jamScheduledSwapBar = -1;
    jamCurrentType = "";
    stopPlayback();
    needsRedraw = true;
    stepLedsDirty = true;
    ledDirtyAll = true;
}

/* Start looping a groove immediately (first groove press). */
function jamStartGroove(clip) {
    jamPlaying = true;
    jamCurrentType = clip.type || "groove";
    jamStandaloneFill = false;
    jamReturnFromStart = false;
    jamReturnGroove = clip;
    jamQueue = [];
    jamQueuedGroove = null;
    jamQueuedGrooveEscalated = false;
    jamFillQueued = false;
    jamFillBaseBar = 1;
    jamFillsPlayedBars = 0;
    jamPlayClip(clip);
}

/* Start playback with an intro fill (pressed while stopped). The fill plays
 * once, then the DSP auto-swaps to the first intro groove, which loops. */
function jamStartWithIntroFill(fill) {
    const introGroove = jamGrooves.find(g => g.type === "intro")
        || jamGrooves.find(g => g.type === "verse")
        || null;
    jamPlaying = true;
    jamCurrentType = "intro";
    /* This fill starts playback on its own (no groove yet), so the step LEDs
     * should show only the fill's own length until the return groove swaps in. */
    jamStandaloneFill = true;
    jamReturnGroove = introGroove;
    jamQueue = [];
    jamQueuedGroove = null;
    jamQueuedGrooveEscalated = false;
    jamFillQueued = false;
    jamFillBaseBar = 1;
    jamFillsPlayedBars = 0;
    jamPlayClip(fill);
    if (introGroove) {
        jamPreloadClip(introGroove);
    }
    logJam("START intro fill -> " + fill.name + " return=" + (introGroove ? introGroove.name : "none"));
}

/* Queue a groove: first press = after current groove finishes; same pad
 * again = after current bar finishes. */
function jamQueueGroove(clip) {
    if (!jamPlaying) {
        logJam("PAD groove start (no playback yet) -> " + clip.name);
        jamStartGroove(clip);
        return;
    }
    /* A single press on the currently playing groove queues a bar-end restart
     * (escalated) so the groove can be restarted in place. */
    const isCurrentGroove = jamCurrentClip && jamCurrentClip.type !== "fill" &&
        jamCurrentClip.path === clip.path;
    if ((jamQueuedGroove && jamQueuedGroove.path === clip.path) || isCurrentGroove) {
        /* Same groove pressed again (or the current groove pressed once):
         * escalate to a bar-end restart. Pre-schedule the swap at the exact
         * next bar boundary so it lands sample-accurately. */
        jamQueuedGroove = clip;
        jamQueuedGrooveEscalated = true;
        jamQueue = []; /* clear any pending fills */
        jamFillQueued = false;
        /* jamStagedClip is set by jamPreloadClip itself, only once the DSP
         * confirms the build published -- do not pre-assign it here, that
         * would defeat the confirmation gate canSwap/jamSwapStaged rely on.
         * Likewise, defer the "swap" write itself to onConfirmed: issuing it
         * immediately would race the just-issued (now-async) preload -- see
         * rearch2.md Step 3, "0.7". */
        const curBar = (lastDspTransport && lastDspTransport.bar) ? lastDspTransport.bar : 1;
        jamPreloadClip(clip, undefined, function () {
            if (typeof host_module_set_param_blocking === "function") {
                host_module_set_param_blocking("swap", "0", 100);
            } else if (typeof host_module_set_param === "function") {
                host_module_set_param("swap", "0");
            }
        });
        jamScheduledSwapBar = curBar + 1;
        jamScheduledSwap = clip;
        logJam("PAD groove escalate schedule swap at bar " + jamScheduledSwapBar + " -> " + clip.name);
    } else {
        /* New groove: replace the queue, fire after current groove finishes. */
        if (jamCurrentClip && jamCurrentClip.type === "fill") {
            /* A fill is playing. If the pressed groove is the one we are
             * already returning to, restart it from the start (tick 0) when
             * the fill ends, instead of resuming where it left off. Otherwise
             * make it the new return target. */
            if (jamReturnGroove && jamReturnGroove.path === clip.path) {
                jamReturnFromStart = true;
                /* The return groove may already be staged in the DSP at the
                 * resume position (where it left off). Re-preload it at tick 0
                 * so the auto-swap at the fill's end starts it from the
                 * beginning. */
                jamPreloadClip(clip, 0);
                logJam("PAD groove return-from-start -> " + clip.name);
            } else {
                jamReturnFromStart = false;
                jamQueuedGroove = null;
                jamQueuedGrooveEscalated = false;
                jamReturnGroove = clip;
                jamQueue = [];
                jamFillQueued = false;
                jamFillBaseBar = 1;
                jamFillsPlayedBars = 0;
                jamPreloadClip(clip);
                jamScheduledSwap = null;
                jamScheduledSwapBar = -1;
                logJam("PAD groove set return -> " + clip.name);
            }
        } else {
            jamQueuedGroove = clip;
            jamQueuedGrooveEscalated = false;
            jamQueue = [];
            jamFillQueued = false;
            jamFillBaseBar = 1;
            jamFillsPlayedBars = 0;
            /* Pre-schedule the swap at the end of the current groove (its loop
             * wrap point), so the DSP applies it sample-accurately at the groove
             * end rather than at the next bar boundary. Deferred to
             * onConfirmed -- see the escalate branch above for why.
             *
             * The end tick must be the CURRENTLY PLAYING clip's own length,
             * not dspTimelineInfo.end_tick: that field is get_param("timeline_
             * info"), which reports primary_ch (the song_json/Song Builder/
             * Performance-mode channel) -- Jam mode never touches primary_ch
             * at all, it plays through live_slot via preload_song_json/swap/
             * AUTOSWAP, so timeline_info is always stale/unrelated data here.
             * Confirmed on hardware: every SWAP_SCHEDULED for this branch
             * logged target=960 (one bar) regardless of whether the actual
             * groove was 4 or 8 bars, so it fired at the first bar boundary
             * (or immediately, if the playhead had already passed tick 960)
             * instead of waiting for the real multi-bar groove to finish --
             * same failure shape as jamQueueFill's bug above, different wrong
             * value. jamCurrentClip.bars is the same clip-metadata source
             * jamReturnGrooveResumeTick() already uses correctly for this
             * exact purpose. */
            const curTpb = (lastDspTransport && lastDspTransport.ticks_per_bar) ? lastDspTransport.ticks_per_bar : 240;
            const curBars = Math.max(1, (jamCurrentClip && jamCurrentClip.bars) || 1);
            const endTick = curBars * curTpb;
            jamPreloadClip(clip, undefined, function () {
                if (typeof host_module_set_param_blocking === "function") {
                    host_module_set_param_blocking("swap", String(endTick), 100);
                } else if (typeof host_module_set_param === "function") {
                    host_module_set_param("swap", String(endTick));
                }
            });
            jamScheduledSwapBar = -1; /* groove-end swap, not a bar-boundary swap */
            jamScheduledSwap = clip;
            logJam("PAD groove schedule swap at groove end tick " + endTick + " -> " + clip.name);
        }
    }
    needsRedraw = true;
    ledDirtyAll = true;
}

/* Queue a fill: plays after the current bar finishes, returns to the most
 * recent groove afterwards. Pressing a new fill replaces any previously
 * queued fills, so the newest fill is always the next to play. */
function jamQueueFill(clip) {
    if (!jamPlaying) {
        /* When stopped, an intro fill starts playback: play the fill, then
         * return to the first intro groove. */
        if (clip.type === "fill" && inferSectionFromFilename(clip.name || clip.path) === "intro") {
            jamStartWithIntroFill(clip);
        }
        return;
    }
    /* A new fill supersedes any previously queued fills (and any queued
     * groove), so only the newest fill is queued and lit. */
    jamQueue = [clip];
    jamFillQueued = true;
    jamQueuedGroove = null;
    jamQueuedGrooveEscalated = false;
    /* Preload the new fill into staging so it is ready to play. If a fill is
     * ALREADY playing, do NOT pre-schedule a swap: the currently-playing fill
     * is non-looping and relies on staging to auto-swap when it ends. A
     * pre-scheduled swap would capture the new fill into pending_swap_timeline
     * and clear staging, so the current fill could not auto-swap and playback
     * would stop. Instead, just stage the new fill; the current fill's
     * auto-swap will promote it when it ends. */
    if (jamCurrentClip && jamCurrentClip.type === "fill") {
        /* A fill is playing: stage the new fill, no pre-scheduled swap. */
        jamPreloadClip(clip);
        jamScheduledSwapBar = -1;
        jamScheduledSwap = null;
        logJam("PAD fill queue while fill playing -> " + clip.name + " qLen=" + jamQueue.length);
        needsRedraw = true;
        ledDirtyAll = true;
        return;
    }
    const curBar = (lastDspTransport && lastDspTransport.bar) ? lastDspTransport.bar : 1;
    /* Record the 0-based groove index where this fill batch plays. The fill
     * fires at the start of bar curBar+1 (1-based), which is 0-based index
     * curBar. The groove resumes after the fills at this index plus the fill
     * bars played. Capture it at queue time (not fire time, when the transport
     * would show the fill's own bar 1). */
    jamFillBaseBar = curBar; /* 0-based groove index the fill starts on */
    jamFillsPlayedBars = 0;
    jamScheduledSwapBar = curBar + 1; /* display/log only -- see below */
    jamScheduledSwap = clip;
    logJam("PAD fill queue at bar " + jamScheduledSwapBar + " -> " + clip.name + " qLen=" + jamQueue.length);
    /* Deferred to onConfirmed -- issuing "swap" immediately would race the
     * just-issued (now-async) preload -- see jamQueueGroove above.
     *
     * Pass "0", not a pre-computed absolute tick. This used to compute
     * tick = curBar * tpb here (an absolute tick within the CURRENT loop
     * iteration) and pass that through. But the actual set_param("swap", ...)
     * call only fires once jamPreloadClip's async build confirms -- an
     * unpredictable delay later -- during which the groove can keep
     * looping. By the time the DSP processed it, that tick could already be
     * far in the past relative to the current playhead (observed on
     * hardware: target=4242 computed from a stale tick against
     * playhead=4241, i.e. already passed), which set_param("swap")'s own
     * staleness guard (arranger_engine.c's "if (target_tick <=
     * e->playhead_tick) target_tick = e->playhead_tick + 1") then fires
     * essentially immediately instead of at the intended boundary -- a
     * queued fill playing right away instead of waiting. "0" tells the DSP
     * to compute the next bar boundary itself, from whatever the playhead
     * actually is at the moment it processes the request, which is always
     * fresh regardless of how long the preload took -- the same pattern
     * jamQueueGroove's escalate branch already uses above. */
    jamPreloadClip(clip, undefined, function () {
        if (typeof host_module_set_param_blocking === "function") {
            host_module_set_param_blocking("swap", "0", 100);
        } else if (typeof host_module_set_param === "function") {
            host_module_set_param("swap", "0");
        }
    });
    needsRedraw = true;
    ledDirtyAll = true;
}

/* Start a clip, preferring the preloaded staged timeline and falling back
 * to a synchronous load when no staging is available. After the clip starts,
 * preload the next logical clip so it is ready in time. */
function jamStartClip(clip, preloadNext, preloadResumeTick) {
    if (!clip) return;
    logJam("STARTCLIP clip=" + (clip.name || clip.path) + " staged=" + (jamStagedClip ? jamStagedClip.name : "null") +
        " bar=" + (lastDspTransport ? lastDspTransport.bar : "?") +
        " beat=" + (lastDspTransport ? lastDspTransport.beat : "?") +
        " tpb=" + (lastDspTransport ? lastDspTransport.ticks_per_bar : "?"));
    /* A swap only applies while the engine is actively rendering (advance_playhead
     * processes pending_swap). When the engine has stopped (e.g. a non-looping
     * fill just ended), the staged swap would be left pending forever and playback
     * would stay silent. In that case fall back to a full restart so the clip
     * actually plays. */
    const dspRunning = !!(lastDspState && lastDspState.running);
    const canSwap = jamStagedClip && jamStagedClip.path === clip.path && dspRunning;
    /* Capture whether a fill is currently playing and the return-groove path
     * BEFORE jamSwapStaged/jamPlayClip overwrite jamCurrentClip with the new
     * clip. Used below to decide whether to keep the fill page when returning
     * to the same groove. */
    const wasFillPlaying = !!(jamCurrentClip && jamCurrentClip.type === "fill");
    const returnGroovePath = jamReturnGroove ? jamReturnGroove.path : null;
    if (canSwap) {
        jamSwapStaged(clip);
    } else {
        jamPlayClip(clip);
    }
    /* Reset the fill page only when switching to a DIFFERENT groove (the fill
     * list is re-filtered for the new groove). When returning to the SAME
     * groove after a fill, keep the current fill page so the fills don't jump
     * back to the start. When a fill plays, keep the current fill page too. */
    if (clip.type !== "fill") {
        const returningToSameGroove = wasFillPlaying && returnGroovePath &&
            clip.path === returnGroovePath;
        if (!returningToSameGroove) {
            jamFillScroll = 0;
        }
        /* The return-from-start flag only applies while a fill is playing; once
         * the groove actually starts, clear it so a later fill resumes normally. */
        jamReturnFromStart = false;
    }
    if (preloadNext) {
        /* Stage the next clip (the return groove, or the next fill). If it is
         * the return groove, stage it at the resume position computed from
         * where the groove was when the fill batch fired plus the fill bars
         * played, so the groove continues where it left off (wrapping past its
         * end). */
        const resumeTick = (preloadNext.type !== "fill")
            ? jamReturnGrooveResumeTick()
            : (preloadResumeTick || 0);
        jamPreloadClip(preloadNext, resumeTick);
    }
}

/* Compute the tick within the return groove at which it should resume after a
 * batch of fills. The groove resumes from where it left off (jamFillBaseBar,
 * the 0-based groove index the fill batch started on) plus the total bars of
 * fills played. If the fills take it past the groove's end, restart from the
 * groove's start. Examples:
 *  - 8-bar groove, fill queued in bar 3 plays at 0-based index 2, 1-bar fill
 *    -> resume at 0-based index 3 = 1-based bar 4... (fill plays bar 4, groove
 *    continues at bar 5).
 *  - 4-bar groove, 2-bar fill queued at bar 4 (0-based 3) -> resume past end,
 *    restart at the start (bar 1). */
function jamReturnGrooveResumeTick() {
    if (!jamReturnGroove) return 0;
    /* If the user pressed the return groove's pad during the fill, restart the
     * groove from the start (tick 0) instead of resuming where it left off. */
    if (jamReturnFromStart) return 0;
    const tpb = (lastDspTransport && lastDspTransport.ticks_per_bar) ? lastDspTransport.ticks_per_bar : 240;
    const grooveBars = Math.max(1, jamReturnGroove.bars || 1);
    /* jamFillBaseBar is the 0-based groove index the fill batch started on;
     * fillsPlayedBars is the cumulative fill bars. The groove resumes at this
     * index plus the fill bars played. */
    const baseBar0 = Math.max(0, jamFillBaseBar);
    let bar0 = baseBar0 + jamFillsPlayedBars;
    /* If the fills carry past the groove's end, restart from the beginning. */
    if (bar0 >= grooveBars) bar0 = 0;
    return bar0 * tpb;
}

/* True if the given clip is the DSP's current active source, matched by leaf
 * name (the DSP reports the full absolute path in state.active_source, while
 * the UI's clip.path is folder-relative). Used to confirm that a pre-scheduled
 * swap has actually been applied by the DSP before trusting the UI state. */
function dspActiveMatches(clip) {
    if (!clip) return false;
    if (!lastDspState || !lastDspState.active_source) return false;
    const activeLeaf = lastDspState.active_source.substring(lastDspState.active_source.lastIndexOf("/") + 1);
    const clipLeaf = (clip.path || "").substring((clip.path || "").lastIndexOf("/") + 1);
    return activeLeaf === clipLeaf;
}

/* Fire the next queued clip at a boundary. The staged timeline is swapped
 * in instantly; the next upcoming clip is then preloaded so it is ready in
 * time. */
function jamFireNext() {
    if (jamQueue.length > 0) {
        /* Play the next queued fill. */
        const next = jamQueue.shift();
        /* An outro fill is an ending: it should stop playback when it
         * finishes, not return to a groove. So no return groove is staged. */
        const remaining = (isOutroClip(next) || jamQueue.length > 0)
            ? (jamQueue.length > 0 ? jamQueue[0] : null)
            : jamReturnGroove;
        /* The groove bar where this fill batch resumes FROM was captured at
         * queue time (jamQueueFill sets jamFillBaseBar). Do NOT re-capture it
         * here: at fire time the transport shows the fill's own bar (1), not
         * the groove bar. */
        jamFillsPlayedBars += Math.max(1, next.bars || 1);
        logJam("FIRE fill -> " + next.name + " remaining=" + (remaining ? remaining.name : "none") +
            " fillsPlayed=" + jamFillsPlayedBars);
        /* If this fill's swap was pre-scheduled (jamQueueFill), trust it: the
         * DSP captured the fill into pending_swap_timeline at schedule time,
         * so the swap will apply at the boundary regardless of staging. We do
         * NOT gate on dspActiveMatches — it lags the audio by a poll, so it is
         * often false at the exact fire tick and would wrongly fall through to
         * re-schedule, which re-captures whatever is currently in staging
         * (the return groove) and swaps that in instead of the fill. So if a
         * swap was pre-scheduled for this clip, just update the UI state. */
        if (jamScheduledSwap && jamScheduledSwap.path === next.path) {
            jamCurrentClip = next;
            jamCurrentType = next.type || "groove";
            jamLastBarCounter = -1;
            jamLastWrapCounter = -1;
            jamLastSwapCounter = -1;
            jamSettling = true;
            jamStagedClip = null;
            jamScheduledSwap = null;
            jamScheduledSwapBar = -1;
            playbackSectionIndex = 0;
            resetStepFlash();
            needsRedraw = true;
            stepLedsDirty = true;
            /* Preload the next clip (return groove or next fill) so it is
             * ready when this fill ends. */
            if (remaining) {
                /* If remaining is the return groove, stage it at the resume
                 * position so it continues where it left off; if it is another
                 * fill, stage it at tick 0. */
                const resumeTick = (remaining.type !== "fill")
                    ? jamReturnGrooveResumeTick()
                    : 0;
                jamPreloadClip(remaining, resumeTick);
            }
        } else {
            /* No pre-scheduled swap: swap now so the fill actually plays. */
            jamScheduledSwap = null;
            jamScheduledSwapBar = -1;
            jamStartClip(next, remaining);
        }
        if (jamQueue.length === 0) jamFillQueued = false;
        return;
    }
    if (jamQueuedGroove) {
        /* Switch to the queued groove. */
        const g = jamQueuedGroove;
        jamQueuedGroove = null;
        jamQueuedGrooveEscalated = false;
        jamReturnGroove = g;
        logJam("FIRE groove -> " + g.name);
        /* If this groove's swap was pre-scheduled, trust it (same reasoning as
         * the fill branch: dspActiveMatches lags by a poll and would wrongly
         * fall through to re-schedule). Just update the UI state. */
        if (jamScheduledSwap && jamScheduledSwap.path === g.path) {
            jamCurrentClip = g;
            jamCurrentType = g.type || "groove";
            jamLastBarCounter = -1;
            jamLastWrapCounter = -1;
            jamLastSwapCounter = -1;
            jamSettling = true;
            jamStagedClip = null;
            jamScheduledSwap = null;
            jamScheduledSwapBar = -1;
            playbackSectionIndex = 0;
            resetStepFlash();
            needsRedraw = true;
            stepLedsDirty = true;
        } else {
            /* Stale scheduled swap that didn't apply; clear it and swap now. */
            jamScheduledSwap = null;
            jamScheduledSwapBar = -1;
            jamStartClip(g, null);
        }
        return;
    }
    /* Nothing queued: if we just finished a fill, return to the most recent
     * groove, resuming where it left off (wrapping past its end). */
    if (jamCurrentClip && jamCurrentClip.type === "fill" && jamReturnGroove) {
        logJam("FIRE return-to-groove -> " + jamReturnGroove.name +
            " fillsPlayed=" + jamFillsPlayedBars);
        /* Swap to the return groove at the resume position. */
        jamStartClip(jamReturnGroove, null, jamReturnGrooveResumeTick());
        jamFillBaseBar = 1;
        jamFillsPlayedBars = 0;
    }
}

/* Called every tick while in Jam mode. Detects bar-end and groove-end
 * boundaries from the DSP transport and fires queued clips. Uses wrap
 * detection (position decreasing) so it works for 1-bar clips (fills) where
 * the transport bar stays at 1 and only the beat wraps. */
function jamTick() {
    if (!jamPlaying) return;
    if (!lastDspTransport || !lastDspTransport.running) return;

    const bar = lastDspTransport.bar || 1;
    const beat = lastDspTransport.beat || 1;

    /* Fills are non-looping; the DSP now auto-swaps to a staged return
     * groove when a fill ends. The UI only needs to fall back if the DSP
     * stopped without a staged clip. An outro groove/fill is also non-looping
     * and should stop playback when it finishes. */
    if (lastDspState && lastDspState.stopped_at_end) {
        if (jamCurrentClip && isOutroClip(jamCurrentClip)) {
            /* An outro groove/fill finished: stop playback (outros are
             * endings). Uses isOutroClip, not isNonLoopingClip — a regular
             * fill is also non-looping but must RETURN to its groove, not
             * stop. */
            logJam("TICK stopped_at_end outro stop -> " + jamCurrentClip.name);
            jamStopPlayback();
        } else if (jamCurrentClip && jamCurrentClip.type === "fill" && jamReturnGroove) {
            logJam("TICK stopped_at_end fill return -> return-to-groove=" + jamReturnGroove.name);
            jamFireNext();
        } else {
            logJam("TICK stopped_at_end bar=" + bar + " beat=" + beat +
                " clip=" + (jamCurrentClip ? jamCurrentClip.name : "?") +
                " loop=" + (lastDspState.loop ? "1" : "0") + " running=" + (lastDspState.running ? "1" : "0"));
            jamPlayClip(jamCurrentClip);
        }
        return;
    }

    /* On the tick right after a clip starts, just record the DSP's boundary
     * counters and do not evaluate any boundaries, so the initial position
     * isn't treated as a bar advance / loop wrap. */
    if (jamSettling) {
        jamSettling = false;
        jamLastBarCounter = lastDspTransport.bar_counter || 0;
        jamLastWrapCounter = lastDspTransport.wrap_counter || 0;
        jamLastSwapCounter = lastDspTransport.swap_counter || 0;
        logJam("TICK settle bar=" + bar + " beat=" + beat +
            " bc=" + jamLastBarCounter + " wc=" + jamLastWrapCounter +
            " clip=" + (jamCurrentClip ? jamCurrentClip.name : "?"));
        return;
    }

    /* The DSP is the authoritative playback source. It increments bar_counter
     * on every new bar (including loop wraps and seeks) and wrap_counter on
     * every full loop back to bar 1. We compare these monotonic counters
     * rather than inferring boundaries from bar/beat deltas in JS, which is
     * fragile when a pad press lands exactly on a boundary and the UI's cached
     * bar lags the DSP playhead. */
    const bc = lastDspTransport.bar_counter || 0;
    const wc = lastDspTransport.wrap_counter || 0;
    const sc = lastDspTransport.swap_counter || 0;
    const barAdvanced = bc > jamLastBarCounter;
    const wrap = wc > jamLastWrapCounter;
    const swapped = sc > jamLastSwapCounter;
    const boundary = barAdvanced || wrap || swapped;

    jamLastBarCounter = bc;
    jamLastWrapCounter = wc;
    jamLastSwapCounter = sc;

    /* Repaint the pad LEDs on every bar/wrap boundary so the "last bar" red
     * indication and queued-groove imminent-switch state stay current. */
    if (boundary) {
        ledDirtyAll = true;
    }

    if (jamTickLogEnabled) {
        logJam("TICK bar=" + bar + " beat=" + beat + " bc=" + bc + " wc=" + wc +
            " sc=" + sc + " lastBC=" + (jamLastBarCounter) + " lastWC=" + (jamLastWrapCounter) +
            " wrap=" + (wrap ? "1" : "0") +
            " barAdv=" + (barAdvanced ? "1" : "0") +
            " swap=" + (swapped ? "1" : "0") +
            " bound=" + (boundary ? "1" : "0") +
            " clip=" + (jamCurrentClip ? jamCurrentClip.name : "?") +
            " qGroove=" + (jamQueuedGroove ? jamQueuedGroove.name : "-") +
            " qLen=" + jamQueue.length);
    }

    if (jamQueuedGroove && jamQueuedGrooveEscalated) {
        /* Escalated groove: fire at the end of the current bar. */
        if (boundary) {
            jamFireNext();
            return;
        }
    } else if (jamQueuedGroove) {
        /* Non-escalated groove: fire after the current groove finishes (loop wrap). */
        if (wrap) {
            jamFireNext();
            return;
        }
    }

    if (jamFillQueued && jamQueue.length > 0) {
        /* Fire the next queued fill at the end of the current bar. */
        if (boundary) {
            jamFireNext();
            return;
        }
    }
    /* Note: the return from a fill to the groove is handled by the DSP's
     * sample-accurate auto-swap at the fill's end, not by a UI wrap-detection
     * fallback here. A UI-initiated swap on wrap would double-fire and start
     * the groove slightly early, so it is intentionally omitted. The UI's
     * active_source sync block updates the display when the DSP auto-swaps. */
}

function handleJamInput(cc, value) {
    if (cc === MoveCapture) { if (value > 0) setKeys(!keysOn); return; }
    if (keysOn && (cc === MoveUp || cc === MoveDown)) { if (value > 0) shiftKeysOctave(cc === MoveUp ? 1 : -1); return; }
    if (cc === MoveMainKnob) {
        const delta = decodeDelta(value);
        if (shiftHeld) {
            /* Shift+jogwheel cycles the key used for the chord-pad grid
             * (see jamKey, diatonicChord). Only meaningful while at least
             * one Jam instrument is enabled, but harmless to adjust either
             * way -- it just won't be visible until the chord pads appear. */
            const idx = KEYS.indexOf(jamKey);
            const newIdx = ((idx < 0 ? 0 : idx) + delta) % KEYS.length;
            jamKey = KEYS[(newIdx + KEYS.length) % KEYS.length];
            /* The chord moves to the new key only once Shift is released
             * (see jamApplyKeyChangeOnShiftRelease), so turning through several
             * keys on the way doesn't queue each one. */
            jamKeyChangePending = true;
            needsRedraw = true;
            stepLedsDirty = true;
            ledDirtyAll = true;
        } else {
            /* Jog wheel adjusts the BPM in realtime (no restart). */
            const newBpm = Math.max(20, Math.min(300, jamBpm + delta));
            if (newBpm !== jamBpm) {
                jamBpm = newBpm;
                if (typeof host_module_set_param === "function") {
                    host_module_set_param("tempo", String(jamBpm));
                }
                needsRedraw = true;
            }
        }
    } else if (cc === MoveShift) {
        shiftHeld = value > 0;
    } else if (cc === MoveUp && value > 0) {
        /* Reversed: Up scrolls the groove pads down (next page). */
        const maxScroll = Math.max(0, Math.ceil(jamGrooves.length / (jamGrooveCols() * 4)) - 1);
        jamGrooveScroll = Math.min(maxScroll, jamGrooveScroll + 1);
        needsRedraw = true;
        ledDirtyAll = true;
    } else if (cc === MoveDown && value > 0) {
        /* Reversed: Down scrolls the groove pads up (previous page). */
        const maxScroll = Math.max(0, Math.ceil(jamGrooves.length / (jamGrooveCols() * 4)) - 1);
        jamGrooveScroll = Math.max(0, jamGrooveScroll - 1);
        needsRedraw = true;
        ledDirtyAll = true;
    } else if (cc === MoveLeft && value > 0) {
        /* Left scrolls the fills up (previous page). */
        const fills = jamVisibleFills();
        const maxFillScroll = Math.max(0, Math.ceil(fills.length / (jamFillCols() * 4)) - 1);
        jamFillScroll = Math.max(0, jamFillScroll - 1);
        needsRedraw = true;
        ledDirtyAll = true;
    } else if (cc === MoveRight && value > 0) {
        /* Right scrolls the fills down (next page). */
        const fills = jamVisibleFills();
        const maxFillScroll = Math.max(0, Math.ceil(fills.length / (jamFillCols() * 4)) - 1);
        jamFillScroll = Math.min(maxFillScroll, jamFillScroll + 1);
        needsRedraw = true;
        ledDirtyAll = true;
    } else if (cc === MovePlay && value > 0) {
        if (jamPlaying) {
            /* Stop playback. */
            jamPlaying = false;
            jamCurrentClip = null;
            jamReturnGroove = null;
            jamQueue = [];
            jamQueuedGroove = null;
            jamQueuedGrooveEscalated = false;
            jamFillQueued = false;
            jamFillBaseBar = 1;
            jamFillsPlayedBars = 0;
            jamCurrentType = "";
            jamHoldPad = -1;
            jamHoldClip = null;
            jamHoldTriggerTime = 0;
            jamHoldOverlayShown = false;
            /* The DSP cuts off any sounding Jam instrument note on stop
             * regardless (emit_jam_instruments_all_off), but leaves
             * jam_chord_live untouched (see arr_set_param's "stop" handler)
             * so the SAME chord resumes automatically on the next Play --
             * mirror that here by leaving jamChordLiveDegree alone too, so
             * drawJamLEDs can highlight it green (queued to resume) while
             * stopped. A not-yet-promoted pending pick is discarded either
             * way (it was queued for a bar boundary that will now never
             * arrive), matching the DSP clearing jam_chord_pending_set on
             * stop. */
            jamChordPendingDegree = -1;
            jamLastBarCounterForChord = -1;
            jamLastSwapCounterForChord = -1;
            hideHoldPopup();
            stopPlayback();
            needsRedraw = true;
            stepLedsDirty = true;
            ledDirtyAll = true;
        } else if (jamPreviewScheduled) {
            /* A jam preview is playing: stop the one-shot audition. */
            logJam("PREVIEW stop on Play");
            jamPreviewPad = -1;
            jamPreviewClip = null;
            jamPreviewScheduled = false;
            jamPreviewStartTime = 0;
            jamPreviewObservedRunning = false;
            stopPlayback();
            jamCurrentClip = null;
            jamCurrentType = "";
            needsRedraw = true;
            stepLedsDirty = true;
            ledDirtyAll = true;
        }
    } else if (shiftHeld && (cc === MoveRow2 || cc === MoveRow3 || cc === MoveRow4) && value > 0) {
        /* Shift+Track 2/3/4: open the live settings of that Jam instrument
         * (Inst 1, Inst 2, the Pads), instead of toggling it. */
        openJamInstrumentMenu(cc === MoveRow2 ? 0 : cc === MoveRow3 ? 1 : 2);
    } else if (cc === MoveRow4 && value > 0) {
        /* Track 4: the Pads -- a chord held under the groove, from the chord
         * pads -- on or off. */
        jamPadsEnabled = !jamPadsEnabled;
        showPopup("Pads", jamPadsEnabled ? "On" : "Off", 2000);
        if (jamPadsEnabled) pushJamInstrumentRouting(2);
        if (typeof host_module_set_param === "function") {
            host_module_set_param("jam_inst3_enabled", jamPadsEnabled ? "1" : "0");
        }
        needsRedraw = true;
        ledDirtyAll = true;
    } else if ((cc === MoveRow1 || cc === MoveRow2 || cc === MoveRow3) && value > 0) {
        /* Drums/Inst 1/Inst 2 on/off (Track 1/2/3, same as Song Builder's
         * track buttons). Toggling an instrument also flips the chord-pad
         * grid layout on/off -- see jamChordModeActive/drawJamLEDs/
         * handleJamPad. */
        if (cc === MoveRow1) {
            jamDrumEnabled = !jamDrumEnabled;
            showPopup("Drums", jamDrumEnabled ? "On" : "Off", 2000);
            if (typeof host_module_set_param === "function") {
                host_module_set_param("drum_enabled", jamDrumEnabled ? "1" : "0");
            }
        } else if (cc === MoveRow2) {
            jamInst1Enabled = !jamInst1Enabled;
            showPopup("Inst 1", jamInst1Enabled ? "On" : "Off", 2000);
            if (typeof host_module_set_param === "function") {
                host_module_set_param("jam_inst1_enabled", jamInst1Enabled ? "1" : "0");
            }
            if (jamInst1Enabled) pushJamInstrumentRouting(0);
        } else {
            jamInst2Enabled = !jamInst2Enabled;
            showPopup("Inst 2", jamInst2Enabled ? "On" : "Off", 2000);
            if (typeof host_module_set_param === "function") {
                host_module_set_param("jam_inst2_enabled", jamInst2Enabled ? "1" : "0");
            }
            if (jamInst2Enabled) pushJamInstrumentRouting(1);
        }
        needsRedraw = true;
        stepLedsDirty = true;
        ledDirtyAll = true;
    } else if (cc === MoveRec && value > 0) {
        /* Record the Schwung mix, as in Perform. */
        perfToggleRecording("Jam " + jamFolderLabel);
        ledDirtyAll = true;
    } else if (cc === MoveBack && value > 0) {
        /* Stop (and any recording) and return to the folder picker. */
        perfStopRecording();
        jamPlaying = false;
        jamCurrentClip = null;
        jamReturnGroove = null;
        jamQueue = [];
        jamQueuedGroove = null;
        jamQueuedGrooveEscalated = false;
        jamFillQueued = false;
        jamFillBaseBar = 1;
        jamFillsPlayedBars = 0;
        jamStagedClip = null;
        jamCurrentType = "";
        jamHoldPad = -1;
        jamHoldClip = null;
        jamHoldTriggerTime = 0;
        jamHoldOverlayShown = false;
        hideHoldPopup();
        stopPlayback();
        menuStack.pop();
        currentView = VIEW_JAM_FOLDER;
        /* Preserve the category path and cursor so Back returns to the folder
         * the user was in, not the base folder. The path/selection were set
         * when the folder was entered (jamFolderPickerPath = category path,
         * jamFolderPickerSelectedIndex = the selected folder item). */
        needsRedraw = true;
        stepLedsDirty = true;
        ledDirtyAll = true;
    }
}

/* Handle a pad press in Jam mode. Left 4 columns = grooves (scrollable),
 * right 4 columns = fills (filtered by current groove type). */
/* A chord pad press (row/col within the 2-column chord block). Behavior
 * depends on transport state:
 *  - Playing: queues that chord for the enabled Jam instrument(s), taking
 *    effect at the next bar boundary -- see jam_chord's DSP-side handling
 *    (arr_set_param) and apply_pending_jam_chord.
 *  - Stopped: there's no "next bar" to defer to, so the pad directly
 *    becomes what will play the instant Play is pressed (green -- see
 *    drawJamLEDs/jamQueuedChordDegree and the "play" handler's own
 *    apply_pending_jam_chord call). Pressing the pad that is ALREADY
 *    queued instead un-queues it (chord cleared, nothing plays on the next
 *    Play until a chord is chosen again).
 * Release events are ignored; this is a simple select action, not a
 * hold-to-preview like the groove/fill pads. */
function handleJamChordPad(row, col, velocity) {
    const degree = jamChordDegreeForPad(row, col);
    if (velocity > 0) {
        jamChordHoldDegree = degree;
        jamChordHoldTime = Date.now();
        jamChordHoldShown = false;
        return;
    }
    if (degree !== jamChordHoldDegree) return;
    const wasShown = jamChordHoldShown;
    jamChordHoldDegree = -1;
    jamChordHoldShown = false;
    if (wasShown) {
        /* Held: the name was shown, so don't select the chord. */
        jamHoldOverlayShown = false;
        hideHoldPopup();
        return;
    }
    jamSelectChordDegree(degree);
}

/* After a key change, queue the current chord's degree again in the new key
 * so the change is heard: at the next bar while playing (like a pad press),
 * or when Play is pressed while stopped. Nothing to do if no chord is set. */
function jamRequeueChordInKey() {
    const degree = jamChordPendingDegree >= 0 ? jamChordPendingDegree : jamChordLiveDegree;
    if (degree < 0) return;
    const chord = jamChordForDegree(degree);
    jamChordPendingDegree = degree;
    jamChordPendingKey = jamKey;
    if (!jamPlaying) jamChordLiveDegree = -1;
    if (typeof host_module_set_param === "function") {
        host_module_set_param("jam_chord", jamChordParam(chord, degree, jamKey));
    }
    logJam("KEY-CHANGE key=" + jamKey + " requeue degree=" + degree + " root=" + chord.root + " quality=" + chord.quality);
}

/* Called on every Shift release (from onMidiMessageInternal, which consumes
 * Shift before any per-view handler sees it): move the current chord to a key
 * chosen with Shift+jogwheel. Only re-queues if the key actually ended up
 * different from the one the current chord is in. */
function jamApplyKeyChangeOnShiftRelease() {
    if (!jamKeyChangePending) return;
    jamKeyChangePending = false;
    const chordKey = jamChordPendingDegree >= 0 ? jamChordPendingKey : jamChordLiveKey;
    if (jamKey !== chordKey) jamRequeueChordInKey();
    needsRedraw = true;
    ledDirtyAll = true;
}

/* Select a chord pad's chord (a quick tap on it -- see handleJamChordPad). */
function jamSelectChordDegree(degree) {

    if (!jamPlaying) {
        const queuedDegree = jamQueuedChordDegree();
        if (degree === queuedDegree) {
            jamChordPendingDegree = -1;
            jamChordLiveDegree = -1;
            if (typeof host_module_set_param === "function") {
                host_module_set_param("jam_chord", "off");
            }
            logJam("CHORD-PAD degree=" + degree + " un-queued (stopped)");
        } else {
            const chord = jamChordForDegree(degree);
            jamChordPendingDegree = degree;
            jamChordPendingKey = jamKey;
            jamChordLiveDegree = -1;
            if (typeof host_module_set_param === "function") {
                host_module_set_param("jam_chord", jamChordParam(chord, degree, jamKey));
            }
            logJam("CHORD-PAD degree=" + degree + " root=" + chord.root + " quality=" + chord.quality +
                " shift=" + chord.shift + " queued (stopped)");
        }
        needsRedraw = true;
        stepLedsDirty = true;
        ledDirtyAll = true;
        return;
    }

    const chord = jamChordForDegree(degree);
    jamChordPendingDegree = degree;
    jamChordPendingKey = jamKey;
    if (typeof host_module_set_param === "function") {
        host_module_set_param("jam_chord", jamChordParam(chord, degree, jamKey));
    }
    logJam("CHORD-PAD degree=" + degree + " root=" + chord.root + " quality=" + chord.quality + " shift=" + chord.shift);
    needsRedraw = true;
    stepLedsDirty = true;
    /* drawJamLEDs (which actually colours the chord pads red/white/dim) is
     * only called from the ledDirtyAll branch of the LED update, not every
     * tick -- stepLedsDirty alone (which only governs the separate bar/beat
     * step-LED strip) would leave the pad grid showing stale colours until
     * something else happened to set ledDirtyAll. */
    ledDirtyAll = true;
}

function handleJamPad(padIndex, velocity) {
    const col = padIndex % 8;
    const row = Math.floor(padIndex / 8);
    if (col < 2 && (jamChordModeActive() || (velocity === 0 && jamChordHoldDegree >= 0))) {
        handleJamChordPad(row, col, velocity);
        return;
    }
    const grooveCols = jamGrooveCols();
    const grooveColOffset = jamGrooveColOffset();
    const fillColOffset = jamFillColOffset();
    let clip = null;
    /* Whether this pad is a groove or a fill, decided from the current
     * layout. Grooves shift to columns 2-4 while the chord pads are showing,
     * so the release handlers below must not assume "column < 4 is a
     * groove" -- found live: a groove in column 4 was queued as a fill (it
     * played at the next bar instead of the groove's end, and never lit as
     * a queued groove). */
    let isGroovePad = false;
    if (col >= grooveColOffset && col < grooveColOffset + grooveCols) {
        /* Groove pad. */
        isGroovePad = true;
        const idx = (row + jamGrooveScroll * 4) * grooveCols + (col - grooveColOffset);
        clip = jamGrooves[idx];
    } else if (col >= fillColOffset) {
        /* Fill pad. */
        const fillCols = jamFillCols();
        const fills = jamVisibleFills();
        const fillIdx = (row + jamFillScroll * 4) * fillCols + (col - fillColOffset);
        clip = fills[fillIdx];
    }
    if (!clip) return;

    const isPress = velocity > 0;
    /* Diagnostic: log EVERY pad press/release unconditionally (not just the
     * hold-preview-specific PREVIEW start/release lines), so a repro can be
     * matched against actual physical input rather than inferred from
     * jamCurrentClip transitions alone -- a quick tap takes a different code
     * path than a hold and doesn't log via the "PREVIEW" lines. */
    logJam("PAD-EVENT " + (isPress ? "press" : "release") + " padIndex=" + padIndex +
        " clip=" + (clip.name || clip.path) + " jamPlaying=" + jamPlaying +
        " jamPreviewScheduled=" + jamPreviewScheduled + " jamCurrentClip=" + (jamCurrentClip ? jamCurrentClip.name : "null"));
    if (isPress) {
        if (!jamPlaying) {
            /* Playback stopped: arm a pad-held preview. If a preview is
             * already playing, stop it first so only one clip auditions. */
            if (jamPreviewScheduled) {
                logJam("PREVIEW press new clip stops current preview");
                stopPlayback();
                jamCurrentClip = null;
                jamCurrentType = "";
            }
            jamPreviewPad = padIndex;
            jamPreviewClip = clip;
            jamPreviewTriggerTime = Date.now();
            jamPreviewScheduled = false;
            jamPreviewStartTime = 0;
            jamPreviewObservedRunning = false;
            return;
        }
        /* Playback running: arm a hold-overlay. A quick press (released
         * before the hold delay) queues the clip normally; holding past the
         * delay shows the clip name in the overlay without queueing it. */
        jamHoldPad = padIndex;
        jamHoldClip = clip;
        jamHoldTriggerTime = Date.now();
        jamHoldOverlayShown = false;
        return;
    }

    /* Pad released. */
    if (jamPreviewClip) {
        const heldMs = jamPreviewStartTime ? Date.now() - jamPreviewStartTime : 0;
        hideHoldPopup();
        if (jamPreviewScheduled) {
            /* Preview was playing: stop it (one-shot released). */
            logJam("PREVIEW release clip=" + (jamPreviewClip.name || "?") + " heldMs=" + heldMs);
            jamStopPlayback();
        } else {
            /* Quick press (released before the delay): start loop playback. */
            if (isGroovePad) jamQueueGroove(clip);
            else jamQueueFill(clip);
        }
        jamPreviewPad = -1;
        jamPreviewClip = null;
        jamPreviewScheduled = false;
        jamPreviewStartTime = 0;
        jamPreviewObservedRunning = false;
    }
    if (jamHoldPad === padIndex) {
        /* A held pad during playback: hide the hold-overlay. If it was a quick
         * press (released before the hold delay), queue the clip normally. */
        hideHoldPopup();
        if (!jamHoldOverlayShown) {
            if (isGroovePad) jamQueueGroove(clip);
            else jamQueueFill(clip);
        }
        jamHoldPad = -1;
        jamHoldClip = null;
        jamHoldTriggerTime = 0;
        jamHoldOverlayShown = false;
    }
}

function handlePadPress(note, velocity) {
    /* Keys: the engine plays the pads; only their lights are ours. */
    if (keysOn && keysViewActive() && getPadIndex(note) >= 0) { keysPadPress(getPadIndex(note), velocity); return; }
    /* Step buttons (notes 16-31) drive the chord/instrument track bar grid. */
    if (note >= MoveStep1 && note <= MoveStep16) {
        handleStepPress(note - MoveStep1, velocity);
        return;
    }
    if (currentView === VIEW_BUILDER) {
        /* Clips on the Drum track; roots, chords and items on the Chord,
         * Inst and Pads tracks (see handleHarmonyPad). */
        if (builderTrack === TRACK_DRUM) handleBuilderPad(note, velocity);
        else if (harmonyTrack(builderTrack)) handleHarmonyPad(note, velocity);
        return;
    }
    const padIndex = getPadIndex(note);
    if (padIndex < 0) return;

    if (currentView === VIEW_JAM) {
        handleJamPad(padIndex, velocity);
        return;
    }
    if (velocity === 0) return;
    if (currentView === VIEW_SONG_BANK) {
        return;
    } else if (currentView === VIEW_PERFORMANCE) {
        /* Pads map to the setlist layout: sections of each song, plus a
         * click pad per song that has a click configured. The visible window
         * is scrolled by perfScrollRow. */
        const item = perfItemForPad(padIndex);
        if (!item) return;
        if (!perfPlaying) {
            /* When stopped, the selected pad becomes the active cursor.
             * If it belongs to a different song, load that song so the
             * display and step LEDs use the correct full-song metadata. */
            if (item.kind === "click" || item.songIndex !== perfSongIndex) {
                if (perfLoadSong(item.songIndex)) {
                    /* Click pad selects the first real section; section pads
                     * below will update this if the user pressed a section. */
                    perfSelectedSection = (item.kind === "section") ? item.sectionIndex : -1;
                    perfSelectedSong = -1;
                    perfClickBars = (currentSetlist.songs[item.songIndex]?.click_bars || 0);
                }
            } else {
                if (perfSelectedSection !== item.sectionIndex || perfSelectedSong !== -1) {
                    perfSelectedSection = item.sectionIndex;
                    perfSelectedSong = -1;
                }
            }
            logDebug("PERFSEL stopped kind=" + item.kind + " song=" + item.songIndex +
                " section=" + item.sectionIndex + " perfSong=" + perfSongIndex +
                " perfSelectedSection=" + perfSelectedSection + " perfSelectedSong=" + perfSelectedSong +
                " clickBars=" + perfClickBars);
            needsRedraw = true;
            stepLedsDirty = true;
            ledDirtyAll = true;
            return;
        }
        if (item.kind === "click") {
            /* Click pad: jump to that song (its click plays first). */
            perfQueueSong(item.songIndex);
        } else if (item.songIndex === perfSongIndex) {
            /* Section of the current song: queue a jump so playback reaches
             * the target section at the next bar boundary instead of cutting
             * immediately. */
            perfQueueSection(item.sectionIndex);
        } else {
            perfQueueSong(item.songIndex);
        }
    }
}

function insertClipAtCursor(clip) {
    if (!currentSong || !clip) return;
    if (currentSong.sections.length === 0) {
        currentSong.sections.push(newSection("Section 1"));
        currentSectionIndex = 0;
    }
    const sec = currentSong.sections[currentSectionIndex];
    const bars = clip.bars || 1;
    /* Record the folder the clip was added from (the palette's current folder).
     * Always store it so the clip remembers its origin even if the song's
     * source_folder is later changed back to a different folder. toEngineSongJson
     * only emits it when it differs from the song's primary folder, keeping the
     * saved file clean. */
    /* The folder the pads were loaded from -- NOT the folder picker's
     * cursor, which is left wherever it was last browsed (opening a song from
     * the Song Bank loads its folder onto the pads without moving it, and
     * Back from Record's folder list leaves it where it was browsed to): a
     * clip added from the song's own folder was recorded as another kit's
     * clip of the same name (found live: My Lighthouse's Bridge played
     * Rumba's "10 Fill 3"). Full path, as the song's own source_folder. */
    const paletteIdx = folderClipsIndex >= 0 ? folderClipsIndex : currentBuilderFolderIndex();
    const paletteFolder = folderFullPath(paletteIdx) || "";
    const newClip = {
        source: clip.path,
        name: clip.name,
        type: clip.type || inferPartTypeFromFilename(clip.name || clip.path || ""),
        source_folder: paletteFolder || "",
        start_bar: clipStartBar(clip),
        start_beat: 1,
        end_bar: bars,
        end_beat: (currentSong && currentSong.time_sig_num > 0) ? currentSong.time_sig_num : 4,
        advanced: false,
        guard_fraction: 0,
        speed: 1.0,
        velocity_scale: 1.0,
        snare_note: 38,
        snare_velocity_scale: 1.0,
        kick_note: 36,
        kick_target: 0
    };
    /* Insert AFTER the current clip (or at the start when the cursor is on
     * the section header / empty section), then move the cursor onto the
     * newly inserted clip. */
    /* On a placeholder, the clip takes its place. */
    const onPlaceholder = sec.clips[builderCursor] && sec.clips[builderCursor].placeholder;
    if (onPlaceholder) {
        sec.clips[builderCursor] = newClip;
        unsavedChanges = true;
        stepLedsDirty = true;
        needsRedraw = true;
        return;
    }
    const insertIdx = Math.max(0, Math.min(sec.clips.length, builderCursor + 1));
    sec.clips.splice(insertIdx, 0, newClip);
    builderCursor = Math.min(insertIdx, sec.clips.length);
    unsavedChanges = true;
    stepLedsDirty = true;
    needsRedraw = true;
}

/* The section index the builder is currently showing. During playback this is
 * the auto-followed section (or the one the user jumped to via
 * builderDisplaySection), not the stale currentSectionIndex. While
 * builderPlayingFromTemp is set, currentSong is a song sliced to start at
 * currentSectionIndex, so the section being played is always its own
 * section 0 -- see builderPlayingFromTemp's declaration. */
/* What Song Builder's screens and step LEDs DRAW: while a play-from build
 * is pending (builderPlayingFromTemp), currentSong is a copy sliced to
 * start at the played section -- and, playing from a clip, that section
 * keeps only the clips from it on -- so drawing it showed the section
 * without its earlier clips until playback confirmed. Draw the real song
 * and section instead; edits keep using currentSong. */
function viewSong() {
    return builderPlayingFromTemp ? (tempSongOrigin.get(currentSong) || currentSong) : currentSong;
}
function viewSectionIndex() {
    if (builderPlayingFromTemp) return tempSongOrigin.get(currentSong) ? currentSectionIndex : 0;
    return builderDisplaySectionIndex();
}

function builderDisplaySectionIndex() {
    if (builderPlayingFromTemp) return 0;
    return playbackState === "playing"
        ? (builderDisplaySection >= 0 ? builderDisplaySection : playbackSectionIndex)
        : currentSectionIndex;
}

function deleteClipAtCursor() {
    const sec = currentSong ? currentSong.sections[builderDisplaySectionIndex()] : null;
    if (!sec || builderCursor < 0 || builderCursor >= sec.clips.length) return;
    const clip = sec.clips[builderCursor];
    /* With chords or items in the section, a clip leaves a placeholder of
     * its length, so what follows stays on its drums; Delete on the
     * placeholder removes it. */
    if (!clip.placeholder && sectionHasTrackContent(sec)) {
        sec.clips[builderCursor] = placeholderFor(clip);
        unsavedChanges = true;
        stepLedsDirty = true;
        needsRedraw = true;
        return;
    }
    sec.clips.splice(builderCursor, 1);
    /* Select the clip before the deleted one (or the first clip when deleting
     * the first clip). */
    builderCursor = Math.max(0, Math.min(builderCursor - 1, sec.clips.length - 1));
    unsavedChanges = true;
    stepLedsDirty = true;
    needsRedraw = true;
}

function moveCursor(delta) {
    /* During playback, the displayed section is the auto-followed one (or the
     * section the user jumped to via builderDisplaySection), NOT the stale
     * currentSectionIndex. Match drawBuilder so the scroll wheel moves through
     * the clips of the section actually shown. */
    const secIndex = builderDisplaySectionIndex();
    const sec = currentSong ? currentSong.sections[secIndex] : null;
    if (!sec) return;
    const old = builderCursor;
    const len = sec.clips.length;
    /* Cursor positions:
     *  -1 = section header (rename)
     *   0..len-1 = clip slots
     *   When the section is empty, 0 is the "(add clip)" row. */
    const maxCursor = len > 0 ? len - 1 : 0;
    builderCursor = Math.max(-1, Math.min(maxCursor, builderCursor + delta));
    if (builderCursor !== old) {
        /* As the jog wheel moves the cursor between clips, nudge the step
         * window so the selected clip's first bar stays in view. */
        if (len > 0 && builderCursor >= 0) {
            let cursorBar = 0;
            for (let i = 0; i < builderCursor; i++) {
                const s = (typeof sec.clips[i].speed === "number" && sec.clips[i].speed > 0) ? sec.clips[i].speed : 1.0;
                cursorBar += Math.max(1, Math.round((sec.clips[i].end_bar - sec.clips[i].start_bar) / s));
            }
            const totalBars = sectionBars(sec);
            if (totalBars > NUM_STEPS) {
                const autoMax = totalBars - NUM_STEPS;
                if (stepScrollOffset > cursorBar) stepScrollOffset = cursorBar;
                else if (cursorBar > stepScrollOffset + (NUM_STEPS - 1)) {
                    /* Wrap so the selected clip's first bar lands at step 1. */
                    stepScrollOffset = cursorBar;
                }
                if (stepScrollOffset > autoMax) stepScrollOffset = autoMax;
                if (stepScrollOffset < 0) stepScrollOffset = 0;
                stepLedsDirty = true;
            }
        }
    }
    needsRedraw = true;
}

function duplicateClipAtCursor() {
    const sec = currentSong ? currentSong.sections[builderDisplaySectionIndex()] : null;
    const clip = sec ? sec.clips[builderCursor] : null;
    if (!clip) return;
    sec.clips.splice(builderCursor + 1, 0, JSON.parse(JSON.stringify(clip)));
    builderCursor++;
    unsavedChanges = true;
    stepLedsDirty = true;
    needsRedraw = true;
}

/* ── Merge / split sections (Mute, Shift+Mute) ───────────────────────── */

/* A section's length in beats (halves kept), from its clips' bars. */
function sectionBeats(sec) {
    return Math.round(sectionBars(sec) * beatsPerBar() * 2) / 2;
}

/* A position as beats from its section's start, and back. A position off a
 * whole beat is marked Advanced so the settings pages can show it. */
function posToBeats(it) {
    return it.bar * beatsPerBar() + (chordBeat(it) - 1);
}
function placeAtBeats(obj, pos) {
    const bpb = beatsPerBar();
    const bar = Math.floor(pos / bpb), beat = pos - bar * bpb + 1;
    const o = Object.assign({}, obj, { bar });
    delete o.beat;
    if (beat !== 1) o.beat = beat;
    if (!Number.isInteger(beat)) o.adv = true;
    return o;
}

/* A section's chords as [{pos, chord}] and back. */
function sectionChordList(sec) {
    return sectionChordEvents(sec).map(e => ({ pos: e.bar * beatsPerBar() + (e.beat - 1), chord: e.chord }));
}
function writeSectionChords(sec, list) {
    sec.chords = [];
    const byBar = new Map();
    for (const { pos, chord } of list) {
        const c = placeAtBeats(chord, pos);
        const bar = c.bar;
        delete c.bar;
        if (!byBar.has(bar)) byBar.set(bar, []);
        byBar.get(bar).push(c);
    }
    for (const [bar, chords] of byBar) setBarChords(sec, bar, chords);
}

/* The item lists a section carries: Inst 1, Inst 2, Click (see sectionItems). */
const SECTION_ITEM_TRACKS = [TRACK_INSTRUMENT_1, TRACK_INSTRUMENT_2, TRACK_PADS, TRACK_CLICK];

/* Mute: merge the current section with the next one. The next section's
 * clips, chords and items follow on, shifted by this section's length. A
 * section starts fresh (no chord carried in, Inst defaults, the default
 * click volume), so where this one had something that would now carry on,
 * the join gets a No Chord / back-to-defaults item / default volume -- the
 * merged section sounds as the two did. */
export function mergeSectionWithNext(song, i) {
    if (!song || i < 0 || i + 1 >= song.sections.length) return false;
    const a = song.sections[i], b = song.sections[i + 1];
    const off = sectionBeats(a);
    const ca = sectionChordList(a), cb = sectionChordList(b);
    const merged = ca.concat(cb.map(x => ({ pos: x.pos + off, chord: x.chord })));
    if (ca.length && !cb.some(x => x.pos === 0)) merged.push({ pos: off, chord: { none: true } });
    merged.sort((x, y) => x.pos - y.pos);
    for (const t of SECTION_ITEM_TRACKS) {
        const la = sectionItems(a, t), lb = sectionItems(b, t);
        const moved = lb.map(it => placeAtBeats(it, posToBeats(it) + off));
        if (la.length && !lb.some(it => posToBeats(it) === 0)) {
            moved.push(placeAtBeats(t === TRACK_CLICK ? { volume: clickVolume } : {}, off));
        }
        la.push(...moved);
        sortItems(la);
    }
    a.clips = (a.clips || []).concat(b.clips || []);
    writeSectionChords(a, merged);
    song.sections.splice(i + 1, 1);
    return true;
}

/* Shift+Mute: split the current section before clip `clipIdx` (not the
 * first). The clips from there, and the chords and items from that point,
 * become a new section after it, named like a duplicate. Whatever was in
 * effect at the split -- the chord sounding, the Inst settings, the click
 * volume -- is restated at the new section's start so it carries on. */
export function splitSectionAt(song, i, clipIdx) {
    if (!song || i < 0 || i >= song.sections.length) return false;
    const a = song.sections[i];
    if (!a.clips || clipIdx < 1 || clipIdx >= a.clips.length) return false;
    const bpb = beatsPerBar();
    let bars = 0;
    for (let c = 0; c < clipIdx; c++) bars += clipEffBars(a.clips[c]);
    const off = Math.round(bars * bpb * 2) / 2;
    const b = { id: "sec-" + Date.now(), name: incrementSectionName(a.name || "Section"), clips: a.clips.slice(clipIdx) };
    a.clips = a.clips.slice(0, clipIdx);
    const all = sectionChordList(Object.assign({}, a, { clips: a.clips.concat(b.clips) }));
    const before = all.filter(x => x.pos < off), after = all.filter(x => x.pos >= off).map(x => ({ pos: x.pos - off, chord: x.chord }));
    const lastBefore = before[before.length - 1];
    if (lastBefore && !lastBefore.chord.none && !after.some(x => x.pos === 0)) after.unshift({ pos: 0, chord: lastBefore.chord });
    writeSectionChords(a, before);
    writeSectionChords(b, after);
    for (const t of SECTION_ITEM_TRACKS) {
        const la = sortItems(sectionItems(a, t));
        const keep = la.filter(it => posToBeats(it) < off);
        const move = la.filter(it => posToBeats(it) >= off).map(it => placeAtBeats(it, posToBeats(it) - off));
        const last = keep[keep.length - 1];
        if (last && !move.some(it => posToBeats(it) === 0)) {
            const carry = Object.assign({}, last);
            delete carry.adv;
            move.unshift(placeAtBeats(carry, 0));
        }
        la.length = 0;
        la.push(...keep);
        const lb = sectionItems(b, t);
        lb.push(...move);
        sortItems(lb);
    }
    song.sections.splice(i + 1, 0, b);
    return true;
}

/* Merge/split from Song Builder: the current section, while stopped (the
 * playing timeline still has the old sections). */
function builderMergeOrSplit(split) {
    if (!currentSong) return;
    if (songIsLocked()) { lockedNotice(); return; }
    if (playbackState === "playing") {
        showPopup(split ? "Split" : "Merge", "Stop playback first", 2000);
        return;
    }
    const i = currentSectionIndex;
    const sec = currentSong.sections[i];
    if (!sec) return;
    if (split) {
        if (builderTrack !== TRACK_DRUM || builderCursor < 1 || builderCursor >= sec.clips.length) return;
        const name = sec.name || "Section";
        if (!splitSectionAt(currentSong, i, builderCursor)) return;
        builderCursor = Math.max(0, sec.clips.length - 1);
        showPopup("Split", name + " | " + currentSong.sections[i + 1].name, 2000);
    } else {
        const next = currentSong.sections[i + 1];
        if (!next) return;
        const names = (sec.name || "Section") + " + " + (next.name || "Section");
        if (!mergeSectionWithNext(currentSong, i)) return;
        showPopup("Merged", names, 2000);
    }
    unsavedChanges = true;
    chordListCursor = 0;
    itemListCursor = 0;
    stepLedsDirty = true;
    ledDirtyAll = true;
    needsRedraw = true;
}

function duplicateCurrentSection() {
    if (!currentSong || currentSong.sections.length === 0) return;
    const original = currentSong.sections[currentSectionIndex];
    const copy = JSON.parse(JSON.stringify(original));
    copy.id = "sec-" + Date.now();
    copy.name = incrementSectionName(original.name || "Section");
    currentSong.sections.splice(currentSectionIndex + 1, 0, copy);
    currentSectionIndex++;
    builderCursor = 0;
    unsavedChanges = true;
    stepLedsDirty = true;
    needsRedraw = true;
}

/* A section name without a trailing number: "Chorus 2" -> "Chorus". */
function sectionBaseName(name) {
    return String(name || "Section").replace(/\s*\d+$/, "").trim().toLowerCase();
}

/* The other sections named like section `idx` ("Chorus", "Chorus 2", ...). */
export function sameNamedSections(song, idx) {
    if (!song || !song.sections[idx]) return [];
    const base = sectionBaseName(song.sections[idx].name);
    const out = [];
    song.sections.forEach((s, i) => { if (i !== idx && sectionBaseName(s.name) === base) out.push(i); });
    return out;
}

/* Copy one track's content -- chords, Inst 1/2 items or click items -- from
 * section `from` over sections `to`, keeping what fits each (a shorter
 * section drops what falls past its end). */
export function copyTrackToSections(song, track, from, to) {
    const src = song.sections[from];
    for (const i of to) {
        const dst = song.sections[i];
        const bars = sectionChordBars(dst);
        if (track === TRACK_CHORD) {
            dst.chords = JSON.parse(JSON.stringify((src.chords || []).slice(0, bars)));
        } else {
            const items = JSON.parse(JSON.stringify(sectionItems(src, track))).filter(it => it.bar < bars);
            const list = sectionItems(dst, track);
            list.length = 0;
            for (const it of items) list.push(it);
        }
    }
}

/* Loop on the Chord, Inst or Click track: copy this section's chords/items
 * to other sections, picked from a list. The sections named like this one
 * (Chorus, Chorus 2, ...) start ticked -- the usual target -- and any other
 * can be ticked too; the top row copies to the ticked ones. */
let copyPickFrom = -1;
let copyPickTrack = -1;
let copyPickTicked = new Set();   /* section indices */
let copyPickCursor = 0;

function copyPickTrackName(track) {
    return track === TRACK_CHORD ? "Chords" : itemTrackName(track);
}

/* Rows: the action, then every other section. */
function copyPickRows() {
    const rows = [{ type: "copy" }];
    (currentSong ? currentSong.sections : []).forEach((sec, i) => {
        if (i !== copyPickFrom) rows.push({ type: "section", i, name: sec.name || ("Section " + (i + 1)) });
    });
    return rows;
}

function copyTrackToSameNamedSections() {
    if (!currentSong) return;
    const from = chordDisplaySectionIndex();
    const sec = currentSong.sections[from];
    if (!sec) return;
    if (currentSong.sections.length < 2) {
        showPopup(copyPickTrackName(builderTrack), "No other section to copy to", 2000);
        needsRedraw = true;
        return;
    }
    copyPickFrom = from;
    copyPickTrack = builderTrack;
    copyPickTicked = new Set(sameNamedSections(currentSong, from));
    copyPickCursor = 0;
    currentView = VIEW_COPY_TRACK_PICK;
    menuStack.push({ title: "Copy To", selectedIndex: 0 });
    needsRedraw = true;
}

function drawCopyTrackPick() {
    const from = currentSong ? currentSong.sections[copyPickFrom] : null;
    drawMenuHeader(scrollHeader("Copy " + copyPickTrackName(copyPickTrack) + ": " + (from ? from.name || "Section" : ""), 28), "");
    const n = copyPickTicked.size;
    drawMenuList({
        ...LIST_ROW_FIT,
        labelX: 3,
        items: copyPickRows(),
        selectedIndex: copyPickCursor,
        getLabel: (row) => row.type === "copy" ? (n ? "Copy to " + n + " section" + (n === 1 ? "" : "s") : "Tick sections below") : row.name,
        getValue: (row) => row.type === "section" ? (copyPickTicked.has(row.i) ? "Yes" : "-") : "",
        valueAlignRight: true,
        labelGap: LIST_LABEL_GAP,
        listArea: { topY: LIST_TOP_Y, bottomY: LIST_INDICATOR_BOTTOM_Y }
    });
}

function closeCopyTrackPick() {
    menuStack.pop();
    currentView = VIEW_BUILDER;
    stepLedsDirty = true;
    needsRedraw = true;
}

function handleCopyTrackPickInput(cc, value) {
    const rows = copyPickRows();
    if (cc === MoveMainKnob) {
        copyPickCursor = Math.max(0, Math.min(rows.length - 1, copyPickCursor + decodeDelta(value)));
        needsRedraw = true;
    } else if (cc === MoveMainButton && value > 0) {
        const row = rows[copyPickCursor];
        if (!row) return;
        if (row.type === "section") {
            if (copyPickTicked.has(row.i)) copyPickTicked.delete(row.i); else copyPickTicked.add(row.i);
            needsRedraw = true;
            return;
        }
        if (copyPickTicked.size === 0) return;
        const to = [...copyPickTicked].sort((a, b) => a - b);
        copyTrackToSections(currentSong, copyPickTrack, copyPickFrom, to);
        unsavedChanges = true;
        closeCopyTrackPick();
        showPopup(copyPickTrackName(copyPickTrack), "Copied to " + to.length + " section" + (to.length === 1 ? "" : "s"), 2000);
    } else if (cc === MoveBack && value > 0) {
        closeCopyTrackPick();
    }
}

/* Increment a trailing number in a section name for duplication. "Verse 1" ->
 * "Verse 2". If the name ends in a number without a trailing space, insert a
 * space ("Verse1" -> "Verse 2"). If there's no trailing number, append " 2".
 */
function incrementSectionName(name) {
    const base = name || "Section";
    const m = base.match(/^(.*?)(\s*)(\d+)$/);
    if (m) {
        const prefix = m[1];
        const num = parseInt(m[3], 10) + 1;
        return prefix.trimEnd() + " " + num;
    }
    return base + " 2";
}

function moveClipAtCursor(delta) {
    const sec = currentSong ? currentSong.sections[builderDisplaySectionIndex()] : null;
    if (!sec || builderCursor < 0 || builderCursor >= sec.clips.length) return;
    const newIdx = builderCursor + delta;
    if (newIdx < 0 || newIdx >= sec.clips.length) return;
    const clips = sec.clips;
    const tmp = clips[builderCursor];
    clips[builderCursor] = clips[newIdx];
    clips[newIdx] = tmp;
    builderCursor = newIdx;
    unsavedChanges = true;
    stepLedsDirty = true;
    needsRedraw = true;
}

function moveSectionInSong(delta) {
    if (!currentSong || currentSong.sections.length < 2) return;
    const newIdx = currentSectionIndex + delta;
    if (newIdx < 0 || newIdx >= currentSong.sections.length) return;
    const secs = currentSong.sections;
    const tmp = secs[currentSectionIndex];
    secs[currentSectionIndex] = secs[newIdx];
    secs[newIdx] = tmp;
    currentSectionIndex = newIdx;
    unsavedChanges = true;
    stepLedsDirty = true;
    needsRedraw = true;
}

function clipForBuilderPad(padIndex) {
    const slot = builderSlotForPad(padIndex);
    if (slot.bank === "groove") {
        return grooveClips[builderPage * GROOVE_PADS_PER_BANK + slot.slot] || null;
    }
    return fillClips[builderPage * FILL_PADS_PER_BANK + slot.slot] || null;
}

function builderPageCount() {
    const groovePages = Math.max(1, Math.ceil(grooveClips.length / GROOVE_PADS_PER_BANK));
    const fillPages = Math.max(1, Math.ceil(fillClips.length / FILL_PADS_PER_BANK));
    return Math.max(groovePages, fillPages);
}

function handleBuilderPad(note, velocity) {
    /* Only a pad with a clip on it adds anything -- knob and jog TOUCHES
     * (notes 0-9) arrive here too, and must not say the song is locked. */
    const padIndex = getPadIndex(note);
    if (padIndex < 0) return;
    const clip = clipForBuilderPad(padIndex);
    if (!clip) return;
    /* Cannot add/insert clips in a locked song. */
    if (songIsLocked()) { if (velocity > 0) lockedNotice(); return; }
    if (velocity > 0) {
        padPreviewClip = clip;
        padPreviewBars = clipPlayBars(clip);
        padPreviewTriggerTime = Date.now();
        padPreviewScheduled = false;
        previewStartTime = 0;
        /* Remember the cursor so releasing the preview restores the same
         * highlighted clip (stopPlayback resets builderCursor to 0). */
        previewCursorBefore = builderCursor;
        logDebug("handleBuilderPad press clip=" + clip.name + " bars=" + padPreviewBars + " pad=" + padIndex);
        /* Light only the pressed pad; do not trigger a full redraw. */
        const dimColour = clipColor(clip, true);
        padColor(padIndex, dimColour, true);
        stepLedsDirty = true;
    } else {
        hideHoldPopup();
        /* Restore this pad to its normal grid colour. */
        padColor(padIndex, builderPadColorForIndex(padIndex), true);
        const heldMs = previewStartTime ? Date.now() - previewStartTime : 0;
        logDebug("handleBuilderPad release heldMs=" + heldMs + " clip=" + (clip ? clip.name : "?"));
        if (previewingClip) {
            stopPreview();
            previewingClip = null;
            /* Suppress the all-steps clear flash for a tick after the preview
             * ends so the section steps don't blink black before repainting. */
            padPreviewStopping = true;
            /* stopPlayback reset builderCursor to 0; restore the clip that was
             * highlighted before the preview so it doesn't jump to the first
             * clip on release. */
            builderCursor = previewCursorBefore;
        }
        if (padPreviewClip && !padPreviewScheduled) {
            /* Released before preview delay elapsed -> short tap insert only. */
            insertClipAtCursor(padPreviewClip);
        }
        if (padPreviewClip) {
            padPreviewClip = null;
            padPreviewBars = 0;
            hideHoldPopup();
            stepLedsDirty = true;
        }
        padPreviewScheduled = false;
        previewStartTime = 0;
    }
}

/* ── Harmony pads: the Chord, Inst and Pads tracks ──────────────────── */

/* The left half (columns 0-3) holds roots, the key's own first -- from the
 * bottom row: I ii iii IV / V vi vii° N.C. / bII bIII #IV bVI / bVII (as
 * semitones above the key, -1 = unused). The right half (columns 4-7)
 * holds chord types on the Chord track and item variations on the Inst
 * and Pads tracks. A pad plays a bar of what it holds and selects it; a
 * step then adds it to that bar (harmonyStepPress). On the Inst and Pads
 * tracks the root is only the chord the preview plays over: the item
 * plays the song's chords. */
const HARMONY_ROOTS = [0, 2, 4, 5, 7, 9, 11, CHORD_ROOT_NONE, 1, 3, 6, 8, 10, -1, -1, -1];
const HARMONY_TYPES = ["maj", "min", "7", "maj7", "m7", "sus2", "sus4", "7sus4",
    "dim", "aug", "6", "m6", "add9", "9", "maj9", "m9"];
const HARMONY_STRUM_MS = 30;
/* The right half's 16 pads (from the bottom row) on an Inst or Pads track,
 * by what the instrument plays (null = dark). An entry with `mod` is a
 * modifier: it adds its fields to the pattern selected beside it, as the
 * Chord track's types do to its root.
 *  Chord (the Pads, or an Inst set to Chord): a row per strum, a column per
 *    inversion;
 *  Bass: its 8 patterns, the top row an Approach for them;
 *  Arp: its 10 patterns, the top row a Range for them. */
function harmonyChordGrid(extra) {
    return [[0, "No Strum"], [1, "Strum Up"], [2, "Strum Down"], [3, "Strum Alt"]].flatMap(([s, sname]) =>
        [INVERSION_AUTO, 0, 1, 2].map(inv => ({
            name: inversionLabel(inv) + " " + sname,
            fields: Object.assign({}, extra, s === 0 ? { inversion: inv, strum: 0 }
                : { inversion: inv, strum: HARMONY_STRUM_MS, strum_dir: s - 1 })
        })));
}
function harmonyPadded(list, top) {
    return [...list, ...new Array(12 - list.length).fill(null), ...top, ...new Array(4 - top.length).fill(null)];
}
const HARMONY_VARIATIONS = {
    pads: harmonyChordGrid({}),
    chord: harmonyChordGrid({ voicing: "chord" }),
    bass: harmonyPadded(
        BASS_PATTERN_LABELS.map((name, i) => ({ name: "Bass " + name, fields: { voicing: "bass", pattern: i } })),
        APPROACH_LABELS.map((name, a) => ({ name: "Approach " + name, mod: true, fields: { approach: a } }))),
    arp: harmonyPadded(
        ARP_PATTERN_LABELS.map((name, i) => ({ name: "Arp " + name, fields: { voicing: "arp", pattern: i } })),
        [1, 2, 3].map(r => ({ name: arpRangeLabel(r), mod: true, fields: { arp_range: r } })))
};
const HARMONY_VOICING_COLOUR = { bass: 9 /* Bright Lime */, chord: AzureBlue, arp: 20 /* Electric Violet */ };
const HARMONY_TYPE_COLOUR = 26;  /* Light Magenta */

/* What the pads have selected, for the song it was selected in: the Chord
 * track's root and type, the Inst/Pads tracks' preview root, and each
 * Inst/Pads track's variation -- { list, slot, mod }: the list it was picked
 * from (an Inst whose Voicing changes since has none), its pattern's slot
 * and its modifier's (-1 = none). -1 = none. */
let harmonySong = null;
let harmonyChordRoot = -1;
let harmonyChordQuality = "maj";
let harmonyInstRoot = -1;
const harmonyVariation = new Map();
/* A pad preview (one bar of the temporary song) is playing or starting;
 * harmonyPreviewConfirmed once the engine has started it. */
let harmonyPreviewing = false;
let harmonyPreviewConfirmed = false;
let harmonyPreviewStart = 0;
const HARMONY_PREVIEW_TIMEOUT_MS = 3000;

function harmonyTrack(track) {
    return track === TRACK_CHORD || isInstTrack(track);
}

function harmonyCheckSong() {
    const song = viewSong();
    if (harmonySong === song) return;
    harmonySong = song;
    harmonyChordRoot = -1;
    harmonyChordQuality = "maj";
    harmonyInstRoot = -1;
    harmonyVariation.clear();
}

/* Which list an Inst/Pads track's right half holds: the Pads' own, else the
 * instrument's Voicing. */
function harmonyListName(track) {
    if (track === TRACK_PADS) return "pads";
    const song = viewSong();
    const inst = song && song.instruments ? song.instruments[instIndex(track)] : null;
    const v = inst && inst.voicing;
    return HARMONY_VARIATIONS[v] && v !== "pads" ? v : "bass";
}

/* The track's selection, if it was picked from the list its pads hold now. */
function harmonySelection(track) {
    harmonyCheckSong();
    const sel = harmonyVariation.get(track);
    return sel && sel.list === harmonyListName(track) ? sel : null;
}

/* The selected variation of an Inst/Pads track -- its pattern with its
 * modifier's fields added -- or null. */
function harmonySelectedVariation(track) {
    const sel = harmonySelection(track);
    if (!sel) return null;
    const list = HARMONY_VARIATIONS[sel.list];
    const main = list[sel.slot], mod = sel.mod >= 0 ? list[sel.mod] : null;
    if (!mod) return main;
    return { name: main.name + " " + mod.name, fields: Object.assign({}, main.fields, mod.fields) };
}

/* The chord the Chord track's pads have selected, or null. */
function harmonySelectedChord() {
    harmonyCheckSong();
    if (harmonyChordRoot < 0) return null;
    if (harmonyChordRoot === CHORD_ROOT_NONE) return { none: true };
    const key = currentSong ? (currentSong.key || DEFAULT_KEY) : DEFAULT_KEY;
    return { root: chordRootName(key, harmonyChordRoot), quality: harmonyChordQuality };
}

/* The chord sounding at `bar` of `sec` (the last one at or before it), or
 * null before the section's first. */
function chordInEffect(sec, bar) {
    for (let b = bar; b >= 0; b--) {
        const list = barChords(sec, b).filter(c => !c.none);
        if (list.length) return list[list.length - 1];
    }
    return null;
}

/* What an Inst/Pads preview plays over: the root pad's chord, else the
 * chord at the selected item's bar, else the key's I. */
function harmonyInstChord(sec) {
    const key = currentSong ? (currentSong.key || DEFAULT_KEY) : DEFAULT_KEY;
    if (harmonyInstRoot >= 0) {
        return { root: chordRootName(key, harmonyInstRoot), quality: chordRootDefaultQuality(harmonyInstRoot) };
    }
    const bar = Math.max(0, listCursorBar(sec));
    const c = sec ? chordInEffect(sec, bar) : null;
    return c ? { root: c.root, quality: c.quality, bass: c.bass } : diatonicChord(key, 0);
}

function harmonyPadColour(track, p) {
    const col = p % PAD_COLUMNS, slot = Math.floor(p / PAD_COLUMNS) * 4 + (col % 4);
    const trackColour = TRACK_ROW_COLOUR[track];
    if (col < 4) {
        const r = HARMONY_ROOTS[slot];
        if (r < 0 || (r === CHORD_ROOT_NONE && track !== TRACK_CHORD)) return Black;
        if (r === (track === TRACK_CHORD ? harmonyChordRoot : harmonyInstRoot)) return White;
        if (r === CHORD_ROOT_NONE) return DarkGrey;
        return CHORD_ROOT_SCALE_DEGREE[r] >= 0 ? trackColour : veryDarkPartner(trackColour);
    }
    if (track === TRACK_CHORD) {
        return harmonyChordRoot >= 0 && harmonyChordRoot !== CHORD_ROOT_NONE &&
            harmonyChordQuality === HARMONY_TYPES[slot] ? White : HARMONY_TYPE_COLOUR;
    }
    const name = harmonyListName(track), entry = HARMONY_VARIATIONS[name][slot];
    if (!entry) return Black;
    const sel = harmonySelection(track);
    if (sel && (sel.slot === slot || sel.mod === slot)) return White;
    if (entry.mod) return HARMONY_TYPE_COLOUR;
    return track === TRACK_PADS ? trackColour : HARMONY_VOICING_COLOUR[name];
}

function drawHarmonyPads() {
    harmonyCheckSong();
    for (let i = 0; i < NUM_PADS; i++) padColor(i, harmonyPadColour(builderTrack, i), true);
}

/* A pad on the Chord, Inst or Pads track: select what it holds and play a
 * bar of it. While the song plays it only selects. */
function handleHarmonyPad(note, velocity) {
    const p = getPadIndex(note);
    if (p < 0 || velocity === 0) return;
    harmonyCheckSong();
    const track = builderTrack;
    const col = p % PAD_COLUMNS, slot = Math.floor(p / PAD_COLUMNS) * 4 + (col % 4);
    const key = currentSong ? (currentSong.key || DEFAULT_KEY) : DEFAULT_KEY;
    const sec = viewSong() ? viewSong().sections[chordDisplaySectionIndex()] : null;
    let chord, variation = null, name;
    if (col < 4) {
        const r = HARMONY_ROOTS[slot];
        if (r < 0 || (r === CHORD_ROOT_NONE && track !== TRACK_CHORD)) return;
        if (track === TRACK_CHORD) {
            harmonyChordRoot = r;
            if (r !== CHORD_ROOT_NONE) harmonyChordQuality = chordRootDefaultQuality(r);
            chord = harmonySelectedChord();
        } else {
            harmonyInstRoot = r;
            chord = harmonyInstChord(sec);
            variation = harmonySelectedVariation(track);
        }
        name = chord.none ? "No Chord" : chordLabel(chord, key);
    } else if (track === TRACK_CHORD) {
        if (harmonyChordRoot < 0 || harmonyChordRoot === CHORD_ROOT_NONE) harmonyChordRoot = 0;
        harmonyChordQuality = HARMONY_TYPES[slot];
        chord = harmonySelectedChord();
        name = chordLabel(chord, key);
    } else {
        const list = harmonyListName(track), entry = HARMONY_VARIATIONS[list][slot];
        if (!entry) return;
        const sel = harmonySelection(track) || { list, slot: 0, mod: -1 };
        /* A modifier goes with the selected pattern (the first, if none);
         * pressed again it comes off. */
        if (entry.mod) sel.mod = sel.mod === slot ? -1 : slot;
        else sel.slot = slot;
        harmonyVariation.set(track, sel);
        variation = harmonySelectedVariation(track);
        chord = harmonyInstChord(sec);
        name = variation.name;
    }
    showPopup(track === TRACK_CHORD ? "Chord" : itemTrackName(track), name, 1000);
    ledDirtyAll = true;
    needsRedraw = true;
    if (!chord.none) harmonyPreview(track, chord, variation ? variation.fields : null);
}

/* Play one bar of `chord` (and, on an Inst/Pads track, that track alone with
 * `fields` as an item): a temporary one-section song over the section's
 * first drum bar, the drums and click silenced (a Follow Note bass still
 * hears the kick). It stops by itself at the bar's end. */
function harmonyPreview(track, chord, fields) {
    if (playbackState === "playing" && !harmonyPreviewing) return;
    const song = viewSong();
    if (!song) return;
    const sec = song.sections[chordDisplaySectionIndex()];
    const temp = JSON.parse(JSON.stringify(song));
    const k = instIndex(track);
    const insts = [0, 1, 2].map(i => Object.assign({}, (temp.instruments || [])[i] || defaultInstrument(i),
        { bars: [], overrides: [] }));
    if (k >= 0) insts.forEach((inst, i) => { inst.enabled = i === k; });
    else if (!insts.some(inst => inst.enabled)) insts[2].enabled = true;
    temp.instruments = insts;
    const first = sec && Array.isArray(sec.clips) ? sec.clips.find(c => !c.placeholder) : null;
    const startBar = first && typeof first.start_bar === "number" ? first.start_bar : 0;
    const clip = first
        ? Object.assign({}, first, { start_bar: startBar, end_bar: startBar + 1, start_beat: 0, end_beat: 0, speed: 1 })
        : { placeholder: true, name: "", start_bar: 0, end_bar: 1 };
    const inst = [[], [], []];
    if (k >= 0 && fields) inst[k] = [Object.assign({ bar: 0 }, fields)];
    const c = Object.assign({}, chord);
    delete c.beat;
    delete c.adv;
    temp.sections = [{ name: "Preview", clips: [clip], chords: [c], inst }];
    temp.count_in = false;
    /* A preview still playing stops first. Restarting over it sent the old
     * chord's note-offs and the new one's note-ons on the same tick, so a
     * note the two share wasn't heard as a new attack -- silent once the
     * first had faded (found live). Stopping now releases them while the
     * new bar builds. */
    if (harmonyPreviewing) {
        if (typeof host_module_set_param_blocking === "function") host_module_set_param_blocking("stop", "1", 100);
        else if (typeof host_module_set_param === "function") host_module_set_param("stop", "1");
    }
    const saved = currentSong;
    const savedLoop = dspLoopEnabled;
    currentSong = temp;
    dspLoopEnabled = false;
    harmonyPreviewing = true;
    harmonyPreviewConfirmed = false;
    harmonyPreviewStart = Date.now();
    playCurrentSong(false, function () {
        dspLoopEnabled = savedLoop;
        harmonyPreviewConfirmed = true;
    });
    currentSong = saved;
    harmonySetSwitches(false);
}

/* The drums and click off for a preview, or back as they were. Blocking
 * writes, as playCurrentSong's: the engine's one parameter slot would let
 * a quick second write clobber the first (or the song) before it lands. */
function harmonySetSwitches(on) {
    const block = typeof host_module_set_param_blocking === "function";
    if (!block && typeof host_module_set_param !== "function") return;
    const set = block ? host_module_set_param_blocking : host_module_set_param;
    const t = block ? 100 : undefined;
    if (on) pushLiveMutesToDsp(set, t);
    else set("drum_enabled", "0", t);
    set("click_enabled", on && clickOn ? "1" : "0", t);
}

/* Called every tick: once the preview has played (or was stopped) -- or
 * never started -- give the drums and the click back. */
function tickHarmonyPreview() {
    if (!harmonyPreviewing || playbackState === "playing") return;
    if (harmonyPreviewConfirmed || Date.now() - harmonyPreviewStart > HARMONY_PREVIEW_TIMEOUT_MS) endHarmonyPreview();
}

function endHarmonyPreview() {
    harmonyPreviewing = false;
    harmonyPreviewConfirmed = false;
    harmonySetSwitches(true);
    stepLedsDirty = true;
}

/* Halfway through a bar: beat 3 of 4, the "and" of 2 in 3/4 (Advanced). */
function harmonyHalfBeat() {
    return beatsPerBar() / 2 + 1;
}

/* A step on the Chord, Inst or Pads track with a pad selected: add the
 * selection to that bar -- on beat 1, or halfway if beat 1 has something
 * else (replacing what is there) -- or, if the bar already has it, take it
 * out. False with nothing selected (the step then selects, as before). */
function harmonyStepPress(track, sec, bar) {
    if (!harmonyTrack(track)) return false;
    const chord = track === TRACK_CHORD ? harmonySelectedChord() : null;
    const variation = track === TRACK_CHORD ? null : harmonySelectedVariation(track);
    if (!chord && !variation) return false;
    if (songIsLocked()) { lockedNotice(); return true; }
    const half = harmonyHalfBeat();
    if (track === TRACK_CHORD) {
        const same = (c) => c.none ? !!chord.none : (!chord.none && !c.bass &&
            noteSemitone(c.root) === noteSemitone(chord.root) && c.quality === chord.quality);
        const list = barChords(sec, bar);
        const i = list.findIndex(same);
        if (i >= 0) {
            removeChordEvent(sec, bar, i);
            chordListCursor = Math.min(chordListCursor, sectionChordEvents(sec).length);
            syncChordCursorBar(sec);
        } else {
            const beat = chordPosFree(sec, bar, 1, -1, -1) ? 1 : half;
            const at = barChords(sec, bar).findIndex(c => chordBeat(c) === beat);
            if (at >= 0) removeChordEvent(sec, bar, at);
            const add = Object.assign({}, chord);
            if (beat !== 1) add.beat = beat;
            if (!Number.isInteger(beat)) add.adv = true;
            insertChordEvent(sec, bar, add);
            selectChordListAt(sec, bar, beat);
        }
    } else {
        if (!itemAddAvailable()) {
            showPopup(itemTrackName(track), "Add a chord to the Chord track first", 2000);
            return true;
        }
        const list = sortItems(sectionItems(sec, track));
        const f = variation.fields;
        const i = list.findIndex(it => it.bar === bar && Object.keys(f).every(k => it[k] === f[k]));
        let it = null;
        if (i >= 0) {
            list.splice(i, 1);
        } else {
            const beat = itemPosFree(list, bar, 1, null) ? 1 : half;
            const at = list.findIndex(x => x.bar === bar && chordBeat(x) === beat);
            if (at >= 0) list.splice(at, 1);
            it = Object.assign({ bar }, f);
            if (beat !== 1) it.beat = beat;
            if (!Number.isInteger(beat)) it.adv = true;
            list.push(it);
        }
        sortItems(list);
        itemListCursor = it ? list.indexOf(it) : Math.min(itemListCursor, list.length);
        syncItemCursorBar(list);
        unsavedChanges = true;
        markInstrumentLive(track);
    }
    stepLedsDirty = true;
    needsRedraw = true;
    return true;
}

function changeBuilderPage(delta) {
    const total = builderPageCount();
    const newPage = Math.max(0, Math.min(total - 1, builderPage + delta));
    if (newPage !== builderPage) {
        builderPage = newPage;
        /* Page browsing only changes the pad grid; playback continues. */
        stepLedsDirty = false;
        needsRedraw = true;
    }
}

/* Effective playable bar count for a single clip, accounting for sub-bar
 * (beat) trims and speed. A clip starting at beat 2 of its first bar and
 * ending at beat 4 of its last bar plays fewer bars than (end_bar -
 * start_bar). The DSP trims at the source tick level, so the effective bar
 * count must reflect the partial first/last bars. Used for the builder
 * clip-length display and the step-LED bar mapping so a shortened clip shows
 * its real (fractional) length. */
/* Format a fractional bar count as a mixed fraction for display, e.g.
 * 3.5 -> "3 2/4", 0.5 -> "2/4", 4 -> "4". The denominator is the song's
 * beats-per-bar, so a half-bar trim shows as "2/4" in 4/4 time. */
function formatBars(bars) {
    const bpb = (currentSong && currentSong.time_sig_num > 0) ? currentSong.time_sig_num : 4;
    const whole = Math.floor(bars);
    const frac = bars - whole;
    if (frac < 0.01) return String(whole);
    const num = Math.round(frac * bpb);
    const den = bpb;
    if (num >= den) return String(whole + 1);
    return whole > 0 ? (whole + " " + num + "/" + den) : (num + "/" + den);
}

function clipEffBars(clip) {
    if (!clip) return 1;
    const bpb = (currentSong && currentSong.time_sig_num > 0) ? currentSong.time_sig_num : 4;
    const speed = (typeof clip.speed === "number" && clip.speed > 0) ? clip.speed : 1.0;
    const startBeat = (clip.start_beat !== undefined && clip.start_beat > 0) ? clip.start_beat : 1;
    const endBeat = (clip.end_beat !== undefined && clip.end_beat > 0) ? clip.end_beat : bpb;
    const startFrac = (startBeat - 1) / bpb;
    const endFrac = (bpb - endBeat) / bpb;
    return Math.max(0.25, ((clip.end_bar - clip.start_bar) - startFrac - endFrac) / speed);
}

/* Total bars across all sections of a song, self-contained (does not depend
 * on the currentSong global, so it is safe to call for any setlist song). */
function songTotalBars(song) {
    if (!song || !song.sections) return 0;
    const bpb = (song.time_sig_num > 0) ? song.time_sig_num : 4;
    let bars = 0;
    for (const sec of song.sections) {
        for (const c of (sec.clips || [])) {
            const speed = (typeof c.speed === "number" && c.speed > 0) ? c.speed : 1.0;
            const startBeat = (c.start_beat !== undefined && c.start_beat > 0) ? c.start_beat : 1;
            const endBeat = (c.end_beat !== undefined && c.end_beat > 0) ? c.end_beat : bpb;
            const startFrac = (startBeat - 1) / bpb;
            const endFrac = (bpb - endBeat) / bpb;
            bars += Math.max(0.25, ((c.end_bar - c.start_bar) - startFrac - endFrac) / speed);
        }
    }
    return bars;
}

/* Quarter-note beats per bar for a song's time signature. A bar in 6/8 has
 * 6 eighth-note beats but only 3 quarter-note beats (num*4/den), and it is
 * quarter notes that define the BPM. Using time_sig_num directly would make
 * 6/8 bars count as 6 quarter notes and the time advance 2x too fast. */
function qtrBeatsPerBar(song) {
    const num = (song && song.time_sig_num > 0) ? song.time_sig_num : 4;
    const den = (song && song.time_sig_den > 0) ? song.time_sig_den : 4;
    return num * 4 / den;
}

/* Duration of a song in seconds at its own tempo/time-sig. */
function songDurationSec(song) {
    if (!song) return 0;
    const bpm = song.tempo_bpm || 120;
    return songTotalBars(song) * qtrBeatsPerBar(song) * (60 / bpm);
}

/* Format seconds as M:SS. */
function formatTime(sec) {
    const s = Math.max(0, Math.floor(sec));
    const m = Math.floor(s / 60);
    const ss = s % 60;
    return m + ":" + (ss < 10 ? "0" : "") + ss;
}

/* Cache key for the setlist total: the setlist path plus every song's path
 * and click bars, so the total is recomputed only when the setlist changes. */
function perfSetTotalKey() {
    if (!currentSetlist) return "";
    let k = currentSetlist.path || "";
    for (const e of currentSetlist.songs) k += "|" + (e.path || "") + ":" + (e.click_bars || 0);
    return k;
}

/* Total duration of the whole setlist in seconds (sum of every song). */
function computeSetTotalSec() {
    if (!currentSetlist) return 0;
    let total = 0;
    for (const e of currentSetlist.songs) {
        const song = applySetlistEdits(readJson(e.path), e);
        if (song) total += songDurationSec(song);
    }
    return total;
}

function sectionBars(sec) {
    if (!sec || !sec.clips) return 0;
    let bars = 0;
    for (const c of sec.clips) {
        bars += clipEffBars(c);
    }
    return bars;
}

/* Return the full-song bar range [startBar, endBar) for the given section
 * index, or null if out of range. Used to detect section-end boundaries. */
function perfSectionBarRange(sectionIndex) {
    const full = perfFullSong || currentSong;
    if (!full || sectionIndex < 0 || sectionIndex >= full.sections.length) return null;
    let startBar = 0;
    for (let i = 0; i < sectionIndex; i++) {
        startBar += sectionBars(full.sections[i]);
    }
    const endBar = startBar + sectionBars(full.sections[sectionIndex]);
    return { startBar, endBar };
}

/* A previous play-from build that never confirmed leaves currentSong pointing
 * at its trimmed copy; put the full song back before cutting a new copy, so a
 * copy is never cut from a copy (currentSectionIndex indexes the full song). */
function restoreSongFromTempCopy() {
    const origin = tempSongOrigin.get(currentSong);
    if (origin) currentSong = origin;
}

function playFromCurrentSection() {
    restoreSongFromTempCopy();
    const sec = currentSong ? currentSong.sections[currentSectionIndex] : null;
    if (!sec || !sec.clips || sec.clips.length === 0) return;
    /* Play from the current section through the end of the song. */
    const temp = JSON.parse(JSON.stringify(currentSong));
    temp.sections = JSON.parse(JSON.stringify(currentSong.sections.slice(currentSectionIndex)));
    reindexInstrumentsForSectionSlice(temp, currentSectionIndex);
    tempSongOrigin.set(temp, currentSong);
    tempSongStart.set(temp, currentSectionIndex);
    let barOffset = 0;
    for (let i = 0; i < currentSectionIndex; i++) {
        barOffset += sectionBars(currentSong.sections[i]);
    }
    const saved = currentSong;
    const savedLoop = dspLoopEnabled;
    currentSong = temp;
    previewBarOffset = barOffset;
    dspLoopEnabled = false;
    builderPlayingFromTemp = true;
    /* Restore all three from onConfirmed, not synchronously after this call
     * returns -- see the comment on the Shift+Play handler in
     * handleBuilderInput for why (playCurrentSong is async; a synchronous
     * restore here puts dspLoopEnabled back before its own deferred read of
     * it, and reverts currentSong before persistResolvedClipFolders -- also
     * called from that same deferred callback -- has a chance to read/save
     * the temp song it actually built). builderPlayingFromTemp covers the
     * same gap for the section-index display fallback -- see its
     * declaration. */
    playCurrentSong(false, function () {
        dspLoopEnabled = savedLoop;
        currentSong = saved;
        builderPlayingFromTemp = false;
    });
}

function previewClip(clip, barOffset) {
    if (!clip) return;
    const base = currentSong || newSong(currentSong ? currentSong.source_folder : "");
    const temp = JSON.parse(JSON.stringify(base));
    const bpb = (currentSong && currentSong.time_sig_num > 0) ? currentSong.time_sig_num : 4;
    temp.sections = [{
        id: "preview-" + Date.now(),
        name: "Preview",
        clips: [{
            source: clip.path,
            name: clip.name,
            start_bar: clipStartBar(clip),
            start_beat: 1,
            end_bar: clip.bars || 1,
            end_beat: bpb,
            advanced: false,
            guard_fraction: 0,
            speed: 1.0,
            velocity_scale: 1.0
        }]
    }];
    /* Carry the current song tempo/time-sig into the preview so pads preview
     * at the speed the song will actually play. */
    if (currentSong) {
        temp.tempo_bpm = currentSong.tempo_bpm;
        temp.time_sig_num = currentSong.time_sig_num;
        temp.time_sig_den = currentSong.time_sig_den;
    }
    const saved = currentSong;
    currentSong = temp;
    const savedLoop = dspLoopEnabled;
    dspLoopEnabled = false;
    previewBarOffset = (typeof barOffset === "number") ? barOffset : 0;
    /* The loop mode is read when the build confirms, so it is restored then.
     * The song goes back NOW, as jamPlayClip does: playCurrentSong has built
     * its JSON (and remembered the preview song for the folder check) before
     * it returns. Leaving the one-section preview song in currentSong until
     * the confirmation made the builder draw sections[currentSectionIndex]
     * of it -- "No section." for any section but the first, for the whole
     * build -- and a build that never confirmed left it there for good. */
    playCurrentSong(false, function () {
        dspLoopEnabled = savedLoop;
    });
    currentSong = saved;
}

function previewClipAtCursor() {
    restoreSongFromTempCopy();
    const sec = currentSong ? currentSong.sections[currentSectionIndex] : null;
    if (!sec || builderCursor < 0 || builderCursor >= sec.clips.length) {
        playFromCurrentSection();
        return;
    }
    /* Play from the cursor clip in the current section through the end of the
     * song. The first section keeps only the clips from the cursor onward,
     * preserving their original trims. */
    const fromCursorClips = sec.clips.slice(builderCursor).map(c => ({
        placeholder: c.placeholder,
        source: c.source,
        /* The clip's own folder. Leaving it out made the DSP look for a clip
         * borrowed from another folder in the song's folder, find it by
         * searching the whole library (possibly a same-named file from the
         * wrong folder), and report a "folder correction" -- which is what
         * then got saved over the song. */
        source_folder: c.source_folder,
        type: c.type,
        advanced: c.advanced,
        name: c.name,
        start_bar: c.start_bar,
        start_beat: c.start_beat !== undefined ? c.start_beat : 0,
        end_bar: c.end_bar,
        end_beat: c.end_beat !== undefined ? c.end_beat : 0,
        guard_fraction: c.guard_fraction,
        speed: c.speed !== undefined ? c.speed : 1.0,
        velocity_scale: c.velocity_scale,
        snare_note: c.snare_note,
        snare_velocity_scale: c.snare_velocity_scale,
        kick_note: c.kick_note,
        kick_target: c.kick_target,
        /* Carry the per-clip MIDI out channel override so a clip with a
         * modified channel keeps it when played from the cursor. */
        channel: c.channel !== undefined ? c.channel : 0
    }));
    const temp = JSON.parse(JSON.stringify(currentSong));
    temp.sections = JSON.parse(JSON.stringify(currentSong.sections.slice(currentSectionIndex)));
    reindexInstrumentsForSectionSlice(temp, currentSectionIndex);
    temp.sections[0].id = "play-from-cursor-" + Date.now();
    temp.sections[0].clips = fromCursorClips;
    tempSongOrigin.set(temp, currentSong);
    tempSongStart.set(temp, currentSectionIndex);
    /* Step-LED flash should still appear on the clip's actual step in the
     * original full section/song layout, not step 1 of the temporary section. */
    let barOffset = 0;
    for (let i = 0; i < currentSectionIndex; i++) {
        barOffset += sectionBars(currentSong.sections[i]);
    }
    for (let i = 0; i < builderCursor; i++) {
        const s = (typeof sec.clips[i].speed === "number" && sec.clips[i].speed > 0) ? sec.clips[i].speed : 1.0;
        barOffset += Math.max(1, Math.round((sec.clips[i].end_bar - sec.clips[i].start_bar) / s));
    }
    const saved = currentSong;
    const savedLoop = dspLoopEnabled;
    currentSong = temp;
    previewBarOffset = barOffset;
    dspLoopEnabled = false;
    builderPlayingFromTemp = true;
    /* Restore from onConfirmed -- see playFromCurrentSection above. */
    playCurrentSong(false, function () {
        dspLoopEnabled = savedLoop;
        currentSong = saved;
        builderPlayingFromTemp = false;
    });
}

/* ── Performance / Setlist playback ─────────────────────────────────── */

/* Build the pad layout for the whole setlist: each song contributes one pad
 * per section (full colour for the current song, dimmed for others), and a
 * song with a click (click_bars > 0) contributes an extra "click" pad before
 * its sections. Returns an array of { kind: 'section'|'click', songIndex,
 * sectionIndex }. */
function buildPerfLayout() {
    const layout = [];
    if (!currentSetlist) return layout;
    for (let s = 0; s < currentSetlist.songs.length; s++) {
        const entry = currentSetlist.songs[s];
        const song = applySetlistEdits(readJson(entry.path), entry);
        const sections = (song && song.sections) ? song.sections : [];
        if (entry.click_bars > 0) {
            layout.push({ kind: "click", songIndex: s, sectionIndex: -1 });
        }
        for (let i = 0; i < sections.length; i++) {
            const sec = sections[i];
            layout.push({
                kind: "section",
                songIndex: s,
                sectionIndex: i,
                sectionInfo: {
                    name: sec.name || ("Section " + (i + 1)),
                    hasClips: !!(sec.clips && sec.clips.length > 0)
                }
            });
        }
    }
    return layout;
}

/* Load the given setlist song index (0-based) into the builder state and send
 * it to the DSP as a one-shot timeline. */
function perfLoadSong(index, resetToggles) {
    if (!currentSetlist) return false;
    if (index < 0 || index >= currentSetlist.songs.length) return false;
    const entry = currentSetlist.songs[index];
    if (!entry || !loadSongFile(entry.path)) return false;
    /* This setlist's key, tempo and section order for the song, on a copy:
     * activeSongObj stays the file's own song, so nothing saves the edits
     * over it (see saveCurrentSong, persistResolvedClipFolders). */
    currentSong = applySetlistEdits(currentSong, entry);
    currentMode = MODE_PERFORMANCE;
    perfSongIndex = index;
    perfSongLoaded = true;
    perfFullSong = JSON.parse(JSON.stringify(currentSong));
    perfFullSongLoaded = false; /* DSP gets it on the next playCurrentSong */
    /* Live mute toggles are a per-session performance control, not a saved
     * preference: they're set to this song's own authored instrument enabled
     * flags (drums always on; an instrument slot the song never configured
     * defaults to off) only when Perform is entered (resetToggles), and
     * otherwise kept as the user left them -- across stops, song changes,
     * auto-advance and the end of the setlist. Found live: resetting on every
     * song load reverted the user's mutes whenever playback stopped at the
     * end of the setlist (which reloads the first song) or moved on to
     * another song. The current values are (re-)pushed either way, because
     * drum_enabled is engine-level (not part of the song JSON). */
    if (resetToggles) {
        perfDrumEnabled = true;
        perfInst1Enabled = !!(perfFullSong.instruments && perfFullSong.instruments[0] && perfFullSong.instruments[0].enabled);
        perfInst2Enabled = !!(perfFullSong.instruments && perfFullSong.instruments[1] && perfFullSong.instruments[1].enabled);
        perfInst3Enabled = !!(perfFullSong.instruments && perfFullSong.instruments[2] && perfFullSong.instruments[2].enabled);
    }
    /* Three different keys back to back -- use the blocking variant so none
     * of them can be clobbered by the next before the DSP consumes it (see
     * pushJamInstrumentRouting's comment). */
    if (typeof host_module_set_param === "function" ||
        typeof host_module_set_param_blocking === "function") {
        const block = typeof host_module_set_param_blocking === "function";
        const set = block ? host_module_set_param_blocking : host_module_set_param;
        const t = block ? 100 : undefined;
        set("drum_enabled", perfDrumEnabled ? "1" : "0", t);
        set("inst1_enabled", perfInst1Enabled ? "1" : "0", t);
        set("inst2_enabled", perfInst2Enabled ? "1" : "0", t);
        set("inst3_enabled", perfInst3Enabled ? "1" : "0", t);
    }
    perfSongSections = buildPerfLayout();
    currentSectionIndex = 0;
    playbackSectionIndex = 0;
    previewBarOffset = 0;
    dspLoopEnabled = false;
    /* Clamp the pad scroll row to the new layout's valid range. On an
     * auto-advance the previous (longer) song may have scrolled down (high
     * perfScrollRow); keeping that stale value for the shorter new song makes
     * the up/down button LEDs wrong (they think the view is a different row).
     * Clamping keeps the scroll position but bounds it to the new layout. */
    const maxRow = Math.max(0, Math.ceil(perfSongSections.length / 8) - 4);
    if (perfScrollRow > maxRow) perfScrollRow = maxRow;
    /* Re-enable auto-follow for the new song; the manual-scroll lock only
     * applies to the song the user was actively viewing. */
    perfManualScroll = false;
    /* Force a full pad repaint so the grid reflects the new song's sections
     * (coloured) and dims/greys the other songs. Without this, the previous
     * song's pad colours can persist when the active-pad flash runs. */
    ledDirtyAll = true;
    /* Restore this song's knob values (no-op when it is the song already
     * applied, e.g. perfStart reloading it before Play). */
    applyPerfKnobs(false);
    return true;
}

/* Play the current song through the DSP. If the setlist entry has a click
 * (click_bars > 0), first play a separate count-in timeline, then the real
 * song. The count-in's generated MIDI file only sets its length; the click
 * track plays it if the entry's Click Sound is on (else pad flashes only). */
function perfPlayCurrent() {
    if (!currentSong) return;
    /* A new play request is going out -- don't trust stopped_at_end again
     * until it's confirmed running. See perfObservedRunningSincePlay's
     * declaration. */
    perfObservedRunningSincePlay = false;
    const entry = currentSetlist ? currentSetlist.songs[perfSongIndex] : null;
    const clickBars = entry ? (entry.click_bars || 0) : 0;
    const clickSound = clickSoundOn(entry);
    logClick("PERFCLICK bars=" + clickBars + " sound=" + clickSound + " songBars=" + (currentSong.sections ? currentSong.sections.length : 0) +
        " sig=" + (currentSong.time_sig_num || "?") + "/" + (currentSong.time_sig_den || "?") + " ppq=" + (currentSong.ppq || "?"));
    perfClickBars = clickBars;
    /* Reset tick-driven count-in state so stale values from a previous song's
     * pad-flash click can't prematurely end a MIDI-note click. */
    perfClickTotalMs = 0;
    perfClickStartMs = 0;
    perfClickDsp = false;
    perfClickMute = false;
    if (clickBars > 0) {
        /* The DSP's ticks_per_beat is the MIDI ppq, and a bar contains
         * num*4/den quarter-note beats (3 for 6/8, 4 for 4/4), so the count-in
         * audio lasts clicksInQtrBeats = clickBars * num*4/den quarter notes.
         * time_sig_num itself (6) would double the timer for compound meters. */
        const qtrBeatsPerBar = (currentSong.time_sig_num || 4) * 4 / (currentSong.time_sig_den || 4);
        const bpm = currentSong.tempo_bpm || 120;
        /* Ensure the click MIDI file exists for the current revision. The file
         * is cached by a revision-based path; generateClickForEntry only
         * rewrites it when the click settings changed (click_rev bumped) or
         * the file is missing, so unchanged clicks are not rewritten on every
         * play. */
        const regenerated = generateClickForEntry(entry);
        clickMidiPath = regenerated || (entry && entry.click_path) || "";
        if (!clickMidiPath || !host_file_exists(clickMidiPath)) {
            logDebug("perfPlayCurrent: failed to generate click MIDI");
            return;
        }
        /* Build a click-only timeline: one section, one clip spanning the
         * click bars. */
        const clickSong = JSON.parse(JSON.stringify(currentSong));
        clickSong.sections = [{
            id: "click-" + Date.now(),
            name: "Click",
            clips: [{
                source: clickMidiPath,
                name: "Click",
                start_bar: 0,
                end_bar: clickBars,
                guard_fraction: 0,
                velocity_scale: 1.0
            }]
        }];
        /* The count-in's clip only sets its length; the click track plays it
         * (on the click's own output, channel and notes) if this song's
         * count-in has sound. */
        clickSong.count_in = true;
        clickSong.count_in_sound = clickSoundOn(entry);
        currentSong = clickSong;
        playbackSectionIndex = 0;
        previewBarOffset = 0;
        logClick("PERFCLICK path=" + clickMidiPath + " json=" + JSON.stringify(toEngineSongJson(clickSong)));
        perfClickPlaying = true;
        perfClickDsp = true;
        perfClickMute = !clickSound;
        perfClickStartMs = Date.now();
        /* Force a full step-LED redraw so the count-in click's steps (blue)
         * replace any steps left lit by the previous song's last section.
         * Do NOT clearStepLEDs() first — those black messages get wiped by
         * ledQueue.clear() in updateLEDs, leaving the old section's steps
         * physically lit. Instead rely on stepRedrawAll + a forced click
         * draw to overwrite every step. Also force a pad repaint so the new
         * song's sections are coloured and other songs are greyed. */
        stepLedsDirty = true;
        stepRedrawAll = true;
        ledDirtyAll = true;
        /* Compute the exact musical duration of the count-in. We use this
         * timer to start the real song on the next downbeat, instead of
         * waiting for the DSP's stopped_at_end flag, which fires slightly
         * early/late depending on clip-duration heuristics. */
        perfClickTotalMs = Math.round(clickBars * qtrBeatsPerBar * (60000 / bpm));
        /* Pass preloadStaged=true so playCurrentSong stages the full song into
         * DSP staging AFTER the click's song_json loads (loading song_json
         * clears staging, so preloading first would wipe it) but BEFORE play=1.
         * This keeps the blocking preload off the audio path (no first-note
         * blip) while leaving the staged full song intact for a sample-accurate
         * click→song swap. */
        perfClickSwapCounter = (lastDspTransport && lastDspTransport.swap_counter) || 0;
        perfClickSongStaged = false;
        playCurrentSong(true);
        return;
    }
    perfClickPlaying = false;
    playCurrentSong();
    perfFullSongLoaded = true; /* the full song timeline is now in the DSP */
    /* Force a full step-LED repaint so the new song's first section replaces
     * the previous song's last-section steps. Without stepRedrawAll the draw
     * runs with force=false and only changes steps whose colour differs, so
     * leftover steps (e.g. a shorter new first section) stay lit from the old
     * song. The click branch above already does this; the no-click path must
     * too. */
    stepScrollOffset = 0;
    resetStepFlash();
    stepRedrawAll = true;
    stepLedsDirty = true;
}

/* Preload the real (full) performance song into the DSP staging timeline so
 * it can be auto-swapped in the instant the count-in click ends. Mirrors the
 * Jam-mode preload/swap mechanism. */
function preloadPerfSongToStaging() {
    if (!perfFullSong || typeof host_module_set_param !== "function") return;
    const json = toEngineSongJson(perfFullSong);
    /* perfClickSongStaged now flips only once the DSP confirms this build
     * actually published, not the instant the (now-instantly-returning)
     * preload_song_json call returns -- its consumer at the click->song
     * transition depends on this being accurate (see the comment there). */
    requestStagingBuild(function () {
        if (typeof host_module_set_param_blocking === "function") {
            host_module_set_param_blocking("preload_song_json", json, 100);
            /* The staged song plays through once then stops (performance
             * songs advance, they don't loop). */
            host_module_set_param_blocking("staging_loop", "0", 100);
        } else {
            host_module_set_param("preload_song_json", json);
            host_module_set_param("staging_loop", "0");
        }
    }, function () {
        perfClickSongStaged = true;
    });
}

/* Start a performance from the current setlist position. */
function perfStart() {
    if (!currentSetlist || currentSetlist.songs.length === 0) return;
    stopPlayback();
    /* Always reload the full song from the setlist before starting. A previous
     * queued section jump may have left `currentSong` as a sliced one-shot, and
     * reusing it would play from the wrong section or fail with zero events. */
    if (perfSongIndex < 0 || perfSongIndex >= currentSetlist.songs.length) {
        const start = perfNextPlayable(0);
        if (start < 0) return; /* no playable songs in the setlist */
        perfSongIndex = start;
    }
    if (!perfLoadSong(perfSongIndex)) return;
    perfSongSections = buildPerfLayout();
    perfPlaying = true;
    /* Don't trust the DSP's stopped_at_end until this playback has been seen
     * running -- see perfObservedRunningSincePlay. perfPlayCurrent arms this
     * too, but starting from a selected section goes through
     * perfFireSectionJump instead, which didn't. Found live: after the
     * setlist finished, the last song's stale stopped_at_end fired an
     * immediate "advance" -- selecting a section in the first song started
     * the second song from the top, and selecting one in the second song
     * reset the display to the first while the section played. */
    perfObservedRunningSincePlay = false;
    perfQueuedSection = -1;
    perfQueuedSectionPresses = 0;
    perfQueuedSongIndex = -1;
    perfJumpPending = false;
    perfAdvancePending = false;
    perfLastBar = -1;
    perfLastBarCounter = -1;
    dspLoopEnabled = false;
    /* If a section was selected while stopped, jump to it before starting.
     * Guard against a stale selection index from a previous song. */
    if (perfSelectedSection >= 0 && currentSong && perfFullSong) {
        const sectionIndex = perfSelectedSection;
        if (sectionIndex < perfFullSong.sections.length) {
            logDebug("PERFSTART jump to selected section=" + sectionIndex);
        perfClearSelection();
            perfFireSectionJump(sectionIndex);
        } else {
            logDebug("PERFSTART selected section out of range, playing from start");
            perfClearSelection();
            perfPlayCurrent();
        }
    } else {
        logDebug("PERFSTART no selected section, playing from start selected=" + perfSelectedSection);
        perfClearSelection();
        perfPlayCurrent();
    }
    needsRedraw = true;
    stepLedsDirty = true;
}

/* Stop the performance entirely. */
function perfStop() {
    perfPlaying = false;
    perfQueuedSection = -1;
    perfQueuedSectionPresses = 0;
    perfQueuedSongIndex = -1;
    perfJumpPending = false;
    perfAdvancePending = false;
    perfClickPlaying = false;
    perfClickDsp = false;
    perfClickMute = false;
    if (!perfStoppedKeepSelection) {
        perfClearSelection();
    }
    stopPlayback();
    needsRedraw = true;
    stepLedsDirty = true;
}

/* Clear any stopped-state selection. Called when starting playback so the
 * selection does not persist across multiple starts. */
function perfClearSelection() {
    perfSelectedSection = -1;
    perfSelectedSong = -1;
}

/* Queue a jump to the given section of the current song. */
function perfQueueSection(sectionIndex) {
    if (!currentSong || sectionIndex < 0 || sectionIndex >= currentSong.sections.length) return;
    if (sectionIndex === playbackSectionIndex && !perfPlaying) return;
    /* Replace any pending song jump. */
    perfQueuedSongIndex = -1;
    /* Section press semantics:
     *  - a DIFFERENT (not queued) section queues a jump at the end of the
     *    current section (presses=1);
     *  - pressing the already-queued "next" section escalates to the end of
     *    the current bar (presses=2);
     *  - pressing the CURRENT playing section queues a repeat: the first
     *    press fires it at the end of the section (presses=1), a second
     *    press escalates it to the end of the current bar (presses=2).
     * Both repeat presses target the current section's start, so after the
     * jump fires (perfFireSectionJump clears perfQueuedSection) the display
     * and pads fall through to the normal "next section" state. */
    const isRepeat = (sectionIndex === playbackSectionIndex);
    const isQueuedRepeat = isRepeat && perfQueuedSection === sectionIndex;
    const isNext = (!isRepeat && sectionIndex === perfNextSectionIndex());
    if (isQueuedRepeat) {
        /* Second press on the current section: repeat at bar-end. */
        perfQueuedSectionPresses = 2;
    } else {
        perfQueuedSection = sectionIndex;
        perfQueuedSectionPresses = isNext ? 2 : 1;
    }
    perfJumpPending = true;
    /* If the full song timeline is already in the DSP, schedule the seek
     * sample-accurately now at the correct musical boundary, so the jump lands
     * on the boundary instead of a polling-latency later. */
    if (perfFullSongLoaded && perfPlaying && lastDspTransport && lastDspTransport.running &&
        typeof host_module_set_param === "function") {
        const curBar = lastDspTransport.bar || 1;
        /* Section-end boundaries can be fractional (perfSectionBarRange uses
         * sectionBars, which accounts for beat-level trims). The DSP parses the
         * boundary with strtod and converts to ticks, so it can fire exactly at
         * the section seam (a fractional bar) — neither cutting the current
         * section short (floor/truncate) nor bleeding into the next section
         * (ceil). Send the raw fractional boundary bar. */
        const sectionEnd = perfSectionBarRange(playbackSectionIndex)?.endBar;
        const boundaryBar0 = (perfQueuedSectionPresses >= 2)
            ? curBar /* bar-end: seek at end of the current bar */
            : (typeof sectionEnd === "number" ? sectionEnd : curBar);
        const targetRange = perfSectionBarRange(sectionIndex);
        /* The exact (possibly fractional) section start: a section after one
         * that ends mid-bar starts mid-bar, and the DSP seeks to fractional
         * bars. Rounding up landed the jump late, skipping its start. */
        const targetBar = targetRange ? targetRange.startBar : 0;
        /* seek_bar_scheduled = "<boundaryBar>:<targetBar>" (0-based bars). */
        host_module_set_param("seek_bar_scheduled", boundaryBar0 + ":" + targetBar);
        perfSeekScheduled = true;
        logDebug("PERFJUMP scheduled boundary=" + boundaryBar0 + " target=" + targetBar +
            " section=" + sectionIndex + " presses=" + perfQueuedSectionPresses);
    }
    needsRedraw = true;
    ledDirtyAll = true;
}

/* Queue a jump to an upcoming song in the setlist. */
function perfQueueSong(songIndex) {
    if (!currentSetlist || songIndex < 0 || songIndex >= currentSetlist.songs.length) return;
    if (songIndex === perfSongIndex) return;
    perfQueuedSection = -1;
    perfQueuedSectionPresses = 0;
    if (perfQueuedSongIndex === songIndex) {
        perfQueuedSongIndex = -1;
        perfJumpPending = false;
    } else {
        perfQueuedSongIndex = songIndex;
        perfJumpPending = true;
    }
    needsRedraw = true;
    ledDirtyAll = true;
}

/* Fire a queued section jump. If the full song is already loaded in the DSP,
 * seek to the target section's start bar and play from there (near-instant).
 * Otherwise fall back to rebuilding a sliced one-shot timeline. */
function perfFinishSectionJumpUiState(sectionIndex) {
    /* Clear stale transport/end state so perfTick doesn't act on old data. */
    lastDspState = null;
    lastDspTransport = null;
    playbackState = "playing";
    playbackStartTime = Date.now();
    playbackSectionIndex = sectionIndex;
    lastStepBeatKey = "";
    lastStepBarIndex = -1;
    lastTransportBar = 0;
    maxBeatThisBar = 0;
    transportBeatsPerBar = 0;
    lastSubdivisionIndex = 0;
    /* Reset the step-LED scroll window, flash state, and cached step colours
     * so the new section's steps are fully cleared and repainted. */
    stepScrollOffset = 0;
    resetStepFlash();
    stepRedrawAll = true;
    perfQueuedSection = -1;
    perfQueuedSectionPresses = 0;
    perfJumpPending = false;
    needsRedraw = true;
    stepLedsDirty = true;
}

function perfFireSectionJump(sectionIndex) {
    const full = perfFullSong || currentSong;
    if (!full || sectionIndex < 0 || sectionIndex >= full.sections.length) return;
    const range = perfSectionBarRange(sectionIndex);
    if (!range) return;
    const startBar = range.startBar;
    currentSectionIndex = sectionIndex;
    /* Also set synchronously, not only inside perfFinishSectionJumpUiState
     * (which only runs once the jump is confirmed -- immediately for the
     * perfFullSongLoaded seek path, but after an async build in the else
     * branch below). drawPerformance's section-name display falls back to
     * fullSong.sections[playbackSectionIndex] as soon as perfPlaying is true
     * (set synchronously and early, in perfStart, before this function ever
     * runs) -- so during that gap it was reading the STALE value perfLoadSong
     * reset to (0), showing the first section's name until the jump actually
     * confirmed. Setting it here closes the gap the same way
     * currentSectionIndex already does, one line up. */
    playbackSectionIndex = sectionIndex;
    dspLoopEnabled = false;
    if (perfFullSongLoaded && typeof host_module_set_param === "function") {
        /* Full song is already in the DSP and confirmed built -- this is a
         * pure seek within an already-active timeline, no build in flight,
         * so it stays immediate. If the seek was already scheduled
         * sample-accurately at queue time (seek_bar_scheduled), the DSP has
         * applied it at the boundary — do not re-seek here (that would jump
         * early). Otherwise seek and play immediately. */
        if (!perfSeekScheduled) {
            previewBarOffset = 0;
            host_module_set_param("play_from_bar", String(startBar));
        } else {
            /* The scheduled seek already set the playhead; just sync the
             * offset for display. */
            previewBarOffset = 0;
        }
        perfSeekScheduled = false;
        perfFinishSectionJumpUiState(sectionIndex);
    } else {
        /* Full song not yet in the DSP: load the FULL song timeline, then seek
         * to the target section. Keeping the full song in the DSP means later
         * section jumps use the fast seek path (play_from_bar) instead of a
         * blocking rebuild, so live section changes are blip-free. Build the
         * timeline WITHOUT `play` (which would start from tick 0 and play the
         * song's first note before the seek lands — a double-note blip), then
         * seek directly to the target bar. The seek itself (and every "now
         * playing" UI state update) waits for the DSP to confirm the build
         * actually published -- see buildSongTimelineOnly/requestPrimaryBuild
         * -- rather than racing it over the shared shadow_param SHM slot with
         * a tuned timeout, which could otherwise seek against a partial/stale
         * timeline (wrong bar) or be dropped entirely. */
        const temp = JSON.parse(JSON.stringify(full));
        currentSong = temp;
        previewBarOffset = 0;
        buildSongTimelineOnly(function () {
            perfFullSongLoaded = true;
            const set2 = typeof host_module_set_param_blocking === "function"
                ? host_module_set_param_blocking : host_module_set_param;
            set2("play_from_bar", String(startBar),
                 typeof host_module_set_param_blocking === "function" ? 100 : undefined);
            perfFinishSectionJumpUiState(sectionIndex);
        });
    }
}

/* Fire a queued song jump: load and start the target song one-shot. */
function perfFireSongJump(songIndex) {
    if (!currentSetlist || songIndex < 0 || songIndex >= currentSetlist.songs.length) return;
    if (perfLoadSong(songIndex)) {
        perfPlayCurrent();
    }
    perfQueuedSongIndex = -1;
    perfQueuedSection = -1;
    perfQueuedSectionPresses = 0;
    perfJumpPending = false;
    needsRedraw = true;
    stepLedsDirty = true;
    ledDirtyAll = true;
}

/* Advance to the next song in the setlist (called on song end). */
function perfAdvance() {
    if (!currentSetlist) { perfStop(); return; }

    const currentEntry = currentSetlist.songs[perfSongIndex];
    const stopAfterFinish = currentEntry ? (currentEntry.stop_after_finish === true) : false;

    const next = perfNextPlayable(perfSongIndex + 1);

    /* End of setlist. */
    if (next < 0) {
        perfStoppedKeepSelection = true;
        perfStop();
        perfStoppedKeepSelection = false;
        perfSongIndex = 0;
        if (currentSetlist.songs.length > 0) {
            perfLoadSong(0);
        }
        perfSelectedSong = 0;
        perfSelectedSection = -1;
        needsRedraw = true;
        stepLedsDirty = true;
        ledDirtyAll = true;
        return;
    }

    /* Stop-after-finish: stop playback and select the next song so the next
     * Play starts from it. */
    if (stopAfterFinish) {
        perfStoppedKeepSelection = true;
        perfStop();
        perfStoppedKeepSelection = false;
        perfSongIndex = next;
        if (perfLoadSong(next)) {
            perfSelectedSong = next;
            perfSelectedSection = -1;
        }
        perfAdvancePending = false;
        needsRedraw = true;
        stepLedsDirty = true;
        ledDirtyAll = true;
        return;
    }

    if (perfLoadSong(next)) {
        perfPlayCurrent();
    }
    perfAdvancePending = false;
    needsRedraw = true;
    stepLedsDirty = true;
    ledDirtyAll = true;
}

/* Return the index of the next song at or after `from` that has at least one
 * clip (a blank song has no events and the DSP cannot play it). Returns -1 if
 * none. */
function perfNextPlayable(from) {
    if (!currentSetlist) return -1;
    for (let i = from; i < currentSetlist.songs.length; i++) {
        const entry = currentSetlist.songs[i];
        if (!entry) continue;
        const song = readJson(entry.path);
        if (!song || !song.sections) continue;
        let hasClips = false;
        for (const sec of song.sections) {
            if (sec && sec.clips && sec.clips.length > 0) { hasClips = true; break; }
        }
        if (hasClips) return i;
    }
    return -1;
}

/* Called every tick while in performance view / playing. Detects song end and
 * fires queued jumps at the right boundary. */
function perfTick() {
    if (!perfPlaying) return;

    /* Pad-flash-only count-in: no DSP timeline, so check elapsed time. This
     * branch also returns early every tick so the stale DSP end state from the
     * previous song can't re-trigger an advance/restart. */
    if (perfClickPlaying && !perfClickDsp && perfClickTotalMs > 0) {
        if (Date.now() - perfClickStartMs >= perfClickTotalMs) {
            logDebug("perfTick: pad-flash click ended, starting song");
            perfClickPlaying = false;
            if (perfLoadSong(perfSongIndex)) {
                perfObservedRunningSincePlay = false; /* see its declaration */
                playCurrentSong();
            }
            perfAdvancePending = false;
            needsRedraw = true;
            stepLedsDirty = true;
            stepRedrawAll = true;
        }
        return;
    }

    /* For the DSP-driven count-in, use a JS timer to start the real song
     * exactly at the computed downbeat. This avoids the ~50 ms variance we
     * see when relying on the host's stopped_at_end flag. */
    if (perfClickPlaying && perfClickDsp && perfClickTotalMs > 0) {
        if (Date.now() - perfClickStartMs >= perfClickTotalMs) {
            logDebug("perfTick: timer-based click transition");
            perfClickPlaying = false;
            perfClickMute = false;
            /* The real song was preloaded into DSP staging during the click,
             * so the DSP auto-swaps to it sample-accurately at the click's
             * end. We must NOT call playCurrentSong() here — that would issue
             * a blocking song_json rebuild (the audible gap between the last
             * click beat and the song's downbeat). Just sync the UI song to
             * the full song. */
            if (perfFullSong) {
                currentSong = JSON.parse(JSON.stringify(perfFullSong));
                perfFullSongLoaded = true;
            }
            perfAdvancePending = false;
            needsRedraw = true;
            stepLedsDirty = true;
            stepRedrawAll = true;
            /* Force a full pad repaint: the count-in click mode coloured the
             * click pad / dimmed sections; the song now plays, so the pad grid
             * must switch to the song-section colouring (active section
             * green, current song coloured, others grey). */
            ledDirtyAll = true;
            return;
        }
    }

    /* Song end detection: DSP reports stopped_at_end on a one-shot.
     * If this happens while the count-in click is still playing, treat it as
     * the click-to-song transition. With the song preloaded into staging the
     * DSP auto-swaps; if staging wasn't ready for some reason, fall back to a
     * blocking rebuild. */
    if (lastDspState && lastDspState.stopped_at_end && perfObservedRunningSincePlay) {
        if (perfClickPlaying && perfClickDsp) {
            logDebug("perfTick: DSP click end fallback");
            perfClickPlaying = false;
            perfClickMute = false;
            if (!perfClickSongStaged) {
                /* Staging wasn't ready: blocking rebuild (rare fallback). */
                if (perfLoadSong(perfSongIndex)) {
                    perfObservedRunningSincePlay = false; /* see its declaration */
                    playCurrentSong();
                    perfFullSongLoaded = true;
                }
            } else if (perfFullSong) {
                /* Song was preloaded; the DSP auto-swapped it. Sync the UI. */
                currentSong = JSON.parse(JSON.stringify(perfFullSong));
                perfFullSongLoaded = true;
            }
            perfAdvancePending = false;
            needsRedraw = true;
            stepLedsDirty = true;
            stepRedrawAll = true;
            /* Force a full pad repaint so the grid leaves click mode and shows
             * the song's section colouring. */
            ledDirtyAll = true;
            return;
        }
        perfAdvancePending = true;
        logDebug("perfTick: song end detected, advancing");
    }

    /* If a jump was queued, fire it at the appropriate boundary:
     *  - song jump: at the next bar boundary (as before)
     *  - section jump with 1 press: at the end of the current section
     *  - section jump with 2 presses: at the end of the current bar
     * We treat a change in the DSP's authoritative bar_counter as a bar
     * boundary (this is monotonic and correct even across loop wraps/seeks,
     * unlike comparing the raw bar number). */
    if (perfJumpPending && lastDspTransport && lastDspTransport.running) {
        const bar = lastDspTransport.bar || 1;
        const beat = lastDspTransport.beat || 1;
        const bc = lastDspTransport.bar_counter || 0;
        const barChanged = bc > perfLastBarCounter;
        const dspBar0 = bar - 1;
        const fullSongBar0 = dspBar0 + previewBarOffset;

        if (perfQueuedSongIndex >= 0) {
            /* Fire at the end of the current section, i.e. when the playhead
             * transitions into the next section. */
            if (perfLastSection >= 0 && playbackSectionIndex !== perfLastSection && barChanged) {
                perfFireSongJump(perfQueuedSongIndex);
                perfLastBarCounter = bc;
            }
        } else if (perfQueuedSection >= 0) {
            /* presses=2 (the already-queued next section / escalated repeat):
             * fire at the end of the current bar. presses=1 (a different
             * section, or a single-press repeat): fire at the end of the
             * current section. A single-press REPEAT targets the same section
             * (playbackSectionIndex never changes), so it is detected instead
             * by the DSP's seek_counter: when the scheduled seek fires the
             * section replays, and the queued state is cleared so the display
             * and pads fall through to the next section. */
            if (perfQueuedSectionPresses >= 2) {
                if (barChanged) {
                    perfFireSectionJump(perfQueuedSection);
                    perfLastBarCounter = bc;
                }
            } else {
                if (perfLastSection >= 0 && playbackSectionIndex !== perfLastSection && barChanged) {
                    perfFireSectionJump(perfQueuedSection);
                    perfLastBarCounter = bc;
                } else if (perfQueuedSection === playbackSectionIndex &&
                           (lastDspTransport.seek_counter || 0) > perfLastSeekCounter) {
                    /* A repeat of the current section fired (the scheduled
                     * seek applied in the DSP). Clear the queued state so the
                     * next section becomes the highlighted one. */
                    perfFireSectionJump(perfQueuedSection);
                    perfLastBarCounter = bc;
                }
            }
        }
    }

    if (lastDspTransport) {
        const curPerfBar = lastDspTransport.bar || 1;
        /* On each bar change, repaint the pad LEDs so the queued next-section
         * pad can flip from white to purered when the playhead reaches the
         * current section's last bar (mirrors Jam mode's boundary repaint). */
        if (curPerfBar !== perfLastBar) {
            ledDirtyAll = true;
        }
        perfLastBar = curPerfBar;
        perfLastBarCounter = lastDspTransport.bar_counter || 0;
        perfLastSeekCounter = lastDspTransport.seek_counter || 0;
    }
    perfLastSection = playbackSectionIndex;

    if (perfAdvancePending && !perfJumpPending) {
        perfAdvance();
    }
}

function readScanState() {
    if (typeof host_module_get_param !== "function") return null;
    const raw = host_module_get_param("scan_state");
    if (raw) {
        try {
            const st = JSON.parse(raw);
            return { songs: !!st.songs, folders: !!st.folders, found: st.folders_found | 0 };
        } catch (e) {}
    }
    /* An older engine: one flag for both lists. */
    const pending = host_module_get_param("scan_pending");
    if (pending === null || pending === undefined) return null;
    return { songs: pending === "1", folders: pending === "1", found: 0 };
}

/* True while the engine is still scanning `which` ("songs" / "folders"). */
function listLoading(which) {
    return !!(scanState && scanState[which]);
}

function pollScanState() {
    const now = Date.now();
    if (now - lastScanStatePoll < SCAN_STATE_POLL_MS) return;
    lastScanStatePoll = now;
    const prev = scanState;
    scanState = readScanState();
    if (!scanState) return;
    if (prev && prev.songs && !scanState.songs) {
        reloadSongBankAndPreserveSelection();
        needsRedraw = true;
    }
    if (prev && prev.folders && !scanState.folders) {
        libraryCacheValid = false;
        loadLibraryFolders();
        libraryKnownEmpty = libraryFolders.length === 0;
        if (libraryKnownEmpty) pendingLibraryFoldersReload = false;
        ledDirtyAll = true;
        needsRedraw = true;
    }
    /* The walk's running count changes the "Loading" line. */
    if (prev && scanState.folders && prev.found !== scanState.found) needsRedraw = true;
    if (!prev || prev.songs !== scanState.songs || prev.folders !== scanState.folders) needsRedraw = true;
}

/* Whether the screen now showing depends on a list the engine may still be
 * scanning (so the scan state is worth a poll). */
function screenWaitsOnScan() {
    if (pendingSongBankSync) return false;   /* reloads the Song Bank itself, every tick */
    switch (currentView) {
        case VIEW_SONG_BANK: case VIEW_SETLIST_PICK:
        case VIEW_FOLDER_LIST: case VIEW_JAM_FOLDER:
            return true;
    }
    return pendingLibraryFoldersReload || !!pendingFolderClipLoadName || pendingJamFolderClipLoadIndex >= 0 ||
        (scanState !== null && (scanState.songs || scanState.folders));
}

/* "Loading" plus 1-3 cycling dots, for a list or clips still on their way. */
function loadingText(what) {
    const dots = ".".repeat(1 + Math.floor(Date.now() / 400) % 3);
    return "Loading " + what + dots;
}

/* Drawn in place of an empty list of library folders: "Loading library..."
 * and, once the walk has found some, how many so far. */
function drawLibraryFoldersPlaceholder() {
    if (listLoading("folders")) {
        const n = scanState ? scanState.found : 0;
        print(4, LIST_TOP_Y, loadingText("library"), 1);
        if (n > 0) print(4, LIST_TOP_Y + 10, n + (n === 1 ? " folder" : " folders") + " found", 1);
    } else if (libraryKnownEmpty) {
        print(4, LIST_TOP_Y, "No MIDI folders found", 1);
    }
}

function loadLibraryFolders() {
    /* Reuse the cached folder list + clip map when the DSP scan is stable.
     * Re-fetching and re-parsing every folder's clips on each picker open is
     * the source of the delay when opening Jam / new-song / change-folder. */
    if (libraryCacheValid) return;
    libraryFolders = [];
    libraryFolderCategories = [];
    libraryCategoryTree = makeCategoryTree();
    if (typeof host_module_get_param !== "function") return;
    /* One "folders_json" read in place of folder_count + folder_name_N +
     * folder_category_N (2N+1 round trips) -- see readDspList. */
    let count = 0;
    let listedItems = [];
    const listed = readDspList("folders_json");
    if (listed) {
        count = listed.count;
        listedItems = listed.items;
    } else {
        try {
            const cnt = host_module_get_param("folder_count");
            if (cnt) count = parseInt(cnt, 10);
        } catch (e) {}
    }
    for (let i = 0; i < count; i++) {
        /* From the list answer where it reached, else by index. */
        const f = i < listedItems.length ? listedItems[i] : null;
        const name = f ? f.name : host_module_get_param("folder_name_" + i);
        if (!name) continue;
        libraryFolders.push(name);
        const cat = (f ? f.category : host_module_get_param("folder_category_" + i)) || "";
        libraryFolderCategories.push(cat);
        addFolderToTree(libraryCategoryTree, cat, i);
    }
    if (libraryFolders.length === 0) {
        /* Ask for a scan only if none is on its way: this runs every tick
         * while a screen waits for folders, and each request queued ANOTHER
         * full walk of the library behind the one in progress. */
        if (!listLoading("folders") && !libraryKnownEmpty) host_module_set_param("scan_library", "1");
        pendingLibraryFoldersReload = !libraryKnownEmpty;
    } else {
        libraryKnownEmpty = false;
        /* Build the clip->folder map once folders are known, so existing songs
         * can backfill a clip's source_folder on load/save. */
        buildFolderClipMap();
        libraryCacheValid = true;
    }
}

/* Tree helpers for nested category navigation. */

function makeCategoryTree() {
    return { children: {}, folders: [] };
}

function addFolderToTree(tree, catPath, folderIndex) {
    const parts = catPath ? catPath.split("/") : [];
    let node = tree;
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (!node.children[part]) {
            node.children[part] = makeCategoryTree();
        }
        node = node.children[part];
    }
    node.folders.push(folderIndex);
}

function getTreeNode(tree, path) {
    let node = tree;
    for (let i = 0; i < path.length; i++) {
        const part = path[i];
        node = node.children[part];
        if (!node) return null;
    }
    return node;
}

function getTreeDisplayItems(node) {
    const items = [];
    const childNames = Object.keys(node.children).sort((a, b) => a.localeCompare(b));
    for (let i = 0; i < childNames.length; i++) {
        const name = childNames[i];
        items.push({ type: "category", name: name, label: shortSongName(name) + " >" });
    }
    const folderItems = node.folders.map(idx => ({ type: "folder", index: idx, label: shortSongName(libraryFolders[idx]) }));
    folderItems.sort((a, b) => libraryFolders[a.index].localeCompare(libraryFolders[b.index]));
    items.push(...folderItems);
    return items;
}

/* Global folder index of the currently selected Builder folder. */
function currentBuilderFolderIndex() {
    const node = getTreeNode(libraryCategoryTree, folderPickerPath);
    if (!node) return 0;
    const items = getTreeDisplayItems(node);
    const item = items[folderPickerSelectedIndex];
    if (item && item.type === "folder") return item.index;
    return node.folders[0] !== undefined ? node.folders[0] : 0;
}

/* Global folder index of the currently selected Jam folder. */
function currentJamFolderIndex() {
    const node = getTreeNode(libraryCategoryTree, jamFolderPickerPath);
    if (!node) return 0;
    const items = getTreeDisplayItems(node);
    const item = items[jamFolderPickerSelectedIndex];
    if (item && item.type === "folder") return item.index;
    return node.folders[0] !== undefined ? node.folders[0] : 0;
}

/* Point the Builder folder picker at the category path containing folderIndex. */
function setFolderPickerToFolder(folderIndex) {
    const cat = libraryFolderCategories[folderIndex] || "";
    folderPickerPath = cat ? cat.split("/") : [];
    const node = getTreeNode(libraryCategoryTree, folderPickerPath);
    if (!node) {
        folderPickerSelectedIndex = 0;
        return;
    }
    const items = getTreeDisplayItems(node);
    for (let i = 0; i < items.length; i++) {
        if (items[i].type === "folder" && items[i].index === folderIndex) {
            folderPickerSelectedIndex = i;
            return;
        }
    }
    folderPickerSelectedIndex = 0;
}

/* Full relative path of a folder index (category + leaf), e.g.
 * "GM Ballads/Song 08 082 Not Only One". Root-level folders have no category,
 * so the full path is just the leaf name. */
function folderFullPath(folderIndex) {
    const cat = libraryFolderCategories[folderIndex] || "";
    const name = libraryFolders[folderIndex] || "";
    return cat ? cat + "/" + name : name;
}

/* Resolve a folder name (leaf or full path) to its full relative path. Used
 * when creating a song so source_folder stores the full path, which lets the
 * DSP resolve clips directly and lets the folder picker reopen at the exact
 * category. */
function folderFullPathForName(name) {
    if (!name) return "";
    /* libraryFolders is a flat array of leaf folder names across the entire
     * nested library, so a leaf name can legitimately appear in more than one
     * category (e.g. "Song 01", "Groove"). indexOf would silently pick the
     * first match regardless of category, and the caller persists the result
     * straight to disk — corrupting the song's source_folder with a wrong
     * guess. Refuse to guess on ambiguity: only upgrade when the leaf name is
     * unique, otherwise leave the value unchanged so the (correct-by-
     * verification) C-side fallback chain resolves it. */
    let match = -1, count = 0;
    for (let i = 0; i < libraryFolders.length; i++) {
        if (libraryFolders[i] === name) { match = i; count++; }
    }
    if (count !== 1) return name; /* ambiguous or not found — leave unchanged */
    return folderFullPath(match);
}

/* Resolve a folder path (leaf or full path) to its libraryFolders index.
 * Returns -1 if not found. */
function folderIndexForPath(path) {
    if (!path) return -1;
    let idx = libraryFolders.indexOf(path);
    if (idx >= 0) return idx;
    for (let i = 0; i < libraryFolders.length; i++) {
        if (folderFullPath(i) === path) return i;
    }
    const leaf = path.substring(path.lastIndexOf("/") + 1);
    return libraryFolders.indexOf(leaf);
}

/* Upgrade a song's source_folder (and each clip's source_folder) from a
 * leaf-only name to the full relative path (category + leaf) when the folder
 * is found in the library. This lets the DSP resolve clips directly and the
 * folder picker reopen at the exact category. Returns true if anything changed. */
function upgradeSongSourceFolders(song) {
    if (!song) return false;
    let changed = false;
    const songFull = folderFullPathForName(song.source_folder);
    if (songFull && songFull !== song.source_folder) {
        song.source_folder = songFull;
        changed = true;
    }
    for (const sec of song.sections || []) {
        for (const c of sec.clips || []) {
            if (!c.source_folder) continue;
            const full = folderFullPathForName(c.source_folder);
            if (full && full !== c.source_folder) {
                c.source_folder = full;
                changed = true;
            }
        }
    }
    return changed;
}

/* The library folder the pad palette's clips (folderClips) were loaded from:
 * where a clip added from a pad comes from. -1 = none loaded. */
let folderClipsIndex = -1;

function loadFolderClips(folderIndex) {
    folderClipsIndex = folderIndex;
    folderClips = [];
    grooveClips = [];
    fillClips = [];
    if (typeof host_module_get_param !== "function") return;
    const clipsJson = host_module_get_param("folder_clips_json_" + folderIndex);
    if (!clipsJson) return;
    try {
        const raw = JSON.parse(clipsJson);
        folderClips = raw.map(c => {
            const path = (typeof c === "string") ? c : (c.source || c);
            const type = inferPartTypeFromFilename(path);
            const clip = {
                path: path,
                name: (typeof c === "string") ? clipDisplayName(c) : (c.display || c.name || clipDisplayName(path)),
                bars: (typeof c === "string") ? clipDisplayBars(c) : (c.bars || clipDisplayBars(path)),
                type: type
            };
            return clip;
        });
        grooveClips = folderClips.filter(c => c.type !== "fill");
        fillClips = folderClips.filter(c => c.type === "fill");
        /* Order both the groove and fill palettes by section type (intro →
         * verse → prechorus → chorus → bridge → outro), then by simplest name
         * first, matching Jam mode's ordering. */
        grooveClips.sort(clipOrderCompare);
        fillClips.sort(clipOrderCompare);
    } catch (e) { folderClips = []; grooveClips = []; fillClips = []; }
}

/* Build a map of clip leaf name -> EVERY folder holding a clip of that name,
 * from the DSP's folder scan. Used to backfill a clip's source_folder when
 * loading an existing song whose clips were added from a different folder
 * than the song's primary one -- see clipFolderBackfill. */
/* The folder to record for a clip with none, from the leaf -> folders map: the
 * one other folder holding it. Nothing when the song's own folder holds it --
 * a clip from the song's folder is SAVED with no folder (it needs none), so
 * this sees every one of them; taking the last folder scanned with that name
 * re-pointed them at another folder's clip of the same name (found live: a
 * Chorus playing "06 4th Cym" from another kit). Nothing either when several
 * other folders hold it: that is a guess, and the engine's own library-wide
 * search is no worse. */
export function clipFolderBackfill(map, leaf, songFolder) {
    const folders = map && leaf ? map[leaf] : null;
    if (!Array.isArray(folders) || folders.length === 0) return "";
    /* An older song names its folder by its last part(s) only. */
    if (songFolder && folders.some(f => f === songFolder || f.endsWith("/" + songFolder))) return "";
    return folders.length === 1 ? folders[0] : "";
}

function buildFolderClipMap() {
    folderClipMap = {};
    if (typeof host_module_get_param !== "function") return;
    /* Every folder's clip list from the paged "clip_leaves_json" answer
     * (usually one read; items[i] is folder i's clip paths) instead of one
     * folder_clips_json_N round trip per folder, which this paid at every
     * library load and every resume. A folder the answer did not reach is
     * read on its own, as before. */
    const listed = readDspList("clip_leaves_json");
    const leaves = listed ? listed.items : [];
    for (let i = 0; i < libraryFolders.length; i++) {
        const folder = folderFullPath(i);
        let clipsJson = null;
        if (!(i < leaves.length && Array.isArray(leaves[i]))) {
            clipsJson = host_module_get_param("folder_clips_json_" + i);
            if (!clipsJson) continue;
        }
        try {
            const raw = clipsJson ? JSON.parse(clipsJson) : leaves[i];
            for (const c of raw) {
                const path = (typeof c === "string") ? c : (c.source || c);
                const leaf = clipDisplayName(path);
                if (!leaf) continue;
                if (!folderClipMap[leaf]) folderClipMap[leaf] = [];
                if (folderClipMap[leaf].indexOf(folder) < 0) folderClipMap[leaf].push(folder);
            }
        } catch (e) {}
    }
}

/* ── Pad helpers (local to avoid deprecated shared exports) ──────────── */

function getPadIndex(noteNumber) {
    return MovePads.indexOf(noteNumber);
}

/* ── Lifecycle hooks ───────────────────────────────────────────────── */

globalThis.init = function() {
    menuStack = createMenuStack();
    clearAllLEDs();
    resetLedState();
    menuStack.push({ title: "Arranger", selectedIndex: 0 });
    ensureDir(LIBRARY_ROOT);
    ensureDir(SONGS_DIR);
    ensureDir(SETLISTS_DIR);
    if (typeof host_module_set_param === "function") {
        host_module_set_param("library_root", LIBRARY_ROOT);
    }
    loadLibraryFolders();
    songFiles = listSongFiles();
    lastConfigRaw = readConfigRaw();
    loadSettings();
    applyOutputSettingsToDsp();
    logDebug("init: BUILD=" + UI_BUILD_VERSION + " library_root=" + LIBRARY_ROOT + " folders=" + libraryFolders.length + " songs=" + songFiles.length +
        " external_send=" + (typeof move_midi_external_send) + " shadow_send=" + (typeof shadow_send_midi_to_dsp));
    needsRedraw = true;
};

/* The battery, from Schwung's host_battery() -- the Move's controller reports
 * it about once per 1% of charge, and until it first does Schwung reads Move's
 * own log line. An overtake module owns the whole screen, so Move's own
 * battery display is never seen while the Arranger is up: an icon filled to
 * the level is drawn at the right of the header on the root, Perform and Jam
 * screens. At BATTERY_LOW_PCT it blinks, and a popup warns once -- re-armed
 * once it is back above it by a margin, so a reading wavering on the line
 * warns only once. Neither while it is charging. On the charger -- charging,
 * or full -- a lightning bolt shows to the left of the icon.
 * Older Schwung has no host_battery(): nothing is drawn. */
const BATTERY_POLL_MS = 2000;
const BATTERY_LOW_PCT = 10;
const BATTERY_REARM_PCT = 12;
const BATTERY_BLINK_MS = 500;
const BATTERY_ICON_W = 10;   /* a 9x5 body and a 1x3 terminal */
const BATTERY_BOLT_W = 4;    /* a 3x5 bolt and a 1-pixel gap */
let batteryLevel = null;     /* 0..100, null = unknown */
let batteryCharging = false;
let batteryOnPower = false;  /* charging, or full on the charger */
let batteryPolledAt = -Infinity;
let batteryLowWarned = false;
let batteryBlinkOff = false; /* the off half of the low-battery blink */

function batteryLow() {
    return batteryLevel !== null && batteryLevel <= BATTERY_LOW_PCT && !batteryCharging;
}

function pollBattery() {
    const now = Date.now();
    /* The blink: redraw on each half-period change while low. */
    const off = batteryLow() && Math.floor(now / BATTERY_BLINK_MS) % 2 === 1;
    if (off !== batteryBlinkOff) {
        batteryBlinkOff = off;
        needsRedraw = true;
    }
    if (now - batteryPolledAt < BATTERY_POLL_MS) return;
    batteryPolledAt = now;
    if (typeof host_battery !== "function") return;
    let b = null;
    try { b = host_battery(); } catch (e) { b = null; }
    const level = (b && typeof b.level === "number" && b.level >= 0 && b.level <= 100) ? Math.round(b.level) : null;
    const { charging, onPower } = batteryChargeState(b);
    if (level !== batteryLevel || charging !== batteryCharging || onPower !== batteryOnPower) {
        batteryLevel = level;
        batteryCharging = charging;
        batteryOnPower = onPower;
        needsRedraw = true;
    }
    if (level === null) return;
    if (level > BATTERY_LOW_PCT) {
        if (level >= BATTERY_REARM_PCT) batteryLowWarned = false;
        return;
    }
    /* An already-plugged-in Move needs no warning. */
    if (!batteryLowWarned && !charging) {
        batteryLowWarned = true;
        showPopup("Low battery", level + "% left. Plug in the Move.", 5000);
    }
}

/* host_battery()'s charge state: { charging, onPower }. From the controller's
 * report, the low nibble of its flags byte is Move's own chargingState --
 * 1 charging, 2 full on the charger (0x21 was captured while Move logged
 * "charging", 0x22 while it logged "fullyCharged"). From Move's log line,
 * `charging` as that line said. A Schwung that decodes it itself gives
 * `charging` / `plugged`, used as given. */
function batteryChargeState(b) {
    if (!b) return { charging: false, onPower: false };
    if (typeof b.charging === "boolean" || typeof b.plugged === "boolean") {
        const charging = b.charging === true;
        return { charging, onPower: charging || b.plugged === true };
    }
    if (b.source === "xmos" && typeof b.flags === "number") {
        const state = b.flags & 0x0F;
        return { charging: state === 1, onPower: state === 1 || state === 2 };
    }
    return { charging: false, onPower: false };
}

/* Pixels the battery takes: the icon, and the bolt while on the charger. */
function batteryBadgeWidth() {
    if (batteryLevel === null) return 0;
    return BATTERY_ICON_W + (batteryOnPower ? BATTERY_BOLT_W : 0);
}

/* The icon with its last pixel at column `right`, top row `y` (the header's
 * glyph rows); blank on the off half of the low-battery blink. */
function drawBatteryBadge(right, y) {
    if (batteryLevel === null || batteryBlinkOff) return;
    const x0 = right - BATTERY_ICON_W + 1;
    fill_rect(x0, y, 9, 1, 1);
    fill_rect(x0, y + 4, 9, 1, 1);
    fill_rect(x0, y, 1, 5, 1);
    fill_rect(x0 + 8, y, 1, 5, 1);
    fill_rect(x0 + 9, y + 1, 1, 3, 1);
    const fill = batteryLevel <= 0 ? 0 : Math.max(1, Math.round(batteryLevel * 7 / 100));
    if (fill) fill_rect(x0 + 1, y + 1, fill, 3, 1);
    if (batteryOnPower) {
        /* The bolt: ..X / .X. / XXX / .X. / X.. */
        const bx = x0 - BATTERY_BOLT_W;
        fill_rect(bx + 2, y, 1, 1, 1);
        fill_rect(bx + 1, y + 1, 1, 1, 1);
        fill_rect(bx, y + 2, 3, 1, 1);
        fill_rect(bx + 1, y + 3, 1, 1, 1);
        fill_rect(bx, y + 4, 1, 1, 1);
    }
}

/* A Menu Header's right text with room kept for the battery at the right
 * edge: blank space the header measures and draws nothing into, which
 * drawHeaderBattery then fills. The battery holds its place whatever the
 * text beside it says. */
function headerRightWithBattery(right) {
    if (batteryLevel === null) return right;
    const need = batteryBadgeWidth();
    let pad = "";
    while (fontWidth4x5(pad) < need) pad += " ";
    return right ? right + "  " + pad : pad;
}

/* After drawMenuHeader(title, headerRightWithBattery(...)): the header's
 * right text ends at column SCREEN_WIDTH - 3, glyphs from row 1. */
function drawHeaderBattery() {
    drawBatteryBadge(SCREEN_WIDTH - 3, 1);
}

/* ── Keys: the pads as a keyboard, in Perform and Jam ─────────────────
 *
 * Capture turns the pads into a keyboard on the Keys route (Options > Keys),
 * and back. Up/Down change octave while it is on; the song plays on, and the
 * steps and Track buttons keep their jobs. The ENGINE plays the notes:
 * Schwung hands it the pad notes on the audio thread (arr_on_midi), so a key
 * sounds with no round trip through here. This side only switches it,
 * feeds it the layout, key and octave, and lights the pads. Keys go off on
 * leaving Perform/Jam, so a pad in any other screen is never a note. */
export const KEYS_LAYOUTS = ["In Key 4ths", "In Key 3rds", "In Key Seq", "Chrom 4ths", "Chrom 3rds", "Chrom Seq"];
export const KEYS_SCALES = [
    { name: "Major", steps: [0, 2, 4, 5, 7, 9, 11] },
    { name: "Minor", steps: [0, 2, 3, 5, 7, 8, 10] },
    { name: "Dorian", steps: [0, 2, 3, 5, 7, 9, 10] },
    { name: "Mixolydian", steps: [0, 2, 4, 5, 7, 9, 10] },
    { name: "Maj Pent", steps: [0, 2, 4, 7, 9] },
    { name: "Min Pent", steps: [0, 3, 5, 7, 10] },
    { name: "Blues", steps: [0, 3, 5, 6, 7, 10] }
];
const KEYS_ROOT_COLOUR = AzureBlue;
const KEYS_SCALE_COLOUR = White;
let keysOn = false;
let keysOctave = 3;
let keysSentRoot = -1;
const keysPressed = new Set();

/* The note pad `pad` (0 = bottom left, row-major) plays, or -1: the engine's
 * keys_note, for the pad lights. In Key layouts step through the scale (a
 * row up is 3 scale steps -- a 4th in a seven-note scale -- or 2, or the
 * row carries on); Chromatic ones by semitone (a row up is 5, 4 or 8). */
export function keysPadNote(layout, scale, root, octave, pad) {
    if (pad < 0 || pad > 31) return -1;
    const row = Math.floor(pad / 8), col = pad % 8;
    const steps = (KEYS_SCALES[scale] || KEYS_SCALES[0]).steps;
    const base = (octave + 1) * 12 + ((root % 12) + 12) % 12;
    let note;
    if (layout >= 3) {
        note = base + col + row * (layout === 3 ? 5 : layout === 4 ? 4 : 8);
    } else {
        const d = col + row * (layout === 1 ? 2 : layout === 2 ? 8 : 3);
        note = base + 12 * Math.floor(d / steps.length) + steps[d % steps.length];
    }
    return note >= 0 && note <= 127 ? note : -1;
}

function keysViewActive() {
    return currentView === VIEW_PERFORMANCE || currentView === VIEW_JAM;
}

/* The key the pads are rooted on: the song's (a setlist's key change
 * included) in Perform, Jam's own key in Jam. */
function keysRootPc() {
    const name = currentView === VIEW_JAM ? jamKey : (currentSong && currentSong.key) || DEFAULT_KEY;
    const i = KEYS.indexOf(name);
    return i < 0 ? 0 : i;
}

function keysSet(key, val) {
    if (typeof host_module_set_param === "function") host_module_set_param("keys_" + key, String(val));
}

/* Hand the engine the route, layout, key and octave. */
function pushKeysToDsp() {
    keysSet("output", keysOutput);
    keysSet("channel", keysChannel);
    keysSet("layout", keysLayout);
    keysSet("scale", keysScale);
    keysSentRoot = keysRootPc();
    keysSet("root", keysSentRoot);
    keysSet("octave", keysOctave);
}

function keysNoteName(note) {
    return note < 0 ? "-" : NOTE_NAMES[note % 12] + (Math.floor(note / 12) - 1);
}

/* Capture: Keys on or off. */
function setKeys(on, quiet) {
    if (on === keysOn) return;
    keysOn = on;
    keysPressed.clear();
    if (on) {
        keysOctave = keysStartOctave;
        pushKeysToDsp();
    }
    keysSet("on", on ? 1 : 0);
    ledDirtyAll = true;
    needsRedraw = true;
    if (!quiet) {
        showPopup("Keys", on ? keysNoteName(keysPadNote(keysLayout, keysScale, keysSentRoot, keysOctave, 0)) + "  " +
            KEYS_LAYOUTS[keysLayout] : "Off", 1500);
    }
}

/* Up/Down while Keys are on. */
function shiftKeysOctave(delta) {
    const next = Math.max(-1, Math.min(8, keysOctave + delta));
    if (next === keysOctave) return;
    keysOctave = next;
    keysSet("octave", keysOctave);
    ledDirtyAll = true;
    showPopup("Keys", "Octave " + keysOctave + "  (" + keysNoteName(keysPadNote(keysLayout, keysScale, keysSentRoot, keysOctave, 0)) + ")", 1200);
}

/* Once a tick: Keys follow the key (a new song in Perform), and end with
 * the screen. */
function tickKeys() {
    if (!keysOn) return;
    if (!keysViewActive()) { setKeys(false, true); return; }
    const root = keysRootPc();
    if (root !== keysSentRoot) {
        keysSentRoot = root;
        keysSet("root", root);
        ledDirtyAll = true;
    }
}

/* Is `note` held on any pad? The 4ths and 3rds layouts repeat a note a row
 * up and a few pads left, so one held key lights all its pads. */
function keysNoteHeld(note) {
    if (note < 0) return false;
    for (const q of keysPressed) {
        if (keysPadNote(keysLayout, keysScale, keysSentRoot, keysOctave, q) === note) return true;
    }
    return false;
}

/* The pads as a keyboard: the key's root in blue, other scale notes white,
 * notes outside the scale (Chromatic layouts) dark; a held note green, on
 * every pad that plays it. */
function keysPadColour(p) {
    const note = keysPadNote(keysLayout, keysScale, keysSentRoot, keysOctave, p);
    if (keysPressed.has(p) || keysNoteHeld(note)) return PureGreen;
    if (note < 0) return Black;
    const rel = ((note - keysSentRoot) % 12 + 12) % 12;
    if (rel === 0) return KEYS_ROOT_COLOUR;
    return (KEYS_SCALES[keysScale] || KEYS_SCALES[0]).steps.includes(rel) ? KEYS_SCALE_COLOUR : Black;
}

function drawKeysLEDs() {
    for (let p = 0; p < NUM_PADS; p++) padColor(p, keysPadColour(p), true);
    flushPadGridImmediate();
}

/* A pad pressed or released while Keys are on: its light, and those of the
 * other pads playing the same note, only -- the engine has already played
 * it. */
function keysPadPress(padIndex, velocity) {
    if (padIndex < 0) return;
    if (velocity > 0) keysPressed.add(padIndex); else keysPressed.delete(padIndex);
    const note = keysPadNote(keysLayout, keysScale, keysSentRoot, keysOctave, padIndex);
    for (let p = 0; p < NUM_PADS; p++) {
        if (p === padIndex || (note >= 0 && keysPadNote(keysLayout, keysScale, keysSentRoot, keysOctave, p) === note)) {
            padColor(p, keysPadColour(p), true);
        }
    }
}

/* Arranger's own popups (record, click, mutes, exit confirm, backups,
 * missing clip): the shared multi-line card -- a title band plus the message
 * wrapped onto up to three lines -- drawn after every redraw and timed by the
 * clock, not by a tick countdown. The shared overlay was one band (a long
 * value was cut off) and still vanished after about a second on the device
 * even with tick counts scaled to a measured tick rate. */
const POPUP_MAX_LINES = 3;
let popupTitle = "";
let popupLines = [];
let popupUntil = 0;

function popupTextWidth(t) {
    return (typeof text_width === "function") ? text_width(String(t)) : String(t).length * 6;
}

/* Word-wrap `text` to `px` pixels; a word wider than a line is broken. */
function wrapPopupText(text, px) {
    const lines = [];
    let cur = "";
    for (const word of String(text).split(/\s+/).filter(w => w)) {
        let w = word;
        while (popupTextWidth(w) > px) {
            let n = w.length - 1;
            while (n > 1 && popupTextWidth(w.substring(0, n)) > px) n--;
            if (cur) { lines.push(cur); cur = ""; }
            lines.push(w.substring(0, n));
            w = w.substring(n);
        }
        const next = cur ? cur + " " + w : w;
        if (popupTextWidth(next) <= px) {
            cur = next;
        } else {
            lines.push(cur);
            cur = w;
        }
    }
    if (cur) lines.push(cur);
    return lines;
}

/* `text` is a string or an array of lines, each wrapped. `ms` Infinity keeps
 * it up until hideHoldPopup (a pad being held). */
function showPopup(title, text, ms) {
    popupTitle = String(title || "");
    const parts = Array.isArray(text) ? text : [text || ""];
    popupLines = [].concat(...parts.map(t => wrapPopupText(t, contentW()))).slice(0, POPUP_MAX_LINES);
    popupUntil = Date.now() + ms;
    needsRedraw = true;
}

/* End a popup shown while a pad is held, leaving a timed one alone. */
function hideHoldPopup() {
    if (popupUntil === Infinity) hidePopup();
}

function barsLabel(bars) {
    return bars + " bar" + (bars === 1 ? "" : "s");
}

function hidePopup() {
    if (!popupUntil) return;
    popupUntil = 0;
    needsRedraw = true;
}

function popupActive() {
    return popupUntil > 0 && Date.now() < popupUntil;
}

/* Called every tick: clear an expired popup off the screen. */
function tickPopup() {
    if (popupUntil && Date.now() >= popupUntil) {
        popupUntil = 0;
        needsRedraw = true;
    }
}

/* Button-hint footer: up to three [button, action] pairs for the screen's
 * most important controls, drawn with Schwung's chain-editor footer
 * (drawFooter: the button in a pill, BACK pinned right) in rows 56-63, below
 * where every list and display stops. Shift swaps in the Shift actions. Each
 * set is checked to fit the 128px bar -- drawFooter silently drops a pair
 * that doesn't. */
const footerCtx = {
    fillRect: (x, y, w, h, c) => fill_rect(x, y, w, h, c),
    print: (x, y, t, c) => print(x, y, t, c),
    textWidth: (t) => (typeof text_width === "function") ? text_width(String(t)) : String(t).length * 6
};

const HINTS_LIST = [["JOG", "SEL"], ["CLK", "OPEN"], ["BACK", "OUT"]];

/* Browse/edit menus: what the jog and click do depends on the mode. */
function editMenuHints(editing) {
    return editing
        ? [["JOG", "ADJ"], ["CLK", "DONE"], ["BACK", "OUT"]]
        : [["JOG", "SEL"], ["CLK", "EDIT"], ["BACK", "OUT"]];
}

export function footerHints() {
    /* A confirm box: the click takes the highlighted choice, Back cancels. */
    if (confirmState) return [["JOG", "SEL"], ["CLK", "PICK"], ["BACK", "OUT"]];
    switch (currentView) {
        case VIEW_ROOT:
            return [["JOG", "SEL"], ["CLK", "OPEN"], ["BACK", "EXIT"]];
        case VIEW_SONG_BANK:
        case VIEW_SETLIST_BANK: {
            /* Row 0 is "+ New Song" / "+ New Setlist": the click creates one,
             * and there is nothing there for Shift to rename. */
            const onNew = (currentView === VIEW_SONG_BANK ? selectedSongIndex : selectedSetlistIndex) === 0;
            if (onNew) return [["JOG", "SEL"], ["CLK", "NEW"], ["BACK", "OUT"]];
            return shiftHeld ? [["JOG", "SEL"], ["CLK", "NAME"], ["BACK", "OUT"]] : HINTS_LIST;
        }
        case VIEW_SONG_BACKUPS:
            return [["JOG", "SEL"], ["CLK", "LOAD"], ["BACK", "OUT"]];
        case VIEW_FOLDER_LIST: case VIEW_SETLIST_EDIT: case VIEW_SETLIST_PICK:
        case VIEW_SECTION_PICK: case VIEW_PERF_SETLIST: case VIEW_JAM_FOLDER:
        case VIEW_KNOB_PICK:
            return HINTS_LIST;
        case VIEW_KNOB_MAP:
            /* Sample switches the bank being edited. With Back (pinned right)
             * no three pairs naming it fit the 128px band, so Back -- lit, and
             * the same on every screen -- gives way. */
            return shiftHeld ? [["JOG", "MOVE"], ["BACK", "OUT"]] : [["CLK", "OPEN"], ["SMPL", "BANK"]];
        case VIEW_OPTIONS: return editMenuHints(optionsEditing);
        case VIEW_OPTIONS_DRUMS: case VIEW_OPTIONS_INST: case VIEW_OPTIONS_KEYS: case VIEW_OPTIONS_CLICK:
        case VIEW_OPTIONS_CHAINS:
            return editMenuHints(optionsSubEditing);
        case VIEW_SONG_SETTINGS:
            /* A locked song's settings are read-only: only Lock Song clicks. */
            if (songIsLocked()) return songSettingsFocus === 4 ? [["JOG", "SEL"], ["CLK", "UNLOCK"], ["BACK", "OUT"]] : [["JOG", "SEL"], ["BACK", "OUT"]];
            return editMenuHints(songSettingsEditing);
        case VIEW_TRIM: return editMenuHints(trimEditing);
        case VIEW_INSTRUMENT: return editMenuHints(instrumentEditing);
        case VIEW_INSTRUMENT_BAR: return editMenuHints(itemEditing);
        case VIEW_CHORD_PICK: return editMenuHints(chordPickEditing);
        case VIEW_SETLIST_CLICK:
            /* Sections and Knobs open a screen rather than edit in place. */
            if (!clickSettingsEditing && SETLIST_SONG_ROWS[clickSettingsFocus] &&
                SETLIST_SONG_ROWS[clickSettingsFocus].opens) return HINTS_LIST;
            return editMenuHints(clickSettingsEditing);
        case VIEW_SETLIST_SECTIONS: {
            const row = setlistSectionRows()[setlistSecCursor];
            if (!row || row.type !== "section") return HINTS_LIST;
            if (shiftHeld) return [["JOG", "MOVE"], ["BACK", "OUT"]];
            return [["COPY", "REPEAT"], ["DEL", "REMOVE"]];
        }
        case VIEW_SETLIST_SECTION_PICK: return [["JOG", "SEL"], ["CLK", "ADD"], ["BACK", "OUT"]];
        case VIEW_COPY_TRACK_PICK:
            return copyPickCursor === 0 ? [["JOG", "SEL"], ["CLK", "COPY"], ["BACK", "OUT"]]
                : [["JOG", "SEL"], ["CLK", "TICK"], ["BACK", "OUT"]];
        case VIEW_JAM_INSTRUMENT: return editMenuHints(jamInstrumentEditing);
        /* Where a screen has pad and track actions, those lead: Play, Record
         * and Back are self-explanatory (and lit), so they give way. In Song
         * Builder, T1 (Track 1) names the track it switches to -- Chord from
         * the Drum track, Drum from any other. Shift shows the less obvious
         * Shift actions. */
        case VIEW_BUILDER: return builderFooterHints();
        case VIEW_PERFORMANCE:
            /* The knob feedback panel covers the footer rows while it shows. */
            if (perfKnobFeedbackVisible()) return null;
            return [["PAD", perfPlaying ? "CUE" : "PICK"], ["TRK", "MUTE"], ["BACK", "OUT"]];
        case VIEW_JAM:
            if (shiftHeld) return [["JOG", "KEY"], ["TRK", "INST"]];
            return [["PAD", jamPlaying ? "CUE" : "PLAY"], ["TRK", "MUTE"], ["BACK", "OUT"]];
        default:
            return null;
    }
}

/* What the jog click does on the selected Song Builder row, for the footer
 * -- null where it does nothing (a locked song, the Drum track's empty-
 * section row, "+ Add" with no chords to add to). */
function builderClickAction() {
    if (songIsLocked()) return null;
    if (builderTrack === TRACK_DRUM) {
        const sec = currentSong ? currentSong.sections[builderDisplaySectionIndex()] : null;
        if (!sec) return null;
        if (builderCursor < 0) return "NAME";
        const clip = sec.clips[builderCursor];
        return clip && !clip.placeholder ? "TRIM" : null;
    }
    const sec = currentSong ? currentSong.sections[chordDisplaySectionIndex()] : null;
    if (!sec) return null;
    if (builderTrack === TRACK_CHORD) {
        if (chordListCursor < 0) return "NAME";
        return chordListCursor < sectionChordEvents(sec).length ? "EDIT" : "ADD";
    }
    if (itemListCursor < 0) return "NAME";
    if (itemListCursor < sectionItems(sec, builderTrack).length) return "EDIT";
    return itemAddAvailable() ? "ADD" : null;
}

/* Song Builder's footer: only actions that work on the selected row. Where
 * the click does nothing (see builderClickAction), Menu -- the settings, and
 * a locked song's way to unlock -- takes its place. T1 names the track it
 * switches to; on the Inst and Click tracks their own Track button turns
 * the track on or off. */
function builderFooterHints() {
    const locked = songIsLocked();
    const clk = builderClickAction();
    const first = clk ? ["CLK", clk] : ["MENU", "SET"];
    if (builderTrack === TRACK_DRUM) {
        if (shiftHeld) return [["CLK", "SET"], ["PLAY", "SONG"], ["BACK", "OUT"]];
        if (locked) return [["T1", "CHORD"], first, ["BACK", "OUT"]];
        /* A pad fills a selected placeholder rather than adding after it. */
        const dsec = currentSong ? currentSong.sections[builderDisplaySectionIndex()] : null;
        const onPh = dsec && dsec.clips[builderCursor] && dsec.clips[builderCursor].placeholder;
        return [["PAD", onPh ? "FILL" : "ADD"], ["T1", "CHORD"], first];
    }
    if (shiftHeld) {
        /* Shift + jog moves the selected chord or item. */
        const sec = currentSong ? currentSong.sections[chordDisplaySectionIndex()] : null;
        const n = !sec ? 0 : (builderTrack === TRACK_CHORD ? sectionChordEvents(sec).length
                                                           : sectionItems(sec, builderTrack).length);
        const cursor = builderTrack === TRACK_CHORD ? chordListCursor : itemListCursor;
        return !locked && cursor >= 0 && cursor < n ? [["JOG", "MOVE"], ["PLAY", "SONG"]] : [["PLAY", "SONG"], ["BACK", "OUT"]];
    }
    const setOrOut = clk ? ["MENU", "SET"] : ["BACK", "OUT"];
    if (builderTrack === TRACK_CLICK) return [first, ["T4", "PADS"], setOrOut];
    /* The Chord, Inst and Pads tracks lead with the pads, as the Drum track
     * does: a pad plays and picks; with one picked, a step adds it. */
    const picked = builderTrack === TRACK_CHORD ? harmonySelectedChord() : harmonySelectedVariation(builderTrack);
    const pad = picked && !locked ? ["STEP", "ADD"] : ["PAD", "PICK"];
    if (builderTrack === TRACK_PADS) return [pad, ["T4", "CLICK"], first];
    return [pad, ["T1", "DRUM"], first];
}

function drawFooterHints() {
    const hints = footerHints();
    if (hints) drawFooter(footerCtx, hints);
}

function drawPopup() {
    if (!popupActive()) return;
    drawOverlayCard(null, { title: popupTitle, lines: popupLines });
}

globalThis.tick = function() {
    pollBattery();
    tickKeys();
    tickHarmonyPreview();
    flushInstrumentLive();
    tickPopup();
    {
        const nowMs = Date.now();
        if (nowMs - lastScrollBeatMs >= MENU_SCROLL_TICK_MS) {
            lastScrollBeatMs = nowMs;
            scrollBeat++;
        }
    }
    /* Chain view first: follow the co-run session's real state, then let any
     * held Track/Menu fire -- in that order, so an overlay requested by a hold
     * is opened on the NEXT tick, after shadow_ui has primed the session (see
     * openMasterFxView). */
    reconcileChainView();
    tickLongPressHolds();

    /* Promote a held Back to a suspend once it's been down BACK_SUSPEND_HOLD_MS
     * -- see backHoldActive's declaration. Checked unconditionally, ahead of
     * every view-specific tick work below, so it fires regardless of what the
     * module is currently doing. */
    if (backHoldActive && !backHoldSuspendFired && Date.now() - backHoldStartTime >= BACK_SUSPEND_HOLD_MS) {
        backHoldSuspendFired = true;
        if (typeof host_suspend_overtake === "function") {
            host_suspend_overtake();
        }
    }

    /* Diagnostic for the LED-queue backlog report: sample ledQueue.size
     * every ~2s (any view, any activity -- the backlog was already large at
     * the START of a preview session, so it isn't obviously jam-specific)
     * and log the growth since the last sample, so the actual growth rate
     * and which view/state it correlates with can be read back from the log
     * instead of guessed from a static read of the ~48 ledDirtyAll call
     * sites. */
    {
        const nowLQ = Date.now();
        if (nowLQ - lastLedQueueSampleTick >= 2000) {
            const growth = lastLedQueueSampleLen < 0 ? 0 : (ledQueue.size - lastLedQueueSampleLen);
            logDebug("LEDQ len=" + ledQueue.size + " growth=" + growth + " view=" + currentView +
                " jamPlaying=" + (typeof jamPlaying !== "undefined" ? jamPlaying : "?") +
                " ledDirtyAll=" + ledDirtyAll + " needsRedraw=" + needsRedraw +
                " byUpdateLEDs=" + ledQueuePushByUpdateLEDs + " byStepRefresh=" + ledQueuePushByStepRefresh +
                " byButtonLEDs=" + ledQueuePushByButtonLEDs);
            /* Schwung's transport as chain modules see it (see host_clock in
             * arranger_engine.c): for tempo-synced effects that sound wrong. */
            if (typeof host_module_get_param === "function") {
                const hc = host_module_get_param("host_clock");
                if (hc) logDebug("HOSTCLOCK " + hc);
            }
            lastLedQueueSampleTick = nowLQ;
            lastLedQueueSampleLen = ledQueue.size;
            ledQueuePushByUpdateLEDs = 0;
            ledQueuePushByStepRefresh = 0;
            ledQueuePushByButtonLEDs = 0;
        }
    }

    /* Drain any pending MIDI output as early as possible in the callback so
     * events are not delayed by display/LED work. When the DSP is emitting
     * directly this acks the queue; otherwise the JS sends the events here. */
    drainOutputEvents();

    /* Always update DSP transport so every LED/draw call below uses the most
     * recent sample-accurate position. */
    /* ...and wherever Play works (Song Builder's settings pages) or a build
     * is waiting to be confirmed: Play from Instrument Settings sent the song
     * and then never started it -- the confirmation that starts playback is
     * read here, and it was never read from those pages. */
    if (currentView === VIEW_PERFORMANCE || currentView === VIEW_BUILDER || currentView === VIEW_JAM ||
        playbackState === "playing" || SONG_BUILDER_SUBVIEWS.has(currentView) ||
        pendingPrimaryConfirm || pendingStagingConfirm) {
        updateDspState();
    }

    /* Drive setlist auto-advance and queued jumps while in a performance. */
    if (currentView === VIEW_PERFORMANCE && perfPlaying) {
        perfTick();
    }

    /* Drive Jam queue/boundary detection while in Jam mode. */
    if (currentView === VIEW_JAM && jamPlaying) {
        jamTick();
    }

    /* If a pad has been held long enough, start the audible preview. */
    if (padPreviewClip && !padPreviewScheduled) {
        const elapsed = Date.now() - padPreviewTriggerTime;
        if (elapsed >= PAD_PREVIEW_DELAY_MS) {
            padPreviewScheduled = true;
            previewingClip = padPreviewClip;
            previewStartTime = Date.now();
            const bars = padPreviewBars;
            logDebug("preview trigger clip=" + previewingClip.name + " bars=" + bars + " elapsed=" + elapsed);
            showPopup(barsLabel(bars), clipShortName(previewingClip), Infinity);
            previewClip(previewingClip);
            stepLedsDirty = true;
        }
    }

    /* Jam preview: if playback is stopped and a jam pad is held past the
     * delay, play the held clip as a one-shot until release. */
    if (currentView === VIEW_JAM && !jamPlaying && jamPreviewClip && !jamPreviewScheduled) {
        const elapsed = Date.now() - jamPreviewTriggerTime;
        if (elapsed >= PAD_PREVIEW_DELAY_MS) {
            jamPreviewScheduled = true;
            jamPreviewStartTime = Date.now();
            jamPreviewObservedRunning = false;
            const clip = jamPreviewClip;
            const bars = clip.bars || 1;
            logJam("PREVIEW start one-shot -> " + (clip.name || clip.path) + " bars=" + bars);
            /* Play the clip as a one-shot (non-looping) from the start, using
             * the same single-clip path Jam uses. No return groove is staged:
             * the preview is a temporary audition that ends on release.
             * forceNonLoop=true tells jamPlayClip to set loop=0 itself, in
             * its own DSP-confirmed callback, instead of this call site
             * issuing a separate immediate "loop" write -- that write used to
             * be safe because jamPlayClip's internal reassert (loop=1 by
             * default) ran synchronously before it, so this one always had
             * the last word. Now that jamPlayClip's reassert is deferred
             * until the build is confirmed, an immediate write here would run
             * BEFORE it and get overwritten back to loop=1 once confirmation
             * lands -- exactly the bug class this rearchitecture exists to
             * eliminate, just found in the preview path instead of Jam's
             * main swap path. */
            jamPlayClip(clip, true);
        }
    }

    /* Jam hold-overlay: if playback is running and a jam pad is held past the
     * delay, show the clip name in the overlay without queueing it. */
    if (currentView === VIEW_JAM && jamPlaying && jamHoldClip && !jamHoldOverlayShown) {
        const elapsed = Date.now() - jamHoldTriggerTime;
        if (elapsed >= PAD_PREVIEW_DELAY_MS) {
            jamHoldOverlayShown = true;
            const clip = jamHoldClip;
            showPopup(barsLabel(clipPlayBars(clip)), clipShortName(clip), Infinity);
            logJam("HOLD overlay -> " + (clip.name || clip.path));
        }
    }

    /* Jam chord pad hold: show the chord's name once held past the delay. */
    if (currentView === VIEW_JAM && jamChordHoldDegree >= 0 && !jamChordHoldShown &&
        Date.now() - jamChordHoldTime >= PAD_PREVIEW_DELAY_MS) {
        const degree = jamChordHoldDegree;
        const chord = jamChordForDegree(degree);
        const roman = ["I", "ii", "iii", "IV", "V", "vi", "vii", "I"][degree];
        jamChordHoldShown = true;
        jamHoldOverlayShown = true;
        const chordName = chord.root + " " + (CHORD_TYPE_LABEL[chord.quality] || chord.quality) +
            (degree === 7 ? " +8ve" : "");
        showPopup("Chord", [chordName, roman + " in key " + jamKey], Infinity);
        logJam("CHORD-HOLD overlay -> " + chordName);
    }

    /* What is still loading -- see scanState. */
    if (screenWaitsOnScan()) pollScanState();
    /* The "Loading..." dots animate. */
    if (listLoading("songs") || listLoading("folders")) {
        const phase = Math.floor(Date.now() / 400);
        if (phase !== lastLoadingPhase) { lastLoadingPhase = phase; needsRedraw = true; }
    }

    /* Retry loading the builder's clip pads if they weren't ready yet (e.g.
     * a song opened on a fresh boot before the DSP folder scan finished).
     * Ensure libraryFolders is populated, re-resolve the folder by name, then
     * load the clips; once they arrive, force a pad repaint. */
    /* All three wait for a folder scan in progress to finish (pollScanState
     * reloads the folders the moment it does) rather than re-reading lists
     * the engine has not published yet, every tick. */
    if (pendingFolderClipLoadName && !listLoading("folders")) {
        if (libraryFolders.length === 0) {
            loadLibraryFolders();
        }
        const fi = folderIndexForPath(pendingFolderClipLoadName);
        if (fi >= 0) {
            loadFolderClips(fi);
            if (folderClips.length > 0) {
                pendingFolderClipLoadName = null;
                ledDirtyAll = true;
                stepLedsDirty = true;
                needsRedraw = true;
            }
        }
    }

    /* Retry loading the Jam folder's clips if they weren't ready yet (e.g. a
     * Jam folder entered on a fresh boot before the DSP folder scan finished).
     * Re-load the clips each tick until they arrive, then repaint the pads. */
    if (pendingJamFolderClipLoadIndex >= 0 && !listLoading("folders")) {
        if (libraryFolders.length === 0) {
            loadLibraryFolders();
        }
        jamLoadFolder(pendingJamFolderClipLoadIndex);
        if (jamGrooves.length > 0 || jamFills.length > 0) {
            pendingJamFolderClipLoadIndex = -1;
            ledDirtyAll = true;
            stepLedsDirty = true;
            needsRedraw = true;
        }
    }

    /* Retry loading the top-level library folder list if the DSP scan hadn't
     * caught up when loadLibraryFolders() first ran (folder_count was 0).
     * Re-poll each tick until the folders arrive, then repaint so the Folder
     * List / Jam Folder picker isn't left empty. */
    if (pendingLibraryFoldersReload && libraryFolders.length === 0 && !listLoading("folders")) {
        loadLibraryFolders();
        if (libraryFolders.length > 0) {
            pendingLibraryFoldersReload = false;
            ledDirtyAll = true;
            needsRedraw = true;
        }
    }

    /* Reload the folder/song lists once the rescan requested on resume has
     * landed (see onResume). */
    if (libraryRescanPending) {
        pollLibraryRescan();
    }

    /* Pick up settings changed in Schwung Manager (see pollModuleConfig). */
    pollModuleConfig();

    /* Retry loading the Song Bank list after a duplicate/delete until the
     * DSP's worker thread finishes rescanning (see requestSongBankSync). */
    if (pendingSongBankSync) {
        const idx = songFiles.findIndex(f => f.path === pendingSongBankSync.path);
        const found = idx >= 0;
        if (pendingSongBankSync.shouldExist ? found : !found) {
            if (found && pendingSongBankSync.selectOnArrive) {
                selectedSongIndex = idx + 1;
            }
            pendingSongBankSync = null;
            needsRedraw = true;
        } else {
            reloadSongBankAndPreserveSelection();
            needsRedraw = true;
        }
    }

    /* Text entry takes over the whole screen and the pads. Skip the arranger's
     * own LED drawing while it's active so the keyboard pad LEDs (Pad Typing)
     * aren't clobbered by the builder/performance pad repaint. Force a full
     * pad repaint for when text entry closes, so the clip pads are restored
     * instead of leaving the default Move pad LEDs. */
    if (isTextEntryActive()) {
        tickTextEntry();
        drawTextEntry();
        /* Turn off the previous screen's button hints while typing. */
        for (const cc of ALL_BUTTON_CCS) {
            setButtonHint(cc, Black);
        }
        ledDirtyAll = true;
        wasTextEntryActive = true;
        flushLedQueue();
        needsRedraw = false;
        return;
    }

    /* Text entry just closed (OK or Back): force a full screen and pad redraw
     * so the underlying view and clip pads are restored. */
    if (wasTextEntryActive) {
        wasTextEntryActive = false;
        ledDirtyAll = true;
        stepLedsDirty = true;
        needsRedraw = true;
    }

    /* Periodically redraw scrollable menu views so the shared marquee scroller
     * animates long Song / Setlist / clip names that overflow the row width.
     * Also redraw while a confirm modal is up so its quoted name can scroll. */
    if (SCROLLABLE_MENU_VIEWS.has(currentView)) {
        const now = Date.now();
        if (now - lastMenuScrollTick >= MENU_SCROLL_TICK_MS) {
            lastMenuScrollTick = now;
            needsRedraw = true;
        }
    }

    if (chainViewRepaintTicks > 0) {
        chainViewRepaintTicks--;
        needsRedraw = true;
    }
    /* Knob values: send queued writes, save the setlist once turning stops,
     * and take the feedback down when it expires. */
    flushKnobWrites();
    flushPresetNameReads();
    pollPerfKnobs(Date.now());
    flushKnobSave(Date.now());
    if (knobShowIndex >= 0 && Date.now() >= knobShowUntil && !knobTouched[knobShowIndex]) {
        knobShowIndex = -1;
        knobShowSlot = -1;
        needsRedraw = true;
    }

    if (needsRedraw) {
        const lq0 = ledQueueWrites;
        updateLEDs();
        ledQueuePushByUpdateLEDs += Math.max(0, ledQueueWrites - lq0);
    }
    /* Clear the pad-preview-stop suppression flag once the section steps have
     * been repainted, so it doesn't leak into later redraws. */
    if (padPreviewStopping) {
        padPreviewStopping = false;
    }
    if (tickOverlay()) {
        needsRedraw = true;
    }

    /* While a chain view is up the screen is the editor's: shadow_ui draws it
     * after this tick. Arranger keeps its LEDs (above) but draws nothing. */
    if (needsRedraw && chainViewActive()) {
        needsRedraw = false;
    }

    if (needsRedraw) {
        clear_screen();
        if (confirmState) {
            drawConfirm();
        } else {
            switch (currentView) {
                case VIEW_ROOT: drawRoot(); break;
                case VIEW_FOLDER_LIST: drawFolderList(); break;
                case VIEW_BUILDER: drawBuilder(); break;
                case VIEW_TRIM: drawTrim(); break;
                case VIEW_SONG_SETTINGS: drawSongSettings(); break;
                case VIEW_SONG_BACKUPS: drawSongBackups(); break;
                case VIEW_SONG_BANK: drawSongBank(); break;
                case VIEW_OPTIONS: drawOptions(); break;
                case VIEW_OPTIONS_DRUMS: drawOptionsDrums(); break;
                case VIEW_OPTIONS_INST: drawOptionsInst(); break;
                case VIEW_OPTIONS_KEYS: drawOptionsKeys(); break;
                case VIEW_OPTIONS_CLICK: drawOptionsClick(); break;
                case VIEW_OPTIONS_CHAINS: drawOptionsChains(); break;
                case VIEW_KNOB_MAP: drawKnobMap(); break;
                case VIEW_KNOB_PICK: drawKnobPick(); break;
                case VIEW_SETLIST_BANK: drawSetlistBank(); break;
                case VIEW_SETLIST_EDIT: drawSetlistEdit(); break;
                case VIEW_SETLIST_PICK: drawSetlistPick(); break;
                case VIEW_SETLIST_CLICK: drawSetlistClick(); break;
                case VIEW_SETLIST_SECTIONS: drawSetlistSections(); break;
                case VIEW_SETLIST_SECTION_PICK: drawSetlistSectionPick(); break;
                case VIEW_COPY_TRACK_PICK: drawCopyTrackPick(); break;
                case VIEW_SECTION_PICK: drawSectionPick(); break;
                case VIEW_PERF_SETLIST: drawPerfSetlist(); break;
                case VIEW_PERFORMANCE: drawPerformance(); break;
                case VIEW_JAM_FOLDER: drawJamFolder(); break;
                case VIEW_JAM: drawJam(); break;
                case VIEW_CHORD_PICK: drawChordPick(); break;
                case VIEW_INSTRUMENT: drawInstrument(); break;
                case VIEW_INSTRUMENT_BAR: drawInstrumentBarMenu(); break;
                case VIEW_JAM_INSTRUMENT: drawJamInstrumentMenu(); break;
            }
        }
        drawFooterHints();
        drawPopup();
        needsRedraw = false;
    }

    /* Refresh builder/performance step LEDs every tick so the current-bar
     * flash stays in time even when no other redraw is triggered. The
     * chord-pick submenu keeps showing the chord track's bar LEDs underneath
     * it. In performance view, click bars are only shown when no section is
     * selected while stopped, or during an active count-in. */
    {
        const lq1 = ledQueueWrites;
        if (currentView === VIEW_BUILDER || currentView === VIEW_PERFORMANCE || currentView === VIEW_CHORD_PICK) {
            if (currentView === VIEW_PERFORMANCE && perfClickBars > 0 &&
                (perfClickPlaying || (!perfPlaying && perfSelectedSection < 0))) {
                drawClickStepLEDs();
            } else if ((currentView === VIEW_BUILDER || currentView === VIEW_CHORD_PICK) && builderTrack !== TRACK_DRUM) {
                drawChordStepLEDs(false);
            } else {
                drawBuilderStepLEDs(false);
            }
        } else if (currentView === VIEW_JAM) {
            drawJamStepLEDs(false);
        }
        ledQueuePushByStepRefresh += Math.max(0, ledQueueWrites - lq1);
    }
    /* Beat flash is shown on the STEP LEDs only (drawBuilderStepLEDs /
     * drawClickStepLEDs above). The performance pads must NOT flash on the
     * beat: updatePerformancePadFlash used to toggle the active pad
     * white/green every beat, which overwrote the queued-repeat red on the
     * current section's last bar. Pads are drawn statically by
     * drawPerformanceLEDs (queued = white, last-bar imminent = red). */
    {
        const lq2 = ledQueueWrites;
        updateButtonLEDs();
        ledQueuePushByButtonLEDs += Math.max(0, ledQueueWrites - lq2);
    }
    flushLedQueue();
};

/* The CC routing every non-Back CC has always gone through immediately, on
 * press. Extracted so the Back long-press-to-suspend interception below can
 * call it too -- for a plain tap, on release, instead of on press -- without
 * duplicating it. `rawData` is only needed to reconstruct the array
 * handleTextEntryMidi expects. */
function routeCcInput(rawData, cc, value) {
    if (isTextEntryActive()) {
        /* While editing a name, all input goes to the keyboard. The
         * previous screen's buttons (loop/delete/etc.) are ignored. */
        handleTextEntryMidi(rawData);
        needsRedraw = true;
        return;
    }
    if (confirmState) {
        handleConfirmInput(cc, value);
        return;
    }
    if (cc === MovePlay && value > 0 && currentSong && SONG_BUILDER_SUBVIEWS.has(currentView)) {
        /* Play anywhere in Song Builder, its settings pages included. */
        if (playbackState !== "playing") applyOpenEditForPlay();
        builderPlayPress();
        needsRedraw = true;
        return;
    }
    switch (currentView) {
        case VIEW_ROOT: handleRootInput(cc, value); break;
        case VIEW_FOLDER_LIST: handleFolderListInput(cc, value); break;
        case VIEW_BUILDER: handleBuilderInput(cc, value); break;
        case VIEW_TRIM: handleTrimInput(cc, value); break;
        case VIEW_SONG_SETTINGS: handleSongSettingsInput(cc, value); break;
        case VIEW_SONG_BACKUPS: handleSongBackupsInput(cc, value); break;
        case VIEW_SONG_BANK: handleSongBankInput(cc, value); break;
        case VIEW_OPTIONS: handleOptionsInput(cc, value); break;
        case VIEW_OPTIONS_DRUMS: handleOptionsDrumsInput(cc, value); break;
        case VIEW_OPTIONS_INST: handleOptionsInstInput(cc, value); break;
        case VIEW_OPTIONS_KEYS: handleOptionsKeysInput(cc, value); break;
        case VIEW_OPTIONS_CLICK: handleOptionsClickInput(cc, value); break;
        case VIEW_OPTIONS_CHAINS: handleOptionsChainsInput(cc, value); break;
        case VIEW_KNOB_MAP: handleKnobMapInput(cc, value); break;
        case VIEW_KNOB_PICK: handleKnobPickInput(cc, value); break;
        case VIEW_SETLIST_BANK: handleSetlistBankInput(cc, value); break;
        case VIEW_SETLIST_EDIT: handleSetlistEditInput(cc, value); break;
        case VIEW_SETLIST_PICK: handleSetlistPickInput(cc, value); break;
        case VIEW_SETLIST_CLICK: handleSetlistClickInput(cc, value); break;
        case VIEW_SETLIST_SECTIONS: handleSetlistSectionsInput(cc, value); break;
        case VIEW_SETLIST_SECTION_PICK: handleSetlistSectionPickInput(cc, value); break;
        case VIEW_COPY_TRACK_PICK: handleCopyTrackPickInput(cc, value); break;
        case VIEW_SECTION_PICK: handleSectionPickInput(cc, value); break;
        case VIEW_PERF_SETLIST: handlePerfSetlistInput(cc, value); break;
        case VIEW_PERFORMANCE: handlePerformanceInput(cc, value); break;
        case VIEW_JAM_FOLDER: handleJamFolderInput(cc, value); break;
        case VIEW_JAM: handleJamInput(cc, value); break;
        case VIEW_CHORD_PICK: handleChordPickInput(cc, value); break;
        case VIEW_INSTRUMENT: handleInstrumentInput(cc, value); break;
        case VIEW_INSTRUMENT_BAR: handleInstrumentBarMenuInput(cc, value); break;
        case VIEW_JAM_INSTRUMENT: handleJamInstrumentMenuInput(cc, value); break;
    }
}

globalThis.onMidiMessageInternal = function(data) {
    const status = data[0] & 0xF0;
    const cc = data[1];
    const value = data[2];

    if (chainViewActive() && chainViewOwnsEvent(status, cc)) return;
    if (chainViewBlocks(status, cc, value)) return;

    if (status === 0xB0) {
        if (isTrackCc(cc) || cc === MoveMenu) {
            /* See LONG_PRESS_HOLD_MS's declaration. */
            if (value > 0) {
                if (isTextEntryActive()) {
                    routeCcInput(data, cc, value);
                } else if (shiftHeld) {
                    /* Shift+Track / Shift+Menu act on press as they always
                     * have -- but not under a chain view, where they would
                     * open an Arranger menu nobody can see. */
                    if (!chainViewActive()) routeCcInput(data, cc, value);
                } else {
                    startLongPressHold(cc, data[0], value);
                }
            } else if (longPressHolds.has(cc)) {
                endLongPressHold(cc);
            } else if (!chainViewActive()) {
                /* The release of a press that went straight through. */
                routeCcInput(data, cc, value);
            }
            return;
        }
        if (cc === MoveShift) {
            shiftHeld = value > 0;
            if (!shiftHeld) jamApplyKeyChangeOnShiftRelease();
            needsRedraw = true; /* the footer shows the Shift actions */
            return;
        }
        if (cc === MoveBack) {
            /* See backHoldActive's declaration. */
            if (value > 0) {
                if (isTextEntryActive()) {
                    /* The keyboard cancels on press, and a hold must not
                     * suspend out of it -- no hold tracking here. */
                    routeCcInput(data, cc, value);
                    return;
                }
                backHoldActive = true;
                backHoldStartTime = Date.now();
                backHoldSuspendFired = false;
                backHoldPressValue = value;
                backHoldStatusByte = data[0];
            } else {
                /* Only a release whose press this module saw stands for a
                 * tap. The host shares text_entry.mjs with us, so while our
                 * keyboard is open the HOST takes the Back press, cancels the
                 * keyboard and never forwards it: all we get is the release.
                 * Replaying that release as a press sent a second Back to
                 * whatever screen was under the keyboard. */
                const sawPress = backHoldActive;
                backHoldActive = false;
                if (sawPress && !backHoldSuspendFired) {
                    routeCcInput([backHoldStatusByte, cc, backHoldPressValue], cc, backHoldPressValue);
                }
            }
            return;
        }
        routeCcInput(data, cc, value);
    } else if (status === MidiNoteOn || status === MidiNoteOff) {
        if (isTextEntryActive()) {
            /* While editing a name, pads go to the keyboard (typing/select),
             * not to the previous screen's pad handlers. */
            handleTextEntryMidi(data);
            needsRedraw = true;
            return;
        }
        if (cc < KNOB_COUNT && (currentView === VIEW_PERFORMANCE || currentView === VIEW_KNOB_MAP)) {
            /* Knob touch: show (Performance) or select (Knobs) that knob. */
            const down = status === MidiNoteOn && value > 0;
            knobTouched[cc] = down;
            if (down && currentView === VIEW_KNOB_MAP) knobEditFocus = cc;
            if (down) showKnob(cc);
            else needsRedraw = true;
            return;
        }
        handlePadPress(cc, value);
    }
};

globalThis.onMidiMessageExternal = function onMidiMessageExternal(data) {
    /* Pass through external MIDI if needed */
};

globalThis.onResume = function onResume() {
    /* A suspend tears co-run down (and its Track/Menu releases went to
     * whatever was on screen); start clean. */
    longPressHolds.clear();
    if (chainViewActive()) endChainView();
    knobTouched.fill(false);
    knobLedRepaintTicks = KNOB_LED_REPAINT_TICKS;  /* Schwung's screens may have lit them */
    if (currentView === VIEW_PERFORMANCE && currentSetlist) {
        /* The Move Set (and with it the chains) may have changed while away. */
        refreshPerfKnobs();
        checkMoveSet(currentSetlist, () => {}, () => leavePerformanceToSetlists());
    }
    clearAllLEDs();
    resetLedState();
    /* The library may have changed while the module was suspended (files
     * added/moved on the Move), so have the DSP rescan it -- and reload the
     * folder and song lists once THAT scan has landed (pollLibraryRescan,
     * from tick). This used to reload first and request the rescan after,
     * so it re-read the scan from before the suspend: a change showed up one
     * resume late, and in between the UI's folder list and the DSP's
     * (index-addressed) one disagreed. Blocking, so the request cannot be
     * dropped by the fire-and-forget param slot. */
    if (typeof host_module_set_param_blocking === "function") {
        host_module_set_param_blocking("library_root", LIBRARY_ROOT, 100);
    } else if (typeof host_module_set_param === "function") {
        host_module_set_param("library_root", LIBRARY_ROOT);
    }
    if (typeof host_module_get_param === "function") {
        libraryRescanPending = true;
        libraryRescanDeadline = Date.now() + LIBRARY_RESCAN_MAX_WAIT_MS;
        lastLibraryRescanPoll = 0;
    }
    needsRedraw = true;
    logDebug("onResume: rescan requested, folders=" + libraryFolders.length + " songs=" + songFiles.length);
};

/* Reload the folder and song lists once the rescan requested by onResume
 * has been published. Checked at most every LIBRARY_RESCAN_POLL_MS -- one
 * cheap read -- and given up on (reload anyway) after
 * LIBRARY_RESCAN_MAX_WAIT_MS, or at once if the DSP has no "scan_pending"
 * answer, so a missing signal can never leave the lists stale for good. */
function pollLibraryRescan() {
    const now = Date.now();
    if (now - lastLibraryRescanPoll < LIBRARY_RESCAN_POLL_MS) return;
    lastLibraryRescanPoll = now;
    const pending = host_module_get_param("scan_pending");
    if (pending === "1" && now < libraryRescanDeadline) return;
    libraryRescanPending = false;
    const foldersBefore = libraryFolders.join("\n") + "\n\n" + libraryFolderCategories.join("\n");
    libraryCacheValid = false;
    loadLibraryFolders();
    reloadSongBankAndPreserveSelection();
    /* Repaint the pads only if the library actually changed; the common
     * case (nothing changed while suspended) needs no LED traffic. */
    if (libraryFolders.join("\n") + "\n\n" + libraryFolderCategories.join("\n") !== foldersBefore) {
        ledDirtyAll = true;
    }
    needsRedraw = true;
    logDebug("rescan landed: folders=" + libraryFolders.length + " songs=" + songFiles.length +
        " waited=" + (now - (libraryRescanDeadline - LIBRARY_RESCAN_MAX_WAIT_MS)) + "ms");
}

globalThis.onUnload = function onUnload() {
    closeChainView();
    perfStopRecording();
    flushKnobSave();
    stopPlayback();
    /* Send the All Notes Off backstop now: the module is going, so the
     * engine's 2 s countdown to it would never finish, and anything left
     * sounding would hang in Schwung's chains. */
    if (typeof host_module_set_param_blocking === "function") {
        host_module_set_param_blocking("release_notes", "1", 100);
    } else if (typeof host_module_set_param === "function") {
        host_module_set_param("release_notes", "1");
    }
    clearAllLEDs();
    resetLedState();
};
