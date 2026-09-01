/*
 * Arranger — Schwung Overtake Module
 *
 * Song Builder + Performance/Setlist mode for arranging GM drum MIDI clips.
 */

/* Build version stamp. Bump this on every deploy so the running JS can be
 * confirmed from the logs (see init()/playCurrentSong()) instead of guessing
 * whether a new file actually loaded. Keep the DSP dsp_build_version in
 * arranger_engine.c in sync so both sides are verifiable. */
const UI_BUILD_VERSION = "arranger-ui-2026-09-01a";

import {
    MidiNoteOn, MidiNoteOff, MidiCC,
    MoveMainKnob, MoveMainButton, MoveBack, MoveMenu, MoveShift,
    MovePlay, MoveRec, MoveRecord, MoveDelete, MoveCopy, MoveUndo, MoveLoop,
    MoveMute, MoveCapture,
    MoveUp, MoveDown, MoveLeft, MoveRight,
    MoveStep1, MoveStep16,
    MovePad1, MovePad32,
    MoveRow1, MoveRow2, MoveRow3, MoveRow4,
    Black, White, BrightRed,
    WhiteLedOff, WhiteLedDim, WhiteLedBright,
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
    createTextScroller
} from '/data/UserData/schwung/shared/text_scroll.mjs';

import {
    openTextEntry, isTextEntryActive, handleTextEntryMidi,
    drawTextEntry, tickTextEntry
} from '/data/UserData/schwung/shared/text_entry.mjs';

import {
    createMenuStack
} from '/data/UserData/schwung/shared/menu_stack.mjs';

import * as os from 'os';

const { print, clear_screen, setTimeout } = globalThis;

/* ── Constants ─────────────────────────────────────────────────────── */

const SCREEN_WIDTH = 128;
const SCREEN_HEIGHT = 64;

const LIBRARY_ROOT = "/data/UserData/UserLibrary/Arranger/MidiLibrary";
const SONGS_DIR = "/data/UserData/UserLibrary/Arranger/Songs";
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
const VIEW_SONG_SETTINGS = "song_settings";
const VIEW_SETLIST_BANK = "setlist_bank";
const VIEW_SETLIST_EDIT = "setlist_edit";
const VIEW_SETLIST_PICK = "setlist_pick";
const VIEW_SETLIST_CLICK = "setlist_click";
const VIEW_PERF_SETLIST = "perf_setlist";
const VIEW_JAM_FOLDER = "jam_folder";
const VIEW_JAM = "jam";
const VIEW_SECTION_PICK = "section_pick";

/* Section names offered when adding a new section via Shift + Loop. */
const SECTION_NAMES = [
    "Intro", "Verse", "Prechorus", "Chorus", "Interlude", "Instrumental",
    "Turn", "Bridge", "Down Bridge", "Down Chorus", "Outro"
];

/* ── State ───────────────────────────────────────────────────────────── */

let currentMode = MODE_BUILDER;
let currentView = VIEW_ROOT;
let menuStack = null;

let confirmState = null;   /* { title, name, labels, selectedIndex, onConfirm, onCancel } */

let libraryFolders = [];
let selectedFolderIndex = 0;
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
let clickChannel = 0;       /* count-in click channel: 0 = follow primary output channel, else 1-16 */
let dspDirectEmit = false;
let pendingSongJson = null;
let dspTimelineInfo = null;
let lastDspState = null;

let shiftHeld = false;
let needsRedraw = true;
let ledQueue = [];
const LEDS_PER_TICK = 8;
let lastPadState = new Uint8Array(NUM_PADS);
let lastStepState = new Uint8Array(NUM_STEPS);
let lastButtonState = new Map();
let lastLedView = null;
let lastLedKey = "";
let ledDirtyAll = true;

let activeSongFile = null;
let songFiles = [];
let selectedSongIndex = 0;

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

let songSettingsFocus = 0;
let songSettingsPendingBpm = 120;
let songSettingsPendingNum = 4;
let songSettingsPendingDen = 4;
let songSettingsEditing = false;

let selectedOutputIndex = 0;
let optionsFocus = 0;      /* 0 = Output, 1 = MIDI channel, 2 = Click channel, 3 = Swap guard, 4 = DSP debug */
let optionsEditing = false;
let swapGuardFraction = 0.25;  /* guard window (fraction of a beat) at mid-clip swap boundaries */
let dspDebugEnabled = false;   /* runtime toggle for the DSP debug log (.dsp_log) */

let setlistFiles = [];
let selectedSetlistIndex = 0;
let currentSetlist = null;
let setlistSongIndex = 0;
let editingSetlist = false;
let setlistPendingName = "My Setlist";
let setlistPickIndex = 0; /* selected song in the add-song picker */
let sectionPickIndex = 0; /* selected name in the add-section picker */
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
let builderPreviewScroller = createTextScroller({ scrollInterval: 8, delayFrames: 12 });
let builderPreviewName = "";
let builderPreviewBars = 0;
let wasTextEntryActive = false;  /* previous tick's text-entry state, to detect close */
let stepScrollOffset = 0;   /* bar offset for the step-LED window when a section has more than NUM_STEPS bars */
let stepRedrawAll = false;  /* true for one tick after a section change, to force a full step redraw */
let playbackSectionIndex = 0; /* section currently being played by DSP */
/* Song Builder: when the user navigates sections with Left/Right while
 * playing, show that section in the display and step LEDs instead of the
 * currently playing section. -1 = follow the playhead. */
let builderDisplaySection = -1;
/* Set to the source-folder NAME when the builder needs its clip pads loaded
 * but the DSP folder scan isn't ready yet (e.g. an existing song opened on a
 * fresh boot). The tick re-resolves the folder index (once libraryFolders is
 * populated) and reloads the clips until they arrive. */
let pendingFolderClipLoadName = null;
let lastTransportBar = 0;     /* last bar number seen from DSP transport */
let maxBeatThisBar = 0;       /* highest transport beat seen in current bar */
let transportBeatsPerBar = 0; /* observed transport beats in last complete bar */
let lastSubdivisionIndex = 0; /* current subdivision within transport beat */
let lastSubFlashMs = 0;       /* wall-clock anchor of the current sub-beat flash */

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

/* ── Jam mode state ─────────────────────────────────────────────────── */
let jamFolderIndex = 0;             /* selected folder index in the Jam folder picker */
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
let lastJamStepKey = "";            /* last jam step LED state key, to log only on change */

/* Jam preview (pad-held one-shot while stopped). Mirrors the builder pad
 * preview: press a pad while stopped, hold past the delay to hear the clip
 * as a one-shot until release; a quick (short) press starts loop playback. */
let jamPreviewPad = -1;             /* pad index held for a potential jam preview (-1 = none) */
let jamPreviewClip = null;          /* clip armed/playing for jam preview */
let jamPreviewTriggerTime = 0;      /* when the jam pad press happened */
let jamPreviewScheduled = false;    /* true once the jam one-shot preview playback started */
let jamPreviewStartTime = 0;        /* when the jam preview playback started */

/* Jam hold-overlay (pad held while playback is running): shows the name of the
 * held groove/fill in the display overlay without queueing it. A quick press
 * still queues normally. */
let jamHoldPad = -1;               /* pad index held for a jam hold-overlay (-1 = none) */
let jamHoldClip = null;             /* clip being held for the jam hold-overlay */
let jamHoldTriggerTime = 0;         /* when the jam hold-overlay pad press happened */
let jamHoldOverlayShown = false;    /* true once the hold-overlay has been shown */
/* Custom scrolling overlay for the jam hold, so long clip names marquee
 * instead of being hard-truncated by the shared drawOverlay(). */
let jamHoldScroller = createTextScroller({ scrollInterval: 8, delayFrames: 12 });
let jamHoldName = "";
let jamHoldBars = 1;

/* Dedicated marquee scroller for the Jam header (folder name). */
const jamHeaderScroller = createTextScroller();

/* Dedicated marquee scrollers for the four performance info lines (Now / Sec /
 * NSec / Next). Kept separate from the shared menu/header scrollers so long
 * song and section names scroll in place without fighting other scrollers. */
const perfLineScrollers = [0, 1, 2, 3].map(() => createTextScroller());
/* Max name chars visible per line. Screen is 128px wide starting at x=2
 * (126px usable = 21 chars at 6px each); the widest prefix " NSec: " is 7
 * chars, leaving 14 for the name. The scroller scrolls the full name. */
const PERF_LINE_MAX_CHARS = 14;

const PAD_PREVIEW_DELAY_MS = 250; /* delay before pad tap triggers insert preview */

/* Menu views that show scrollable lists. While one of these is active we
 * redraw periodically so the shared marquee scroller animates long Song /
 * Setlist / clip names that overflow the row width. */
const SCROLLABLE_MENU_VIEWS = new Set([
    VIEW_ROOT, VIEW_FOLDER_LIST, VIEW_BUILDER, VIEW_TRIM, VIEW_SONG_SETTINGS,
    VIEW_SONG_BANK, VIEW_OPTIONS, VIEW_SETLIST_BANK, VIEW_SETLIST_EDIT,
    VIEW_SETLIST_PICK, VIEW_SETLIST_CLICK, VIEW_PERF_SETLIST, VIEW_PERFORMANCE,
    VIEW_JAM_FOLDER, VIEW_JAM, VIEW_SECTION_PICK
]);
const MENU_SCROLL_TICK_MS = 30; /* ~25fps redraw for marquee animation (halves the ~2s scroll-start delay) */
let lastMenuScrollTick = 0;

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

/* Generate a click MIDI file (a single note per beat, for `bars` bars) and
 * write it to the given path. Returns true on success. The click note is
 * `note` (0 = no note, pad-flash only). */
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

function logJam(msg) {
    if (!dspDebugEnabled) return;
    if (typeof host_write_file !== "function") return;
    try {
        const line = new Date().toISOString() + " " + msg + "\n";
        if (typeof host_append_file === "function") {
            host_append_file(JAM_LOG_PATH, line);
            return;
        }
        let existing = "";
        try { if (host_file_exists(JAM_LOG_PATH)) existing = host_read_file(JAM_LOG_PATH); } catch (e) {}
        const trimmed = existing.length > 500000 ? existing.slice(existing.length - 500000) : existing;
        host_write_file(JAM_LOG_PATH, trimmed + line);
    } catch (e) {}
}

function logDebug(msg) {
    if (!dspDebugEnabled) return;
    if (typeof host_write_file !== "function") return;
    try {
        const line = new Date().toISOString() + " " + msg + "\n";
        if (typeof host_append_file === "function") {
            host_append_file(DEBUG_LOG_PATH, line);
            return;
        }
        let existing = "";
        try { if (host_file_exists(DEBUG_LOG_PATH)) existing = host_read_file(DEBUG_LOG_PATH); } catch (e) {}
        const trimmed = existing.length > 20000 ? existing.slice(existing.length - 20000) : existing;
        host_write_file(DEBUG_LOG_PATH, trimmed + line);
    } catch (e) {}
}

const TIMING_LOG_PATH = "/data/UserData/UserLibrary/Arranger/.timing_log";

function logTiming(msg) {
    if (!dspDebugEnabled) return;
    if (typeof host_write_file !== "function") return;
    try {
        const line = new Date().toISOString() + " " + msg + "\n";
        if (typeof host_append_file === "function") {
            host_append_file(TIMING_LOG_PATH, line);
            return;
        }
        let existing = "";
        try { if (host_file_exists(TIMING_LOG_PATH)) existing = host_read_file(TIMING_LOG_PATH); } catch (e) {}
        const trimmed = existing.length > 500000 ? existing.slice(existing.length - 500000) : existing;
        host_write_file(TIMING_LOG_PATH, trimmed + line);
    } catch (e) {}
}

function logClick(msg) {
    if (!dspDebugEnabled) return;
    if (typeof host_write_file !== "function") return;
    try {
        const line = new Date().toISOString() + " " + msg + "\n";
        if (typeof host_append_file === "function") {
            host_append_file(CLICK_LOG_PATH, line);
            return;
        }
        let existing = "";
        try { if (host_file_exists(CLICK_LOG_PATH)) existing = host_read_file(CLICK_LOG_PATH); } catch (e) {}
        const trimmed = existing.length > 20000 ? existing.slice(existing.length - 20000) : existing;
        host_write_file(CLICK_LOG_PATH, trimmed + line);
    } catch (e) {}
}

function listFolders(path) {
    const folders = [];
    if (!host_file_exists(path)) return folders;
    try {
        const raw = host_read_file(path + "/.folder_index");
        if (raw) return JSON.parse(raw);
    } catch (e) {}
    /* Fallback: we cannot list directories from JS directly in all hosts.
     * The DSP plugin will provide a folder list via get_param. */
    return folders;
}

function inferTempoFromFolder(name) {
    /* A three-digit number together (e.g. "078", "110", "120") is the BPM.
     * Prefer an explicit "NNN BPM" marker, then any standalone 3-digit number. */
    const explicit = name.match(/(\d{3})\s*BPM/i);
    if (explicit) return parseInt(explicit[1], 10);
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
    const [num, den] = inferTimeSigFromFolder(folderName);
    return {
        id: "song-" + Date.now(),
        name: folderName,
        source_folder: folderName,
        tempo_bpm: inferTempoFromFolder(folderName),
        time_sig_num: num,
        time_sig_den: den,
        ppq: 240,
        sync_mode: "internal",
        locked: false,
        created: new Date().toISOString(),
        modified: new Date().toISOString(),
        sections: [newSection("Intro")]
    };
}

function newSection(name = "Section") {
    return { id: "sec-" + Date.now(), name, clips: [] };
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

function toEngineSongJson(song) {
    const secOut = [];
    for (const sec of song.sections) {
        const clipsOut = [];
        for (const c of sec.clips || []) {
            const src = resolveClipSource(c.source, song.source_folder);
            /* Clamp end_bar to a sane value so corrupt end_bar:72 songs still play one bar. */
            let endBar = c.end_bar;
            if (typeof endBar !== "number" || endBar <= 0 || endBar > 256) endBar = 1;
            let startBar = c.start_bar;
            if (typeof startBar !== "number" || startBar < 0 || startBar >= endBar) startBar = 0;
            const startBeat = (typeof c.start_beat === "number" && c.start_beat > 0) ? c.start_beat : 0;
            const endBeat = (typeof c.end_beat === "number" && c.end_beat > 0) ? c.end_beat : 0;
            clipsOut.push({
                source: src,
                start_bar: startBar,
                start_beat: startBeat,
                end_bar: endBar,
                end_beat: endBeat,
                guard_fraction: (typeof c.guard_fraction === "number") ? c.guard_fraction : 0,
                speed: (typeof c.speed === "number" && c.speed > 0) ? c.speed : 1.0,
                velocity_scale: (typeof c.velocity_scale === "number" && c.velocity_scale >= 0) ? c.velocity_scale : 1,
                snare_note: (typeof c.snare_note === "number") ? c.snare_note : 38,
                snare_velocity_scale: (typeof c.snare_velocity_scale === "number" && c.snare_velocity_scale >= 0) ? c.snare_velocity_scale : 1,
                kick_note: (typeof c.kick_note === "number") ? c.kick_note : 36,
                kick_target: (typeof c.kick_target === "number") ? c.kick_target : 0,
                /* Per-clip MIDI channel override: 0 = follow the engine's
                 * output-target channel; 1-16 = explicit channel (used for the
                 * count-in click). */
                channel: (typeof c.channel === "number" && c.channel > 0) ? c.channel : 0
            });
        }
        secOut.push({ name: sec.name || "Section", clips: clipsOut });
    }
    return JSON.stringify({
        source_folder: song.source_folder || "",
        name: song.name || "Untitled",
        tempo_bpm: song.tempo_bpm || 120,
        time_sig_num: song.time_sig_num || 4,
        time_sig_den: song.time_sig_den || 4,
        ppq: song.ppq || 240,
        sync_mode: song.sync_mode || "internal",
        sections: secOut
    });
}

function toUiSong(engineLike) {
    const s = engineLike || {};
    return {
        id: s.id || ("song-" + Date.now()),
        name: s.name || "Untitled",
        source_folder: s.source_folder || "",
        tempo_bpm: s.tempo_bpm || 120,
        time_sig_num: s.time_sig_num || (s.time_signature ? s.time_signature[0] : 4),
        time_sig_den: s.time_sig_den || (s.time_signature ? s.time_signature[1] : 4),
        locked: !!(s.locked),
        created: s.created || new Date().toISOString(),
        modified: s.modified || new Date().toISOString(),
        sections: (s.sections || []).map(sec => ({
            id: sec.id || ("sec-" + Date.now()),
            name: sec.name || "Section",
            clips: (sec.clips || []).map(c => ({
                source: c.source || c.path || "",
                name: c.name || clipDisplayName(c.source || c.path || ""),
                type: c.type || inferPartTypeFromFilename(c.name || c.source || c.path || ""),
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
                advanced: !!(c.advanced)
            }))
        }))
    };
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

function listSongFiles() {
    const out = [];
    if (typeof host_module_get_param !== "function") return out;
    let count = 0;
    try {
        const cnt = host_module_get_param("song_count");
        if (cnt) count = parseInt(cnt, 10);
    } catch (e) {}
    for (let i = 0; i < count; i++) {
        const name = host_module_get_param("song_name_" + i);
        const path = host_module_get_param("song_path_" + i);
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

function saveCurrentSong() {
    if (!currentSong) return;
    currentSong.modified = new Date().toISOString();
    const path = activeSongFile || songPath(currentSong.name);
    activeSongFile = path;
    writeJson(path, currentSong);
    unsavedChanges = false;
    /* Invalidate the DSP's cached song scan so a newly saved song appears in
     * the Song Bank list. Without this, listSongFiles() returns the stale
     * cached scan and a brand-new song is missing until the module reloads. */
    if (typeof host_module_set_param === "function") {
        host_module_set_param("scan_library", "1");
    }
    reloadSongBankAndPreserveSelection();
    needsRedraw = true;
}

function loadSongFile(path) {
    logDebug("loadSongFile: reading " + path);
    const obj = readJson(path);
    if (!obj) { logDebug("loadSongFile: readJson returned null for " + path); return false; }
    activeSongFile = path;
    currentSong = toUiSong(obj);
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
    const cc = pick("click_channel", "number");
    if (typeof cc === "number") clickChannel = cc;
    const sg = pick("swap_guard_fraction", "number");
    if (typeof sg === "number") swapGuardFraction = sg;
    const dd = pick("dsp_debug", "boolean");
    if (typeof dd === "boolean") dspDebugEnabled = dd;
    if (outputChannel < 1) outputChannel = 1;
    if (outputChannel > 16) outputChannel = 16;
    if (moveChannel < 1) moveChannel = 1;
    if (moveChannel > 16) moveChannel = 16;
    if (schwungChannel < 1) schwungChannel = 1;
    if (schwungChannel > 16) schwungChannel = 16;
    if (clickChannel < 0) clickChannel = 0;
    if (clickChannel > 16) clickChannel = 16;
    if (swapGuardFraction < 0) swapGuardFraction = 0;
    if (swapGuardFraction > 1) swapGuardFraction = 1;
    selectedOutputIndex = OUTPUT_TARGETS.indexOf(outputTarget);
    if (selectedOutputIndex < 0) selectedOutputIndex = 0;
}

function saveOutputSettings() {
    const values = {
        output: outputTarget,
        output_channel: outputChannel,
        move_channel: moveChannel,
        schwung_channel: schwungChannel,
        click_channel: clickChannel,
        swap_guard_fraction: swapGuardFraction,
        dsp_debug: dspDebugEnabled
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

/* Effective MIDI channel for the count-in click. clickChannel 0 means follow
 * the primary output channel; otherwise it is an explicit 1-16 channel. */
function activeClickChannel() {
    return clickChannel > 0 ? clickChannel : activeOutputChannel();
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
        click_note: 0,
        stop_after_finish: false
    };
    setlist.songs.push(entry);
    saveSetlist(setlist);
}

function setSetlistClickBars(setlist, idx, bars) {
    if (!setlist || idx < 0 || idx >= setlist.songs.length) return;
    setlist.songs[idx].click_bars = Math.max(0, Math.min(4, bars));
    entryClickRevision(setlist.songs[idx]);
    generateClickForEntry(setlist.songs[idx]);
    saveSetlist(setlist);
}

function setSetlistClickNote(setlist, idx, note) {
    if (!setlist || idx < 0 || idx >= setlist.songs.length) return;
    setlist.songs[idx].click_note = Math.max(0, Math.min(127, note));
    entryClickRevision(setlist.songs[idx]);
    generateClickForEntry(setlist.songs[idx]);
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

function playCurrentSong(preloadStaged) {
    if (!currentSong) { logDebug("playCurrentSong: no currentSong"); return; }
    lastLoggedDspError = null;
    const json = toEngineSongJson(currentSong);
    pendingSongJson = json;
    const secCount = currentSong.sections ? currentSong.sections.length : 0;
    const clipCount = currentSong.sections ? currentSong.sections.reduce((a, s) => a + (s.clips ? s.clips.length : 0), 0) : 0;
    if (typeof host_module_set_param === "function") {
        logTiming("START BUILD=" + UI_BUILD_VERSION + " song=" + currentSong.name + " sections=" + secCount + " clips=" + clipCount +
            " bpm=" + (currentSong.tempo_bpm || "?") + " ts=" + (currentSong.time_sig_num || "?") + "/" + (currentSong.time_sig_den || "?") +
            " bars=" + (dspTimelineInfo ? dspTimelineInfo.total_bars : "?") + " t=" + Date.now());
        logDebug("playCurrentSong: BUILD=" + UI_BUILD_VERSION + " song=" + currentSong.name + " sections=" + secCount + " clips=" + clipCount + " json_len=" + json.length + " output=" + outputTarget);
        logDebug("playCurrentSong json=" + json.slice(0, 600));
        /* Ensure library_root is set first so clip resolution works. */
        host_module_set_param("library_root", LIBRARY_ROOT);
        pushOutputRoutingToDsp();
        host_module_set_param("loop", "0");
        host_module_set_param("song_json", json);
        if (typeof host_module_get_param === "function") {
            const afterJsonErr = host_module_get_param("error");
            const afterJsonInfo = host_module_get_param("timeline_info");
            logDebug("playCurrentSong after song_json: error=" + (afterJsonErr || "null") + " timeline_info=" + (afterJsonInfo || "null"));
        }
        /* Optional: preload the full song into DSP staging AFTER the current
         * (click) song_json has loaded. Loading song_json clears staging, so
         * preloading first would wipe the staged full song and the click→song
         * swap would never fire. Preloading here, before play=1, keeps the
         * blocking build off the audio path (no first-note blip) while leaving
         * the staged full song intact for a sample-accurate swap. */
        if (preloadStaged) {
            preloadPerfSongToStaging();
        }
        host_module_set_param("loop", dspLoopEnabled ? "1" : "0");
        host_module_set_param("play", "1");
        if (typeof host_module_get_param === "function") {
            const info = host_module_get_param("timeline_info");
            const err = host_module_get_param("error");
            logDebug("playCurrentSong post: timeline_info=" + (info || "null") + " error=" + (err || "null"));
        }
    } else {
        logDebug("playCurrentSong: host_module_set_param unavailable");
    }
    /* Clear stale transport/end state so perfTick doesn't act on old data. */
    lastDspState = null;
    lastDspTransport = null;
    playbackState = "playing";
    playbackStartTime = Date.now();
    playbackSectionIndex = currentSectionIndex;
    lastStepBeatKey = "";
    lastStepBarIndex = -1;
    lastTransportBar = 0;
    maxBeatThisBar = 0;
    transportBeatsPerBar = 0;
    lastSubdivisionIndex = 0;
    needsRedraw = true;
}

function stopPlayback() {
    logTiming("STOP t=" + Date.now());
    if (typeof host_module_set_param === "function") {
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

function updateDspState() {
    if (typeof host_module_get_param !== "function") return;
    try {
        const info = host_module_get_param("timeline_info");
        if (info) dspTimelineInfo = JSON.parse(info);
    } catch (e) { dspTimelineInfo = null; }
    try {
        const st = host_module_get_param("state");
        if (st) {
            lastDspState = JSON.parse(st);
            /* Log only when the DSP-reported active source changes, so the
             * log isn't flooded every tick. */
            if (jamPlaying && lastDspState.active_source !== jamActiveSource) {
                logJam("STATE active_source=" + lastDspState.active_source + " jamActiveSource=" + jamActiveSource);
            }
        }
    } catch (e) {
        if (jamPlaying) logJam("STATE parse error=" + e + " raw=" + String(st));
        lastDspState = null;
    }
    try {
        const tr = host_module_get_param("transport");
        if (tr) {
            lastDspTransport = JSON.parse(tr);
        }
    } catch (e) {
        logDebug("updateDspState transport parse error=" + e + " raw=" + String(tr));
        lastDspTransport = null;
    }
    try {
        const err = host_module_get_param("error");
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
            const suppressed = host_module_get_param("swap_guard_suppressed");
            const n = suppressed ? parseInt(suppressed, 10) : 0;
            if (n !== lastSwapGuardSuppressed) {
                lastSwapGuardSuppressed = n;
                logJam("GUARD suppressed=" + n + " fraction=" + swapGuardFraction);
            }
        } catch (e) {}
    }
    /* Jam mode: keep the UI in sync with any clip the DSP has auto-swapped to
     * (e.g. a non-looping fill returning to its groove). The DSP exposes the
     * active clip's source path in state.active_source. */
    if (jamPlaying && lastDspState && lastDspState.active_source &&
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
                jamFillScroll = 0;
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
            jamFillScroll = 0;
            resetStepFlash();
            needsRedraw = true;
            stepLedsDirty = true;
            ledDirtyAll = true;
        }
    }

    /* If a jam preview one-shot finished on its own (non-looping clip ended),
     * clear the preview state and return to the stopped Jam grid. This must
     * run before the generic DSP-stop branch below so it isn't mistaken for a
     * normal clip that ended. */
    if (jamPreviewScheduled && ((lastDspState && !lastDspState.running) || (lastDspTransport && !lastDspTransport.running))) {
        logJam("PREVIEW finished on its own");
        hideOverlay();
        jamPreviewPad = -1;
        jamPreviewClip = null;
        jamPreviewScheduled = false;
        jamPreviewStartTime = 0;
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
    if (playbackState === "playing" && lastDspTransport && lastDspTransport.running && !padPreviewClip) {
        /* Use the fractional bar position (bar_frac, 0-based) so a clip that
         * ends mid-bar (Advanced Trim / speed) switches sections at the exact
         * musical boundary instead of the next integer bar. */
        const dspBarFrac = (typeof lastDspTransport.bar_frac === "number") ? lastDspTransport.bar_frac : ((lastDspTransport.bar || 1) - 1);
        const fullSongBarFrac = dspBarFrac + previewBarOffset;
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
    while (ledQueue.length > 0 && n < LEDS_PER_TICK) {
        const msg = ledQueue.shift();
        if (msg.length === 4) {
            /* msg = [0x09, MidiNoteOn, note, color] */
            if (perfClickPlaying && (msg[2] >= MovePad1 && msg[2] < MovePad1 + NUM_PADS)) {
                logDebug("LEDSEND pad=" + (msg[2] - MovePad1) + " color=" + msg[3] +
                    " bar=" + (lastDspTransport ? lastDspTransport.bar : "?") +
                    " beat=" + (lastDspTransport ? lastDspTransport.beat : "?") +
                    " t=" + Date.now());
            }
            move_midi_internal_send(msg);
        } else {
            setButtonLED(msg[0], msg[1]);
        }
        n++;
    }
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
        move_midi_internal_send(msg);
    }
}

function queuePadLED(padIndex, color) {
    const note = MovePad1 + padIndex;
    ledQueue.push([0x09, MidiNoteOn, note, color]);
}

function queueStepLED(stepIndex, color) {
    const note = MoveStep1 + stepIndex;
    ledQueue.push([0x09, MidiNoteOn, note, color]);
}

function queueButtonLED(cc, color) {
    ledQueue.push([cc, color]);
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
        active.set(MoveBack, WhiteLedBright);
        active.set(MoveMainButton, WhiteLedBright);
    } else {
        switch (currentView) {
            case VIEW_ROOT:
                active.set(MoveBack, WhiteLedBright);
                break;
            case VIEW_FOLDER_LIST:
                active.set(MoveBack, WhiteLedBright);
                active.set(MoveMainButton, WhiteLedBright);
                break;
            case VIEW_BUILDER: {
                const ledLocked = songIsLocked();
                /* Use the displayed section (auto-followed/jumped during
                 * playback) so copy/delete light up for the live section's
                 * clips, not the stale currentSectionIndex. */
                const ledSec = currentSong ? currentSong.sections[builderDisplaySectionIndex()] : null;
                const ledOnClip = ledSec && builderCursor >= 0 && builderCursor < ledSec.clips.length;
                const ledOnSection = builderCursor === -1;
                const ledOnInsert = ledSec && ledSec.clips.length === 0 && builderCursor === 0;
                /* Use the displayed section (auto-followed/jumped during
                 * playback) so the left/right arrow LEDs reflect the section
                 * actually shown, not the stale currentSectionIndex. */
                const ledSectionIndex = builderDisplaySectionIndex();
                const ledHasLeftSection = !!(currentSong && ledSectionIndex > 0);
                const ledHasRightSection = !!(currentSong && currentSong.sections && ledSectionIndex < currentSong.sections.length - 1);
                const ledTotalPages = builderPageCount();
                const ledHasUp = builderPage > 0;
                const ledHasDown = builderPage < ledTotalPages - 1;
                active.set(MoveBack, WhiteLedBright);
                active.set(MoveMainButton, WhiteLedBright);
                active.set(MoveMenu, WhiteLedBright);
                if (!ledLocked) active.set(MoveRecord, PureBlue); /* change the source folder */
                /* Loop, Copy, and Delete do nothing on a locked song, so keep
                 * them black (not added to the active map). */
                if (!ledLocked) {
                    if (ledOnClip) active.set(MoveCopy, WhiteLedBright);
                    else if (ledOnSection || ledOnInsert) active.set(MoveCopy, WhiteLedDim);
                    active.set(MoveLoop, WhiteLedDim);
                    if (ledOnClip) active.set(MoveDelete, WhiteLedBright);
                    else if (ledOnSection || ledOnInsert) active.set(MoveDelete, WhiteLedDim);
                }
                if (ledHasDown) active.set(MoveUp, WhiteLedBright);
                if (ledHasUp) active.set(MoveDown, WhiteLedBright);
                if (ledHasLeftSection) active.set(MoveLeft, WhiteLedBright);
                if (ledHasRightSection) active.set(MoveRight, WhiteLedBright);
                /* Play stays red while playing; when stopped it is green only
                 * if the current section has clips, else black (nothing to
                 * play). */
                if (playbackState === "playing") {
                    active.set(MovePlay, PureRed);
                } else if (ledSec && ledSec.clips.length > 0) {
                    active.set(MovePlay, PureGreen);
                }
                if (!ledLocked) {
                    /* Shift does nothing on a locked song (all its alternate
                     * actions are blocked), so leave it black. */
                    active.set(MoveShift, WhiteLedDim);
                    if (shiftHeld) {
                        active.set(MoveShift, WhiteLedBright);
                        active.set(MoveMainButton, WhiteLedBright);
                        /* Shift+Copy / Shift+Delete / Shift+Loop / Shift+Left /
                         * Shift+Right act on the whole section, so they stay
                         * lit anywhere. */
                        active.set(MoveCopy, WhiteLedBright);
                        active.set(MoveLoop, WhiteLedBright);
                        if (ledHasLeftSection) active.set(MoveLeft, WhiteLedBright);
                        if (ledHasRightSection) active.set(MoveRight, WhiteLedBright);
                        active.set(MoveDelete, WhiteLedBright);
                        active.set(MovePlay, PureGreen);
                    }
                } else if (shiftHeld) {
                    active.set(MoveShift, WhiteLedBright);
                    active.set(MoveMainButton, WhiteLedBright);
                    /* Shift+Copy / Shift+Delete / Shift+Loop are inert on a
                     * locked song, so leave them black. Shift+Left/Right
                     * (reorder sections) are also blocked but keep their
                     * dim/bright hints per section availability. */
                    active.set(MovePlay, PureGreen);
                }
                break;
            }
            case VIEW_TRIM:
                active.set(MoveBack, WhiteLedBright);
                active.set(MoveMainButton, WhiteLedBright);
                break;
            case VIEW_SONG_SETTINGS:
                active.set(MoveBack, WhiteLedBright);
                active.set(MoveMainButton, WhiteLedBright);
                break;
            case VIEW_SONG_BANK:
                active.set(MoveBack, WhiteLedBright);
                active.set(MoveMainButton, WhiteLedBright);
                if (selectedSongIndex > 0) {
                    /* A locked song cannot be deleted or renamed: leave the
                     * Delete and Shift buttons black (omit from active map). */
                    const entry = songFiles[selectedSongIndex - 1];
                    const locked = entry ? !!(readJson(entry.path)?.locked) : false;
                    if (!locked) active.set(MoveDelete, WhiteLedBright);
                    if (!locked) {
                        /* Shift (rename) only applies to an existing, unlocked
                         * song — not the "+ New Song" row nor a locked one. */
                        active.set(MoveShift, WhiteLedDim);
                        if (shiftHeld) active.set(MoveShift, WhiteLedBright);
                    }
                }
                break;
            case VIEW_OPTIONS:
                active.set(MoveBack, WhiteLedBright);
                active.set(MoveMainButton, WhiteLedBright);
                break;
            case VIEW_SETLIST_BANK:
                active.set(MoveBack, WhiteLedBright);
                active.set(MoveMainButton, WhiteLedBright);
                if (selectedSetlistIndex > 0) {
                    active.set(MoveDelete, WhiteLedBright);
                    /* Shift (rename) only applies to an existing setlist, not
                     * the "+ New Setlist" row. */
                    active.set(MoveShift, WhiteLedDim);
                    if (shiftHeld) active.set(MoveShift, WhiteLedBright);
                }
                break;
            case VIEW_SETLIST_EDIT: {
                const songs = currentSetlist ? currentSetlist.songs : [];
                const onAddSong = setlistSongIndex >= songs.length;
                active.set(MoveBack, WhiteLedBright);
                active.set(MoveMainButton, WhiteLedBright);
                if (!onAddSong) active.set(MoveDelete, WhiteLedBright);
                if (!onAddSong && setlistSongIndex > 0) active.set(MoveLeft, WhiteLedBright);
                if (!onAddSong && setlistSongIndex < songs.length - 1) active.set(MoveRight, WhiteLedBright);
                if (!onAddSong) {
                    /* Shift has no action on "(add song)", so leave it black. */
                    active.set(MoveShift, WhiteLedDim);
                    if (shiftHeld) active.set(MoveShift, WhiteLedBright);
                }
                break;
            }
            case VIEW_SETLIST_PICK:
                active.set(MoveBack, WhiteLedBright);
                active.set(MoveMainButton, WhiteLedBright);
                break;
            case VIEW_SETLIST_CLICK:
                active.set(MoveBack, WhiteLedBright);
                active.set(MoveMainButton, WhiteLedBright);
                break;
            case VIEW_SECTION_PICK:
                active.set(MoveBack, WhiteLedBright);
                active.set(MoveMainButton, WhiteLedBright);
                break;
            case VIEW_PERF_SETLIST:
                active.set(MoveBack, WhiteLedBright);
                active.set(MoveMainButton, PureGreen);
                break;
            case VIEW_PERFORMANCE:
                active.set(MoveBack, WhiteLedBright);
                {
                    const maxRow = Math.max(0, Math.ceil(perfSongSections.length / 8) - 4);
                    const upLit = perfScrollRow < maxRow;
                    const downLit = perfScrollRow > 0;
                    if (upLit) active.set(MoveUp, WhiteLedBright);
                    if (downLit) active.set(MoveDown, WhiteLedBright);
                    /* When the pad window scrolls (auto-scroll or manual), the
                     * up/down button LEDs must reflect the new position. Force a
                     * re-send on a scroll-row change so a stale queued/deduped
                     * state can't leave them lit incorrectly. */
                    if (perfScrollRow !== perfLastUpDownScrollRow) {
                        perfLastUpDownScrollRow = perfScrollRow;
                        /* Send directly, bypassing the throttled ledQueue. A
                         * queued button message can be wiped by the next
                         * ledDirtyAll's ledQueue.length=0 (which fires on bar
                         * boundaries during playback) before it flushes,
                         * leaving the up/down LEDs stuck in their old state
                         * after an auto-scroll. */
                        setButtonLED(MoveUp, upLit ? WhiteLedBright : Black);
                        setButtonLED(MoveDown, downLit ? WhiteLedBright : Black);
                        lastButtonState.set(MoveUp, upLit ? WhiteLedBright : Black);
                        lastButtonState.set(MoveDown, downLit ? WhiteLedBright : Black);
                    }
                }
                active.set(MovePlay, perfPlaying ? PureRed : PureGreen);
                break;
            case VIEW_JAM_FOLDER:
                active.set(MoveBack, WhiteLedBright);
                active.set(MoveMainButton, WhiteLedBright);
                break;
            case VIEW_JAM:
                active.set(MoveBack, WhiteLedBright);
                {
                    const maxScroll = Math.max(0, Math.ceil(jamGrooves.length / 16) - 1);
                    /* Reversed: Up scrolls down, Down scrolls up. */
                    if (jamGrooveScroll < maxScroll) active.set(MoveUp, WhiteLedBright);
                    if (jamGrooveScroll > 0) active.set(MoveDown, WhiteLedBright);
                    const fills = jamVisibleFills();
                    const maxFillScroll = Math.max(0, Math.ceil(fills.length / 16) - 1);
                    if (jamFillScroll > 0) active.set(MoveLeft, WhiteLedBright);
                    if (jamFillScroll < maxFillScroll) active.set(MoveRight, WhiteLedBright);
                }
                active.set(MovePlay, jamPlaying ? PureRed : Black);
                break;
        }
    }

    for (const cc of ALL_BUTTON_CCS) {
        if (active.has(cc)) {
            setButtonHint(cc, active.get(cc));
        } else {
            setButtonHint(cc, Black);
        }
    }
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

/* Pure palette colours (indexed 0-127) used for transport/state LEDs. */
const PureGreen = 126;   /* solid green */
const PureRed = 127;     /* solid red */
const PureBlue = 125;    /* solid blue */
const DarkGrey = 119;    /* inactive-song grey */

/* Single colour for the count-in click section, used consistently for the
 * click pad and the click step LEDs (dim variant for the pad, matching dim for
 * the steps). Previously the click pad/steps used inconsistent colours
 * (grey/green/light-red) depending on state. */
const CLICK_COLOUR = 16;       /* Azure Blue */
const CLICK_DIM_COLOUR = 16 * 2 + 63; /* dim partner (95) */

/* Instrument variation colour (hat/stick/ride/clap). Returns -1 if the name
 * has no instrument keyword. Used so variation grooves and fills share a
 * colour that stands out from plain section clips. The dim partner for a
 * colour in 1-26 is base*2 + 63 (e.g. colour 2 -> 67, colour 12 -> 87). */
function instrumentColor(name, dim) {
    const lower = (name || "").toLowerCase();
    if (lower.includes("hat")) return dim ? 15 * 2 + 63 : 15;    /* Teal-Cyan (avoid a red close to PureRed) */
    if (lower.includes("stick")) return dim ? 5 * 2 + 63 : 5;  /* Light Yellow */
    if (lower.includes("ride")) return dim ? 20 * 2 + 63 : 20;  /* Electric Violet */
    if (lower.includes("clap")) return dim ? 25 * 2 + 63 : 25;  /* Bright Pink */
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

/* Colour for a section type. The dim partner for a base colour in 1-26 is
 * base*2 + 63 (e.g. intro 3 Bright Orange -> 69 Burnt Sienna, not red). */
function sectionColor(type, dim) {
    const base = SECTION_BASE_COLOUR[type] !== undefined ? SECTION_BASE_COLOUR[type] : 11;
    return dim ? base * 2 + 63 : base;
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
    if (!clip) return dim ? GROOVE_DIM_COLOUR : GROOVE_COLOUR_BASE;
    const inst = instrumentColor(clip.name, dim);
    if (inst >= 0) return inst;
    const name = clip.name || clip.path || "";
    const section = inferSectionFromFilename(name);
    if (section === "") {
        const base = GENERIC_COLOURS[genericColourIndex(name)];
        return dim ? base * 2 + 63 : base;
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
        : currentSong;

    let secIndex = currentSectionIndex;
    if (currentView === VIEW_PERFORMANCE) {
        /* When stopped and a section is selected, preview its bars on the
         * step LEDs so the user sees where the play head will land. */
        if (!perfPlaying && perfSelectedSection >= 0 && stepSong && perfSelectedSection < stepSong.sections.length) {
            secIndex = perfSelectedSection;
        } else if (playbackState === "playing") {
            secIndex = playbackSectionIndex;
        } else {
            secIndex = -1;
        }
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
        const fullSongBarFrac = dspBarFrac + previewBarOffset;
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

    const grooveCols = 4;
    const fillCols = 4;
    const rows = 4;

    const imminent = jamImminentNext();

    /* Grooves: left 4 columns, scrolled by jamGrooveScroll (rows). */
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < grooveCols; c++) {
            const idx = (r + jamGrooveScroll * rows) * grooveCols + c;
            const clip = jamGrooves[idx];
            if (!clip) continue;
            const p = r * 8 + c;
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
                /* A fill is playing and this is the return groove: green
                 * until the fill's last bar (imminent return), then red. If
                 * the user pressed it to restart from the start, show blue. */
                desired[p] = jamReturnFromStart ? PureBlue : (imminent ? PureRed : PureGreen);
            } else {
                desired[p] = clipColor(clip, false);
            }
        }
    }

    /* Fills: right 4 columns, filtered by current groove type, scrolled by
     * jamFillScroll (rows). Only the next fill to play (front of the queue)
     * is highlighted; fills queued further back are white. */
    const nextFill = (jamQueue.length > 0) ? jamQueue[0] : null;
    const fills = jamVisibleFills();
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < fillCols; c++) {
            const idx = (r + jamFillScroll * rows) * fillCols + c;
            const clip = fills[idx];
            if (!clip) continue;
            const p = r * 8 + (4 + c);
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
            for (let s = 0; s < NUM_STEPS; s++) {
                if (s >= pBars) {
                    stepColor(s, Black, force);
                } else if (s === pBar) {
                    stepColor(s, pFlash ? White : Black, force);
                } else {
                    stepColor(s, pColour, force);
                }
            }
            return;
        }
        for (let s = 0; s < NUM_STEPS; s++) stepColor(s, Black, true);
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
         * builder/performance/jam; leaving either should turn them off so they
         * don't stay stuck showing the last song/section. */
        if (currentView === VIEW_BUILDER || currentView === VIEW_PERFORMANCE || currentView === VIEW_JAM ||
            lastLedView === VIEW_BUILDER || lastLedView === VIEW_PERFORMANCE || lastLedView === VIEW_JAM) {
            stepLedsDirty = true;
        }
        if ((lastLedView === VIEW_BUILDER || lastLedView === VIEW_PERFORMANCE || lastLedView === VIEW_JAM) &&
            currentView !== VIEW_BUILDER && currentView !== VIEW_PERFORMANCE && currentView !== VIEW_JAM) {
            leavingStepView = true;
            stepLedsDirty = false;
        }
        lastLedView = currentView;
    }
    if (ledDirtyAll) {
        ledQueue.length = 0;
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
            case VIEW_JAM: drawJamLEDs(); break;
            default: clearPadLEDs();
        }
        ledDirtyAll = false;
    }
    /* Clear step LEDs after the queue has been reset, otherwise the black
     * messages queued by clearStepLEDs get wiped by ledQueue.length = 0. */
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
    } else if (currentView === VIEW_BUILDER || currentView === VIEW_PERFORMANCE) {
        drawBuilderStepLEDs(forceSteps);
        stepLedsDirty = false;
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
        /* Slower scroll: 8 frames between steps (vs the default 2) so long
         * names glide rather than zip past. Short delay so names start
         * scrolling quickly instead of sitting truncated for ~2s. */
        sc = createTextScroller({ scrollInterval: 8, delayFrames: 12 });
        headerScrollers.set(title, sc);
    }
    sc.setSelected(title);
    sc.tick();
    if (title.length <= maxChars) return title;
    return sc.getScrolledText(title, maxChars);
}

function drawRoot() {
    drawMenuHeader("Arranger", "v0.2");
    drawMenuList({
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
}

function drawFolderList() {
    drawMenuHeader("Source Folder", "");
    const items = libraryFolders.map(f => ({ label: shortSongName(f) }));
    drawMenuList({
        items,
        selectedIndex: selectedFolderIndex,
        getLabel: (item) => item.label,
        getValue: () => "",
        maxVisible: 5,
        labelX: 0,
        labelGap: 0
    });
}

function drawBuilder() {
    const playingIdx = (playbackState === "playing" && builderDisplaySection >= 0) ? builderDisplaySection : playbackSectionIndex;
    const displayIdx = playbackState === "playing" ? playingIdx : currentSectionIndex;
    const sec = currentSong ? currentSong.sections[displayIdx] : null;
    drawMenuHeader(scrollHeader("Edit: " + (currentSong ? shortSongName(currentSong.name) : ""), songIsLocked() ? 20 : 21), songIsLocked() ? "*" : "");
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
        items,
        selectedIndex: builderCursor + 1,
        getLabel: (item) => {
            if (item.type === "section") return sec.name || "Section";
            if (item.type === "clip") return clipShortName(sec.clips[item.index]);
            return "(pads add clips)";
        },
        getValue: (item) => {
            if (item.type === "section") return (displayIdx + 1) + "/" + currentSong.sections.length;
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
        valueX: 44,
        labelGap: 1,
        listArea: { topY: LIST_TOP_Y, bottomY: LIST_INDICATOR_BOTTOM_Y }
    });
    const bpm = currentSong ? currentSong.tempo_bpm : 120;
    const num = currentSong ? currentSong.time_sig_num : 4;
    const den = currentSong ? currentSong.time_sig_den : 4;
    drawBuilderPreviewOverlay();
}

/* Shared scrolling overlay: draws the centered 120x28 box with a marquee-
 * scrolling clip name and a value line. Used by both the Song Builder pad
 * preview and the Jam hold overlay, so long names aren't hard-truncated. */
function drawScrollingOverlay(scroller, name, bars) {
    if (!name) return;
    const boxX = (SCREEN_WIDTH - 120) / 2;
    const boxY = (SCREEN_HEIGHT - 28) / 2;
    fill_rect(boxX, boxY, 120, 28, 0);
    fill_rect(boxX, boxY, 120, 1, 1);
    fill_rect(boxX, boxY + 27, 120, 1, 1);
    fill_rect(boxX, boxY, 1, 28, 1);
    fill_rect(boxX + 119, boxY, 1, 28, 1);
    scroller.tick();
    let display = name;
    if (display.length > 18) display = scroller.getScrolledText(display, 18);
    print(boxX + 4, boxY + 2, display, 1);
    print(boxX + 4, boxY + 14, "Value: " + bars + " bar" + (bars > 1 ? "s" : ""), 1);
}

/* Custom overlay for the Song Builder pad preview, using the shared scrolling
 * overlay helper. */
function drawBuilderPreviewOverlay() {
    if (!padPreviewScheduled || !builderPreviewName) return;
    drawScrollingOverlay(builderPreviewScroller, builderPreviewName, builderPreviewBars);
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
    drawMenuHeader(scrollHeader("Edit: " + (clip ? clipShortName(clip) : "Clip Settings"), songIsLocked() ? 20 : 21), trimAdvanced ? "A" : "");
    if (!clip) {
        print(2, LIST_TOP_Y, "No clip selected", 1);
        return;
    }
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
        items,
        selectedIndex,
        getLabel: (item) => item.label,
        getValue: (item) => item.value,
        valueAlignRight: true,
        editMode: trimEditing,
        listArea: { topY: LIST_TOP_Y, bottomY: LIST_INDICATOR_BOTTOM_Y }
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
    currentView = VIEW_SONG_SETTINGS;
    menuStack.push({ title: "Settings", selectedIndex: 0 });
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
        { key: "lock", label: "Lock Song", value: songIsLocked() ? "On" : "Off" }
    ];
    drawMenuList({
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
    currentSong.tempo_bpm = Math.max(20, Math.min(300, Math.round(songSettingsPendingBpm)));
    currentSong.time_sig_num = Math.max(1, Math.min(16, songSettingsPendingNum));
    currentSong.time_sig_den = [1, 2, 4, 8, 16].includes(songSettingsPendingDen) ? songSettingsPendingDen : 4;
    unsavedChanges = true;
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
            }
        } else {
            songSettingsFocus = Math.max(0, Math.min(3, songSettingsFocus + delta));
        }
        needsRedraw = true;
    } else if (cc === MoveMainButton && value > 0) {
        if (songSettingsFocus === 3) {
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
                    if (currentSong) currentSong.name = trimmed;
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

function drawSongBank() {
    drawMenuHeader("Song Bank", "");
    const items = [{ label: "+ New Song" }].concat(songFiles.map(f => ({ label: shortSongName(f.name || f) })));
    /* Mark locked songs with "*" in the value column. */
    const lockMap = new Map();
    for (const f of songFiles) {
        const obj = readJson(f.path);
        if (obj && obj.locked) lockMap.set(f.name, true);
    }
    drawMenuList({
        items,
        selectedIndex: selectedSongIndex,
        getLabel: (item) => item.label,
        getValue: (item) => (item.label && lockMap.has(item.label)) ? "*" : "",
        valueAlignRight: true,
        labelGap: 2,
        maxVisible: 5
    });
}

function drawOptions() {
    drawMenuHeader("Options", "");
    const items = [
        { key: "output", label: "Output", value: currentOutputLabel() },
        { key: "channel", label: "MIDI Channel", value: String(activeOutputChannel()) },
        { key: "clickchan", label: "Click Channel", value: clickChannel === 0 ? "Default" : String(clickChannel) },
        { key: "swapguard", label: "Swap Guard", value: Math.round(swapGuardFraction * 100) + "%" },
        { key: "dspdebug", label: "DSP Debug", value: dspDebugEnabled ? "On" : "Off" }
    ];
    drawMenuList({
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

function drawSetlistBank() {
    drawMenuHeader("Setlists", "");
    const items = [{ label: "+ New Setlist" }].concat(setlistFiles.map(f => ({ label: f.name || f })));
    drawMenuList({
        items,
        selectedIndex: selectedSetlistIndex,
        getLabel: (item) => item.label,
        getValue: () => "",
        maxVisible: 5
    });
}

function drawSetlistEdit() {
    drawMenuHeader(scrollHeader("Edit: " + (currentSetlist ? currentSetlist.name : ""), 21), "");
    const songs = currentSetlist ? currentSetlist.songs : [];
    const items = songs.map((s, i) => ({ type: "song", index: i, name: shortSongName(s.name) || "" }));
    items.push({ type: "add" });
    drawMenuList({
        items,
        selectedIndex: setlistSongIndex,
        getLabel: (item) => {
            if (item.type === "add") return "(add song)";
            /* Return the full name so the shared list scroller marquees the
             * selected row instead of hard-truncating it. */
            return item.name || "";
        },
        getValue: (item) => {
            if (item.type === "add") return "";
            return "";
        },
        maxVisible: 5
    });
}

function drawSetlistPick() {
    drawMenuHeader(scrollHeader("Add Song: " + (currentSetlist ? shortSongName(currentSetlist.name) : ""), 21), "");
    const items = songFiles.map(f => ({ label: shortSongName(f.name || f) }));
    drawMenuList({
        items,
        selectedIndex: setlistPickIndex,
        getLabel: (item) => item.label,
        getValue: () => "",
        maxVisible: 5
    });
}

function drawSectionPick() {
    drawMenuHeader("New Section Name", "");
    const items = SECTION_NAMES.map(n => ({ label: n }));
    drawMenuList({
        items,
        selectedIndex: sectionPickIndex,
        getLabel: (item) => item.label,
        getValue: () => "",
        maxVisible: 5
    });
}

function drawSetlistClick() {
    const entry = currentSetlist ? currentSetlist.songs[setlistSongIndex] : null;
    drawMenuHeader(scrollHeader("Edit: " + (entry ? shortSongName(entry.name) : ""), 21), "");
    const bars = entry ? (entry.click_bars || 0) : 0;
    const note = entry ? (entry.click_note || 0) : 0;
    const stop = entry ? (entry.stop_after_finish || false) : false;
    const items = [
        { key: "bars", label: "Click Bars", value: bars === 0 ? "Off" : String(bars) },
        { key: "note", label: "Click Note", value: note === 0 ? "None" : String(note) },
        { key: "stop", label: "Stop At End", value: stop ? "Yes" : "No" }
    ];
    drawMenuList({
        items,
        selectedIndex: clickSettingsFocus,
        getLabel: (item) => item.label,
        getValue: (item) => item.value,
        valueAlignRight: true,
        editMode: clickSettingsEditing,
        labelGap: 2,
        listArea: { topY: LIST_TOP_Y, bottomY: LIST_INDICATOR_BOTTOM_Y }
    });
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
                nextSecName = "→ next song";
            }
        } else if (playbackSectionIndex + 1 < fullSong.sections.length) {
            nextSecName = fullSong.sections[playbackSectionIndex + 1]?.name || "";
        } else if (currentSetlist && currentSetlist.songs[perfSongIndex + 1]) {
            nextSecName = "→ next song";
        }
    }
    logDebug("PERFDISP song=" + songName + " sec=" + secName + " nextSec=" + nextSecName +
        " hasClick=" + hasClick + " clickPlaying=" + perfClickPlaying + " perfPlaying=" + perfPlaying +
        " perfSelected=" + perfSelectedSection + " playbackSection=" + playbackSectionIndex);

    /* Scroll each info line independently so long song/section names marquee
     * instead of being hard-truncated. */
    const perfLines = [songName, secName, nextSecName || "—", nextSongName || "—"];
    const perfPrefixes = ["Now:  ", " Sec:  ", " NSec: ", "Next: "];
    const perfYs = [2, 16, 30, 44];
    for (let i = 0; i < 4; i++) {
        const scroller = perfLineScrollers[i];
        scroller.setSelected(perfLines[i]);
        scroller.tick();
        let text = perfLines[i];
        if (text.length > PERF_LINE_MAX_CHARS) {
            text = scroller.getScrolledText(text, PERF_LINE_MAX_CHARS);
        }
        print(2, perfYs[i], perfPrefixes[i] + text, 1);
    }
}

function drawPerfSetlist() {
    drawMenuHeader("Select Setlist", "");
    const items = setlistFiles.map(f => ({ label: f.name || f }));
    drawMenuList({
        items,
        selectedIndex: perfSetlistIndex,
        getLabel: (item) => item.label,
        getValue: () => "",
        maxVisible: 5
    });
}

/* ── Jam mode ───────────────────────────────────────────────────────── */

/* Load the clips for the given folder index into the Jam groove/fill lists. */
function jamLoadFolder(folderIndex) {
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
    drawMenuHeader("Jam Folder", "");
    const items = libraryFolders.map(f => ({ label: shortSongName(f) }));
    /* Widen the label area (labelX/labelGap at 0) so folder names can use the
     * full row up to the scroll-arrow column instead of being cut to ~16 chars
     * with blank space on the right. */
    drawMenuList({
        items,
        selectedIndex: jamFolderIndex,
        getLabel: (item) => item.label,
        getValue: () => "",
        labelX: 0,
        labelGap: 0,
        maxVisible: 5
    });
}

function drawJam() {
    const folderName = libraryFolders[jamFolderIndex] || "";
    const shortFolder = shortSongName(folderName);
    jamHeaderScroller.setSelected(shortFolder);
    jamHeaderScroller.tick();
    /* The screen fits ~21 chars. The "Jam: " prefix takes 5, and the play
     * indicator (●) on the right takes ~2, so the folder name gets 14 chars
     * while playing and 16 otherwise. Scroll longer names within that width. */
    const maxName = jamPlaying ? 14 : 16;
    let header = shortFolder;
    if (header.length > maxName) header = jamHeaderScroller.getScrolledText(header, maxName);
    drawMenuHeader("Jam: " + header, jamPlaying ? "●" : "");

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
    drawJamHoldOverlay();
}

/* Draw a centered overlay showing the held jam clip's name, marquee-scrolling
 * long names instead of hard-truncating them. Uses the shared scrolling
 * overlay helper. */
function drawJamHoldOverlay() {
    if (!jamHoldOverlayShown || !jamHoldName) return;
    drawScrollingOverlay(jamHoldScroller, jamHoldName, jamHoldBars);
}

/* ── Input handling ─────────────────────────────────────────────────── */

function handleRootInput(cc, value) {
    const items = ["Song Builder", "Setlists", "Perform", "Jam", "Output"];
    if (cc === MoveMainKnob) {
        const delta = decodeDelta(value);
        const idx = menuStack.getSelectedIndex();
        const newIdx = Math.max(0, Math.min(items.length - 1, idx + delta));
        if (newIdx !== idx) {
            menuStack.setSelectedIndex(newIdx);
            needsRedraw = true;
        }
    } else if (cc === MoveBack && value > 0) {
        if (shiftHeld) {
            /* Shift + Back suspends the module (keeps running in background). */
            if (typeof host_suspend_overtake === "function") {
                host_suspend_overtake();
            }
        } else {
            if (typeof host_exit_module === "function") {
                host_exit_module();
            } else if (typeof host_return_to_menu === "function") {
                host_return_to_menu();
            }
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
            jamFolderIndex = 0;
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
    if (cc === MoveMainKnob) {
        const delta = decodeDelta(value);
        const newIdx = Math.max(0, Math.min(libraryFolders.length - 1, selectedFolderIndex + delta));
        if (newIdx !== selectedFolderIndex) {
            selectedFolderIndex = newIdx;
            needsRedraw = true;
        }
    } else if (cc === MoveMainButton && value > 0) {
        const folder = libraryFolders[selectedFolderIndex];
        if (builderChangeFolder) {
            /* Re-selecting the source folder for the current song: update the
             * song's source_folder and reload the clip palette from it. */
            builderChangeFolder = false;
            if (currentSong) {
                currentSong.source_folder = folder;
                unsavedChanges = true;
            }
            currentView = VIEW_BUILDER;
            menuStack.pop();
            builderPage = 0;
            loadFolderClips(selectedFolderIndex);
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
                currentSong.name = songName;
                currentSectionIndex = 0;
                builderCursor = 0;
                currentView = VIEW_BUILDER;
                menuStack.push({ title: "Arrange", selectedIndex: 0 });
                builderPage = 0;
                loadFolderClips(selectedFolderIndex);
                stepLedsDirty = true;
                needsRedraw = true;
            },
            onCancel: () => {
                startNewSong(folder);
            }
        });
        needsRedraw = true;
    } else if (cc === MoveBack && value > 0) {
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
    if (cc === MoveMainKnob) {
        const delta = decodeDelta(value);
        if (shiftHeld) {
            if (builderCursor >= 0) {
                if (locked) return; /* no reordering clips in a locked song */
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
        openSongSettings();
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
        if (builderCursor === -1) {
            /* Section header -> rename (blocked when locked). */
            const section = sec;
            if (section && !locked) {
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
        } else if (builderCursor < sec.clips.length) {
            /* Clip -> open trim (blocked when locked). */
            if (!locked) openTrimView();
        }
        /* Otherwise the cursor is on the "(add clip)" row of an empty section,
         * which is not clickable. */
    } else if (cc === MoveDelete && value > 0) {
        if (locked) return; /* cannot delete sections/clips in a locked song */
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
        if (playbackState === "playing") {
            stopPlayback();
        } else if (shiftHeld) {
            /* Shift + Play starts playback from the beginning of the song,
             * playing through to the end without looping. */
            saveCurrentSong();
            const savedLoop = dspLoopEnabled;
            dspLoopEnabled = false;
            playCurrentSong();
            dspLoopEnabled = savedLoop;
        } else {
            previewClipAtCursor();
        }
    } else if (cc === MoveCopy && value > 0) {
        if (locked) return; /* cannot duplicate in a locked song */
        if (shiftHeld) {
            duplicateCurrentSection();
        } else {
            duplicateClipAtCursor();
        }
    } else if (cc === MoveLoop && value > 0) {
        if (locked) return; /* cannot add sections in a locked song */
        if (shiftHeld) {
            /* Shift + Loop opens a picker of common section names, then adds
             * a new empty section with the chosen name after the current one. */
            sectionPickIndex = 0;
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
            if (locked) return; /* cannot reorder sections in a locked song */
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
                stepScrollOffset = 0;
                builderDisplaySection = playbackState === "playing" ? currentSectionIndex : -1;
                stepLedsDirty = true;
                needsRedraw = true;
            }
        }
    } else if (cc === MoveRight && value > 0) {
        if (shiftHeld) {
            if (locked) return; /* cannot reorder sections in a locked song */
            moveSectionInSong(1);
        } else if (currentSong) {
            const navBase = playbackState === "playing"
                ? (builderDisplaySection >= 0 ? builderDisplaySection : playbackSectionIndex)
                : currentSectionIndex;
            if (navBase < currentSong.sections.length - 1) {
                currentSectionIndex = navBase + 1;
                builderCursor = 0;
                stepScrollOffset = 0;
                builderDisplaySection = playbackState === "playing" ? currentSectionIndex : -1;
                stepLedsDirty = true;
                needsRedraw = true;
            }
        }
    } else if (cc === MoveRecord && value > 0) {
        /* Reopen the Source Folder list to change the current song's folder.
         * Blocked on a locked song. */
        if (locked) return;
        builderChangeFolder = true;
        currentView = VIEW_FOLDER_LIST;
        menuStack.push({ title: "Source Folder", selectedIndex: 0 });
        loadLibraryFolders();
        selectedFolderIndex = Math.max(0, libraryFolders.indexOf(currentSong ? currentSong.source_folder : ""));
        needsRedraw = true;
    }
}

function startNewSong(folderName) {
    currentMode = MODE_BUILDER;
    activeSongFile = null;
    currentSong = newSong(folderName);
    currentSectionIndex = 0;
    currentView = VIEW_BUILDER;
    menuStack.push({ title: "Arrange", selectedIndex: 0 });
    builderPage = 0;
    builderCursor = 0;
    loadFolderClips(selectedFolderIndex);
    pendingFolderClipLoadName = (folderClips.length === 0) ? (libraryFolders[selectedFolderIndex] || null) : null;
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
            }
            writeJson(newPath, obj);
            if (activeSongFile === entry.path) activeSongFile = newPath;
            reloadSongBankAndPreserveSelection();
            needsRedraw = true;
        },
        onCancel: () => { needsRedraw = true; }
    });
}

function openConfirm({ title, name, onConfirm, onCancel }) {
    confirmState = {
        title,
        name,
        labels: ["No", "Yes"],
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
    const { title, name, selectedIndex, labels } = confirmState;
    drawMenuHeader(title);
    /* Draw the quoted name locally (instead of the shared drawConfirmModal) so
     * long Song/Setlist names marquee rather than being hard-truncated. */
    if (name !== undefined && name !== null && name !== "") {
        const displayName = scrollHeader('"' + String(name) + '"', 20);
        print(4, LIST_TOP_Y, displayName, 1);
    }
    const listY = LIST_TOP_Y + 16;
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
    if (obj && obj.locked) return; /* a locked song cannot be deleted */
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
            /* Invalidate the DSP's cached song scan so the deleted song is
             * dropped from the bank list. */
            if (typeof host_module_set_param === "function") {
                host_module_set_param("scan_library", "1");
            }
            reloadSongBankAndPreserveSelection();
            needsRedraw = true;
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
        selectedFolderIndex = 0;
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
    loadFolderClips(libraryFolders.indexOf(srcFolder));
    /* If the DSP folder scan isn't ready yet (fresh boot), retry until the
     * clips arrive, then repaint the pads. Track the folder NAME so the retry
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

function handleOptionsInput(cc, value) {
    if (cc === MoveMainKnob) {
        const delta = decodeDelta(value);
        if (optionsEditing) {
            if (optionsFocus === 0) {
                /* Cycle through output targets. */
                const newIdx = Math.max(0, Math.min(OUTPUT_TARGETS.length - 1, selectedOutputIndex + delta));
                if (newIdx !== selectedOutputIndex) {
                    selectedOutputIndex = newIdx;
                    setOutputTarget(OUTPUT_TARGETS[selectedOutputIndex]);
                }
            } else if (optionsFocus === 1) {
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
            } else if (optionsFocus === 2) {
                /* Adjust the count-in click channel. 0 = follow the primary
                 * output channel (Default); 1-16 = explicit channel. */
                const newCh = Math.max(0, Math.min(16, clickChannel + delta));
                if (newCh !== clickChannel) {
                    clickChannel = newCh;
                    saveOutputSettings();
                }
            } else if (optionsFocus === 3) {
                /* Adjust the mid-clip swap guard (0-100%, in 5% steps). */
                const newG = Math.max(0, Math.min(1, swapGuardFraction + delta * 0.05));
                if (newG !== swapGuardFraction) {
                    swapGuardFraction = newG;
                    saveOutputSettings();
                    pushSwapGuardToDsp();
                }
            } else {
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
            const newIdx = Math.max(0, Math.min(4, optionsFocus + delta));
            if (newIdx !== optionsFocus) {
                optionsFocus = newIdx;
            }
        }
        needsRedraw = true;
    } else if (cc === MoveMainButton && value > 0) {
        optionsEditing = !optionsEditing;
        needsRedraw = true;
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

function handleSetlistEditInput(cc, value) {
    if (!currentSetlist) return;
    const itemCount = currentSetlist.songs.length + 1; /* songs + add entry */
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
        if (setlistSongIndex >= currentSetlist.songs.length) {
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
    } else if (cc === MoveLeft && value > 0 && setlistSongIndex < currentSetlist.songs.length) {
        moveSetlistSong(currentSetlist, setlistSongIndex, -1);
        needsRedraw = true;
    } else if (cc === MoveRight && value > 0 && setlistSongIndex < currentSetlist.songs.length) {
        moveSetlistSong(currentSetlist, setlistSongIndex, 1);
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
    if (cc === MoveMainKnob) {
        const delta = decodeDelta(value);
        const newIdx = Math.max(0, Math.min(SECTION_NAMES.length - 1, sectionPickIndex + delta));
        if (newIdx !== sectionPickIndex) {
            sectionPickIndex = newIdx;
            needsRedraw = true;
        }
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
        menuStack.pop();
        currentView = VIEW_BUILDER;
        needsRedraw = true;
    }
}

function handleSetlistClickInput(cc, value) {
    if (!currentSetlist) return;
    if (cc === MoveMainKnob) {
        const delta = decodeDelta(value);
        if (clickSettingsEditing) {
            if (clickSettingsFocus === 0) {
                const cur = currentSetlist.songs[setlistSongIndex].click_bars || 0;
                setSetlistClickBars(currentSetlist, setlistSongIndex, cur + delta);
            } else if (clickSettingsFocus === 1) {
                const cur = currentSetlist.songs[setlistSongIndex].click_note || 0;
                setSetlistClickNote(currentSetlist, setlistSongIndex, cur + delta);
            } else if (clickSettingsFocus === 2) {
                const cur = currentSetlist.songs[setlistSongIndex].stop_after_finish || false;
                setSetlistStopAfterFinish(currentSetlist, setlistSongIndex, !cur);
            }
        } else {
            clickSettingsFocus = Math.max(0, Math.min(2, clickSettingsFocus + delta));
        }
        needsRedraw = true;
    } else if (cc === MoveMainButton && value > 0) {
        clickSettingsEditing = !clickSettingsEditing;
        needsRedraw = true;
    } else if (cc === MoveBack && value > 0) {
        if (clickSettingsEditing) {
            clickSettingsEditing = false;
            needsRedraw = true;
        } else {
            menuStack.pop();
            currentView = VIEW_SETLIST_EDIT;
            needsRedraw = true;
        }
    }
}

function handlePerformanceInput(cc, value) {
    /* Main knob is intentionally unused in performance view: song/section
     * selection is done with pads, and the display uses plain print(). */
    if (cc === MoveUp && value > 0) {
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
    } else if (cc === MoveBack && value > 0) {
        perfStop();
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
            currentSetlist = obj;
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
                perfLoadSong(firstPlayable);
            }
            perfSongSections = buildPerfLayout();
            currentView = VIEW_PERFORMANCE;
            menuStack.push({ title: "Performance", selectedIndex: 0 });
            needsRedraw = true;
            stepLedsDirty = true;
            ledDirtyAll = true;
        }
    } else if (cc === MoveBack && value > 0) {
        menuStack.pop();
        currentView = VIEW_ROOT;
        needsRedraw = true;
    }
}

/* ── Jam input handling ────────────────────────────────────────────── */

function handleJamFolderInput(cc, value) {
    if (cc === MoveMainKnob) {
        const delta = decodeDelta(value);
        const newIdx = Math.max(0, Math.min(libraryFolders.length - 1, jamFolderIndex + delta));
        if (newIdx !== jamFolderIndex) {
            jamFolderIndex = newIdx;
            needsRedraw = true;
        }
    } else if (cc === MoveMainButton && value > 0) {
        /* Enter the selected folder into the Jam screen. */
        jamLoadFolder(jamFolderIndex);
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
        jamBpm = inferTempoFromFolder(libraryFolders[jamFolderIndex] || "");
        currentView = VIEW_JAM;
        menuStack.push({ title: "Jam", selectedIndex: 0 });
        needsRedraw = true;
        stepLedsDirty = true;
        ledDirtyAll = true;
    } else if (cc === MoveBack && value > 0) {
        menuStack.pop();
        currentView = VIEW_ROOT;
        needsRedraw = true;
    }
}

/* Build a one-section engine song JSON for a single clip. */
function jamClipToSongJson(clip) {
    const base = newSong(libraryFolders[jamFolderIndex] || "");
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
function jamPreloadClip(clip, resumeTick) {
    if (!clip) return;
    if (typeof host_module_set_param !== "function") return;
    const json = jamClipToSongJson(clip);
    const isFill = clip.type === "fill";
    const nonLoop = isNonLoopingClip(clip);
    const loopVal = nonLoop ? "0" : "1";
    const rTick = resumeTick || 0;
    logJam("PRELOAD clip=" + (clip.name || clip.path) + " type=" + (clip.type || "?") + " bpm=" + jamBpm + " loop=" + loopVal + " resume=" + rTick + " json_len=" + json.length);
    if (typeof host_module_set_param_blocking === "function") {
        host_module_set_param_blocking("preload_song_json", json, 500);
        host_module_set_param_blocking("loop", loopVal, 100);
        host_module_set_param_blocking("swap_resume", String(rTick), 100);
    } else {
        host_module_set_param("preload_song_json", json);
        host_module_set_param("loop", loopVal);
        host_module_set_param("swap_resume", String(rTick));
    }
    jamStagedClip = clip;
    jamStagedIsFill = isFill;
    jamStagedResumeTick = rTick;
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
    if (typeof host_module_set_param_blocking === "function") {
        host_module_set_param_blocking("loop", swapLoop, 100);
        host_module_set_param_blocking("swap", targetTick, 500);
    } else {
        host_module_set_param("loop", swapLoop);
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
function jamPlayClip(clip) {
    if (!clip) return;
    const saved = currentSong;
    const savedLoop = dspLoopEnabled;
    currentSong = null; /* playCurrentSong will receive pendingSongJson from the temp song below */
    previewBarOffset = 0;
    dspLoopEnabled = true; /* always loop in Jam mode */

    const temp = newSong(libraryFolders[jamFolderIndex] || "");
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
    playCurrentSong();
    /* Re-assert the correct loop mode on the DSP after playback starts. The
     * DSP's song_json handler resets e->loop to 0, and the dspLoopEnabled
     * restore below runs before a reliable loop value is guaranteed. */
    if (typeof host_module_set_param === "function") {
        host_module_set_param("loop", isNonLoopingClip(clip) ? "0" : "1");
    }
    dspLoopEnabled = savedLoop;
    currentSong = saved;
    jamCurrentClip = clip;
    jamCurrentType = clip.type || "groove";
    jamLastBarCounter = -1;
    jamLastWrapCounter = -1;
    jamLastSwapCounter = -1;
    /* Wait one tick after starting a clip before evaluating boundaries, so the
     * first bar=1 (which the DSP always reports at playback start) isn't
     * mistaken for a loop wrap / groove finish. Without this, fills are cut
     * instantly and a just-started groove immediately tries to "finish". */
    jamSettling = true;
    jamStagedClip = null;
    playbackSectionIndex = 0;
    resetStepFlash();
    needsRedraw = true;
    stepLedsDirty = true;
    logJam("PLAY clip=" + (clip.name || clip.path) + " bars=" + (clip.bars || 1) +
        " type=" + (clip.type || "?") + " loop=" + dspLoopEnabled + " bpm=" + jamBpm);
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
        jamStagedClip = clip;
        jamStagedIsFill = false;
        jamPreloadClip(clip);
        if (typeof host_module_set_param_blocking === "function") {
            host_module_set_param_blocking("swap", "0", 100);
        } else if (typeof host_module_set_param === "function") {
            host_module_set_param("swap", "0");
        }
        const curBar = (lastDspTransport && lastDspTransport.bar) ? lastDspTransport.bar : 1;
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
            jamPreloadClip(clip);
            /* Pre-schedule the swap at the end of the current groove (its loop
             * wrap point), so the DSP applies it sample-accurately at the groove
             * end rather than at the next bar boundary. */
            const endTick = (dspTimelineInfo && dspTimelineInfo.end_tick) ? dspTimelineInfo.end_tick : 0;
            if (typeof host_module_set_param_blocking === "function") {
                host_module_set_param_blocking("swap", String(endTick), 100);
            } else if (typeof host_module_set_param === "function") {
                host_module_set_param("swap", String(endTick));
            }
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
    jamPreloadClip(clip);
    if (jamCurrentClip && jamCurrentClip.type === "fill") {
        /* A fill is playing: stage the new fill, no pre-scheduled swap. */
        jamScheduledSwapBar = -1;
        jamScheduledSwap = null;
        logJam("PAD fill queue while fill playing -> " + clip.name + " qLen=" + jamQueue.length);
        needsRedraw = true;
        ledDirtyAll = true;
        return;
    }
    const curBar = (lastDspTransport && lastDspTransport.bar) ? lastDspTransport.bar : 1;
    const tpb = (lastDspTransport && lastDspTransport.ticks_per_bar) ? lastDspTransport.ticks_per_bar : 240;
    const endTick = (dspTimelineInfo && dspTimelineInfo.end_tick) ? dspTimelineInfo.end_tick : 0;
    /* Record the 0-based groove index where this fill batch plays. The fill
     * fires at the start of bar curBar+1 (1-based), which is 0-based index
     * curBar. The groove resumes after the fills at this index plus the fill
     * bars played. Capture it at queue time (not fire time, when the transport
     * would show the fill's own bar 1). */
    jamFillBaseBar = curBar; /* 0-based groove index the fill starts on */
    jamFillsPlayedBars = 0;
    /* The fill fires at the next bar boundary. curBar is 1-based; the next
     * boundary (start of bar curBar+1) is at tick = curBar * tpb. Using
     * (curBar+1)*tpb would target one bar too far and make the fill play one
     * bar late. Clamp to the groove's end so a fill queued in the last bar
     * swaps at the loop wrap instead of a target that never fires. */
    let tick = curBar * tpb;
    if (endTick > 0 && tick > endTick) tick = endTick;
    jamScheduledSwapBar = curBar + 1;
    jamScheduledSwap = clip;
    logJam("PAD fill queue at bar " + jamScheduledSwapBar + " -> " + clip.name + " qLen=" + jamQueue.length);
    if (typeof host_module_set_param_blocking === "function") {
        host_module_set_param_blocking("swap", String(tick), 100);
    } else if (typeof host_module_set_param === "function") {
        host_module_set_param("swap", String(tick));
    }
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
    if (canSwap) {
        jamSwapStaged(clip);
    } else {
        jamPlayClip(clip);
    }
    /* Reset the fill page only when switching to a GROOVE (the fill list is
     * re-filtered for the new groove). When a fill plays, keep the current
     * fill page so the fills don't jump while the fill is queued/playing. */
    if (clip.type !== "fill") {
        jamFillScroll = 0;
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
    if (cc === MoveMainKnob) {
        const delta = decodeDelta(value);
        /* Jog wheel adjusts the BPM in realtime (no restart). */
        const newBpm = Math.max(20, Math.min(300, jamBpm + delta));
        if (newBpm !== jamBpm) {
            jamBpm = newBpm;
            if (typeof host_module_set_param === "function") {
                host_module_set_param("tempo", String(jamBpm));
            }
            needsRedraw = true;
        }
    } else if (cc === MoveShift) {
        shiftHeld = value > 0;
    } else if (cc === MoveUp && value > 0) {
        /* Reversed: Up scrolls the groove pads down (next page). */
        const maxScroll = Math.max(0, Math.ceil(jamGrooves.length / 16) - 1);
        jamGrooveScroll = Math.min(maxScroll, jamGrooveScroll + 1);
        needsRedraw = true;
        ledDirtyAll = true;
    } else if (cc === MoveDown && value > 0) {
        /* Reversed: Down scrolls the groove pads up (previous page). */
        const maxScroll = Math.max(0, Math.ceil(jamGrooves.length / 16) - 1);
        jamGrooveScroll = Math.max(0, jamGrooveScroll - 1);
        needsRedraw = true;
        ledDirtyAll = true;
    } else if (cc === MoveLeft && value > 0) {
        /* Left scrolls the fills up (previous page). */
        const fills = jamVisibleFills();
        const maxFillScroll = Math.max(0, Math.ceil(fills.length / 16) - 1);
        jamFillScroll = Math.max(0, jamFillScroll - 1);
        needsRedraw = true;
        ledDirtyAll = true;
    } else if (cc === MoveRight && value > 0) {
        /* Right scrolls the fills down (next page). */
        const fills = jamVisibleFills();
        const maxFillScroll = Math.max(0, Math.ceil(fills.length / 16) - 1);
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
            hideOverlay();
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
            stopPlayback();
            jamCurrentClip = null;
            jamCurrentType = "";
            needsRedraw = true;
            stepLedsDirty = true;
            ledDirtyAll = true;
        }
    } else if (cc === MoveBack && value > 0) {
        /* Stop and return to the folder picker. */
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
        hideOverlay();
        stopPlayback();
        menuStack.pop();
        currentView = VIEW_JAM_FOLDER;
        needsRedraw = true;
        stepLedsDirty = true;
        ledDirtyAll = true;
    }
}

/* Handle a pad press in Jam mode. Left 4 columns = grooves (scrollable),
 * right 4 columns = fills (filtered by current groove type). */
function handleJamPad(padIndex, velocity) {
    const col = padIndex % 8;
    const row = Math.floor(padIndex / 8);
    let clip = null;
    if (col < 4) {
        /* Groove pad. */
        const idx = (row + jamGrooveScroll * 4) * 4 + col;
        clip = jamGrooves[idx];
    } else {
        /* Fill pad. */
        const fills = jamVisibleFills();
        const fillIdx = (row + jamFillScroll * 4) * 4 + (col - 4);
        clip = fills[fillIdx];
    }
    if (!clip) return;

    const isPress = velocity > 0;
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
        hideOverlay();
        if (jamPreviewScheduled) {
            /* Preview was playing: stop it (one-shot released). */
            logJam("PREVIEW release clip=" + (jamPreviewClip.name || "?") + " heldMs=" + heldMs);
            jamStopPlayback();
        } else {
            /* Quick press (released before the delay): start loop playback. */
            if (col < 4) jamQueueGroove(clip);
            else jamQueueFill(clip);
        }
        jamPreviewPad = -1;
        jamPreviewClip = null;
        jamPreviewScheduled = false;
        jamPreviewStartTime = 0;
    }
    if (jamHoldPad === padIndex) {
        /* A held pad during playback: hide the hold-overlay. If it was a quick
         * press (released before the hold delay), queue the clip normally. */
        hideOverlay();
        if (!jamHoldOverlayShown) {
            if (col < 4) jamQueueGroove(clip);
            else jamQueueFill(clip);
        }
        jamHoldPad = -1;
        jamHoldClip = null;
        jamHoldTriggerTime = 0;
        jamHoldOverlayShown = false;
    }
}

function handlePadPress(note, velocity) {
    if (currentView === VIEW_BUILDER) {
        handleBuilderPad(note, velocity);
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
    const newClip = {
        source: clip.path,
        name: clip.name,
        type: clip.type || inferPartTypeFromFilename(clip.name || clip.path || ""),
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
    const insertIdx = Math.max(0, Math.min(sec.clips.length, builderCursor + 1));
    sec.clips.splice(insertIdx, 0, newClip);
    builderCursor = Math.min(insertIdx, sec.clips.length);
    unsavedChanges = true;
    stepLedsDirty = true;
    needsRedraw = true;
}

/* The section index the builder is currently showing. During playback this is
 * the auto-followed section (or the one the user jumped to via
 * builderDisplaySection), not the stale currentSectionIndex. */
function builderDisplaySectionIndex() {
    return playbackState === "playing"
        ? (builderDisplaySection >= 0 ? builderDisplaySection : playbackSectionIndex)
        : currentSectionIndex;
}

function deleteClipAtCursor() {
    const sec = currentSong ? currentSong.sections[builderDisplaySectionIndex()] : null;
    if (!sec || builderCursor < 0 || builderCursor >= sec.clips.length) return;
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
    if (songIsLocked()) return; /* cannot add/insert clips in a locked song */
    const padIndex = getPadIndex(note);
    if (padIndex < 0) return;
    const clip = clipForBuilderPad(padIndex);
    if (!clip) return;
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
        hideOverlay();
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
            builderPreviewName = "";
            builderPreviewBars = 0;
            stepLedsDirty = true;
        }
        padPreviewScheduled = false;
        previewStartTime = 0;
    }
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

function playFromCurrentSection() {
    const sec = currentSong ? currentSong.sections[currentSectionIndex] : null;
    if (!sec || !sec.clips || sec.clips.length === 0) return;
    /* Play from the current section through the end of the song. */
    const temp = JSON.parse(JSON.stringify(currentSong));
    temp.sections = JSON.parse(JSON.stringify(currentSong.sections.slice(currentSectionIndex)));
    let barOffset = 0;
    for (let i = 0; i < currentSectionIndex; i++) {
        barOffset += sectionBars(currentSong.sections[i]);
    }
    const saved = currentSong;
    const savedLoop = dspLoopEnabled;
    currentSong = temp;
    previewBarOffset = barOffset;
    dspLoopEnabled = false;
    playCurrentSong();
    dspLoopEnabled = savedLoop;
    currentSong = saved;
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
    playCurrentSong();
    dspLoopEnabled = savedLoop;
    currentSong = saved;
}

function previewClipAtCursor() {
    const sec = currentSong ? currentSong.sections[currentSectionIndex] : null;
    if (!sec || builderCursor < 0 || builderCursor >= sec.clips.length) {
        playFromCurrentSection();
        return;
    }
    /* Play from the cursor clip in the current section through the end of the
     * song. The first section keeps only the clips from the cursor onward,
     * preserving their original trims. */
    const fromCursorClips = sec.clips.slice(builderCursor).map(c => ({
        source: c.source,
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
    temp.sections[0].id = "play-from-cursor-" + Date.now();
    temp.sections[0].clips = fromCursorClips;
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
    playCurrentSong();
    dspLoopEnabled = savedLoop;
    currentSong = saved;
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
        const song = readJson(entry.path);
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
function perfLoadSong(index) {
    if (!currentSetlist) return false;
    if (index < 0 || index >= currentSetlist.songs.length) return false;
    const entry = currentSetlist.songs[index];
    if (!entry || !loadSongFile(entry.path)) return false;
    currentMode = MODE_PERFORMANCE;
    perfSongIndex = index;
    perfSongLoaded = true;
    perfFullSong = JSON.parse(JSON.stringify(currentSong));
    perfFullSongLoaded = false; /* DSP gets it on the next playCurrentSong */
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
    return true;
}

/* Play the current song through the DSP. If the setlist entry has a click
 * (click_bars > 0), first play a separate count-in click timeline, then the
 * real song. The click is a generated MIDI file (or pad-flash only if
 * click_note is 0). */
function perfPlayCurrent() {
    if (!currentSong) return;
    const entry = currentSetlist ? currentSetlist.songs[perfSongIndex] : null;
    const clickBars = entry ? (entry.click_bars || 0) : 0;
    const clickNote = entry ? (entry.click_note || 0) : 0;
    logClick("PERFCLICK bars=" + clickBars + " note=" + clickNote + " songBars=" + (currentSong.sections ? currentSong.sections.length : 0) +
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
                velocity_scale: 1.0,
                /* Route the count-in click to its own MIDI channel so it can
                 * be separated from the song/primary output. */
                channel: activeClickChannel()
            }]
        }];
        currentSong = clickSong;
        playbackSectionIndex = 0;
        previewBarOffset = 0;
        logClick("PERFCLICK path=" + clickMidiPath + " json=" + JSON.stringify(toEngineSongJson(clickSong)));
        perfClickPlaying = true;
        perfClickDsp = true;
        perfClickMute = (clickNote <= 0);
        perfClickStartMs = Date.now();
        /* Force a full step-LED redraw so the count-in click's steps (blue)
         * replace any steps left lit by the previous song's last section.
         * Do NOT clearStepLEDs() first — those black messages get wiped by
         * ledQueue.length=0 in updateLEDs, leaving the old section's steps
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
    if (typeof host_module_set_param_blocking === "function") {
        host_module_set_param_blocking("preload_song_json", json, 500);
        /* The staged song plays through once then stops (performance songs
         * advance, they don't loop). */
        host_module_set_param_blocking("loop", "0", 100);
    } else {
        host_module_set_param("preload_song_json", json);
        host_module_set_param("loop", "0");
    }
    perfClickSongStaged = true;
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
        /* Round the target bar UP so we don't land early and skip the start of
         * the target section (the DSP seeks to whole bars only). */
        const targetBar = targetRange ? Math.ceil(targetRange.startBar) : 0;
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
function perfFireSectionJump(sectionIndex) {
    const full = perfFullSong || currentSong;
    if (!full || sectionIndex < 0 || sectionIndex >= full.sections.length) return;
    const range = perfSectionBarRange(sectionIndex);
    if (!range) return;
    const startBar = range.startBar;
    currentSectionIndex = sectionIndex;
    dspLoopEnabled = false;
    if (perfFullSongLoaded && typeof host_module_set_param === "function") {
        /* Full song is in the DSP. If the seek was already scheduled
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
    } else {
        /* Full song not yet in the DSP: rebuild a sliced one-shot timeline.
         * The sliced timeline starts at bar 1, so offset by startBar to map
         * back to the full song. */
        const temp = JSON.parse(JSON.stringify(full));
        temp.sections = JSON.parse(JSON.stringify(full.sections.slice(sectionIndex)));
        currentSong = temp;
        previewBarOffset = startBar;
        playCurrentSong();
        perfFullSongLoaded = true;
    }
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
    if (lastDspState && lastDspState.stopped_at_end) {
        if (perfClickPlaying && perfClickDsp) {
            logDebug("perfTick: DSP click end fallback");
            perfClickPlaying = false;
            perfClickMute = false;
            if (!perfClickSongStaged) {
                /* Staging wasn't ready: blocking rebuild (rare fallback). */
                if (perfLoadSong(perfSongIndex)) {
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



function loadLibraryFolders() {
    libraryFolders = [];
    if (typeof host_module_get_param !== "function") return;
    let count = 0;
    try {
        const cnt = host_module_get_param("folder_count");
        if (cnt) count = parseInt(cnt, 10);
    } catch (e) {}
    for (let i = 0; i < count; i++) {
        const name = host_module_get_param("folder_name_" + i);
        if (name) libraryFolders.push(name);
    }
    if (libraryFolders.length === 0) {
        host_module_set_param("scan_library", "1");
    }
}

function loadFolderClips(folderIndex) {
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

/* ── Pad helpers (local to avoid deprecated shared exports) ──────────── */

function isPadNote(noteNumber) {
    return MovePads.includes(noteNumber);
}

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
    loadSettings();
    applyOutputSettingsToDsp();
    logDebug("init: BUILD=" + UI_BUILD_VERSION + " library_root=" + LIBRARY_ROOT + " folders=" + libraryFolders.length + " songs=" + songFiles.length +
        " external_send=" + (typeof move_midi_external_send) + " shadow_send=" + (typeof shadow_send_midi_to_dsp));
    needsRedraw = true;
};

globalThis.tick = function() {
    /* Drain any pending MIDI output as early as possible in the callback so
     * events are not delayed by display/LED work. When the DSP is emitting
     * directly this acks the queue; otherwise the JS sends the events here. */
    drainOutputEvents();

    /* Always update DSP transport so every LED/draw call below uses the most
     * recent sample-accurate position. */
    if (currentView === VIEW_PERFORMANCE || currentView === VIEW_BUILDER || currentView === VIEW_JAM || playbackState === "playing") {
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
            /* Use the custom scrolling overlay so long clip names marquee
             * instead of being truncated by the shared drawOverlay(). */
            builderPreviewName = clipShortName(previewingClip);
            builderPreviewBars = bars;
            builderPreviewScroller.setSelected(builderPreviewName);
            showOverlay("", bars + " bar" + (bars > 1 ? "s" : ""), 0x7FFFFFFF);
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
            const clip = jamPreviewClip;
            const bars = clip.bars || 1;
            logJam("PREVIEW start one-shot -> " + (clip.name || clip.path) + " bars=" + bars);
            /* Play the clip as a one-shot (non-looping) from the start, using
             * the same single-clip path Jam uses. No return groove is staged:
             * the preview is a temporary audition that ends on release. */
            jamPreviewClip = clip;
            jamPreviewScheduled = true;
            jamPlayClip(clip);
            /* A preview is a temporary audition: force the engine to stop at
             * the end of the clip rather than loop. jamPlayClip sets loop on
             * by default; re-assert non-loop for the preview. */
            if (typeof host_module_set_param === "function") {
                host_module_set_param("loop", "0");
            }
        }
    }

    /* Jam hold-overlay: if playback is running and a jam pad is held past the
     * delay, show the clip name in the overlay without queueing it. */
    if (currentView === VIEW_JAM && jamPlaying && jamHoldClip && !jamHoldOverlayShown) {
        const elapsed = Date.now() - jamHoldTriggerTime;
        if (elapsed >= PAD_PREVIEW_DELAY_MS) {
            jamHoldOverlayShown = true;
            const clip = jamHoldClip;
            jamHoldName = clipShortName(clip);
            jamHoldBars = clipPlayBars(clip);
            jamHoldScroller.setSelected(jamHoldName);
            logJam("HOLD overlay -> " + (clip.name || clip.path) + " bars=" + jamHoldBars);
        }
    }

    /* Retry loading the builder's clip pads if they weren't ready yet (e.g.
     * a song opened on a fresh boot before the DSP folder scan finished).
     * Ensure libraryFolders is populated, re-resolve the folder by name, then
     * load the clips; once they arrive, force a pad repaint. */
    if (pendingFolderClipLoadName) {
        if (libraryFolders.length === 0) {
            loadLibraryFolders();
        }
        const fi = libraryFolders.indexOf(pendingFolderClipLoadName);
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

    if (needsRedraw) {
        updateLEDs();
    }
    /* Clear the pad-preview-stop suppression flag once the section steps have
     * been repainted, so it doesn't leak into later redraws. */
    if (padPreviewStopping) {
        padPreviewStopping = false;
    }
    if (tickOverlay()) {
        needsRedraw = true;
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
                case VIEW_SONG_BANK: drawSongBank(); break;
                case VIEW_OPTIONS: drawOptions(); break;
                case VIEW_SETLIST_BANK: drawSetlistBank(); break;
                case VIEW_SETLIST_EDIT: drawSetlistEdit(); break;
                case VIEW_SETLIST_PICK: drawSetlistPick(); break;
                case VIEW_SETLIST_CLICK: drawSetlistClick(); break;
                case VIEW_SECTION_PICK: drawSectionPick(); break;
                case VIEW_PERF_SETLIST: drawPerfSetlist(); break;
                case VIEW_PERFORMANCE: drawPerformance(); break;
                case VIEW_JAM_FOLDER: drawJamFolder(); break;
                case VIEW_JAM: drawJam(); break;
            }
        }
        needsRedraw = false;
    }

    /* Refresh builder/performance step LEDs every tick so the current-bar
     * flash stays in time even when no other redraw is triggered.
     * In performance view, click bars are only shown when no section is
     * selected while stopped, or during an active count-in. */
    if (currentView === VIEW_BUILDER || currentView === VIEW_PERFORMANCE) {
        if (currentView === VIEW_PERFORMANCE && perfClickBars > 0 &&
            (perfClickPlaying || (!perfPlaying && perfSelectedSection < 0))) {
            drawClickStepLEDs();
        } else {
            drawBuilderStepLEDs(false);
        }
    } else if (currentView === VIEW_JAM) {
        drawJamStepLEDs(false);
    }
    /* Beat flash is shown on the STEP LEDs only (drawBuilderStepLEDs /
     * drawClickStepLEDs above). The performance pads must NOT flash on the
     * beat: updatePerformancePadFlash used to toggle the active pad
     * white/green every beat, which overwrote the queued-repeat red on the
     * current section's last bar. Pads are drawn statically by
     * drawPerformanceLEDs (queued = white, last-bar imminent = red). */
    updateButtonLEDs();
    flushLedQueue();
};

globalThis.onMidiMessageInternal = function(data) {
    const status = data[0] & 0xF0;
    const cc = data[1];
    const value = data[2];

    if (status === 0xB0) {
        if (cc === MoveShift) {
            shiftHeld = value > 0;
            return;
        }
        if (isTextEntryActive()) {
            /* While editing a name, all input goes to the keyboard. The
             * previous screen's buttons (loop/delete/etc.) are ignored. */
            handleTextEntryMidi(data);
            needsRedraw = true;
            return;
        }
        if (confirmState) {
            handleConfirmInput(cc, value);
            return;
        }
        switch (currentView) {
            case VIEW_ROOT: handleRootInput(cc, value); break;
            case VIEW_FOLDER_LIST: handleFolderListInput(cc, value); break;
            case VIEW_BUILDER: handleBuilderInput(cc, value); break;
            case VIEW_TRIM: handleTrimInput(cc, value); break;
            case VIEW_SONG_SETTINGS: handleSongSettingsInput(cc, value); break;
            case VIEW_SONG_BANK: handleSongBankInput(cc, value); break;
            case VIEW_OPTIONS: handleOptionsInput(cc, value); break;
            case VIEW_SETLIST_BANK: handleSetlistBankInput(cc, value); break;
            case VIEW_SETLIST_EDIT: handleSetlistEditInput(cc, value); break;
            case VIEW_SETLIST_PICK: handleSetlistPickInput(cc, value); break;
            case VIEW_SETLIST_CLICK: handleSetlistClickInput(cc, value); break;
            case VIEW_SECTION_PICK: handleSectionPickInput(cc, value); break;
            case VIEW_PERF_SETLIST: handlePerfSetlistInput(cc, value); break;
            case VIEW_PERFORMANCE: handlePerformanceInput(cc, value); break;
            case VIEW_JAM_FOLDER: handleJamFolderInput(cc, value); break;
            case VIEW_JAM: handleJamInput(cc, value); break;
        }
    } else if (status === MidiNoteOn || status === MidiNoteOff) {
        if (isTextEntryActive()) {
            /* While editing a name, pads go to the keyboard (typing/select),
             * not to the previous screen's pad handlers. */
            handleTextEntryMidi(data);
            needsRedraw = true;
            return;
        }
        handlePadPress(cc, value);
    }
};

globalThis.onMidiMessageExternal = function onMidiMessageExternal(data) {
    /* Pass through external MIDI if needed */
};

globalThis.onResume = function onResume() {
    clearAllLEDs();
    resetLedState();
    if (typeof host_module_get_param === "function") {
        loadLibraryFolders();
        reloadSongBankAndPreserveSelection();
    }
    if (typeof host_module_set_param === "function") {
        host_module_set_param("library_root", LIBRARY_ROOT);
    }
    needsRedraw = true;
    logDebug("onResume: folders=" + libraryFolders.length + " songs=" + songFiles.length);
};

globalThis.onUnload = function onUnload() {
    stopPlayback();
    clearAllLEDs();
    resetLedState();
};
