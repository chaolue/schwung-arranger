/*
 * Arranger Engine — native overtake generator plugin for Schwung.
 *
 * Responsibilities:
 *  - Parse Standard MIDI File Type 1 from the user's MIDI library.
 *  - Build a merged, boundary-guarded event timeline per Arranger Song.
 *  - Drive playback from incoming MIDI clock, synced to Move's transport.
 *  - Emit note-on/note-off events to the host for routing (external / Move /
 *    Schwung chain) via the v2 generator plugin API.
 *
 * Based on schwung-midi-player/src/dsp/midi_player.c, adapted for:
 *  - multiple clips assembled into Sections/Songs;
 *  - boundary-guard algorithm at clip seams;
 *  - three selectable output targets (external/move/schwung) handled in JS UI;
 *  - malformed SMF track-length tolerance.
 */

/* Must be defined before any system header so CPU_ZERO/CPU_SET and
 * sched_setaffinity are available in the worker thread. */
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif

#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <stdint.h>
#include <stdatomic.h>
#include <math.h>
#include <stdarg.h>
#include <time.h>
#include <errno.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>
#include <dirent.h>
#include <ctype.h>
#include <pthread.h>
#include <semaphore.h>
#include <sched.h>
#include "plugin_api_v1.h"

static const host_api_v1_t *g_host;

/* Runtime debug flag. When 0 (default), arr_log/dsp_host_log skip all work,
 * so the hot audio path does no I/O. Set to 1 only when debugging. */
static int g_dsp_debug = 0;

/* arr_log/dsp_host_log do DIRECT fopen/fprintf/fclose and/or g_host->log --
 * real blocking I/O, safe ONLY on the SCHED_OTHER worker thread. They must
 * be called exclusively from worker-thread-only code (load_clip,
 * resolve_clip_index, build_timeline_targeted, parse_song_json,
 * parse_chords_and_instruments/parse_section_chords -- everything reached
 * through arranger_worker_iterate). Even gated behind g_dsp_debug (off by
 * default), a call reachable from the audio thread reintroduces the exact
 * stall this rearchitecture exists to eliminate the moment debug logging is
 * turned on -- which is exactly when this module gets debugged on real
 * hardware. Anything reachable from create_instance/destroy_instance/
 * set_param/get_param/on_midi/render_block MUST use dsp_log_enqueue_worker
 * instead (formats into a stack buffer and enqueues into the lock-free SPSC
 * ring g_log_ring; the worker thread's log_ring_drain does the actual I/O).
 * The ring is single-producer -- do not call dsp_log_enqueue_worker from the
 * worker thread itself, since arr_log/dsp_host_log already run I/O directly
 * there and mixing both into one ring would race two producers against the
 * lock-free head/tail update. See docs/REALTIME_SAFETY.md in the Schwung
 * host repo. */
static void arr_log(const char *fmt, ...) {
    /* Gate before any work so the hot RT path (e.g. LOOPSTOP on every loop
     * wrap) does no formatting or I/O when debug is off. */
    if (!fmt || !g_dsp_debug) return;
    va_list ap;
    va_start(ap, fmt);
    char buf[1024];
    vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);

    if (g_host && g_host->log) {
        char host_buf[1100];
        snprintf(host_buf, sizeof(host_buf), "[arr_dsp] %s", buf);
        g_host->log(host_buf);
    }

    FILE *fp = fopen("/data/UserData/UserLibrary/Arranger/.dsp_log", "a");
    if (fp) {
        struct timespec ts;
        clock_gettime(CLOCK_REALTIME, &ts);
        struct tm tm_info;
        localtime_r(&ts.tv_sec, &tm_info);
        fprintf(fp, "[%04d-%02d-%02d %02d:%02d:%02d.%03d] %s\n",
                tm_info.tm_year + 1900, tm_info.tm_mon + 1, tm_info.tm_mday,
                tm_info.tm_hour, tm_info.tm_min, tm_info.tm_sec,
                (int)(ts.tv_nsec / 1000000), buf);
        fclose(fp);
    }
}

/* Formatted host log, gated behind g_dsp_debug so the same on/off switch that
 * governs arr_log also governs these control-thread diagnostic messages. */
static void dsp_host_log(const char *fmt, ...) {
    if (!fmt || !g_dsp_debug) return;
    if (!g_host || !g_host->log) return;
    va_list ap;
    va_start(ap, fmt);
    char buf[1024];
    vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    g_host->log(buf);
}

/* -------------------------------------------------------------------------- */
/* Worker thread + logging ring buffer                                        */
/* -------------------------------------------------------------------------- */
/* The Schwung host has no control thread: every plugin entry point runs on
 * the SPI audio callback (SCHED_FIFO 90, core 3, ~900us budget). All file
 * I/O, allocation, and long builds must therefore move to a dedicated
 * SCHED_OTHER worker thread. The audio thread only ever posts to a semaphore,
 * sets/loads atomics, and reads the last value the worker published. */

#define LOG_RING_CAP 256
#define LOG_RING_MSG_LEN 256

typedef struct {
    char msg[LOG_RING_CAP][LOG_RING_MSG_LEN];
    _Atomic(uint32_t) head;   /* next slot to write (audio thread) */
    _Atomic(uint32_t) tail;   /* next slot to read (worker thread) */
} log_ring_t;

/* SPSC logging ring: the audio thread enqueues, the worker drains. */
static log_ring_t g_log_ring;

/* Forward declarations: the ring helpers and worker thread are defined after
 * the engine struct and copy_trunc (they reference both). */
static void log_ring_enqueue(log_ring_t *ring, const char *msg);
static void log_ring_drain(log_ring_t *ring);
static void dsp_log_enqueue_worker(const char *fmt, ...);
static void *arranger_worker_thread(void *arg);

#define MAX_TRACKS         64
#define MAX_EVENTS         65536
#define MAX_CLIP_EVENTS    65536
#define MAX_TRACK_NAME_LEN 48
#define QUEUE_CAP          2048
#define MAX_SONG_SECTIONS  64
#define MAX_SECTION_CLIPS  16
#define MAX_SOURCE_FOLDERS 256
#define MAX_CLIPS_PER_FOLDER 512
#define MAX_PATH_LEN       512
#define MAX_JSON_LEN       8192
#define MAX_SECTION_BARS   256   /* max bars per section for chord/instrument arrays */
#define MAX_INSTRUMENTS    2     /* two instrument tracks (Bass, Keys/Pads) */

/* Cap on the ASSEMBLED, multi-clip timeline built by the async primary/staging
 * channels (arranger_worker_iterate). Derived from MAX_CLIP_EVENTS (a per-clip
 * cap) rather than restated, so the relationship is a declared invariant, not
 * a coincidence. Real songs measured directly against this user's library:
 * 1747-3744 events -> 17-37x headroom. */
#define TIMELINE_MAX_EVENTS MAX_CLIP_EVENTS

/* Request payload buffer size for the async song_json/preload_song_json
 * channels. Matches SHADOW_PARAM_VALUE_LEN (the shadow_param transport's
 * value field size, schwung/src/host/shadow_constants.h) -- a song_json
 * string can never arrive larger than that over this transport. */
#define MAX_SONG_JSON_LEN 131072

/* Fixed double-buffer capacities for the folder/song scan caches. The worker
 * scans into the inactive slot; the audio thread reads the active slot. */
#define FOLDER_CACHE_MAX 512
#define SONG_CACHE_MAX   256

#define OUTPUT_TARGET_EXTERNAL 0
#define OUTPUT_TARGET_MOVE     1
#define OUTPUT_TARGET_SCHWUNG  2

/* -------------------------------------------------------------------------- */
/* SMF event (source clip space)                                              */
/* -------------------------------------------------------------------------- */

typedef struct {
    uint32_t tick;
    uint8_t  status;
    uint8_t  data1;
    uint8_t  data2;
    uint8_t  len;
    uint8_t  track;
    uint8_t  was_note_on;  /* 1 if this event was originally a note-on */
    uint8_t  note_off_generated; /* 1 if we generated a matching note-off */
    int8_t   channel_override; /* -1 = use engine output channel; else 0-15 */
} smf_event_t;

typedef struct {
    char     path[MAX_PATH_LEN];
    char     name[128];
    uint16_t division;
    uint32_t end_tick;
    int      event_count;
    smf_event_t *events;
} clip_t;

/* One entry in the lazy whole-library clip index: a clip leaf name mapped to
 * its resolved full path under library_root. Built only when a song needs the
 * whole-library recursive fallback (see clip_lookup_find). */
typedef struct {
    char leaf[128];
    char full_path[MAX_PATH_LEN];
} clip_lookup_entry_t;

/* -------------------------------------------------------------------------- */
/* Arrangement structures                                                     */
/* -------------------------------------------------------------------------- */

typedef struct {
    int clip_index;          /* index into engine->clips[] */
    int status;              /* 1 if fields were parsed for this clip */
    char source_folder[MAX_PATH_LEN]; /* per-clip source folder; "" = use song->source_folder */
    char source_path[MAX_PATH_LEN];  /* raw source path; resolved once source_folder is known */
    uint32_t start_bar;          /* bar-quantized trim (start) */
    uint32_t end_bar;            /* exclusive */
    uint32_t start_beat;         /* 0-based beat offset within start_bar (advanced trim) */
    uint32_t end_beat;           /* 0-based beat offset within end_bar (advanced trim) */
    double guard_fraction;       /* 0 = use engine default */
    double velocity_scale;       /* applied to note-on velocity */
    double speed;                /* 0.5x/1x/2x: compress/stretch this clip's bars */
    uint8_t snare_note;          /* MIDI note number treated as the snare (0 = disabled) */
    double snare_velocity_scale; /* applied to snare note-on velocity; 0 = drop snare hits */
    uint8_t kick_note;           /* bass kick note to thin (36 = GM kick; 0 = disabled) */
    uint8_t kick_target;         /* max kick hits per bar; 0 = disabled */
    int8_t  channel;             /* MIDI channel override for this clip; -1 = engine output channel */
} section_clip_t;

/* A chord on a bar: root note name, quality, optional bass note (slash chord). */
typedef struct {
    char root[8];
    char quality[8];
    char bass[8];            /* "" = no slash bass */
    uint8_t set;             /* 1 if this bar has a chord */
} chord_t;

/* MAX_INSTRUMENT_OVERRIDES is sparse (one entry per bar that actually
 * customizes octave/follow_note/voicing), far above realistic per-song use. */
#define MAX_INSTRUMENT_OVERRIDES 128

/* A per-bar override of octave/follow_note/voicing/inversion for one
 * instrument bar. A sentinel field ("use the track default") is:
 * octave == -128, follow_note < 0, voicing < 0, inversion < 0. Mute is NOT
 * part of this -- it's still carried entirely by instrument_t.bars,
 * unaffected by overrides. */
typedef struct {
    int16_t section;
    int16_t bar;
    int8_t  octave;
    int16_t follow_note;
    int8_t  voicing;
    int8_t  inversion;
} instrument_bar_override_t;

/* An instrument track: emits chord-derived notes on its own output/channel. */
typedef struct {
    uint8_t enabled;
    int output_target;       /* 0=external, 1=move, 2=schwung */
    int channel;             /* 0-15 */
    int octave;              /* octave offset applied to the emitted note */
    uint8_t follow_note;     /* drum note to follow (e.g. 36 = kick); 0 = off */
    uint8_t voicing;         /* 0 = bass (root/bass note), 1 = full chord */
    /* Full-chord inversion (voicing 1 only; meaningless for bass voicing):
     * 0 = root position, 1/2/3 = first/second/third inversion (clamped to
     * the chord's own tone count - 1 by chord_voiced_intervals -- a triad
     * has no third inversion). */
    uint8_t inversion;
    double note_gap;         /* gap (fraction of a beat) between note-off and the next note-on; 0 = none */
    /* Per-section per-bar on/off map: 1 = send, 0 = muted. */
    uint8_t bars[MAX_SONG_SECTIONS][MAX_SECTION_BARS];
    /* Sparse per-bar overrides of octave/follow_note/voicing/inversion. */
    instrument_bar_override_t overrides[MAX_INSTRUMENT_OVERRIDES];
    int override_count;
} instrument_t;

typedef struct {
    char name[64];
    int clip_count;
    section_clip_t clips[MAX_SECTION_CLIPS];
    uint32_t bars;           /* total bars after assembly */
    int chord_count;         /* number of bars with a chord set */
    chord_t chords[MAX_SECTION_BARS];
} section_t;

typedef struct {
    char name[64];
    char source_folder[MAX_PATH_LEN];
    double tempo_bpm;
    int time_sig_num;
    int time_sig_den;
    int section_count;
    section_t sections[MAX_SONG_SECTIONS];
    uint32_t total_bars;
    char key[8];             /* song key (tonic note name) */
    int instrument_count;
    instrument_t instruments[MAX_INSTRUMENTS];
} song_t;

/* -------------------------------------------------------------------------- */
/* Async timeline build: primary (song_json) and staging (preload_song_json)  */
/* channels. Both are drained by the one worker thread (arranger_engine.c's   */
/* SCHED_OTHER worker) using the same fixed-double-buffer + generation-       */
/* counter-coalescing house style already proven on hardware for the folder/  */
/* song scan caches (folder_cache_t/song_cache_t below): worker writes only   */
/* into slot [1-active], then flips active -- the audio thread never sees a   */
/* partially-written slot and the worker never writes the slot being read.    */
/*                                                                            */
/* Two independent channels, not one shared request/buffer: song_json and    */
/* preload_song_json are routinely issued back-to-back with zero tick gap    */
/* (e.g. Jam mode staging an intro groove immediately after starting a fill), */
/* and coalescing is only safe *within* one destination -- a shared slot      */
/* would let the second call silently discard the first before the worker    */
/* ever started it. Both channels still share the one worker thread and the  */
/* one e->clips[]/clip_count parsed-MIDI cache, since builds must stay        */
/* serialized regardless. */

/* One instance of this per destination (primary, staging). smf_event_t = the
 * assembled timeline; song_t = the render-relevant song structure (section
 * bars/chords, instruments) that emit_instruments_at_tick/_follow/_all_off
 * read every block -- publishing it alongside the events keeps that data
 * from going stale/torn once song parsing moves off the audio thread. */
typedef struct {
    smf_event_t events[TIMELINE_MAX_EVENTS];
    int         event_count;
    uint32_t    end_tick;
    double      tempo_bpm;
    int         time_sig_num;
    int         time_sig_den;
    uint32_t    ticks_per_beat;
    uint32_t    ticks_per_bar;
    char        source[MAX_PATH_LEN];  /* source path of the first clip, for active_source */
    song_t      song;
    int         truncated;             /* 1 if event_count hit TIMELINE_MAX_EVENTS */
    char        build_error[256];
} timeline_slot_t;

typedef struct {
    timeline_slot_t   slot[2];
    _Atomic(uint32_t) active;         /* which slot is safe to read */
    _Atomic(uint32_t) request_gen;    /* bumped by set_param (audio thread) on every accepted request */
    _Atomic(uint32_t) published_gen;  /* = the request_gen the worker actually built and published */

    /* Request payload: same fixed double-buffer + atomic-index pattern as
     * slot[]/active above (and folder_cache_t/song_cache_t further down),
     * not a seqlock. request_json used to be a single buffer guarded by a
     * request_seq seqlock (audio thread bumps it odd-then-even around the
     * write; the worker retries its read on a seq mismatch) -- correct by
     * construction (a mismatched seq is caught and retried) but still a raw
     * concurrent byte-level read/write on the buffer itself, which
     * ThreadSanitizer correctly flags as a data race per the C11 memory
     * model regardless of the surrounding algorithm's self-correction.
     * request_json[2] + request_active sidesteps that the same way the rest
     * of this file already does: the audio thread (the only writer) always
     * writes the buffer request_active does NOT currently point to, then
     * flips it with a release store; the worker (the only reader) acquire-
     * loads request_active and reads only that buffer, which the writer
     * cannot touch again until it becomes inactive after a later write. No
     * retry loop, and no byte-level access is ever concurrent. */
    char              request_json[2][MAX_SONG_JSON_LEN];
    _Atomic(int)      request_active;
} timeline_channel_t;

/* Diff of clips whose resolved location differs from their stored folder,
 * published by the worker after a successful PRIMARY build so
 * get_param("resolved_clips") never has to read e->clips[]/song live from the
 * audio thread (worker-owned once builds move off-thread). Same house style
 * as folder_cache_t/song_cache_t below. */
#define RESOLVED_CLIPS_MAX 64
typedef struct {
    char source[MAX_PATH_LEN];
    char folder[MAX_PATH_LEN];
} resolved_clip_diff_t;

typedef struct {
    resolved_clip_diff_t slot[2][RESOLVED_CLIPS_MAX];
    int                  count[2];
    _Atomic(int)         active;
} resolved_clips_cache_t;

/* Forward declarations for the library/song scan types and functions, used by
 * the engine's cached scan fields below. */
typedef struct engine engine_t;
typedef struct folder_entry folder_entry_t;
typedef struct song_entry song_entry_t;
static void scan_library_into(engine_t *e, folder_entry_t *folders, int *out_count);
static void scan_songs_into(engine_t *e, song_entry_t *songs, int *out_count);
static const char* clip_lookup_find(engine_t *e, const char *leaf);
static void clip_lookup_free(engine_t *e);
static void parse_chords_and_instruments(const char *json, song_t *song);
static void parse_section_chords(const char *arr, section_t *sec);
static void parse_instrument_bars(const char *arr, instrument_t *inst);
static void parse_instrument_overrides(const char *arr, instrument_t *inst);
static void schedule_instrument_note_off(engine_t *e, int i, const instrument_t *inst,
                                         uint32_t tick);
static void fire_pending_instrument_notes_off(engine_t *e, uint32_t tick);
static void emit_instruments_all_off(engine_t *e);

/* One lightweight snapshot of a folder under library_root.
 * Clips are stored as a single concatenated buffer to keep the entry small.
 * Must be >= MAX_CLIPS_PER_FOLDER so no clip is dropped from the scan. */
#define FOLDER_HEAP_CLIPS 512
struct folder_entry {
    char name[128];
    char path[MAX_PATH_LEN];
    char category[128];     /* category path (e.g. "Vintage/03 Swing"); "" for root-level folders */
    char *clip_names;       /* heap: clip_count * 128 byte slots */
    uint32_t *clip_bars;    /* heap: clip_count bar counts */
    int clip_count;
};

struct song_entry {
    char name[128];
    char path[MAX_PATH_LEN];
};

typedef struct {
    const char *name;
    uint32_t bars;
} clip_sort_pair_t;

static int clip_pair_cmp(const void *a, const void *b) {
    const clip_sort_pair_t *pa = (const clip_sort_pair_t *)a;
    const clip_sort_pair_t *pb = (const clip_sort_pair_t *)b;
    return strcasecmp(pa->name, pb->name);
}

static int folder_entry_cmp(const void *a, const void *b) {
    const folder_entry_t *fa = a, *fb = b;
    return strcasecmp(fa->name, fb->name);
}

static void copy_trunc(char *dst, size_t dst_size, const char *src) {
    size_t i = 0;
    while (i + 1 < dst_size && src[i] != '\0') {
        dst[i] = src[i];
        i++;
    }
    dst[i] = '\0';
}

/* -------------------------------------------------------------------------- */
/* Worker thread + logging ring buffer (bodies)                               */
/* -------------------------------------------------------------------------- */

/* Enqueue a formatted message into the SPSC ring. Safe to call from the audio
 * thread: no allocation, no I/O, no blocking. Drops the message if the ring
 * is full (oldest unread messages are preserved). */
static void log_ring_enqueue(log_ring_t *ring, const char *msg) {
    if (!ring || !msg) return;
    uint32_t head = atomic_load_explicit(&ring->head, memory_order_relaxed);
    uint32_t tail = atomic_load_explicit(&ring->tail, memory_order_acquire);
    if (head - tail >= LOG_RING_CAP) return; /* full */
    copy_trunc(ring->msg[head % LOG_RING_CAP], LOG_RING_MSG_LEN, msg);
    atomic_store_explicit(&ring->head, head + 1, memory_order_release);
}

/* Drain the ring on the worker thread, doing the actual vsnprintf/file I/O
 * that the audio thread must never do. */
static void log_ring_drain(log_ring_t *ring) {
    if (!ring) return;
    for (;;) {
        uint32_t tail = atomic_load_explicit(&ring->tail, memory_order_relaxed);
        uint32_t head = atomic_load_explicit(&ring->head, memory_order_acquire);
        if (tail == head) break;
        const char *msg = ring->msg[tail % LOG_RING_CAP];
        if (g_host && g_host->log) {
            char host_buf[LOG_RING_MSG_LEN + 16];
            snprintf(host_buf, sizeof(host_buf), "[arr_dsp] %s", msg);
            g_host->log(host_buf);
        }
        FILE *fp = fopen("/data/UserData/UserLibrary/Arranger/.dsp_log", "a");
        if (fp) {
            struct timespec ts;
            clock_gettime(CLOCK_REALTIME, &ts);
            struct tm tm_info;
            localtime_r(&ts.tv_sec, &tm_info);
            fprintf(fp, "[%04d-%02d-%02d %02d:%02d:%02d.%03d] %s\n",
                    tm_info.tm_year + 1900, tm_info.tm_mon + 1, tm_info.tm_mday,
                    tm_info.tm_hour, tm_info.tm_min, tm_info.tm_sec,
                    (int)(ts.tv_nsec / 1000000), msg);
            fclose(fp);
        }
        atomic_store_explicit(&ring->tail, tail + 1, memory_order_release);
    }
}

/* Audio-thread-safe formatted log: formats into a stack buffer and enqueues
 * into the ring. No I/O, no allocation, no blocking. */
static void dsp_log_enqueue_worker(const char *fmt, ...) {
    if (!fmt || !g_dsp_debug) return;
    va_list ap;
    va_start(ap, fmt);
    char buf[LOG_RING_MSG_LEN];
    vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    log_ring_enqueue(&g_log_ring, buf);
}

/* -------------------------------------------------------------------------- */
/* Engine instance                                                            */
/* -------------------------------------------------------------------------- */

typedef struct engine {
    /* Library root. The audio thread writes library_root_requested (from
     * set_param) and reads it back (get_param); the worker copies it into
     * library_root on wake and uses that for all scans/builds. Splitting the
     * two keeps the multi-byte string race-free: the audio thread never
     * writes the field the worker reads. */
    char library_root_requested[MAX_PATH_LEN];
    char library_root[MAX_PATH_LEN];

    /* Loaded clips (one per unique source file referenced by current song).
     * Worker-owned: only ever touched from arranger_worker_iterate's build
     * processing (parse_song_json/resolve_clip_index append to it), never
     * from the audio thread, now that builds no longer run inline inside
     * set_param. */
    clip_t clips[MAX_CLIPS_PER_FOLDER];
    int clip_count;

    /* Playback */
    int running;
    uint32_t playhead_tick;  /* absolute ticks in assembled timeline */
    int event_cursor;        /* next event in assembled timeline */

    /* Tempo/time-sig for current song */
    double tempo_bpm;
    int time_sig_num;
    int time_sig_den;
    uint32_t ticks_per_beat;
    uint32_t ticks_per_bar;

    uint32_t last_playhead_tick; /* for render_block delta fallback */
    double tick_remainder;       /* fractional ticks accumulated between blocks */

    /* Bar boundary counter: incremented every time the playhead crosses into a
     * new bar, including a loop wrap (where the bar number goes backwards) and
     * a seek. Exposed to the UI via the transport JSON so Jam/performance mode
     * can detect boundaries from the DSP's authoritative position instead of
     * inferring them from fragile bar/beat comparisons in JS. */
    uint32_t bar_counter;
    uint32_t last_bar;           /* bar of the previous playhead position */

    /* Loop wrap counter: incremented every time a looping timeline wraps back
     * to bar 1 (a full loop). Distinct from bar_counter so the UI can tell a
     * loop wrap (used for groove-end transitions) apart from a plain bar
     * advance (used for bar-end fill transitions). */
    uint32_t wrap_counter;

    /* Swap counter: incremented every time a staged timeline is activated via
     * a clip swap. Distinct from bar_counter/wrap_counter so the UI can detect
     * a same-path restart (e.g. pressing the current groove to restart it at
     * the bar boundary), where active_source and bar/wrap counters do not
     * change. */
    uint32_t swap_counter;

    /* Seek counter: incremented every time a pending_seek is applied (a
     * performance section jump/repeat). The seek's target bar may equal the
     * current section (a repeat), where the playhead stays in the same section
     * and neither bar_counter's bar nor the section index changes — so the UI
     * uses this monotonic counter to detect that the repeat actually fired and
     * clear its queued state, instead of remaining stuck on the section being
     * shown as "next". */
    uint32_t seek_counter;

    /* Number of note-ons suppressed by the mid-clip swap guard. Exposed via
     * get_param("swap_guard_suppressed") so the UI can confirm the guard is
     * actually being applied at swap boundaries. */
    uint32_t swap_guard_suppressed;

    /* Async primary (song_json) and staging (preload_song_json) build
     * channels -- see timeline_channel_t above. Both drained by the one
     * worker thread; set_param only ever writes request_json/request_active/
     * request_gen and posts worker_wake. */
    timeline_channel_t primary_ch;
    timeline_channel_t staging_ch;
    resolved_clips_cache_t resolved_clips;

    /* Audio-thread-owned "what's actually playing" buffer. Populated by a
     * bounded copy (never a pointer handoff) from primary_ch.slot[active] at
     * activation (set_param("play"/"play_from_bar")) or from staging_ch's/
     * pending_swap_slot's active content at a swap boundary. Nothing here is
     * ever freed -- there is nothing left to free once every buffer in this
     * pipeline is a fixed array. */
    timeline_slot_t live_slot;
    uint32_t primary_committed_gen; /* = primary_ch.published_gen last copied into live_slot */

    /* Source path of the clip currently playing in the active timeline.
     * Exposed to the JS UI via the "state" get_param so Jam mode can keep
     * the display/pads in sync with DSP-side auto-swaps. Set from
     * live_slot.source at each promotion point. */
    char active_source[MAX_PATH_LEN];

    /* Captured-at-schedule-time buffer for a scheduled clip swap (Jam mode
     * "swap"), fixed-buffer analog of the old pending_swap_timeline pointer
     * hand-off. Physically separate memory from staging_ch.slot[] -- a later
     * preload's worker write can never alias it, so (unlike the old pointer
     * dance) there is no hand-off discipline left to violate. */
    timeline_slot_t pending_swap_slot;
    uint32_t staging_consumed_gen;  /* = staging_ch.published_gen last captured/promoted */
    int staging_loop;               /* loop flag to apply on swap; see set_param("staging_loop") */
    uint32_t staging_resume_tick;   /* resume position (ticks) for the staged clip on swap; 0 = start */
    uint32_t swap_resume_tick;      /* resume position captured at swap time for the caller to apply */

    /* Diagnostic: bumped whenever set_param("swap") no-ops for lack of a
     * published staging build. Under correct JS-side gating (only calling
     * "swap" after staging_published_gen is confirmed) this should never
     * move in normal use -- a live regression tripwire. */
    _Atomic(uint32_t) staging_swap_rejected;

    /* Scheduled clip swap for sample-accurate transitions in Jam mode. */
    uint32_t pending_swap_tick;    /* tick at which to swap -> active */
    int pending_swap;              /* 1 if a swap is scheduled */
    int pending_swap_loop;         /* loop flag captured at swap-schedule time, applied on swap */
    uint32_t pending_swap_resume_tick; /* resume tick captured at swap-schedule time, applied on swap */
    /* Guard window start tick for the pending swap. Note-ons at or after this
     * tick (and before the swap boundary) are suppressed, so the guard applies
     * across every render block leading up to the swap, not just the block
     * that crosses the boundary. */
    uint32_t pending_swap_guard_start;
    int pending_swap_guard_active; /* 1 while the playhead is inside the guard window */

    /* Scheduled sample-accurate seek (performance section jumps). The seek to
     * `pending_seek_bar` is applied inside the audio callback exactly when the
     * playhead crosses `pending_seek_tick`, so a pad-press section jump lands
     * on the musical boundary instead of a polling-latency later. */
    uint32_t pending_seek_tick;    /* tick at which to apply the seek */
    int pending_seek;              /* 1 if a seek is scheduled */
    uint32_t pending_seek_bar;     /* bar (0-based) to seek to */
    uint32_t pending_seek_guard_start; /* guard window start tick for a manual mid-section seek */
    int pending_seek_guard_active; /* 1 while the playhead is inside the seek guard window */

    /* Pending output queue */
    uint8_t queue_status[QUEUE_CAP];
    uint8_t queue_d1[QUEUE_CAP];
    uint8_t queue_d2[QUEUE_CAP];
    uint8_t queue_len[QUEUE_CAP];
    int queue_head;
    int queue_tail;
    int queue_ack_mark;  /* index after the last event serialized for the UI */

    /* Settings */
    double guard_fraction;
    double swap_guard_fraction;  /* guard window (fraction of a beat) applied at a mid-clip swap boundary */
    int output_channel;      /* 0-15 */

    /* Direct event emission: when enabled, events are sent from the DSP
     * render block via host MIDI functions instead of being queued for the
     * JS UI. This removes the JS serialization/polling delay and improves
     * audible timing. */
    int emit_directly;

    /* Channel override of the most recently drained event, used by
     * emit_direct_event when a per-clip channel (e.g. a dedicated click
     * channel) should take precedence over the output-target channel. */
    int8_t last_event_channel_override;

    /* Beat flash trigger: toggled at exact beat boundaries and held for a
     * fraction of each beat. The UI reads this as part of the transport JSON
     * for sample-accurate LED flashing. */
    uint32_t flash_end_tick; /* playhead tick when current beat flash ends */



    /* Transport */
    int loop;                /* 1 = loop timeline, 0 = one-shot */
    int stopped_at_end;      /* 1 when one-shot reached end */

    /* Output routing */
    int output_target;       /* 0=external, 1=move, 2=schwung */
    int move_channel;        /* 0-15 */
    int schwung_channel;     /* 0-15 */

    /* Instrument-track emission state. Tracks the last chord emitted per
     * instrument so a chord change can send note-offs for the previous chord
     * (avoiding stuck notes). */
    chord_t last_inst_chord[MAX_INSTRUMENTS];
    uint8_t last_inst_chord_set[MAX_INSTRUMENTS];
    /* The resolved (per-bar-override-applied) instrument config used for the
     * currently-sounding chord's note-on, so a later note-off (deferred or
     * cut short by a mute/no-chord bar) targets the SAME octave/voicing it
     * was turned on with, even if the live per-bar override has since
     * changed (e.g. the playhead moved to a different bar). */
    instrument_t last_inst_resolved[MAX_INSTRUMENTS];
    /* Deferred note-off: when a chord is emitted, its note-off is scheduled
     * `note_gap` before the next note-on, so the previous note is cut short
     * rather than the new note being delayed. */
    uint32_t pending_off_tick[MAX_INSTRUMENTS];
    uint8_t pending_off_set[MAX_INSTRUMENTS];

    /* Folder/song scan caches as fixed double-buffers. The worker scans into
     * slot [1 - active] and flips active when done; the audio thread only
     * reads slot [active]. dirty is set by set_param("scan_library") /
     * library_root change and cleared by the worker once it rescans. */
    folder_entry_t folders[2][FOLDER_CACHE_MAX];
    int folder_count[2];
    _Atomic(int) folder_active;
    _Atomic(int) folder_dirty;
    song_entry_t songs[2][SONG_CACHE_MAX];
    int song_count[2];
    _Atomic(int) song_active;
    _Atomic(int) song_dirty;

    /* Worker thread. All file I/O, allocation, and long builds run here on
     * SCHED_OTHER; the audio thread only posts to worker_wake and reads
     * atomics. worker_running is set to 0 by destroy_instance to stop it. */
    pthread_t worker_thread;
    sem_t worker_wake;
    _Atomic(int) worker_running;

    /* Lazy whole-library clip index: maps a clip leaf name (e.g.
     * "072 S07 Verse Stick ALT.mid") to its full path under library_root.
     * Built only on the first clip that needs the expensive whole-library
     * recursive fallback in resolve_clip_index, so single-folder songs (which
     * resolve every clip via a direct path and never hit the fallback) never
     * pay the one-time build cost. Songs that pull clips from several folders
     * resolve every subsequent fallback clip from this hash instead of re-
     * walking the entire library tree once per clip — the source of the
     * multi-folder build delay. Invalidated alongside the library cache. */
    clip_lookup_entry_t *clip_index;
    int clip_index_cap;
    int clip_index_valid;
    /* Last error message */
    char error_msg[256];
} engine_t;

/* Forward declaration: the engine's deferred work, run on the worker thread
 * each wake. Defined after the scan helpers. */
static void arranger_worker_iterate(engine_t *e);

/* -------------------------------------------------------------------------- */
/* Worker thread body                                                         */
/* -------------------------------------------------------------------------- */

/* The worker thread. Demotes itself off SCHED_FIFO as its FIRST action (see
 * the comment in the body — this is the exact bug schwung-keydetect shipped),
 * then loops on the wake semaphore, draining the log ring and running the
 * engine's deferred work each iteration. */
static void *arranger_worker_thread(void *arg) {
    /* MUST be first, and MUST be sched_setscheduler — not nice().
     *
     * pthread_create() inherits the calling thread's scheduling policy.
     * create_instance() runs on Move's SPI audio callback (SCHED_FIFO 90),
     * so this thread is born SCHED_FIFO 90 too. nice() only affects
     * SCHED_OTHER/CFS threads — it is a documented no-op on a thread that
     * is still classified SCHED_FIFO, regardless of what priority value
     * you pass it. schwung-keydetect shipped exactly this bug: nice(10)
     * with no preceding sched_setscheduler call, verified via a ~200ms
     * FFT pass running at FIFO 70 (above Move's own Link Main at FIFO 35)
     * and causing periodic audio dropouts on a 4-second grid until fixed.
     * The scheduling *class* must change before priority is a meaningful
     * concept at all. */
    struct sched_param sp = { .sched_priority = 0 };
    if (sched_setscheduler(0, SCHED_OTHER, &sp) != 0) {
        /* arr_log, not dsp_log_enqueue_worker: this runs ON the worker
         * thread, and the ring is single-producer (the audio thread) --
         * enqueueing from here too would race that producer's lock-free
         * head/tail update. arr_log's direct fopen/fprintf is exactly what
         * the worker thread is for. */
        arr_log("worker: sched_setscheduler failed, errno=%d", errno);
        /* Fall through anyway — staying FIFO would be worse than logging
         * and continuing, and this thread still does no file I/O until
         * this call is confirmed, so the audio thread is not yet at risk. */
    }

    cpu_set_t set;
    CPU_ZERO(&set);
    CPU_SET(0, &set); CPU_SET(1, &set); CPU_SET(2, &set);   /* core 3 stays free for SPI */
    sched_setaffinity(0, sizeof(set), &set);

    engine_t *e = (engine_t*)arg;
    while (atomic_load_explicit(&e->worker_running, memory_order_acquire)) {
        sem_wait(&e->worker_wake);          /* worker's own thread: blocking here is fine */
        log_ring_drain(&g_log_ring);
        arranger_worker_iterate(e);
    }
    return NULL;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

static uint32_t read_be32(const uint8_t *p) {
    return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) |
           ((uint32_t)p[2] << 8)  | (uint32_t)p[3];
}

static uint16_t read_be16(const uint8_t *p) {
    return ((uint16_t)p[0] << 8) | (uint16_t)p[1];
}

static uint32_t read_vlq(const uint8_t **pp, const uint8_t *end) {
    uint32_t v = 0;
    while (*pp < end) {
        uint8_t b = *(*pp)++;
        v = (v << 7) | (b & 0x7F);
        if ((b & 0x80) == 0) return v;
    }
    return 0;
}

static int queue_full(const engine_t *e) { return ((e->queue_tail + 1) % QUEUE_CAP) == e->queue_head; }

static void queue_push(engine_t *e, uint8_t s, uint8_t d1, uint8_t d2, uint8_t len) {
    if (queue_full(e)) return;
    e->queue_status[e->queue_tail] = s;
    e->queue_d1[e->queue_tail]     = d1;
    e->queue_d2[e->queue_tail]     = d2;
    e->queue_len[e->queue_tail]    = len;
    e->queue_tail = (e->queue_tail + 1) % QUEUE_CAP;
}

static void queue_clear(engine_t *e) { e->queue_head = e->queue_tail = 0; e->queue_ack_mark = 0; }

/* Build a USB-MIDI packet and send it directly via the host API appropriate
 * for the current output target. Cable nibble matches the JS paths:
 * external=2, move=2 (injected to Move treats cable 2 as external USB),
 * schwung=0 (internal bus). */
static void emit_direct_event(engine_t *e, uint8_t status, uint8_t d1, uint8_t d2, uint8_t len) {
    if (!g_host) return;
    uint8_t high = status & 0xF0;
    uint8_t cin = 0x0F;
    if (high == 0x80)      cin = 0x08;
    else if (high == 0x90) cin = 0x09;
    else if (high == 0xA0) cin = 0x0A;
    else if (high == 0xB0) cin = 0x0B;
    else if (high == 0xC0) cin = 0x0C;
    else if (high == 0xD0) cin = 0x0D;
    else if (high == 0xE0) cin = 0x0E;

    uint8_t ch = e->output_channel & 0x0F;
    uint8_t cable = 2;
    if (e->output_target == OUTPUT_TARGET_MOVE) {
        ch = e->move_channel & 0x0F;
    } else if (e->output_target == OUTPUT_TARGET_SCHWUNG) {
        ch = e->schwung_channel & 0x0F;
        cable = 0;
    }

    /* A per-event channel override (e.g. a click routed to a dedicated MIDI
     * channel) takes precedence over the output-target channel. */
    int8_t override = e->last_event_channel_override;
    if (override >= 0 && override <= 15) ch = (uint8_t)override;

    uint8_t msg[4] = { (cable << 4) | cin, high | ch, d1, d2 };
    int sent = 0;
    const char *route = "external";
    if (e->output_target == OUTPUT_TARGET_SCHWUNG) {
        route = "schwung";
        if (g_host->midi_send_internal) sent = g_host->midi_send_internal(msg, 4);
    } else if (e->output_target == OUTPUT_TARGET_MOVE) {
        route = "move";
        if (g_host->midi_inject_to_move) sent = g_host->midi_inject_to_move(msg, 4);
    } else {
        route = "external";
        if (g_host->midi_send_external) sent = g_host->midi_send_external(msg, 4);
    }
    /* Diagnostic: log the first few direct-emit events per target so we can
     * confirm which host function the DSP actually routes to. This runs on
     * the audio thread (emit_direct_event is reachable from advance_playhead
     * via drain_events_up_to/_guarded), so it must go through the ring
     * buffer (dsp_log_enqueue_worker), never arr_log's direct fopen/fprintf --
     * see the arr_log call-site audit in the comment above arr_log's
     * definition. */
    {
        static int route_log_count[3] = {0,0,0};
        int ri = e->output_target; /* 0=ext,1=move,2=schwung */
        if (ri >= 0 && ri < 3 && route_log_count[ri] < 5) {
            dsp_log_enqueue_worker("DSPEMIT route=%s target=%d cable=%d cin=0x%02X status=0x%02X d1=%d d2=%d sent=%d",
                    route, e->output_target, cable, cin, msg[1], d1, d2, sent);
            route_log_count[ri]++;
        }
    }
    (void)len;
}

static int event_cmp(const void *a, const void *b) {
    const smf_event_t *ea = a, *eb = b;
    if (ea->tick < eb->tick) return -1;
    if (ea->tick > eb->tick) return 1;
    if (ea->track < eb->track) return -1;
    if (ea->track > eb->track) return 1;
    return 0;
}

static void emit_all_notes_off(engine_t *e) {
    /* A clip may use a per-clip channel override (e.g. the count-in click on
     * a dedicated channel). Sending CC 123 only on the primary output_channel
     * leaves stale notes sounding on those override channels, so the next
     * play can start with a note already on and sound like a blip/partial
     * note. Send CC 123 on every MIDI channel to be safe. */
    for (int ch = 0; ch < 16; ch++) {
        if (e->emit_directly) {
            emit_direct_event(e, 0xB0 | ch, 123, 0, 3);
        } else {
            queue_push(e, 0xB0 | ch, 123, 0, 3);
        }
    }
}

/* -------------------------------------------------------------------------- */
/* Clip parsing                                                               */
/* -------------------------------------------------------------------------- */

static int parse_clip(clip_t *clip, const char *path) {
    FILE *f = fopen(path, "rb");
    if (!f) return -1;
    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (sz < 14 || sz > 8 * 1024 * 1024) { fclose(f); return -2; }

    uint8_t *buf = malloc(sz);
    if (!buf) { fclose(f); return -3; }
    if (fread(buf, 1, sz, f) != (size_t)sz) { free(buf); fclose(f); return -4; }
    fclose(f);

    if (memcmp(buf, "MThd", 4) != 0) { free(buf); return -5; }
    uint32_t hlen = read_be32(buf + 4);
    if (hlen < 6) { free(buf); return -6; }
    /* uint16_t fmt = read_be16(buf + 8); */
    uint16_t ntrk = read_be16(buf + 10);
    uint16_t div = read_be16(buf + 12);
    if (div & 0x8000) { free(buf); return -7; }
    if (div == 0) div = 240;

    memset(clip, 0, sizeof(*clip));
    snprintf(clip->path, sizeof(clip->path), "%s", path);
    clip->division = div;

    clip->events = calloc(MAX_CLIP_EVENTS, sizeof(smf_event_t));
    if (!clip->events) { free(buf); return -8; }

    const uint8_t *cur = buf + 8 + hlen;
    const uint8_t *buf_end = buf + sz;
    int track_idx = 0;

    while (cur + 8 <= buf_end && track_idx < (int)ntrk && track_idx < MAX_TRACKS) {
        if (memcmp(cur, "MTrk", 4) != 0) break;
        uint32_t tlen = read_be32(cur + 4);
        const uint8_t *tstart = cur + 8;
        const uint8_t *tend = tstart + tlen;
        if (tend > buf_end) tend = buf_end;

        const uint8_t *tp = tstart;
        uint32_t abs_tick = 0;
        uint8_t running_status = 0;
        int track_ended = 0;

        while (tp < tend && !track_ended) {
            uint32_t delta = read_vlq(&tp, tend);
            abs_tick += delta;
            if (tp >= tend) break;

            uint8_t status = *tp;
            if (status < 0x80) {
                status = running_status;
            } else {
                tp++;
            }
            if (status == 0) break;

            if (status == 0xFF) {
                if (tp >= tend) break;
                uint8_t meta_type = *tp++;
                uint32_t mlen = read_vlq(&tp, tend);
                if (tp + mlen > tend) break;
                if (meta_type == 0x2F) {
                    track_ended = 1;
                    break;
                }
                tp += mlen;
                continue;
            }

            if (status == 0xF0 || status == 0xF7) {
                uint32_t sxlen = read_vlq(&tp, tend);
                if (tp + sxlen > tend) break;
                tp += sxlen;
                continue;
            }

            running_status = status;
            uint8_t type = status & 0xF0;
            int dlen = (type == 0xC0 || type == 0xD0) ? 1 : 2;
            if (tp + dlen > tend) break;
            uint8_t d1 = *tp++;
            uint8_t d2 = (dlen >= 2) ? *tp++ : 0;

            /* Record channel-voice events for the timeline. */
            if (clip->event_count < MAX_CLIP_EVENTS && type >= 0x80 && type <= 0xE0) {
                smf_event_t *ev = &clip->events[clip->event_count++];
                ev->tick  = abs_tick;
                ev->status = status;
                ev->data1  = d1;
                ev->data2  = d2;
                ev->len    = (uint8_t)(1 + dlen);
                ev->track  = (uint8_t)track_idx;
                if (type == 0x90 && d2 > 0) ev->was_note_on = 1;
            }

            if (abs_tick > clip->end_tick) clip->end_tick = abs_tick;
        }

        cur = tend;
        if (!track_ended || (cur + 4 <= buf_end && memcmp(cur, "MTrk", 4) != 0)) {
            const uint8_t *scan = (cur < tstart) ? tstart : cur;
            while (scan + 4 <= buf_end && memcmp(scan, "MTrk", 4) != 0) scan++;
            if (scan + 4 <= buf_end) cur = scan;
        }
        track_idx++;
    }

    /* Generate explicit note-offs for any note-on that doesn't already have a
     * matching note-off inside the clip. Prevents stuck notes during playback
     * and when clips are trimmed at seams. */
    for (int i = 0; i < clip->event_count; i++) {
        smf_event_t *ev = &clip->events[i];
        if (!ev->was_note_on || ev->note_off_generated) continue;
        uint8_t ch = ev->status & 0x0F;
        uint8_t note = ev->data1;
        int found = 0;
        for (int j = i + 1; j < clip->event_count; j++) {
            smf_event_t *later = &clip->events[j];
            uint8_t ltype = later->status & 0xF0;
            uint8_t lch = later->status & 0x0F;
            if (lch == ch && later->data1 == note &&
                (ltype == 0x80 || (ltype == 0x90 && later->data2 == 0))) {
                found = 1;
                break;
            }
        }
        if (found) continue;
        if (clip->event_count >= MAX_CLIP_EVENTS) break;
        smf_event_t *off = &clip->events[clip->event_count++];
        off->tick = ev->tick + clip->division; /* default 1 quarter note */
        if (off->tick > clip->end_tick) clip->end_tick = off->tick;
        off->status = 0x80 | ch;
        off->data1 = note;
        off->data2 = 0;
        off->len = 3;
        off->track = ev->track;
        off->was_note_on = 0;
        off->note_off_generated = 1;
    }

    qsort(clip->events, clip->event_count, sizeof(smf_event_t), event_cmp);
    free(buf);
    return 0;
}

static void free_clip(clip_t *clip) {
    if (clip->events) { free(clip->events); clip->events = NULL; }
    clip->event_count = 0;
}

/* -------------------------------------------------------------------------- */
/* Clip cache                                                                 */
/* -------------------------------------------------------------------------- */

static clip_t* find_clip(engine_t *e, const char *path) {
    for (int i = 0; i < e->clip_count; i++) {
        if (strcmp(e->clips[i].path, path) == 0) return &e->clips[i];
    }
    return NULL;
}

static int load_clip(engine_t *e, const char *path) {
    if (e->clip_count >= MAX_CLIPS_PER_FOLDER) return -1;
    if (find_clip(e, path)) return 0;
    clip_t *clip = &e->clips[e->clip_count];
    int rc = parse_clip(clip, path);
    if (rc != 0) {
        arr_log("load_clip failed: %s", path);
        return rc;
    }
    arr_log("load_clip: %s events=%d end_tick=%u", path, clip->event_count, clip->end_tick);
    e->clip_count++;
    return 0;
}

/* Forward declarations for helpers defined later. */
static void copy_trunc(char *dst, size_t dst_size, const char *src);
static void engine_set_error(engine_t *e, const char *msg);
static void engine_clear_error(engine_t *e);

/* Recursively search under base_dir for a file whose leaf name matches target.
 * Writes the first match into out_path (max out_len). Returns 1 if found. */
static int find_file_recursive(const char *base_dir, const char *target, char *out_path, size_t out_len) {
    DIR *d = opendir(base_dir);
    if (!d) return 0;
    struct dirent *ent;
    int found = 0;
    while ((ent = readdir(d)) && !found) {
        if (ent->d_name[0] == '.') continue;
        char full[MAX_PATH_LEN];
        int n = snprintf(full, sizeof(full), "%s/%s", base_dir, ent->d_name);
        if (n < 0 || (size_t)n >= sizeof(full)) continue;
        struct stat st;
        if (stat(full, &st) != 0) continue;
        if (S_ISDIR(st.st_mode)) {
            found = find_file_recursive(full, target, out_path, out_len);
        } else if (S_ISREG(st.st_mode) && strcasecmp(ent->d_name, target) == 0) {
            copy_trunc(out_path, out_len, full);
            found = 1;
        }
    }
    closedir(d);
    return found;
}

/* Recursively search under base_dir for a DIRECTORY whose name matches target.
 * Writes the first match into out_path (max out_len). Returns 1 if found. */
static int find_dir_recursive(const char *base_dir, const char *target, char *out_path, size_t out_len) {
    DIR *d = opendir(base_dir);
    if (!d) return 0;
    struct dirent *ent;
    int found = 0;
    while ((ent = readdir(d)) && !found) {
        if (ent->d_name[0] == '.') continue;
        char full[MAX_PATH_LEN];
        int n = snprintf(full, sizeof(full), "%s/%s", base_dir, ent->d_name);
        if (n < 0 || (size_t)n >= sizeof(full)) continue;
        struct stat st;
        if (stat(full, &st) != 0) continue;
        if (S_ISDIR(st.st_mode)) {
            if (strcasecmp(ent->d_name, target) == 0) {
                copy_trunc(out_path, out_len, full);
                found = 1;
            } else {
                found = find_dir_recursive(full, target, out_path, out_len);
            }
        }
    }
    closedir(d);
    return found;
}

static int resolve_clip_index(engine_t *e, const char *source_path,
                              const char *source_folder) {
    char full_path[MAX_PATH_LEN];

    /* Fast path: if the exact clip (library_root/source_folder/source_path) is
     * already loaded in the clip cache (which persists across builds, since
     * the worker never clears e->clips[] between requests), return it
     * immediately. This avoids repeated
     * access() filesystem checks for clips referenced many times in a song
     * (e.g. a count-in hihat used in dozens of sections) and for clips already
     * loaded by an earlier song in a setlist. Matching on the FULL expected
     * path (not just the leaf name) means this only short-circuits when it is
     * genuinely the same file, so there is no ambiguity class to guard against
     * — a different folder that happens to share a filename is never
     * substituted. */
    {
        char expected[MAX_PATH_LEN];
        int n = snprintf(expected, sizeof(expected), "%s/%s/%s",
                        e->library_root, source_folder, source_path);
        if (n > 0 && (size_t)n < sizeof(expected)) {
            for (int i = 0; i < e->clip_count; i++) {
                if (strcmp(e->clips[i].path, expected) == 0) return i;
            }
        }
    }

    /* Second fast path: resolve the leaf name via the lazy whole-library index
     * (which only contains leaf names that appear in exactly one folder, so it
     * is unambiguous), and if that resolved file is already loaded, return it.
     * This catches repeated cross-folder clips (e.g. a count-in hihat whose
     * per-clip source_folder differs from the song folder) that the exact-path
     * check above misses, without any wrong-clip risk. */
    {
        const char *leaf = strrchr(source_path, '/');
        leaf = leaf ? leaf + 1 : source_path;
        const char *hit = clip_lookup_find(e, leaf);
        if (hit) {
            for (int i = 0; i < e->clip_count; i++) {
                if (strcmp(e->clips[i].path, hit) == 0) return i;
            }
        }
    }

    /* source_path may already be an absolute path (older songs or UI). */
    if (source_path[0] == '/' && access(source_path, F_OK) == 0) {
        copy_trunc(full_path, sizeof(full_path), source_path);
        goto found;
    }

    /* Try: library_root/source_folder/source_path (normal case). */
    int n = snprintf(full_path, sizeof(full_path), "%s/%s/%s",
                     e->library_root, source_folder, source_path);
    if (n >= 0 && (size_t)n < sizeof(full_path) && access(full_path, F_OK) == 0) {
        goto found;
    }

    /* Try: library_root/source_path (folder-relative or saved with path). */
    n = snprintf(full_path, sizeof(full_path), "%s/%s",
                 e->library_root, source_path);
    if (n >= 0 && (size_t)n < sizeof(full_path) && access(full_path, F_OK) == 0) {
        goto found;
    }

    /* Try: library_root/<category>/source_folder/source_path. The song folder
     * may live one level under a category folder (e.g. GM Ballads/Song 01). */
    if (source_folder[0]) {
        char cat_dir[MAX_PATH_LEN];
        if (find_dir_recursive(e->library_root, source_folder, cat_dir, sizeof(cat_dir))) {
            n = snprintf(full_path, sizeof(full_path), "%s/%s",
                         cat_dir, source_path);
            if (n >= 0 && (size_t)n < sizeof(full_path) && access(full_path, F_OK) == 0) {
                goto found;
            }
        }
    }

    /* Fallback 1: search source_folder recursively for leaf name. */
    {
        const char *leaf = strrchr(source_path, '/');
        if (!leaf) leaf = source_path;
        else leaf++;
        char base[MAX_PATH_LEN];
        n = snprintf(base, sizeof(base), "%s/%s", e->library_root, source_folder);
        if (n >= 0 && (size_t)n < sizeof(base)) {
            char found[MAX_PATH_LEN];
            if (find_file_recursive(base, leaf, found, sizeof(found))) {
                copy_trunc(full_path, sizeof(full_path), found);
                if (access(full_path, F_OK) == 0) goto found;
            }
        }
    }

    /* Fallback 2: search the whole library recursively for leaf name.
     * Use the lazy leaf-name index so the tree is walked once, not per clip;
     * songs that pull clips from several folders avoid a full recursive walk
     * for each unresolved clip (the source of the multi-folder build delay).
     * Also try adding .mid extension if the leaf is missing one. */
    {
        const char *leaf = strrchr(source_path, '/');
        if (!leaf) leaf = source_path;
        else leaf++;
        const char *hit = clip_lookup_find(e, leaf);
        if (!hit && strcasecmp(leaf + (strlen(leaf) > 4 ? strlen(leaf) - 4 : 0), ".mid") != 0) {
            char leaf_mid[128];
            snprintf(leaf_mid, sizeof(leaf_mid), "%s.mid", leaf);
            hit = clip_lookup_find(e, leaf_mid);
        }
        if (hit && access(hit, F_OK) == 0) {
            copy_trunc(full_path, sizeof(full_path), hit);
            goto found;
        }
        /* Not in the index (ambiguous or genuinely absent): fall back to the
         * safe recursive walk for correctness. */
        {
            char found[MAX_PATH_LEN];
            if (find_file_recursive(e->library_root, leaf, found, sizeof(found))) {
                copy_trunc(full_path, sizeof(full_path), found);
                if (access(full_path, F_OK) == 0) goto found;
            }
            size_t leaf_len = strlen(leaf);
            if (leaf_len > 4 && strcasecmp(leaf + leaf_len - 4, ".mid") != 0) {
                char leaf_mid[MAX_PATH_LEN];
                snprintf(leaf_mid, sizeof(leaf_mid), "%s.mid", leaf);
                if (find_file_recursive(e->library_root, leaf_mid, found, sizeof(found))) {
                    copy_trunc(full_path, sizeof(full_path), found);
                    if (access(full_path, F_OK) == 0) goto found;
                }
            }
        }
    }

    /* Nothing found. */
    {
        char err[1024];
        snprintf(err, sizeof(err), "clip not found: source='%.255s' folder='%.255s' root='%.255s'",
                 source_path, source_folder, e->library_root);
        engine_set_error(e, err);
        arr_log("resolve_clip_index failed: %s", err);
    }
    return -1;

found:
    arr_log("resolve_clip_index: source='%s' resolved='%s'", source_path, full_path);
    clip_t *existing = find_clip(e, full_path);
    if (existing) return (int)(existing - e->clips);
    if (e->clip_count >= MAX_CLIPS_PER_FOLDER) return -1;
    if (load_clip(e, full_path) != 0) {
        char err[1024];
        snprintf(err, sizeof(err), "clip load failed: %s", full_path);
        engine_set_error(e, err);
        arr_log("resolve_clip_index load failed: %.1023s", err);
        return -1;
    }
    return e->clip_count - 1;
}

/* -------------------------------------------------------------------------- */
/* Song assembly / boundary guard                                             */
/* -------------------------------------------------------------------------- */

/* Convert a (bar, beat) trim position to source-file ticks for the START of a
 * clip. `beat` is a 1-based beat within `bar` (1 = first beat); a stored 0 is
 * treated as 1 (start of bar). The returned tick is the first tick that plays.
 * Used by Advanced Trim so a clip can start mid-bar (e.g. beat 3 of bar 1). */
static uint32_t trim_start_tick(const clip_t *clip, uint32_t bar, uint32_t beat,
                                int time_sig_num, int time_sig_den) {
    uint32_t ticks_per_bar = (uint32_t)(clip->division * 4.0 * time_sig_num / time_sig_den);
    if (ticks_per_bar == 0) ticks_per_bar = clip->division;
    uint32_t beats_per_bar = time_sig_num > 0 ? (uint32_t)time_sig_num : 1;
    uint32_t ticks_per_beat = ticks_per_bar / beats_per_bar;
    if (ticks_per_beat == 0) ticks_per_beat = clip->division;
    if (beat == 0) beat = 1;                        /* default: first beat */
    if (beat > beats_per_bar) beat = beats_per_bar;
    return bar * ticks_per_bar + (beat - 1) * ticks_per_beat;
}

/* Convert a (bar, beat) trim position to source-file ticks for the END of a
 * clip. `bar` is the EXCLUSIVE end bar; `beat` is the 1-based beat (within the
 * last played bar, `bar - 1`) that is the final beat to play. A stored `beat`
 * of 0 is treated as beats-per-bar (end of the full bar). The returned tick is
 * exclusive (the tick just after the last played beat). */
static uint32_t trim_end_tick(const clip_t *clip, uint32_t bar, uint32_t beat,
                              int time_sig_num, int time_sig_den) {
    uint32_t ticks_per_bar = (uint32_t)(clip->division * 4.0 * time_sig_num / time_sig_den);
    if (ticks_per_bar == 0) ticks_per_bar = clip->division;
    uint32_t beats_per_bar = time_sig_num > 0 ? (uint32_t)time_sig_num : 1;
    uint32_t ticks_per_beat = ticks_per_bar / beats_per_bar;
    if (ticks_per_beat == 0) ticks_per_beat = clip->division;
    if (beat == 0) beat = beats_per_bar;   /* default: full bar (end of bar-1) */
    if (beat > beats_per_bar) beat = beats_per_bar;
    uint32_t last_bar = (bar > 0) ? (bar - 1) : 0;
    return last_bar * ticks_per_bar + beat * ticks_per_beat;
}

/* Number of whole bars spanned by the clip's events. */
static uint32_t clip_total_bars(const clip_t *clip, int time_sig_num, int time_sig_den) {
    uint32_t ticks_per_bar = (uint32_t)(clip->division * 4.0 * time_sig_num / time_sig_den);
    if (ticks_per_bar == 0) ticks_per_bar = clip->division;
    uint32_t end_tick = clip->end_tick;
    uint32_t bars = end_tick / ticks_per_bar;
    if (end_tick % ticks_per_bar) bars++;
    if (bars < 1) bars = 1;
    return bars;
}

static void free_library_cache(engine_t *e);

static void clear_song(engine_t *e) {
    for (int i = 0; i < e->clip_count; i++) free_clip(&e->clips[i]);
    e->clip_count = 0;
    e->live_slot.event_count = 0;
    e->live_slot.end_tick = 0;
    e->playhead_tick = 0;
    e->event_cursor = 0;
    e->running = 0;
    free_library_cache(e);
    queue_clear(e);
    e->staging_loop = 1;
    e->pending_swap = 0;
}

/* Kick-thinning: reduce busy bass-kick patterns by dropping kicks per bar
 * down to `kick_target`. Strong beats are always kept (beat 1, plus beat 3 in
 * 4/4 or beat 4 in 6/8). Remaining kicks are dropped first by proximity to
 * another kick (the busiest / most redundant ones go first).
 *
 * Fills `drop` (length clip->event_count, 1 = drop) for kick note-ons AND their
 * matching note-offs, so removed kicks don't leave stuck notes. Returns 1 if
 * thinning was applied. */
static int thin_kicks(clip_t *clip, uint32_t start_tick, uint32_t end_tick,
                      int time_sig_num, int time_sig_den, uint8_t kick_note,
                      uint8_t kick_target, uint8_t *drop)
{
    if (kick_target == 0 || kick_note == 0 || clip->event_count == 0) return 0;
    memset(drop, 0, clip->event_count);

    uint32_t ticks_per_bar = (uint32_t)(clip->division * 4.0 * time_sig_num / time_sig_den);
    if (ticks_per_bar == 0) ticks_per_bar = clip->division;
    uint32_t ticks_per_beat = ticks_per_bar / time_sig_num;
    if (ticks_per_beat == 0) ticks_per_beat = clip->division;

    int changed = 0;
    uint32_t bar_start = start_tick;
    while (bar_start < end_tick) {
        uint32_t bar_end = bar_start + ticks_per_bar;
        if (bar_end > end_tick) bar_end = end_tick;

        int kick_idx[512];
        uint32_t kick_tick[512];
        int n_kicks = 0;
        for (int i = 0; i < clip->event_count; i++) {
            smf_event_t *ev = &clip->events[i];
            if (ev->tick < bar_start || ev->tick >= bar_end) continue;
            uint8_t type = ev->status & 0xF0;
            if (ev->data1 == kick_note && type == 0x90 && ev->data2 > 0) {
                if (n_kicks < 512) { kick_idx[n_kicks] = i; kick_tick[n_kicks] = ev->tick - bar_start; n_kicks++; }
            }
        }
        if (n_kicks <= kick_target) { bar_start = bar_end; continue; }

        /* Beats to protect: 1, plus 3 for 4/4 or 4 for 6/8. Only the earliest
         * (downbeat) kick on each protected beat is kept — an 8th-note "and"
         * that lands within the same beat (e.g. tick 120 of a 240-tick beat)
         * must NOT be protected, or busy 8th-note patterns can never be thinned
         * down to kick_target. */
        int protected[4]; int n_prot = 0;
        protected[n_prot++] = 1;
        if (time_sig_num == 4) protected[n_prot++] = 3;
        else if (time_sig_num == 6) protected[n_prot++] = 4;

        uint8_t is_protected[512] = {0};
        int n_protected = 0;
        for (int p = 0; p < n_prot; p++) {
            int best_k = -1;
            uint32_t best_t = UINT32_MAX;
            for (int k = 0; k < n_kicks; k++) {
                if (is_protected[k]) continue;
                uint32_t beat = kick_tick[k] / ticks_per_beat + 1;
                if ((int)beat != protected[p]) continue;
                if (kick_tick[k] < best_t) { best_t = kick_tick[k]; best_k = k; }
            }
            if (best_k >= 0) { is_protected[best_k] = 1; n_protected++; }
        }

        /* Number to drop, clamped so we never drop protected kicks. */
        int to_drop = n_kicks - kick_target;
        int droppable = n_kicks - n_protected;
        if (to_drop > droppable) to_drop = droppable;
        if (to_drop <= 0) { bar_start = bar_end; continue; }

        /* Among the non-protected kicks, sort by proximity to the nearest other
         * kick in the bar (closest = busiest = highest priority to drop).
         * We track the selected non-protected kick indices in an array. */
        int cand[512]; int n_cand = 0;
        for (int k = 0; k < n_kicks; k++) if (!is_protected[k]) cand[n_cand++] = k;

        /* Simple selection: repeatedly pick the non-protected kick with the
         * smallest distance to its nearest other kick (excluding already
         * dropped candidates) and drop it, until we've dropped `to_drop`. */
        uint8_t dropped_cand[512] = {0};
        for (int d = 0; d < to_drop && d < n_cand; d++) {
            int best = -1;
            uint32_t best_dist = UINT32_MAX;
            for (int c = 0; c < n_cand; c++) {
                if (dropped_cand[c]) continue;
                int k = cand[c];
                uint32_t rel = kick_tick[k];
                uint32_t best_nb = UINT32_MAX;
                for (int j = 0; j < n_kicks; j++) {
                    if (j == k) continue;
                    uint32_t d2 = (rel > kick_tick[j]) ? (rel - kick_tick[j]) : (kick_tick[j] - rel);
                    if (d2 < best_nb) best_nb = d2;
                }
                if (best_nb < best_dist) { best_dist = best_nb; best = c; }
            }
            if (best < 0) break;
            dropped_cand[best] = 1;
            int k = cand[best];
            int ev_idx = kick_idx[k];
            drop[ev_idx] = 1; /* note-on */
            /* Also drop the matching note-off for this note, if any, up to bar end. */
            uint8_t ch = clip->events[ev_idx].status & 0x0F;
            uint8_t note = clip->events[ev_idx].data1;
            uint32_t on_tick = clip->events[ev_idx].tick;
            for (int i = 0; i < clip->event_count; i++) {
                smf_event_t *off = &clip->events[i];
                uint8_t otype = off->status & 0xF0;
                uint8_t och = off->status & 0x0F;
                if (off->data1 == note && och == ch &&
                    (otype == 0x80 || (otype == 0x90 && off->data2 == 0)) &&
                    off->tick >= on_tick && off->tick < bar_end) {
                    drop[i] = 1;
                    break;
                }
            }
            changed = 1;
        }
        bar_start = bar_end;
    }
    return changed;
}

/* Build the assembled timeline from `song` into the supplied target buffer.
 * For each clip instance, copy events from [start_bar, end_bar) into the
 * timeline at the correct absolute position, applying boundary guard at seams.
 * This generic version supports both the active timeline and the staging
 * timeline used for seamless Jam-mode clip switching. */
static int build_timeline_targeted(engine_t *e, song_t *song, double tempo_bpm,
                                   int time_sig_num, int time_sig_den,
                                   uint32_t ticks_per_beat, uint32_t ticks_per_bar,
                                   smf_event_t **out_timeline, int *out_count,
                                   uint32_t *out_end_tick) {
    (void)tempo_bpm;
    (void)ticks_per_bar;
    engine_clear_error(e);
    if (*out_timeline) { free(*out_timeline); *out_timeline = NULL; }
    *out_count = 0;
    *out_end_tick = 0;

    arr_log("build_timeline_targeted: sections=%d library_root=%.180s",
            song->section_count, e->library_root);

    if (song->section_count == 0) {
        engine_set_error(e, "build_timeline: no sections in song");
        arr_log("build_timeline: no sections");
        return -1;
    }

    /* First pass: count events to allocate. Clamp end_bar to clip length
     * so corrupt "end_bar:90" songs still play at least one bar. */
    int total = 0;
    for (int s = 0; s < song->section_count; s++) {
        section_t *sec = &song->sections[s];
        arr_log("build_timeline: section=%d clip_count=%d", s, sec->clip_count);
        for (int c = 0; c < sec->clip_count; c++) {
            section_clip_t *sc = &sec->clips[c];
            clip_t *clip = NULL;
            if (sc->clip_index >= 0 && sc->clip_index < e->clip_count) {
                clip = &e->clips[sc->clip_index];
            }
            arr_log("build_timeline: section=%d clip=%d idx=%d clip=%p events=%d start_bar=%u end_bar=%u",
                    s, c, sc->clip_index, (void*)clip, clip ? clip->event_count : 0,
                    sc->start_bar, sc->end_bar);
            if (!clip) {
                engine_set_error(e, "build_timeline: clip not resolved");
                arr_log("build_timeline: clip not resolved");
                continue;
            }
            uint32_t max_bars = clip_total_bars(clip, time_sig_num, time_sig_den);
            if (sc->start_bar >= max_bars) sc->start_bar = 0;
            if (sc->end_bar == 0 || sc->end_bar > max_bars) sc->end_bar = max_bars;
            if (sc->end_bar <= sc->start_bar) sc->end_bar = sc->start_bar + 1;
            uint32_t start_tick = trim_start_tick(clip, sc->start_bar, sc->start_beat, time_sig_num, time_sig_den);
            uint32_t end_tick   = trim_end_tick(clip, sc->end_bar,   sc->end_beat,   time_sig_num, time_sig_den);
            if (end_tick <= start_tick) end_tick = start_tick + 1;
            for (int i = 0; i < clip->event_count; i++) {
                uint32_t t = clip->events[i].tick;
                if (t >= start_tick && t < end_tick) total++;
            }
        }
    }

    arr_log("build_timeline: total events to allocate=%d", total);

    if (total == 0) {
        engine_set_error(e, "build_timeline: no events matched");
        arr_log("build_timeline: no events matched");
        return -1;
    }

    *out_timeline = calloc(total + 16, sizeof(smf_event_t));
    if (!*out_timeline) {
        engine_set_error(e, "build_timeline: allocation failed");
        return -1;
    }

    /* Second pass: copy events, applying boundary guard at seams.
     * Guard window = fraction of a beat in source-file ticks.
     * Each clip instance may override the engine default via guard_fraction. */
    uint32_t cursor = 0;
    for (int s = 0; s < song->section_count; s++) {
        section_t *sec = &song->sections[s];
        uint32_t sec_start_tick = cursor;
        for (int c = 0; c < sec->clip_count; c++) {
            section_clip_t *sc = &sec->clips[c];
            clip_t *clip = NULL;
            if (sc->clip_index >= 0 && sc->clip_index < e->clip_count) {
                clip = &e->clips[sc->clip_index];
            }
            if (!clip) continue;

            uint32_t clip_start = trim_start_tick(clip, sc->start_bar, sc->start_beat, time_sig_num, time_sig_den);
            uint32_t clip_end   = trim_end_tick(clip, sc->end_bar,   sc->end_beat,   time_sig_num, time_sig_den);
            if (clip_end <= clip_start) clip_end = clip_start + 1;

            /* Rescale source-file ticks to the song's PPQ tick basis so the
             * playhead (which advances in song ticks) lines up with the audio.
             * Without this, a clip with division 480 played at song PPQ 240
             * would sound and flash at half speed. */
            double scale = (double)ticks_per_beat / (double)clip->division;
            if (scale <= 0.0 || isnan(scale) || isinf(scale)) scale = 1.0;

            /* Speed factor: 2x compresses the clip into half its bars, 0.5x
             * stretches it to double. Defaults to 1.0 (unchanged). */
            double speed = (sc->speed > 0.0) ? sc->speed : 1.0;
            double inv_speed = 1.0 / speed;

            uint32_t clip_dur   = (uint32_t)((clip_end - clip_start) * scale * inv_speed);
            if (clip_dur == 0) clip_dur = 1;

            /* Guard is only applied at the outgoing boundary of a shortened clip. */
            uint32_t cut_out = cursor + clip_dur;

            /* Use the per-clip guard_fraction if it was parsed (> 0 or explicitly 0),
             * otherwise fall back to the engine default. */
            double gf = (sc->status && sc->guard_fraction >= 0.0) ? sc->guard_fraction : e->guard_fraction;
            uint32_t guard_ticks = (uint32_t)(gf * ticks_per_beat);
            if (guard_ticks == 0 && gf > 0.0) guard_ticks = 1;

            /* Kick-thinning: compute which source events to drop for this
             * clip instance before copying. Works in source-clip tick space. */
            uint8_t *kick_drop = NULL;
            if (sc->kick_note > 0 && sc->kick_target > 0) {
                kick_drop = malloc(clip->event_count);
                if (kick_drop) {
                    thin_kicks(clip, clip_start, clip_end, time_sig_num, time_sig_den,
                               sc->kick_note, sc->kick_target, kick_drop);
                }
            }

            for (int i = 0; i < clip->event_count; i++) {
                smf_event_t *src = &clip->events[i];
                if (src->tick < clip_start || src->tick >= clip_end) continue;
                if (kick_drop && kick_drop[i]) continue;

                uint8_t type = src->status & 0xF0;
                uint32_t abs_tick = cursor + (uint32_t)((src->tick - clip_start) * scale * inv_speed);

                /* Boundary guard: suppress note-ons near the *outgoing* seam only.
                 * The guard window applies only to the end portion of a shortened
                 * clip, never to its start. Outgoing side: [cut_out - guard, cut_out).
                 * Only note-ons are gated; note-offs pass through to avoid stuck notes.
                 * guard_ticks == 0 disables the guard entirely for this clip. */
                if (guard_ticks > 0 && type == 0x90 && src->data2 > 0) {
                    if (abs_tick + guard_ticks > cut_out && abs_tick < cut_out) continue;
                }

                smf_event_t *dst = &(*out_timeline)[(*out_count)++];
                *dst = *src;
                dst->tick = abs_tick;
                dst->status = (src->status & 0xF0) | e->output_channel;
                /* Carry the per-clip channel override (e.g. a dedicated click
                 * channel) into the assembled event. -1 means use the engine's
                 * output-target channel. */
                dst->channel_override = sc->channel;

                /* Apply per-clip velocity scaling to real note-ons.
                 * Generated note-offs and zero-velocity events are left as-is.
                 * velocity_scale 0 silences the clip; 1.0 leaves it unchanged. */
                double vscale = sc->velocity_scale;
                if (type == 0x90 && src->data2 > 0 && vscale != 1.0) {
                    int vel = (int)(src->data2 * vscale + 0.5);
                    if (vel < 0) vel = 0;
                    if (vel > 127) vel = 127;
                    dst->data2 = (uint8_t)vel;
                }

                /* Apply snare-note filter / velocity scaling.
                 * snare_note == 0 disables the filter. */
                if (sc->snare_note > 0 && src->data1 == sc->snare_note) {
                    int is_note_on = (type == 0x90 && src->data2 > 0);
                    int is_note_off = (type == 0x80) || (type == 0x90 && src->data2 == 0);
                    if (is_note_on) {
                        if (sc->snare_velocity_scale <= 0.0) {
                            (*out_count)--; /* drop the event we just copied */
                            continue;
                        }
                        if (sc->snare_velocity_scale != 1.0) {
                            /* Scale on top of the whole-clip velocity already
                             * applied in dst->data2, so changing the clip's
                             * Velocity affects the snare too. */
                            int vel = (int)(dst->data2 * sc->snare_velocity_scale + 0.5);
                            if (vel < 0) vel = 0;
                            if (vel > 127) vel = 127;
                            dst->data2 = (uint8_t)vel;
                        }
                    } else if (is_note_off) {
                        if (sc->snare_velocity_scale <= 0.0) {
                            (*out_count)--; /* drop the matching note-off */
                            continue;
                        }
                    }
                }
            }

            if (kick_drop) { free(kick_drop); kick_drop = NULL; }

            cursor += clip_dur;
            if (cursor > *out_end_tick) *out_end_tick = cursor;
        }
        /* Record the section's bar count (in song ticks) so the instrument
         * emitter can map a playhead tick to a section/bar. */
        if (ticks_per_bar > 0) {
            sec->bars = (cursor - sec_start_tick) / ticks_per_bar;
            if (sec->bars < 1) sec->bars = 1;
        }
    }

    qsort(*out_timeline, *out_count, sizeof(smf_event_t), event_cmp);
    return 0;
}

/* Serialize queued events into `buf` as JSON: [{"s":144,"d1":38,"d2":100}, ...].
 * Returns bytes written (not including null terminator). Used by ui.js to
 * drain Schwung-output events via shadow_send_midi_to_dsp. The queue is not
 * consumed by this call; the caller must ack via set_param("events_ack","1")
 * once it has emitted the events. */
static int queue_serialize_events(engine_t *e, char *buf, int buf_len) {
    if (!buf || buf_len < 3) return -1;
    char *p = buf;
    int left = buf_len;
    int w = snprintf(p, left, "[");
    if (w < 0) return -1;
    p += w; left -= w;

    int n = 0;
    int idx = e->queue_head;
    while (idx != e->queue_tail) {
        if (n > 0) {
            w = snprintf(p, left, ",");
            if (w < 0) return -1;
            p += w; left -= w;
        }
        uint8_t s = e->queue_status[idx];
        uint8_t d1 = e->queue_d1[idx];
        uint8_t d2 = e->queue_d2[idx];
        uint8_t ln = e->queue_len[idx];
        w = snprintf(p, left, "{\"s\":%u,\"d1\":%u,\"d2\":%u,\"ln\":%u}",
                     (unsigned)s, (unsigned)d1, (unsigned)d2, (unsigned)ln);
        if (w < 0 || w >= left) return -1;
        p += w; left -= w;
        idx = (idx + 1) % QUEUE_CAP;
        n++;
        if (left < 32) break;
    }
    /* Record how far we serialized so events_ack only clears these, not any
     * events the audio thread pushed after we started serializing. */
    e->queue_ack_mark = idx;
    if (left > 1) {
        snprintf(p, left, "]");
    } else {
        buf[buf_len - 2] = ']';
        buf[buf_len - 1] = '\0';
    }
    return (int)strlen(buf);
}

/* Pop all queued events. Called from set_param("events_ack").
 * Only clears events that were serialized (up to queue_ack_mark), so events
 * pushed by the audio thread after serialization are preserved. */
static void queue_ack_all(engine_t *e) {
    e->queue_head = e->queue_ack_mark;
}

/* -------------------------------------------------------------------------- */
/* JSON helpers (minimal)                                                     */
/*  All helpers search forward from `cursor` so nested keys with the same name  */
/*  resolve to the occurrence under the current object.                         */
/* -------------------------------------------------------------------------- */

static int json_get_string_at(const char *cursor, const char *key, char *out, int out_len) {
    if (!cursor || !key || !out || out_len < 1) return 0;
    char needle[64];
    snprintf(needle, sizeof(needle), "\"%s\"", key);
    const char *pos = strstr(cursor, needle);
    if (!pos) return 0;
    const char *colon = strchr(pos + strlen(needle), ':');
    if (!colon) return 0;
    colon++;
    while (*colon == ' ' || *colon == '\t') colon++;
    if (*colon == '"') {
        colon++;
        const char *end = strchr(colon, '"');
        if (!end) return 0;
        int len = (int)(end - colon);
        if (len >= out_len) len = out_len - 1;
        memcpy(out, colon, len);
        out[len] = '\0';
        return len;
    } else if (*colon == '[' || *colon == '{' || *colon == 't' || *colon == 'f' || *colon == 'n' || (*colon >= '0' && *colon <= '9') || *colon == '-') {
        /* capture unquoted/number/bool/null as string */
        const char *end = colon + 1;
        while (*end && *end != ',' && *end != '}' && *end != '\n') end++;
        int len = (int)(end - colon);
        if (len >= out_len) len = out_len - 1;
        memcpy(out, colon, len);
        out[len] = '\0';
        return len;
    }
    return 0;
}

static int json_get_string(const char *json, const char *key, char *out, int out_len) {
    return json_get_string_at(json, key, out, out_len);
}

static int json_get_int_at(const char *cursor, const char *key, int *out) {
    if (!cursor || !key || !out) return 0;
    char needle[64];
    snprintf(needle, sizeof(needle), "\"%s\"", key);
    const char *pos = strstr(cursor, needle);
    if (!pos) return 0;
    const char *colon = strchr(pos + strlen(needle), ':');
    if (!colon) return 0;
    colon++;
    while (*colon == ' ' || *colon == '\t') colon++;
    *out = atoi(colon);
    return 1;
}

static int json_get_double_at(const char *cursor, const char *key, double *out) {
    if (!cursor || !key || !out) return 0;
    char needle[64];
    snprintf(needle, sizeof(needle), "\"%s\"", key);
    const char *pos = strstr(cursor, needle);
    if (!pos) return 0;
    const char *colon = strchr(pos + strlen(needle), ':');
    if (!colon) return 0;
    colon++;
    while (*colon == ' ' || *colon == '\t') colon++;
    *out = atof(colon);
    return 1;
}

/* -------------------------------------------------------------------------- */
/* Chord / instrument note helpers                                            */
/* -------------------------------------------------------------------------- */

/* Map a note name (e.g. "C", "C#", "Db", "B") to a semitone offset from C.
 * Returns -1 for an unrecognised name. */
static int note_name_semitone(const char *name) {
    if (!name || !name[0]) return -1;
    switch (name[0]) {
        case 'C': return (name[1] == '#') ? 1 : 0;
        case 'D': return (name[1] == '#') ? 3 : ((name[1] == 'b') ? 1 : 2);
        case 'E': return (name[1] == 'b') ? 3 : 4;
        case 'F': return (name[1] == '#') ? 6 : 5;
        case 'G': return (name[1] == '#') ? 8 : ((name[1] == 'b') ? 6 : 7);
        case 'A': return (name[1] == '#') ? 10 : ((name[1] == 'b') ? 8 : 9);
        case 'B': return (name[1] == 'b') ? 10 : 11;
        default: return -1;
    }
}

/* Semitone intervals for each chord quality (relative to the root). Mirrors
 * CHORD_INTERVALS in ui.js. */
static int chord_quality_intervals(const char *quality, int *out, int max) {
    static const int maj[3]  = {0, 4, 7};
    static const int min[3]  = {0, 3, 7};
    static const int dim[3]  = {0, 3, 6};
    static const int aug[3]  = {0, 4, 8};
    static const int s7[4]   = {0, 4, 7, 10};
    static const int m7[4]   = {0, 3, 7, 10};
    static const int maj7[4] = {0, 4, 7, 11};
    static const int dim7[4] = {0, 3, 6, 9};
    static const int sus2[3] = {0, 2, 7};
    static const int sus4[3] = {0, 5, 7};
    const int *src = maj; int n = 3;
    if (!quality) { src = maj; n = 3; }
    else if (strcmp(quality, "min") == 0) { src = min; n = 3; }
    else if (strcmp(quality, "dim") == 0) { src = dim; n = 3; }
    else if (strcmp(quality, "aug") == 0) { src = aug; n = 3; }
    else if (strcmp(quality, "7") == 0) { src = s7; n = 4; }
    else if (strcmp(quality, "m7") == 0) { src = m7; n = 4; }
    else if (strcmp(quality, "maj7") == 0) { src = maj7; n = 4; }
    else if (strcmp(quality, "dim7") == 0) { src = dim7; n = 4; }
    else if (strcmp(quality, "sus2") == 0) { src = sus2; n = 3; }
    else if (strcmp(quality, "sus4") == 0) { src = sus4; n = 3; }
    int count = n < max ? n : max;
    for (int i = 0; i < count; i++) out[i] = src[i];
    return count;
}

/* Same as chord_quality_intervals, but rotated into the given inversion:
 * 0 = root position (unchanged), 1 = first inversion (the original lowest
 * tone moved up an octave, so the next tone becomes the bass), 2 = second,
 * 3 = third (4-note chords only). Clamped to the chord's own tone count - 1
 * (a triad has no third inversion). The rotated set stays in ascending
 * pitch order: the untouched, higher-indexed tones keep their original
 * position (now the lowest), followed by the rotated tones each +12. */
static int chord_voiced_intervals(const char *quality, int inversion, int *out, int max) {
    int raw[4];
    int n = chord_quality_intervals(quality, raw, 4);
    if (inversion < 0) inversion = 0;
    if (inversion > n - 1) inversion = n - 1;
    int count = n < max ? n : max;
    int idx = 0;
    for (int i = inversion; i < n && idx < count; i++) out[idx++] = raw[i];
    for (int i = 0; i < inversion && idx < count; i++) out[idx++] = raw[i] + 12;
    return idx;
}

/* Emit a single note-on/off for an instrument, routed to the instrument's own
 * output target and channel (independent of the engine's drum routing). */
static void emit_instrument_event(engine_t *e, const instrument_t *inst,
                                  uint8_t status, uint8_t note, uint8_t vel) {
    (void)e;
    if (!g_host) return;
    uint8_t high = status & 0xF0;
    uint8_t cin = 0x0F;
    if (high == 0x80)      cin = 0x08;
    else if (high == 0x90) cin = 0x09;
    else if (high == 0xB0) cin = 0x0B;
    uint8_t ch = (uint8_t)(inst->channel & 0x0F);
    uint8_t cable = 2;
    if (inst->output_target == OUTPUT_TARGET_SCHWUNG) cable = 0;
    uint8_t msg[4] = { (cable << 4) | cin, high | ch, note, vel };
    if (inst->output_target == OUTPUT_TARGET_SCHWUNG) {
        if (g_host->midi_send_internal) g_host->midi_send_internal(msg, 4);
    } else if (inst->output_target == OUTPUT_TARGET_MOVE) {
        if (g_host->midi_inject_to_move) g_host->midi_inject_to_move(msg, 4);
    } else {
        if (g_host->midi_send_external) g_host->midi_send_external(msg, 4);
    }
}

/* Emit the chord for a given section/bar on an instrument. voicing 0 = bass
 * note (root, or slash bass), 1 = full chord. Returns the number of notes
 * emitted (so the caller can send matching note-offs). */
static int emit_instrument_chord(engine_t *e, const instrument_t *inst,
                                 const chord_t *ch, uint8_t vel) {
    if (!ch || !ch->set) return 0;
    int root_pc = note_name_semitone(ch->root);
    if (root_pc < 0) root_pc = 0;
    int base = (inst->octave + 1) * 12;
    if (inst->voicing) {
        /* Full chord voicing. */
        int intervals[4];
        int n = chord_voiced_intervals(ch->quality, inst->inversion, intervals, 4);
        for (int i = 0; i < n; i++) {
            int note = base + root_pc + intervals[i];
            if (note < 0) note = 0;
            if (note > 127) note = 127;
            emit_instrument_event(e, inst, 0x90, (uint8_t)note, vel);
        }
        return n;
    } else {
        /* Bass note: slash bass if set, else root. */
        const char *bass = (ch->bass[0]) ? ch->bass : ch->root;
        int bass_pc = note_name_semitone(bass);
        if (bass_pc < 0) bass_pc = root_pc;
        int note = base + bass_pc;
        if (note < 0) note = 0;
        if (note > 127) note = 127;
        emit_instrument_event(e, inst, 0x90, (uint8_t)note, vel);
        return 1;
    }
}

/* Send note-offs for the chord previously emitted on an instrument (so a
 * chord change doesn't leave the old notes ringing). */
static void emit_instrument_chord_off(engine_t *e, const instrument_t *inst,
                                      const chord_t *ch) {
    if (!ch || !ch->set) return;
    int root_pc = note_name_semitone(ch->root);
    if (root_pc < 0) root_pc = 0;
    int base = (inst->octave + 1) * 12;
    if (inst->voicing) {
        int intervals[4];
        int n = chord_voiced_intervals(ch->quality, inst->inversion, intervals, 4);
        for (int i = 0; i < n; i++) {
            int note = base + root_pc + intervals[i];
            if (note < 0) note = 0;
            if (note > 127) note = 127;
            emit_instrument_event(e, inst, 0x80, (uint8_t)note, 0);
        }
    } else {
        const char *bass = (ch->bass[0]) ? ch->bass : ch->root;
        int bass_pc = note_name_semitone(bass);
        if (bass_pc < 0) bass_pc = root_pc;
        int note = base + bass_pc;
        if (note < 0) note = 0;
        if (note > 127) note = 127;
        emit_instrument_event(e, inst, 0x80, (uint8_t)note, 0);
    }
}

/* Find the per-bar override entry for a section/bar, or NULL if that bar has
 * no override (uses the track's own octave/follow_note/voicing). */
static const instrument_bar_override_t *find_bar_override(const instrument_t *inst, int section, int bar) {
    if (!inst) return NULL;
    for (int k = 0; k < inst->override_count && k < MAX_INSTRUMENT_OVERRIDES; k++) {
        if (inst->overrides[k].section == section && inst->overrides[k].bar == bar) return &inst->overrides[k];
    }
    return NULL;
}

/* Resolve the effective instrument config for a given bar: a copy of `inst`
 * with octave/follow_note/voicing overwritten by any matching per-bar
 * override's non-sentinel fields. channel/output_target/enabled/note_gap/bars
 * are never per-bar. This resolved value is what every emission function
 * below actually reads, so the follow_note-vs-bar-boundary emission choice
 * (see emit_instruments_at_tick/emit_instruments_follow) and the octave/
 * voicing used to build a chord are both correct per bar without changing
 * emit_instrument_chord/emit_instrument_chord_off's own signatures. */
static void resolve_instrument_for_bar(const instrument_t *inst, int section, int bar, instrument_t *out) {
    *out = *inst;
    const instrument_bar_override_t *ov = find_bar_override(inst, section, bar);
    if (!ov) return;
    if (ov->octave != -128) out->octave = ov->octave;
    if (ov->follow_note >= 0) out->follow_note = (uint8_t)ov->follow_note;
    if (ov->voicing >= 0) out->voicing = (uint8_t)ov->voicing;
    if (ov->inversion >= 0) out->inversion = (uint8_t)ov->inversion;
}

/* Find the chord active at a given bar within a section. A chord set on an
 * earlier bar carries forward until the next chord (or the section end). */
static const chord_t *chord_at_bar(const section_t *sec, uint32_t bar) {
    if (!sec) return NULL;
    const chord_t *last = NULL;
    for (int b = 0; b < sec->chord_count && b < MAX_SECTION_BARS; b++) {
        if (sec->chords[b].set) last = &sec->chords[b];
        if ((uint32_t)b == bar) break;
    }
    return last;
}

/* Map an absolute playhead tick to a (section, bar-within-section) pair.
 * Returns the section index, or -1 if the tick is out of range. */
static int tick_to_section_bar(const song_t *song, uint32_t tick,
                               uint32_t ticks_per_bar, uint32_t *out_bar) {
    if (!song || ticks_per_bar == 0) return -1;
    uint32_t remaining = tick;
    for (int s = 0; s < song->section_count; s++) {
        uint32_t sec_bars = song->sections[s].bars;
        if (sec_bars < 1) sec_bars = 1;
        uint32_t sec_ticks = sec_bars * ticks_per_bar;
        if (remaining < sec_ticks) {
            if (out_bar) *out_bar = remaining / ticks_per_bar;
            return s;
        }
        remaining -= sec_ticks;
    }
    return -1;
}

/* Compare two chords for equality (both null = equal; both set with the same
 * root/quality/bass = equal). */
static int chord_equal(const chord_t *a, const chord_t *b) {
    if (!a && !b) return 1;
    if (!a || !b) return 0;
    if (a->set != b->set) return 0;
    if (!a->set) return 1;
    return strcmp(a->root, b->root) == 0 &&
           strcmp(a->quality, b->quality) == 0 &&
           strcmp(a->bass, b->bass) == 0;
}

/* Total bars across all sections of the song. */
static uint32_t song_total_bars(const song_t *song) {
    uint32_t total = 0;
    for (int s = 0; s < song->section_count; s++) {
        uint32_t sec_bars = song->sections[s].bars;
        if (sec_bars < 1) sec_bars = 1;
        total += sec_bars;
    }
    return total;
}

/* Get the chord at an absolute bar (0-based across the whole song), or NULL. */
static const chord_t *chord_at_abs_bar(const song_t *song, uint32_t abs_bar) {
    uint32_t remaining = abs_bar;
    for (int s = 0; s < song->section_count; s++) {
        uint32_t sec_bars = song->sections[s].bars;
        if (sec_bars < 1) sec_bars = 1;
        if (remaining < sec_bars) {
            return chord_at_bar(&song->sections[s], remaining);
        }
        remaining -= sec_bars;
    }
    return NULL;
}

/* Emit the chord for every enabled instrument at a given absolute tick. Used
 * at bar boundaries (follow_note == 0). A chord is held across multiple bars:
 * the note-on fires only when the chord changes, and the note-off is scheduled
 * `note_gap` before the next chord change (or the song end). */
static void emit_instruments_at_tick(engine_t *e, uint32_t tick) {
    if (!e || e->live_slot.song.instrument_count == 0) return;
    uint32_t bar = 0;
    int sec_idx = tick_to_section_bar(&e->live_slot.song, tick, e->ticks_per_bar, &bar);
    if (sec_idx < 0) return;
    section_t *sec = &e->live_slot.song.sections[sec_idx];
    const chord_t *ch = chord_at_bar(sec, bar);
    uint32_t abs_bar = tick / e->ticks_per_bar;
    uint32_t total_bars = song_total_bars(&e->live_slot.song);
    /* The chord at the next bar (or NULL past the song end). */
    const chord_t *next_ch = (abs_bar + 1 < total_bars)
        ? chord_at_abs_bar(&e->live_slot.song, abs_bar + 1) : NULL;
    dsp_log_enqueue_worker("EMIT_INST tick=%u sec=%d bar=%u chord=%s next=%s", tick, sec_idx, bar,
            (ch && ch->set) ? ch->root : "null",
            (next_ch && next_ch->set) ? next_ch->root : "null");
    for (int i = 0; i < e->live_slot.song.instrument_count && i < MAX_INSTRUMENTS; i++) {
        instrument_t *inst = &e->live_slot.song.instruments[i];
        if (!inst->enabled) continue;
        instrument_t resolved;
        resolve_instrument_for_bar(inst, sec_idx, (int)bar, &resolved);
        if (resolved.follow_note > 0) {
            /* This bar is follow-note (track default, or a per-bar override
             * switching it on): the drum-hit path (emit_instruments_follow)
             * owns emission here, not this bar-boundary pass. But a chord
             * may still be sounding from a PRECEDING bar-boundary bar (only
             * possible with a per-bar override -- a track-level follow_note
             * is constant, so this transition never occurred before
             * per-bar overrides existed) -- cut it off explicitly so the
             * follow path's next note-on isn't a double-attack over a note
             * that was never turned off. */
            if (e->last_inst_chord_set[i]) {
                emit_instrument_chord_off(e, &e->last_inst_resolved[i], &e->last_inst_chord[i]);
                e->last_inst_chord_set[i] = 0;
                e->pending_off_set[i] = 0;
            }
            continue;
        }
        /* Respect the per-bar mute map (1 = send, 0 = muted). */
        if (bar < MAX_SECTION_BARS && inst->bars[sec_idx][bar] == 0) {
            /* Muted: cut off any sounding note, using the resolved config it
             * was actually turned on with. */
            if (e->last_inst_chord_set[i]) {
                emit_instrument_chord_off(e, &e->last_inst_resolved[i], &e->last_inst_chord[i]);
                e->last_inst_chord_set[i] = 0;
            }
            e->pending_off_set[i] = 0;
            continue;
        }
        if (ch && ch->set) {
            /* Emit a note-on only when the chord actually changes (a held
             * chord stays on across multiple bars). */
            if (!e->last_inst_chord_set[i] || !chord_equal(&e->last_inst_chord[i], ch)) {
                emit_instrument_chord(e, &resolved, ch, 100);
                e->last_inst_chord[i] = *ch;
                e->last_inst_chord_set[i] = 1;
                e->last_inst_resolved[i] = resolved;
                dsp_log_enqueue_worker("EMIT_INST[%d] note-on root=%s ch=%d oct=%d voicing=%d",
                        i, ch->root, resolved.channel, resolved.octave, resolved.voicing);
            }
            /* Schedule the note-off `note_gap` before the next chord change
             * (or the song end), so the note is cut short rather than the new
             * note being delayed. */
            if (!next_ch || !next_ch->set || !chord_equal(ch, next_ch)) {
                uint32_t gap = (uint32_t)(resolved.note_gap * e->ticks_per_beat);
                uint32_t off_tick = (abs_bar + 1) * e->ticks_per_bar - gap;
                if (off_tick <= tick) off_tick = tick + 1;
                schedule_instrument_note_off(e, i, &resolved, off_tick);
            }
        } else {
            /* No chord here: cut off any sounding note, using the resolved
             * config it was actually turned on with. */
            if (e->last_inst_chord_set[i]) {
                emit_instrument_chord_off(e, &e->last_inst_resolved[i], &e->last_inst_chord[i]);
                e->last_inst_chord_set[i] = 0;
            }
            e->pending_off_set[i] = 0;
        }
    }
}

/* Send note-offs for every instrument that currently has a chord sounding.
 * Called on stop so instrument notes don't ring on after playback ends. */
static void emit_instruments_all_off(engine_t *e) {
    if (!e) return;
    for (int i = 0; i < e->live_slot.song.instrument_count && i < MAX_INSTRUMENTS; i++) {
        instrument_t *inst = &e->live_slot.song.instruments[i];
        if (!inst->enabled) continue;
        if (e->last_inst_chord_set[i]) {
            emit_instrument_chord_off(e, &e->last_inst_resolved[i], &e->last_inst_chord[i]);
            e->last_inst_chord_set[i] = 0;
        }
        /* Drop any deferred note-off that hasn't fired yet. */
        e->pending_off_set[i] = 0;
    }
}

/* Schedule the note-off for instrument i's currently-sounding chord to fire at
 * `tick` (computed as the next note-on time minus note_gap), so the previous
 * note is cut short rather than the new note being delayed. */
static void schedule_instrument_note_off(engine_t *e, int i, const instrument_t *inst,
                                         uint32_t tick) {
    (void)inst;
    e->pending_off_tick[i] = tick;
    e->pending_off_set[i] = 1;
}

/* Fire any scheduled instrument note-offs whose tick has been reached by the
 * playhead. Called each render block from advance_playhead. */
static void fire_pending_instrument_notes_off(engine_t *e, uint32_t tick) {
    if (!e) return;
    for (int i = 0; i < e->live_slot.song.instrument_count && i < MAX_INSTRUMENTS; i++) {
        if (!e->pending_off_set[i]) continue;
        if (e->pending_off_tick[i] > tick) continue;
        if (e->last_inst_chord_set[i]) {
            emit_instrument_chord_off(e, &e->last_inst_resolved[i], &e->last_inst_chord[i]);
            e->last_inst_chord_set[i] = 0;
        }
        e->pending_off_set[i] = 0;
        dsp_log_enqueue_worker("EMIT_INST[%d] note-off (deferred) tick=%u", i, tick);
    }
}

/* Find the tick of the next note-on with the given note number at or after
 * `from_tick` in the assembled timeline. Returns 0 if none (past the end). */
static uint32_t find_next_note_on_tick(engine_t *e, uint8_t note, uint32_t from_tick) {
    for (int c = e->event_cursor; c < e->live_slot.event_count; c++) {
        const smf_event_t *ev = &e->live_slot.events[c];
        if (ev->tick < from_tick) continue;
        if ((ev->status & 0xF0) == 0x90 && ev->data2 > 0 && ev->data1 == note) {
            return ev->tick;
        }
    }
    return 0;
}

/* Emit the chord for follow-note instruments when a matching drum note-on
 * fires. Called from the event drain path. The note is held until the next
 * matching drum hit, cut short by `note_gap` before it (or the song end). */
static void emit_instruments_follow(engine_t *e, uint8_t note, uint32_t tick) {
    if (!e || e->live_slot.song.instrument_count == 0) return;
    uint32_t bar = 0;
    int sec_idx = tick_to_section_bar(&e->live_slot.song, tick, e->ticks_per_bar, &bar);
    if (sec_idx < 0) return;
    /* A drum hit anticipating the downbeat (e.g. a pushed kick just before
     * the barline) still falls within the outgoing bar by tick, but
     * musically belongs to the bar it's leading into. When it lands within
     * the Swap Guard window of the next bar boundary, pick up that next
     * bar's chord (and mute state) instead of holding the outgoing one a
     * beat early. Falls back to the outgoing bar past the end of the song. */
    if (e->ticks_per_bar > 0) {
        uint32_t abs_bar = tick / e->ticks_per_bar;
        uint32_t bar_end_tick = (abs_bar + 1) * e->ticks_per_bar;
        uint32_t guard_ticks = (uint32_t)(e->swap_guard_fraction * e->ticks_per_beat);
        if (bar_end_tick > tick && (bar_end_tick - tick) <= guard_ticks) {
            uint32_t next_bar = 0;
            int next_sec = tick_to_section_bar(&e->live_slot.song, bar_end_tick, e->ticks_per_bar, &next_bar);
            if (next_sec >= 0) {
                sec_idx = next_sec;
                bar = next_bar;
            }
        }
    }
    section_t *sec = &e->live_slot.song.sections[sec_idx];
    const chord_t *ch = chord_at_bar(sec, bar);
    for (int i = 0; i < e->live_slot.song.instrument_count && i < MAX_INSTRUMENTS; i++) {
        instrument_t *inst = &e->live_slot.song.instruments[i];
        if (!inst->enabled) continue;
        instrument_t resolved;
        resolve_instrument_for_bar(inst, sec_idx, (int)bar, &resolved);
        if (resolved.follow_note == 0 || resolved.follow_note != note) continue;
        if (bar < MAX_SECTION_BARS && inst->bars[sec_idx][bar] == 0) continue;
        if (ch && ch->set) {
            /* Fire the new note-on immediately (on the drum hit). */
            emit_instrument_chord(e, &resolved, ch, 100);
            e->last_inst_chord[i] = *ch;
            e->last_inst_chord_set[i] = 1;
            e->last_inst_resolved[i] = resolved;
            /* Hold until the next matching drum hit, cut short by note_gap.
             * If there is no next hit, hold until the song end. */
            uint32_t gap = (uint32_t)(resolved.note_gap * e->ticks_per_beat);
            uint32_t next = find_next_note_on_tick(e, note, tick + 1);
            uint32_t off_tick;
            if (next > 0) {
                off_tick = (next > gap) ? (next - gap) : next;
            } else {
                off_tick = e->live_slot.end_tick;
            }
            if (off_tick > tick) {
                schedule_instrument_note_off(e, i, &resolved, off_tick);
            }
        }
    }
}

/* -------------------------------------------------------------------------- */
/* Song loading from JSON                                                     */
/* -------------------------------------------------------------------------- */

/* Parse a song JSON into the supplied `song` structure and return its tempo /
 * time-signature / tick grid. This helper is shared by the active song load
 * and the Jam-mode preload path. It resolves clip indices into the engine's
 * clip cache but does NOT touch the active timeline or playback state. */
static int parse_song_json(engine_t *e, const char *json, song_t *song,
                           double *out_tempo_bpm, int *out_ts_num,
                           int *out_ts_den, uint32_t *out_tpb,
                           uint32_t *out_tpbar) {
    json_get_string(json, "source_folder", song->source_folder, sizeof(song->source_folder));
    json_get_string(json, "name", song->name, sizeof(song->name));
    json_get_string(json, "key", song->key, sizeof(song->key));
    if (!song->key[0]) copy_trunc(song->key, sizeof(song->key), "C");
    double tmp_d = 120.0;
    json_get_double_at(json, "tempo_bpm", &tmp_d);
    song->tempo_bpm = tmp_d;
    int tmp_i = 4;
    json_get_int_at(json, "time_sig_num", &tmp_i);
    song->time_sig_num = tmp_i;
    tmp_i = 4;
    json_get_int_at(json, "time_sig_den", &tmp_i);
    song->time_sig_den = tmp_i;

    *out_tempo_bpm = song->tempo_bpm;
    *out_ts_num = song->time_sig_num;
    *out_ts_den = song->time_sig_den;

    /* Default PPQ comes from the song JSON if present, otherwise 240. */
    int ppq = 240;
    json_get_int_at(json, "ppq", &ppq);
    if (ppq < 24) ppq = 24;
    if (ppq > 960) ppq = 960;
    *out_tpb = (uint32_t)ppq;
    /* A bar has (4/denominator)*numerator quarter-note beats. */
    *out_tpbar = (uint32_t)(*out_tpb * 4.0 * *out_ts_num / *out_ts_den);
    if (*out_tpbar == 0) *out_tpbar = *out_tpb;

    /* Parse sections array. */
    const char *sec_pos = strstr(json, "\"sections\"");
    if (!sec_pos) {
        song->section_count = 0;
        return 0;
    }
    const char *arr_start = strchr(sec_pos, '[');
    if (!arr_start) {
        song->section_count = 0;
        return 0;
    }

    int depth = 0;
    const char *p = arr_start;
    int in_string = 0;
    int escape = 0;
    int section_idx = -1;
    int clip_idx = -1;

    while (*p) {
        char c = *p;
        if (escape) { escape = 0; p++; continue; }
        if (c == '\\') { escape = 1; p++; continue; }
        if (c == '"') {
            in_string = !in_string;
            /* When entering a string at clip depth, parse the key. */
            if (in_string && depth == 2 && section_idx >= 0 && clip_idx >= 0) {
                section_t *sec = &song->sections[section_idx];
                section_clip_t *sc = &sec->clips[clip_idx];
                const char *key_start = p + 1;
                if (strncmp(key_start, "source\"", 7) == 0) {
                    char rel[MAX_PATH_LEN];
                    if (json_get_string_at(p, "source", rel, sizeof(rel))) {
                        copy_trunc(sc->source_path, sizeof(sc->source_path), rel);
                        /* Resolve now using the song's source_folder; if a
                         * per-clip source_folder appears later in the JSON, it
                         * will re-resolve with the correct folder. */
                        sc->clip_index = resolve_clip_index(e, rel, song->source_folder);
                        dsp_host_log("load_song: section=%d clip=%d source=%.120s folder=%.120s idx=%d",
                                     section_idx, clip_idx, rel, song->source_folder, sc->clip_index);
                    }
                    sc->status = 1;
                } else if (strncmp(key_start, "source_folder\"", 14) == 0) {
                    char folder[MAX_PATH_LEN];
                    if (json_get_string_at(p, "source_folder", folder, sizeof(folder))) {
                        copy_trunc(sc->source_folder, sizeof(sc->source_folder), folder);
                        /* A per-clip source_folder overrides the song's. The
                         * source was parsed before this key, so re-resolve the
                         * clip index with the correct folder. */
                        if (sc->source_path[0]) {
                            sc->clip_index = resolve_clip_index(e, sc->source_path, folder);
                            dsp_host_log("load_song: re-resolve section=%d clip=%d source=%.120s folder=%.120s idx=%d",
                                         section_idx, clip_idx, sc->source_path, folder, sc->clip_index);
                        }
                    }
                } else if (strncmp(key_start, "start_bar\"", 10) == 0) {
                    int v; if (json_get_int_at(p, "start_bar", &v)) sc->start_bar = (uint32_t)v;
                } else if (strncmp(key_start, "start_beat\"", 11) == 0) {
                    int v; if (json_get_int_at(p, "start_beat", &v)) sc->start_beat = (uint32_t)v;
                } else if (strncmp(key_start, "end_bar\"", 8) == 0) {
                    int v; if (json_get_int_at(p, "end_bar", &v)) sc->end_bar = (uint32_t)v;
                } else if (strncmp(key_start, "end_beat\"", 9) == 0) {
                    int v; if (json_get_int_at(p, "end_beat", &v)) sc->end_beat = (uint32_t)v;
                } else if (strncmp(key_start, "guard_fraction\"", 15) == 0) {
                    double v; if (json_get_double_at(p, "guard_fraction", &v)) sc->guard_fraction = v;
                } else if (strncmp(key_start, "velocity_scale\"", 15) == 0) {
                    double v; if (json_get_double_at(p, "velocity_scale", &v)) sc->velocity_scale = v;
                } else if (strncmp(key_start, "speed\"", 6) == 0) {
                    double v;
                    if (json_get_double_at(p, "speed", &v)) {
                        if (v < 0.1) v = 0.1;
                        if (v > 10.0) v = 10.0;
                        sc->speed = v;
                    }
                } else if (strncmp(key_start, "snare_note\"", 11) == 0) {
                    int v; if (json_get_int_at(p, "snare_note", &v)) sc->snare_note = (uint8_t)v;
                } else if (strncmp(key_start, "snare_velocity_scale\"", 21) == 0) {
                    double v; if (json_get_double_at(p, "snare_velocity_scale", &v)) sc->snare_velocity_scale = v;
                } else if (strncmp(key_start, "kick_note\"", 10) == 0) {
                    int v; if (json_get_int_at(p, "kick_note", &v)) sc->kick_note = (uint8_t)v;
                } else if (strncmp(key_start, "kick_target\"", 12) == 0) {
                    int v; if (json_get_int_at(p, "kick_target", &v)) sc->kick_target = (uint8_t)v;
                } else if (strncmp(key_start, "channel\"", 8) == 0) {
                    int v;
                    if (json_get_int_at(p, "channel", &v)) {
                        /* Per-clip MIDI channel override. 0 = no override (use
                         * the engine's output-target channel); else 1-16 stored
                         * as the channel number and converted to 0-based. */
                        if (v >= 1 && v <= 16) sc->channel = (int8_t)(v - 1);
                        else sc->channel = -1;
                    }
                }
            }
            p++;
            continue;
        }
        if (in_string) { p++; continue; }

        if (c == '{') {
            depth++;
            if (depth == 1) {
                section_idx++;
                clip_idx = -1;
                if (section_idx >= MAX_SONG_SECTIONS) return -1;
                section_t *sec = &song->sections[section_idx];
                memset(sec, 0, sizeof(*sec));
            } else if (depth == 2) {
                clip_idx++;
                if (clip_idx >= MAX_SECTION_CLIPS) return -1;
                section_t *sec = &song->sections[section_idx];
                sec->clip_count++;
                section_clip_t *sc = &sec->clips[clip_idx];
                sc->clip_index = -1;
                sc->status = 0;
                sc->source_folder[0] = '\0';
                sc->source_path[0] = '\0';
                sc->start_bar = 0;
                sc->end_bar = 1;
                sc->start_beat = 0;
                sc->end_beat = 0;
                sc->guard_fraction = e->guard_fraction;
                sc->velocity_scale = 1.0;         /* unchanged by default */
                sc->speed = 1.0;                  /* normal speed */
                sc->snare_note = 38;              /* GM snare default */
                sc->snare_velocity_scale = 1.0;   /* unchanged by default */
                sc->kick_note = 36;               /* GM kick default */
                sc->kick_target = 0;              /* disabled by default */
                sc->channel = -1;                 /* use engine output channel by default */
            }
            p++;
            continue;
        }
        if (c == '}') {
            depth--;
            p++;
            continue;
        }
        if (c == '[') {
            p++;
            continue;
        }
        if (c == ']') {
            if (depth == 0) break;
            p++;
            continue;
        }

        p++;
    }

    song->section_count = section_idx + 1;

    /* Parse the per-section "chords" arrays and the top-level "instruments"
     * array. These are parsed in a separate pass (rather than inside the
     * depth-tracking clip loop) because their nesting differs: chords are a
     * depth-1 array of objects/null, instruments are a top-level array of
     * objects with a nested per-section "bars" array. */
    parse_chords_and_instruments(json, song);

    return 0;
}

/* Parse the per-section "chords" arrays and the top-level "instruments" array
 * into `song`. Chords are stored per-bar (null entries are skipped); a chord
 * object is {root, quality, bass}. Instruments are {enabled, output, channel,
 * octave, follow_note, voicing, bars:[[1,0,...],...]}. */
static void parse_chords_and_instruments(const char *json, song_t *song) {
    /* --- Chords: walk each section object and read its "chords" array. --- */
    const char *sec_pos = strstr(json, "\"sections\"");
    if (sec_pos) {
        const char *arr_start = strchr(sec_pos, '[');
        if (arr_start) {
            int depth = 0, in_string = 0, escape = 0;
            int section_idx = -1;
            const char *p = arr_start;
            while (*p) {
                char c = *p;
                if (escape) { escape = 0; p++; continue; }
                if (c == '\\') { escape = 1; p++; continue; }
                if (c == '"') {
                    in_string = !in_string;
                    /* On entering a string at section depth, detect the
                     * "chords" key and parse its array. This must happen here
                     * (not after the generic quote handling) because the quote
                     * is consumed by this branch. */
                    if (in_string && depth == 1 && section_idx >= 0 &&
                        section_idx < MAX_SONG_SECTIONS &&
                        strncmp(p, "\"chords\"", 8) == 0) {
                        const char *ch_arr = strchr(p + 8, '[');
                        if (ch_arr) {
                            parse_section_chords(ch_arr, &song->sections[section_idx]);
                        }
                    }
                    p++;
                    continue;
                }
                if (in_string) { p++; continue; }
                if (c == '{') {
                    depth++;
                    if (depth == 1) section_idx++;
                    p++;
                    continue;
                }
                if (c == '}') { depth--; p++; continue; }
                if (c == '[') { p++; continue; }
                if (c == ']') { if (depth == 0) break; p++; continue; }
                p++;
            }
        }
    }

    /* --- Instruments: read the top-level "instruments" array. --- */
    const char *inst_pos = strstr(json, "\"instruments\"");
    if (!inst_pos) return;
    const char *inst_arr = strchr(inst_pos, '[');
    if (!inst_arr) return;
    int depth = 0, in_string = 0, escape = 0;
    int inst_idx = -1;
    const char *p = inst_arr;
    while (*p) {
        char c = *p;
        if (escape) { escape = 0; p++; continue; }
        if (c == '\\') { escape = 1; p++; continue; }
        if (c == '"') {
            in_string = !in_string;
            /* Parse a key when entering a string at instrument depth. */
            if (in_string && depth == 1 && inst_idx >= 0 && inst_idx < MAX_INSTRUMENTS) {
                instrument_t *inst = &song->instruments[inst_idx];
                if (strncmp(p + 1, "enabled", 7) == 0) {
                    /* "enabled" is serialized as a JSON boolean (true/false),
                     * not a number, so atoi() would read 0 for "true". Parse
                     * the raw value and accept true/1 as enabled. */
                    char v[16];
                    if (json_get_string_at(p, "enabled", v, sizeof(v))) {
                        inst->enabled = (strcmp(v, "true") == 0 || strcmp(v, "1") == 0) ? 1 : 0;
                    }
                } else if (strncmp(p + 1, "output", 6) == 0) {
                    char out[16];
                    if (json_get_string_at(p, "output", out, sizeof(out))) {
                        if (strcmp(out, "move") == 0) inst->output_target = OUTPUT_TARGET_MOVE;
                        else if (strcmp(out, "schwung") == 0) inst->output_target = OUTPUT_TARGET_SCHWUNG;
                        else inst->output_target = OUTPUT_TARGET_EXTERNAL;
                    }
                } else if (strncmp(p + 1, "channel", 7) == 0) {
                    int v; if (json_get_int_at(p, "channel", &v)) {
                        if (v >= 1 && v <= 16) inst->channel = v - 1;
                    }
                } else if (strncmp(p + 1, "octave", 6) == 0) {
                    int v; if (json_get_int_at(p, "octave", &v)) inst->octave = v;
                } else if (strncmp(p + 1, "follow_note", 11) == 0) {
                    int v; if (json_get_int_at(p, "follow_note", &v)) inst->follow_note = (uint8_t)v;
                } else if (strncmp(p + 1, "voicing", 7) == 0) {
                    char v[16];
                    if (json_get_string_at(p, "voicing", v, sizeof(v))) {
                        inst->voicing = (strcmp(v, "chord") == 0) ? 1 : 0;
                    }
                } else if (strncmp(p + 1, "inversion", 9) == 0) {
                    int v; if (json_get_int_at(p, "inversion", &v)) inst->inversion = (uint8_t)(v < 0 ? 0 : v);
                } else if (strncmp(p + 1, "note_gap", 8) == 0) {
                    double v; if (json_get_double_at(p, "note_gap", &v)) inst->note_gap = v;
                } else if (strncmp(p + 1, "bars", 4) == 0) {
                    /* "bars": [[1,0,...], [1,1,...], ...] — per-section arrays. */
                    const char *bars_arr = strchr(p + 4, '[');
                    if (bars_arr) parse_instrument_bars(bars_arr, inst);
                } else if (strncmp(p + 1, "overrides", 9) == 0) {
                    /* "overrides": [{"section":0,"bar":3,"octave":5,...}, ...] */
                    const char *ov_arr = strchr(p + 9, '[');
                    if (ov_arr) parse_instrument_overrides(ov_arr, inst);
                }
            }
            p++;
            continue;
        }
        if (in_string) { p++; continue; }
        if (c == '{') {
            depth++;
            if (depth == 1) {
                inst_idx++;
                if (inst_idx >= MAX_INSTRUMENTS) break;
                instrument_t *inst = &song->instruments[inst_idx];
                memset(inst, 0, sizeof(*inst));
                inst->output_target = OUTPUT_TARGET_EXTERNAL;
                inst->channel = 0;
                inst->octave = 3;
                inst->voicing = 0;
                inst->note_gap = 0.25; /* default: 1/4 beat gap between note-off and note-on */
                /* Bars are "on by default" (send the chord). A bar is only
                 * muted when the JSON explicitly sets it to 0. Initialise the
                 * whole map to 1 so an instrument with no per-bar toggles (or
                 * a sparse bars array) still sends every chord. */
                memset(inst->bars, 1, sizeof(inst->bars));
            }
            p++;
            continue;
        }
        if (c == '}') { depth--; p++; continue; }
        if (c == '[') { p++; continue; }
        if (c == ']') { if (depth == 0) break; p++; continue; }
        p++;
    }
    song->instrument_count = inst_idx + 1;

    /* Diagnostic: confirm what was parsed so instrument emission can be
     * verified against the song JSON. */
    arr_log("PARSE_INST count=%d", song->instrument_count);
    for (int i = 0; i < song->instrument_count && i < MAX_INSTRUMENTS; i++) {
        instrument_t *inst = &song->instruments[i];
        arr_log("PARSE_INST[%d] enabled=%d output=%d channel=%d octave=%d follow=%d voicing=%d",
                i, inst->enabled, inst->output_target, inst->channel,
                inst->octave, inst->follow_note, inst->voicing);
    }
    for (int s = 0; s < song->section_count; s++) {
        section_t *sec = &song->sections[s];
        arr_log("PARSE_CHORD section=%d chord_count=%d", s, sec->chord_count);
        for (int b = 0; b < sec->chord_count && b < MAX_SECTION_BARS; b++) {
            if (sec->chords[b].set) {
                arr_log("PARSE_CHORD[%d][%d] root=%s quality=%s bass=%s",
                        s, b, sec->chords[b].root, sec->chords[b].quality,
                        sec->chords[b].bass);
            }
        }
    }
}

/* Parse a section's "chords" array: [ {root,quality,bass}, null, ... ]. */
static void parse_section_chords(const char *arr, section_t *sec) {
    if (!arr || !sec) return;
    int depth = 0, in_string = 0, escape = 0;
    int bar = -1;
    const char *p = arr;
    while (*p) {
        char c = *p;
        if (escape) { escape = 0; p++; continue; }
        if (c == '\\') { escape = 1; p++; continue; }
        if (c == '"') {
            in_string = !in_string;
            if (in_string && depth == 1 && bar >= 0 && bar < MAX_SECTION_BARS) {
                chord_t *ch = &sec->chords[bar];
                if (strncmp(p + 1, "root", 4) == 0) {
                    char v[8];
                    if (json_get_string_at(p, "root", v, sizeof(v))) copy_trunc(ch->root, sizeof(ch->root), v);
                } else if (strncmp(p + 1, "quality", 7) == 0) {
                    char v[8];
                    if (json_get_string_at(p, "quality", v, sizeof(v))) copy_trunc(ch->quality, sizeof(ch->quality), v);
                } else if (strncmp(p + 1, "bass", 4) == 0) {
                    char v[8];
                    if (json_get_string_at(p, "bass", v, sizeof(v))) copy_trunc(ch->bass, sizeof(ch->bass), v);
                }
            }
            p++;
            continue;
        }
        if (in_string) { p++; continue; }
        if (c == '{') {
            depth++;
            if (depth == 1) {
                bar++;
                if (bar >= MAX_SECTION_BARS) break;
                chord_t *ch = &sec->chords[bar];
                memset(ch, 0, sizeof(*ch));
                ch->set = 1;
                copy_trunc(ch->quality, sizeof(ch->quality), "maj");
            }
            p++;
            continue;
        }
        if (c == '}') { depth--; p++; continue; }
        if (c == '[') { p++; continue; }
        if (c == ']') { if (depth == 0) break; p++; continue; }
        /* A null entry advances the bar index without setting a chord. */
        if (c == 'n' && depth == 0 && strncmp(p, "null", 4) == 0) {
            bar++;
            p += 4;
            continue;
        }
        p++;
    }
    sec->chord_count = bar + 1;
}

/* Parse an instrument's "bars" array: [[1,0,...], [1,1,...], ...]. Each inner
 * array is one section; each 0/1 value is one bar (on/off). The bar index
 * advances per VALUE (comma-separated), not per '[' — an inner array has a
 * single '[' but many values. */
static void parse_instrument_bars(const char *arr, instrument_t *inst) {
    if (!arr || !inst) return;
    int depth = 0, in_string = 0, escape = 0;
    int section = -1, bar = -1;
    const char *p = arr;
    while (*p) {
        char c = *p;
        if (escape) { escape = 0; p++; continue; }
        if (c == '\\') { escape = 1; p++; continue; }
        if (c == '"') { in_string = !in_string; p++; continue; }
        if (in_string) { p++; continue; }
        if (c == '[') {
            depth++;
            if (depth == 1) { section++; bar = -1; }
            p++;
            continue;
        }
        if (c == ']') { depth--; p++; continue; }
        if (c == '0' || c == '1') {
            if (depth == 2) {
                bar++;
                if (section >= 0 && section < MAX_SONG_SECTIONS &&
                    bar >= 0 && bar < MAX_SECTION_BARS) {
                    inst->bars[section][bar] = (uint8_t)(c - '0');
                }
            }
            p++;
            continue;
        }
        p++;
    }
}

/* Parse an instrument's "overrides" array:
 * [{"section":0,"bar":3,"octave":5,"follow_note":40,"voicing":"chord",
 *   "inversion":1}, ...].
 * Each object customizes one bar's octave/follow_note/voicing/inversion
 * (mute is NOT here -- it stays in "bars"); a field the object omits keeps
 * its "use the track default" sentinel. Tracks only '{'/'}' depth (one
 * increment per entry, always to depth 1, since the entries are flat
 * sibling objects) -- deliberately not the '['/']' nesting
 * parse_instrument_bars above uses, which only fires its section-boundary
 * logic on the array's own outer '[' and so never distinguishes a
 * second/third inner section array. */
static void parse_instrument_overrides(const char *arr, instrument_t *inst) {
    if (!arr || !inst) return;
    int depth = 0, in_string = 0, escape = 0;
    instrument_bar_override_t cur = {0, 0, -128, -1, -1, -1};
    const char *p = arr;
    while (*p) {
        char c = *p;
        if (escape) { escape = 0; p++; continue; }
        if (c == '\\') { escape = 1; p++; continue; }
        if (c == '"') {
            in_string = !in_string;
            if (in_string && depth == 1) {
                if (strncmp(p + 1, "section", 7) == 0) {
                    int v; if (json_get_int_at(p, "section", &v)) cur.section = (int16_t)v;
                } else if (strncmp(p + 1, "bar", 3) == 0) {
                    int v; if (json_get_int_at(p, "bar", &v)) cur.bar = (int16_t)v;
                } else if (strncmp(p + 1, "octave", 6) == 0) {
                    int v; if (json_get_int_at(p, "octave", &v)) cur.octave = (int8_t)v;
                } else if (strncmp(p + 1, "follow_note", 11) == 0) {
                    int v; if (json_get_int_at(p, "follow_note", &v)) cur.follow_note = (int16_t)v;
                } else if (strncmp(p + 1, "voicing", 7) == 0) {
                    char v[16];
                    if (json_get_string_at(p, "voicing", v, sizeof(v))) {
                        cur.voicing = (int8_t)((strcmp(v, "chord") == 0) ? 1 : 0);
                    }
                } else if (strncmp(p + 1, "inversion", 9) == 0) {
                    int v; if (json_get_int_at(p, "inversion", &v)) cur.inversion = (int8_t)(v < 0 ? 0 : v);
                }
            }
            p++;
            continue;
        }
        if (in_string) { p++; continue; }
        if (c == '{') {
            depth++;
            if (depth == 1) {
                cur.section = -1; cur.bar = -1;
                cur.octave = -128; cur.follow_note = -1; cur.voicing = -1; cur.inversion = -1;
            }
            p++;
            continue;
        }
        if (c == '}') {
            depth--;
            if (depth == 0) {
                if (cur.section >= 0 && cur.bar >= 0 && inst->override_count < MAX_INSTRUMENT_OVERRIDES) {
                    inst->overrides[inst->override_count++] = cur;
                }
            }
            p++;
            continue;
        }
        if (c == ']' && depth == 0) break;
        p++;
    }
}

/* -------------------------------------------------------------------------- */
/* Library scanning (for JS UI via get_param)                                */
/* -------------------------------------------------------------------------- */

static int song_entry_cmp(const void *a, const void *b) {
    const song_entry_t *sa = a, *sb = b;
    return strcasecmp(sa->name, sb->name);
}

/* Free the per-folder heap clip buffers in one double-buffer slot. The
 * folders[] array itself is a fixed struct member (no free needed); only the
 * clip_names/clip_bars pointers are heap. Runs on the worker thread. */
static void free_folder_slot(folder_entry_t *folders, int count) {
    if (!folders) return;
    for (int i = 0; i < count; i++) {
        if (folders[i].clip_names) { free(folders[i].clip_names); folders[i].clip_names = NULL; }
        if (folders[i].clip_bars) { free(folders[i].clip_bars); folders[i].clip_bars = NULL; }
        folders[i].clip_count = 0;
    }
}

/* Free the cached library/song scans, if any. Runs on the worker thread (or
 * on destroy_instance after the worker is joined). */
static void free_library_cache(engine_t *e) {
    free_folder_slot(e->folders[0], e->folder_count[0]);
    free_folder_slot(e->folders[1], e->folder_count[1]);
    e->folder_count[0] = 0;
    e->folder_count[1] = 0;
    atomic_store_explicit(&e->folder_active, 0, memory_order_relaxed);
    atomic_store_explicit(&e->folder_dirty, 0, memory_order_relaxed);
    e->song_count[0] = 0;
    e->song_count[1] = 0;
    atomic_store_explicit(&e->song_active, 0, memory_order_relaxed);
    atomic_store_explicit(&e->song_dirty, 0, memory_order_relaxed);
    clip_lookup_free(e);
}

/* Return the active folder scan slot. The worker scans into the inactive slot
 * and flips folder_active when done; the audio thread only reads slot
 * [folder_active]. Zero allocation, zero I/O. */
static folder_entry_t* get_cached_folders(engine_t *e, int *out_count) {
    int active = atomic_load_explicit(&e->folder_active, memory_order_acquire);
    *out_count = e->folder_count[active];
    return e->folders[active];
}

/* Lazy whole-library clip index. Walks the library ONCE (via the cached
 * folder scan) and records each MIDI file's leaf name -> full path, so the
 * expensive recursive whole-library fallback in resolve_clip_index is only
 * paid on the first clip that needs it; every subsequent fallback clip
 * resolves from this in-memory table instead of re-walking the entire tree.
 * Returns the full path for `leaf` (a bare file name, optionally with .mid),
 * or NULL if not found or if the name is ambiguous. The index is invalidated
 * by free_library_cache (library_root change / scan_library / clear_song). */
static const char* clip_lookup_find(engine_t *e, const char *leaf) {
    if (!leaf) return NULL;
    if (!e->clip_index_valid) {
        if (e->clip_index) { free(e->clip_index); e->clip_index = NULL; }
        e->clip_index_cap = 0;
        int nfold = 0;
        folder_entry_t *folders = get_cached_folders(e, &nfold);
        if (!folders || nfold <= 0) { e->clip_index_valid = 1; return NULL; }
        /* Total clip count bounds the index. */
        int cap = 0;
        for (int i = 0; i < nfold; i++) cap += folders[i].clip_count;
        if (cap < 1) cap = 1;
        /* Pass 1: count how many folders hold each leaf name, and remember one
         * full path per leaf. Only leaves seen exactly once are unambiguous
         * and safe to index (a name in two folders would silently resolve to
         * the wrong one). */
        clip_lookup_entry_t *idx = calloc(cap, sizeof(clip_lookup_entry_t));
        int *count = calloc(cap, sizeof(int));
        if (!idx || !count) {
            free(idx); free(count);
            e->clip_index_valid = 1;
            return NULL;
        }
        int n = 0;
        for (int i = 0; i < nfold; i++) {
            folder_entry_t *f = &folders[i];
            for (int c = 0; c < f->clip_count; c++) {
                const char *clip_rel = f->clip_names + (c * 128);
                const char *leaf_s = strrchr(clip_rel, '/');
                leaf_s = leaf_s ? leaf_s + 1 : clip_rel;
                if (!*leaf_s) continue;
                int slot = -1;
                for (int k = 0; k < n; k++) {
                    if (strcasecmp(idx[k].leaf, leaf_s) == 0) { slot = k; break; }
                }
                if (slot < 0) {
                    if (n >= cap) continue;
                    copy_trunc(idx[n].leaf, sizeof(idx[n].leaf), leaf_s);
                    int np = snprintf(idx[n].full_path, sizeof(idx[n].full_path),
                                      "%s/%s", f->path, clip_rel);
                    if (np < 0 || (size_t)np >= sizeof(idx[n].full_path)) {
                        idx[n].leaf[0] = '\0';
                    }
                    count[n] = 1;
                    n++;
                } else {
                    count[slot]++;
                }
            }
        }
        /* Pass 2: blank out ambiguous leaves (count != 1). */
        for (int k = 0; k < n; k++) {
            if (count[k] != 1) idx[k].leaf[0] = '\0';
        }
        e->clip_index = idx;
        e->clip_index_cap = n;
        e->clip_index_valid = 1;
        free(count);
    }
    if (!e->clip_index) return NULL;
    for (int i = 0; i < e->clip_index_cap; i++) {
        if (e->clip_index[i].leaf[0] == '\0') continue;
        if (strcasecmp(e->clip_index[i].leaf, leaf) == 0) {
            return e->clip_index[i].full_path;
        }
    }
    return NULL;
}

/* Invalidate the lazy clip index (called by free_library_cache). */
static void clip_lookup_free(engine_t *e) {
    if (e->clip_index) { free(e->clip_index); e->clip_index = NULL; }
    e->clip_index_cap = 0;
    e->clip_index_valid = 0;
}

/* Return the active song scan slot. Same double-buffer discipline as
 * get_cached_folders. */
static song_entry_t* get_cached_songs(engine_t *e, int *out_count) {
    int active = atomic_load_explicit(&e->song_active, memory_order_acquire);
    *out_count = e->song_count[active];
    return e->songs[active];
}

static void scan_songs_into(engine_t *e, song_entry_t *songs, int *out_count) {
    *out_count = 0;
    char songs_dir[MAX_PATH_LEN];
    char parent[MAX_PATH_LEN];
    /* library_root is a folder; derive sibling Songs dir without using '..'
     * because some host file functions do not normalize relative paths. */
    int n = snprintf(parent, sizeof(parent), "%s", e->library_root);
    if (n < 0 || (size_t)n >= sizeof(parent)) return;
    char *last_slash = strrchr(parent, '/');
    if (!last_slash) return;
    *last_slash = '\0';
    n = snprintf(songs_dir, sizeof(songs_dir), "%s/Songs", parent);
    if (n < 0 || (size_t)n >= sizeof(songs_dir)) return;

    DIR *d = opendir(songs_dir);
    if (!d) return;
    int count = 0;
    struct dirent *ent;
    while ((ent = readdir(d)) && count < SONG_CACHE_MAX) {
        if (ent->d_name[0] == '.') continue;
        size_t len = strlen(ent->d_name);
        if (len < 6 || strcasecmp(ent->d_name + len - 5, ".json") != 0) continue;
        char full_path[MAX_PATH_LEN];
        int fn = snprintf(full_path, sizeof(full_path), "%s/%s", songs_dir, ent->d_name);
        if (fn < 0 || (size_t)fn >= sizeof(full_path)) continue;
        struct stat st;
        if (stat(full_path, &st) != 0 || !S_ISREG(st.st_mode)) continue;
        song_entry_t *s = &songs[count++];
        memset(s, 0, sizeof(*s));
        copy_trunc(s->path, sizeof(s->path), full_path);
        /* Default display name is filename without extension. */
        char display[128];
        int dn_len = (int)(len - 5);
        if (dn_len >= (int)sizeof(display)) dn_len = (int)sizeof(display) - 1;
        memcpy(display, ent->d_name, dn_len);
        display[dn_len] = '\0';
        copy_trunc(s->name, sizeof(s->name), display);

        /* Try to read the "name" field from the JSON for a friendly label. */
        FILE *f = fopen(full_path, "rb");
        if (f) {
            char buf[1024];
            size_t r = fread(buf, 1, sizeof(buf) - 1, f);
            fclose(f);
            if (r > 0) {
                buf[r] = '\0';
                char json_name[128];
                if (json_get_string(buf, "name", json_name, sizeof(json_name)) && json_name[0]) {
                    copy_trunc(s->name, sizeof(s->name), json_name);
                }
            }
        }
    }
    closedir(d);
    qsort(songs, count, sizeof(song_entry_t), song_entry_cmp);
    *out_count = count;
}

static int scan_clip_bars(const char *path, uint32_t *out_bars) {
    FILE *f = fopen(path, "rb");
    if (!f) return -1;
    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (sz < 14 || sz > 8 * 1024 * 1024) { fclose(f); return -2; }
    uint8_t *buf = malloc(sz);
    if (!buf) { fclose(f); return -3; }
    if (fread(buf, 1, sz, f) != (size_t)sz) { free(buf); fclose(f); return -4; }
    fclose(f);
    if (memcmp(buf, "MThd", 4) != 0) { free(buf); return -5; }
    uint32_t hlen = read_be32(buf + 4);
    if (hlen < 6) { free(buf); return -6; }
    uint16_t ntrk = read_be16(buf + 10);
    uint16_t div = read_be16(buf + 12);
    if (div & 0x8000 || div == 0) div = 240;
    uint32_t end_tick = 0;
    uint32_t ts_num = 0, ts_den = 0; /* time signature from meta (den stored as power of 2) */
    const uint8_t *cur = buf + 8 + hlen;
    const uint8_t *buf_end = buf + sz;
    int track_idx = 0;
    while (cur + 8 <= buf_end && track_idx < (int)ntrk) {
        if (memcmp(cur, "MTrk", 4) != 0) break;
        uint32_t tlen = read_be32(cur + 4);
        const uint8_t *tstart = cur + 8;
        const uint8_t *tend = tstart + tlen;
        if (tend > buf_end) tend = buf_end;
        const uint8_t *tp = tstart;
        uint32_t abs_tick = 0;
        uint8_t running_status = 0;
        int track_ended = 0;
        while (tp < tend && !track_ended) {
            uint32_t delta = read_vlq(&tp, tend);
            abs_tick += delta;
            if (tp >= tend) break;
            uint8_t status = *tp;
            if (status < 0x80) status = running_status; else tp++;
            if (status == 0) break;
            if (status == 0xFF) {
                if (tp >= tend) break;
                uint8_t meta_type = *tp++;
                uint32_t mlen = read_vlq(&tp, tend);
                if (tp + mlen > tend) break;
                if (meta_type == 0x58 && ts_num == 0 && mlen >= 2) {
                    /* Time signature: nn dd cc bb — denominator is 2^dd. */
                    ts_num = tp[0];
                    ts_den = (uint32_t)1 << (tp[1] & 0x0F);
                    if (ts_num == 0) ts_num = 4;
                    if (ts_den == 0) ts_den = 4;
                }
                if (meta_type == 0x2F) { track_ended = 1; if (abs_tick > end_tick) end_tick = abs_tick; break; }
                tp += mlen;
                continue;
            }
            if (status == 0xF0 || status == 0xF7) {
                uint32_t sxlen = read_vlq(&tp, tend);
                if (tp + sxlen > tend) break;
                tp += sxlen;
                continue;
            }
            running_status = status;
            uint8_t type = status & 0xF0;
            int dlen = (type == 0xC0 || type == 0xD0) ? 1 : 2;
            if (tp + dlen > tend) break;
            tp += dlen;
            if (abs_tick > end_tick) end_tick = abs_tick;
        }
        cur = tend;
        track_idx++;
    }
    free(buf);
    /* Use the clip's own time signature if present (falls back to 4/4) so
     * 6/8 and 3/4 files report the correct number of whole bars. */
    if (ts_num == 0) ts_num = 4;
    if (ts_den == 0) ts_den = 4;
    uint32_t ticks_per_bar = (uint32_t)(div * 4.0 * ts_num / ts_den);
    if (ticks_per_bar == 0) ticks_per_bar = div;
    uint32_t bars = end_tick / ticks_per_bar;
    if (end_tick % ticks_per_bar) bars++;
    if (bars < 1) bars = 1;
    *out_bars = bars;
    return 0;
}

/* Recursively scan rel_prefix under folder_root, appending .mid files to f. */
static void scan_dir_recursive(const char *folder_root, const char *rel_prefix, folder_entry_t *f) {
    char full_path[MAX_PATH_LEN];
    int n;
    if (rel_prefix[0]) {
        n = snprintf(full_path, sizeof(full_path), "%s/%s", folder_root, rel_prefix);
    } else {
        n = snprintf(full_path, sizeof(full_path), "%s", folder_root);
    }
    if (n < 0 || (size_t)n >= sizeof(full_path)) return;
    DIR *d = opendir(full_path);
    if (!d) return;
    struct dirent *ent;
    while ((ent = readdir(d)) && f->clip_count < FOLDER_HEAP_CLIPS) {
        if (ent->d_name[0] == '.') continue;
        char child_path[MAX_PATH_LEN];
        int cn = snprintf(child_path, sizeof(child_path), "%s/%s", full_path, ent->d_name);
        if (cn < 0 || (size_t)cn >= sizeof(child_path)) continue;
        struct stat st;
        if (stat(child_path, &st) != 0) continue;
        if (S_ISDIR(st.st_mode)) {
            char child_rel[MAX_PATH_LEN];
            int rn;
            if (rel_prefix[0]) {
                rn = snprintf(child_rel, sizeof(child_rel), "%s/%s", rel_prefix, ent->d_name);
            } else {
                rn = snprintf(child_rel, sizeof(child_rel), "%s", ent->d_name);
            }
            if (rn >= 0 && (size_t)rn < sizeof(child_rel)) {
                scan_dir_recursive(folder_root, child_rel, f);
            }
        } else if (S_ISREG(st.st_mode)) {
            size_t len = strlen(ent->d_name);
            if (len < 5 || strcasecmp(ent->d_name + len - 4, ".mid") != 0) continue;
            char *slot = f->clip_names + (f->clip_count * 128);
            char tmp[128];
            size_t prefix_len = strlen(rel_prefix);
            size_t name_len = strlen(ent->d_name);
            size_t need = prefix_len + (prefix_len ? 1 : 0) + name_len + 1;
            if (need <= sizeof(tmp)) {
                if (prefix_len) {
                    memcpy(tmp, rel_prefix, prefix_len);
                    tmp[prefix_len] = '/';
                    memcpy(tmp + prefix_len + 1, ent->d_name, name_len + 1);
                } else {
                    memcpy(tmp, ent->d_name, name_len + 1);
                }
            } else {
                tmp[0] = '\0';
            }
            memcpy(slot, tmp, 127);
            slot[127] = '\0';
            uint32_t bars = 1;
            scan_clip_bars(child_path, &bars);
            if (f->clip_bars) f->clip_bars[f->clip_count] = bars;
            f->clip_count++;
        }
    }
    closedir(d);
}

/* True if any .mid file exists under dir (recursively). Used to tell a
 * category folder (whose immediate subfolders are song folders) apart from a
 * song folder (which directly contains .mid files, possibly under Grooves/
 * Fills/ subfolders). */
static int dir_contains_mid_recursive(const char *dir) {
    DIR *d = opendir(dir);
    if (!d) return 0;
    struct dirent *ent;
    int found = 0;
    while ((ent = readdir(d)) && !found) {
        if (ent->d_name[0] == '.') continue;
        char child[MAX_PATH_LEN];
        int n = snprintf(child, sizeof(child), "%s/%s", dir, ent->d_name);
        if (n < 0 || (size_t)n >= sizeof(child)) continue;
        struct stat st;
        if (stat(child, &st) != 0) continue;
        if (S_ISDIR(st.st_mode)) {
            if (dir_contains_mid_recursive(child)) found = 1;
        } else if (S_ISREG(st.st_mode)) {
            size_t len = strlen(ent->d_name);
            if (len >= 4 && strcasecmp(ent->d_name + len - 4, ".mid") == 0) found = 1;
        }
    }
    closedir(d);
    return found;
}

/* Build a category path from all parent directories between library_root
 * (exclusive) and the song folder's parent (inclusive).
 * e.g. root=".../MIDI files", song=".../MIDI files/Vintage/03 Swing/Song 01"
 *      => category = "Vintage/03 Swing" */
static void build_category_path(const char *library_root, const char *song_folder,
                                char *out, size_t out_size) {
    size_t root_len = strlen(library_root);
    /* library_root should be a prefix of song_folder. */
    if (strncmp(song_folder, library_root, root_len) != 0 ||
        (song_folder[root_len] != '/' && song_folder[root_len] != '\0')) {
        out[0] = '\0';
        return;
    }
    const char *cat_start = song_folder + root_len;
    if (*cat_start == '/') cat_start++;
    /* Remove the leaf song-folder name: back up to the previous '/'. */
    const char *end = cat_start + strlen(cat_start);
    if (end == cat_start) {
        out[0] = '\0';
        return;
    }
    const char *last_slash = strrchr(cat_start, '/');
    if (!last_slash || last_slash == cat_start) {
        out[0] = '\0';
        return;
    }
    size_t cat_len = (size_t)(last_slash - cat_start);
    if (cat_len >= out_size) cat_len = out_size - 1;
    memcpy(out, cat_start, cat_len);
    out[cat_len] = '\0';
}

/* Scan one song folder (a directory that directly holds .mid files, possibly
 * under Grooves/Fills subfolders) into a folder_entry. Returns 0 on success. */
static int scan_song_folder_into(folder_entry_t *f, const char *full_path,
                                 const char *name, const char *category) {
    memset(f, 0, sizeof(*f));
    copy_trunc(f->name, sizeof(f->name), name);
    copy_trunc(f->path, sizeof(f->path), full_path);
    copy_trunc(f->category, sizeof(f->category), category);
    f->clip_names = calloc(FOLDER_HEAP_CLIPS, 128);
    if (!f->clip_names) return -1;
    f->clip_bars = calloc(FOLDER_HEAP_CLIPS, sizeof(uint32_t));
    if (!f->clip_bars) { free(f->clip_names); f->clip_names = NULL; return -1; }

    scan_dir_recursive(full_path, "", f);
    /* Sort clip names while keeping clip_bars aligned. */
    if (f->clip_count > 1) {
        clip_sort_pair_t *pairs = calloc(f->clip_count, sizeof(clip_sort_pair_t));
        if (pairs) {
            for (int i = 0; i < f->clip_count; i++) {
                pairs[i].name = f->clip_names + (i * 128);
                pairs[i].bars = f->clip_bars ? f->clip_bars[i] : 1;
            }
            qsort(pairs, f->clip_count, sizeof(clip_sort_pair_t), clip_pair_cmp);
            char *temp_names = malloc(f->clip_count * 128);
            if (temp_names) {
                for (int i = 0; i < f->clip_count; i++) {
                    memcpy(temp_names + (i * 128), pairs[i].name, 128);
                    if (f->clip_bars) f->clip_bars[i] = pairs[i].bars;
                }
                memcpy(f->clip_names, temp_names, f->clip_count * 128);
                free(temp_names);
            }
            free(pairs);
        }
    }
    return 0;
}

/* True if dir contains any regular .mid file directly. Used to identify leaf
 * song folders vs intermediate category folders. */
static int dir_has_direct_mid(const char *dir) {
    DIR *d = opendir(dir);
    if (!d) return 0;
    struct dirent *ent;
    int found = 0;
    while ((ent = readdir(d)) && !found) {
        if (ent->d_name[0] == '.') continue;
        char child[MAX_PATH_LEN];
        int n = snprintf(child, sizeof(child), "%s/%s", dir, ent->d_name);
        if (n < 0 || (size_t)n >= sizeof(child)) continue;
        struct stat st;
        if (stat(child, &st) != 0) continue;
        if (!S_ISREG(st.st_mode)) continue;
        size_t len = strlen(ent->d_name);
        if (len >= 4 && strcasecmp(ent->d_name + len - 4, ".mid") == 0) found = 1;
    }
    closedir(d);
    return found;
}

/* Case-insensitive substring search (avoids GNU strcasestr dependency). */
static int str_contains_ci(const char *haystack, const char *needle) {
    size_t nlen = strlen(needle);
    if (nlen == 0) return 1;
    for (const char *p = haystack; *p; ++p) {
        if (strncasecmp(p, needle, nlen) == 0) return 1;
    }
    return 0;
}

/* True if dir is a SONG folder (a leaf in the category tree): it directly
 * contains .mid files, OR it has an immediate subfolder named "Grooves" or
 * "Fills" (a song folder laid out with part subfolders, e.g.
 * "GM Ballads/Song 08 082 Not Only One/Grooves"). A category folder is one
 * whose subfolders are themselves song folders (deeper nesting, e.g.
 * "Vintage Drummer/03 Swing"), so it is NOT a song folder and the scan
 * recurses into it. The Grooves/Fills name check is what tells a song folder
 * with part subfolders apart from a category whose subfolders are songs. */
static int dir_is_song_folder(const char *dir) {
    if (dir_has_direct_mid(dir)) return 1;
    DIR *d = opendir(dir);
    if (!d) return 0;
    struct dirent *ent;
    int found = 0;
    while ((ent = readdir(d)) && !found) {
        if (ent->d_name[0] == '.') continue;
        char child[MAX_PATH_LEN];
        int n = snprintf(child, sizeof(child), "%s/%s", dir, ent->d_name);
        if (n < 0 || (size_t)n >= sizeof(child)) continue;
        struct stat st;
        if (stat(child, &st) != 0) continue;
        if (!S_ISDIR(st.st_mode)) continue;
        /* A part subfolder is named "Grooves", "Clap", "Snare", "Stick",
         * or contains "Fill" (e.g. "Fills", "Hat Fills", "Ride Fills").
         * These names indicate the parent is a song folder whose clips are
         * grouped by part, rather than a category folder whose subfolders are
         * themselves songs. */
        const char *nm = ent->d_name;
        int is_part_folder = strcasecmp(nm, "Grooves") == 0 ||
                              strcasecmp(nm, "Clap") == 0 ||
                              strcasecmp(nm, "Snare") == 0 ||
                              strcasecmp(nm, "Stick") == 0 ||
                              str_contains_ci(nm, "Fill");
        if (is_part_folder && dir_has_direct_mid(child)) found = 1;
    }
    closedir(d);
    return found;
}

/* Recursively find leaf song folders under dir. A leaf folder is any
 * directory that directly contains a .mid file; everything above it is a
 * category. The full category path is built from parent dirs under library_root. */
static void scan_library_recursive(engine_t *e, const char *dir,
                                   folder_entry_t *folders, int *count) {
    DIR *d = opendir(dir);
    if (!d) return;
    struct dirent *ent;
    while ((ent = readdir(d)) && *count < MAX_SOURCE_FOLDERS) {
        if (ent->d_name[0] == '.') continue;
        char child_path[MAX_PATH_LEN];
        int n = snprintf(child_path, sizeof(child_path), "%s/%s", dir, ent->d_name);
        if (n < 0 || (size_t)n >= sizeof(child_path)) continue;
        struct stat st;
        if (stat(child_path, &st) != 0 || !S_ISDIR(st.st_mode)) continue;
        if (dir_is_song_folder(child_path)) {
            char category[128];
            build_category_path(e->library_root, child_path, category, sizeof(category));
            folder_entry_t *f = &folders[*count];
            if (scan_song_folder_into(f, child_path, ent->d_name, category) == 0) {
                (*count)++;
            }
        } else if (dir_contains_mid_recursive(child_path)) {
            /* Intermediate category with deeper song folders: keep recursing. */
            scan_library_recursive(e, child_path, folders, count);
        }
    }
    closedir(d);
}

static void scan_library_into(engine_t *e, folder_entry_t *folders, int *out_count) {
    *out_count = 0;
    DIR *d = opendir(e->library_root);
    if (!d) return;
    int count = 0;
    struct dirent *ent;
    while ((ent = readdir(d)) && count < FOLDER_CACHE_MAX) {
        if (ent->d_name[0] == '.') continue;
        char full_path[MAX_PATH_LEN];
        int n = snprintf(full_path, sizeof(full_path), "%s/%s", e->library_root, ent->d_name);
        if (n < 0 || (size_t)n >= sizeof(full_path)) continue;
        struct stat st;
        if (stat(full_path, &st) != 0 || !S_ISDIR(st.st_mode)) continue;

        if (dir_is_song_folder(full_path)) {
            /* A song folder directly at the root (no category). */
            folder_entry_t *f = &folders[count];
            if (scan_song_folder_into(f, full_path, ent->d_name, "") == 0) {
                count++;
            }
        } else if (dir_contains_mid_recursive(full_path)) {
            scan_library_recursive(e, full_path, folders, &count);
        }
    }
    closedir(d);
    qsort(folders, count, sizeof(folder_entry_t), folder_entry_cmp);
    *out_count = count;
}

/* Read ch->request_json: acquire-load the double-buffer index the audio
 * thread most recently published (release-stored in set_param("song_json"/
 * "preload_song_json")) and copy that buffer. The acquire/release pair makes
 * this a genuine happens-before edge, so the buffer's content is guaranteed
 * fully written and never concurrently touched -- unlike the seqlock this
 * replaced, there is nothing to retry; the read always succeeds in one
 * attempt. Kept as an int-returning function (rather than void) so the one
 * caller's existing "skip this wake" shape needs no change. */
static int read_request_json(timeline_channel_t *ch, char *out, size_t out_len) {
    int active = atomic_load_explicit(&ch->request_active, memory_order_acquire);
    copy_trunc(out, out_len, ch->request_json[active]);
    return 1;
}

/* Copy a just-built timeline+song into a channel's slot, bounded by
 * event_count (not sizeof(timeline_slot_t)) so the common case (a few
 * thousand events) stays cheap even though the type's worst-case footprint
 * is much larger. Worker-side only (called from process_timeline_channel and
 * used again, on the audio thread, at swap boundaries via the identical
 * bounded-copy shape -- see engine_swap_to_staging/advance_playhead). */
static void copy_timeline_slot(timeline_slot_t *dst, const timeline_slot_t *src) {
    int n = src->event_count;
    if (n < 0) n = 0;
    if (n > TIMELINE_MAX_EVENTS) n = TIMELINE_MAX_EVENTS;
    memcpy(dst->events, src->events, sizeof(smf_event_t) * (size_t)n);
    dst->event_count = n;
    dst->end_tick = src->end_tick;
    dst->tempo_bpm = src->tempo_bpm;
    dst->time_sig_num = src->time_sig_num;
    dst->time_sig_den = src->time_sig_den;
    dst->ticks_per_beat = src->ticks_per_beat;
    dst->ticks_per_bar = src->ticks_per_bar;
    copy_trunc(dst->source, sizeof(dst->source), src->source);
    dst->song = src->song;
    dst->truncated = src->truncated;
    copy_trunc(dst->build_error, sizeof(dst->build_error), src->build_error);
}

/* Compute clips whose resolved location differs from their stored folder
 * (the library was reorganized), for get_param("resolved_clips"). Runs on
 * the worker as part of a successful primary build -- e->clips[]/
 * library_root are worker-owned once builds move off-thread, so this must
 * not run on the audio thread the way the old inline get_param handler did.
 * Bounded to `max` entries. Logic unchanged from the original inline
 * handler; only the output (plain strings into a cache slot, not
 * escaped-JSON into a response buffer) differs. */
static void compute_resolved_clips(engine_t *e, const song_t *song,
                                    resolved_clip_diff_t *out, int max, int *out_count) {
    int n = 0;
    for (int s = 0; s < song->section_count && n < max; s++) {
        const section_t *sec = &song->sections[s];
        for (int c = 0; c < sec->clip_count && n < max; c++) {
            const section_clip_t *sc = &sec->clips[c];
            if (!sc->source_path[0]) continue;
            if (sc->clip_index < 0 || sc->clip_index >= e->clip_count) continue;
            const char *full = e->clips[sc->clip_index].path;
            const char *eff = sc->source_folder[0] ? sc->source_folder : song->source_folder;
            char folder[MAX_PATH_LEN] = "";
            size_t full_len = strlen(full);
            size_t src_len = strlen(sc->source_path);
            if (src_len > 0 && full_len > src_len &&
                strcmp(full + full_len - src_len, sc->source_path) == 0) {
                size_t flen = full_len - src_len;
                if (flen > 0 && full[flen - 1] == '/') flen--;
                size_t root_len = strlen(e->library_root);
                if (flen > root_len &&
                    strncmp(full, e->library_root, root_len) == 0 &&
                    full[root_len] == '/') {
                    size_t rel_len = flen - root_len - 1;
                    if (rel_len < sizeof(folder)) {
                        memcpy(folder, full + root_len + 1, rel_len);
                        folder[rel_len] = '\0';
                    }
                }
            }
            if (!folder[0] || strcmp(folder, eff) == 0) continue;
            copy_trunc(out[n].source, sizeof(out[n].source), sc->source_path);
            copy_trunc(out[n].folder, sizeof(out[n].folder), folder);
            n++;
        }
    }
    *out_count = n;
}

/* Process one channel's outstanding build request, if any -- at most one
 * build attempt per call. A request superseded mid-build (request_gen
 * changed since we started) is discarded unpublished; the set_param call
 * that superseded it already posted worker_wake, so the worker's next loop
 * iteration retries against the now-current payload (rearch2.md's
 * "coalesce to latest, never drop" rule -- see file header comment). */
static void process_timeline_channel(engine_t *e, timeline_channel_t *ch, int is_primary) {
    uint32_t req = atomic_load_explicit(&ch->request_gen, memory_order_acquire);
    if (req == atomic_load_explicit(&ch->published_gen, memory_order_acquire)) return;

    char json[MAX_SONG_JSON_LEN];
    if (!read_request_json(ch, json, sizeof(json))) return; /* retry next wake */

    engine_clear_error(e);

    song_t scratch_song;
    memset(&scratch_song, 0, sizeof(scratch_song));
    double tempo_bpm = 120.0;
    int ts_num = 4, ts_den = 4;
    uint32_t tpb = 240, tpbar = 240;
    int parse_rc = parse_song_json(e, json, &scratch_song, &tempo_bpm, &ts_num, &ts_den, &tpb, &tpbar);

    smf_event_t *tmp = NULL;
    int tmp_count = 0;
    uint32_t tmp_end = 0;
    int build_rc = -1;
    if (parse_rc == 0) {
        build_rc = build_timeline_targeted(e, &scratch_song, tempo_bpm, ts_num, ts_den,
                                           tpb, tpbar, &tmp, &tmp_count, &tmp_end);
    }

    if (atomic_load_explicit(&ch->request_gen, memory_order_acquire) != req) {
        /* Superseded mid-build: discard unpublished. */
        if (tmp) free(tmp);
        return;
    }

    int active = atomic_load_explicit(&ch->active, memory_order_acquire);
    timeline_slot_t *target = &ch->slot[1 - active];

    if (build_rc == 0) {
        int n = tmp_count;
        target->truncated = (n > TIMELINE_MAX_EVENTS) ? 1 : 0;
        if (n > TIMELINE_MAX_EVENTS) n = TIMELINE_MAX_EVENTS;
        memcpy(target->events, tmp, sizeof(smf_event_t) * (size_t)n);
        target->event_count = n;
        target->end_tick = tmp_end;
        target->tempo_bpm = tempo_bpm;
        target->time_sig_num = ts_num;
        target->time_sig_den = ts_den;
        target->ticks_per_beat = tpb;
        target->ticks_per_bar = tpbar;
        target->song = scratch_song;
        if (scratch_song.section_count > 0 && scratch_song.sections[0].clip_count > 0) {
            section_clip_t *sc0 = &scratch_song.sections[0].clips[0];
            if (sc0->clip_index >= 0 && sc0->clip_index < e->clip_count) {
                copy_trunc(target->source, sizeof(target->source), e->clips[sc0->clip_index].path);
            } else {
                target->source[0] = '\0';
            }
        } else {
            target->source[0] = '\0';
        }
    } else {
        /* Build failed: publish an empty slot so a stale/wrong timeline is
         * never left "active" from a failed rebuild -- the audio thread's
         * existing event_count==0 guards degrade silently, matching today's
         * behavior on a failed build. */
        target->event_count = 0;
        target->end_tick = 0;
        target->truncated = 0;
        target->source[0] = '\0';
    }
    /* Whatever engine_set_error left in e->error_msg for this attempt --
     * empty on a clean success, or a message even on rc==0 if some clips
     * partially failed to resolve (build_timeline_targeted's existing
     * "continue past a bad clip" behavior, unchanged). */
    copy_trunc(target->build_error, sizeof(target->build_error), e->error_msg);

    if (tmp) free(tmp);

    if (is_primary && build_rc == 0) {
        int rc_active = atomic_load_explicit(&e->resolved_clips.active, memory_order_acquire);
        int rc_target = 1 - rc_active;
        compute_resolved_clips(e, &scratch_song, e->resolved_clips.slot[rc_target],
                                RESOLVED_CLIPS_MAX, &e->resolved_clips.count[rc_target]);
        atomic_store_explicit(&e->resolved_clips.active, rc_target, memory_order_release);
    }

    atomic_store_explicit(&ch->active, 1 - active, memory_order_release);
    atomic_store_explicit(&ch->published_gen, req, memory_order_release);
}

/* The engine's deferred work, run on the worker thread each wake. Handles
 * the folder/song scan double-buffers (if a rescan was requested, scan into
 * the inactive slot and flip active) and the primary/staging async timeline
 * build channels. Runs on the worker thread, so file I/O and allocation are
 * safe here. */
static void arranger_worker_iterate(engine_t *e) {
    if (!e) return;

    /* Copy the audio-thread-requested library root into the worker's working
     * copy before any scan/build that reads it. */
    copy_trunc(e->library_root, sizeof(e->library_root), e->library_root_requested);

    process_timeline_channel(e, &e->primary_ch, 1);
    process_timeline_channel(e, &e->staging_ch, 0);

    /* Folder scan. */
    if (atomic_load_explicit(&e->folder_dirty, memory_order_acquire)) {
        int active = atomic_load_explicit(&e->folder_active, memory_order_acquire);
        int target = 1 - active;
        /* Free the previous contents of the target slot (worker-side). */
        free_folder_slot(e->folders[target], e->folder_count[target]);
        e->folder_count[target] = 0;
        scan_library_into(e, e->folders[target], &e->folder_count[target]);
        /* Publish: the audio thread only reads slot [active]. */
        atomic_store_explicit(&e->folder_active, target, memory_order_release);
        atomic_store_explicit(&e->folder_dirty, 0, memory_order_release);
    }

    /* Song scan. */
    if (atomic_load_explicit(&e->song_dirty, memory_order_acquire)) {
        int active = atomic_load_explicit(&e->song_active, memory_order_acquire);
        int target = 1 - active;
        e->song_count[target] = 0;
        scan_songs_into(e, e->songs[target], &e->song_count[target]);
        atomic_store_explicit(&e->song_active, target, memory_order_release);
        atomic_store_explicit(&e->song_dirty, 0, memory_order_release);
    }
}

/* -------------------------------------------------------------------------- */
/* Transport / tick                                                           */
/* -------------------------------------------------------------------------- */

static uint32_t ticks_per_human_beat(const engine_t *e) {
    uint32_t human_beats = e->time_sig_num > 0 ? (uint32_t)e->time_sig_num : 4;
    uint32_t ticks = e->ticks_per_bar / human_beats;
    return ticks > 0 ? ticks : e->ticks_per_beat;
}

static uint32_t beat_flash_duration_ticks(const engine_t *e) {
    return (uint32_t)(ticks_per_human_beat(e) * 0.35);
}

static uint32_t initial_flash_end_tick(const engine_t *e) {
    return beat_flash_duration_ticks(e);
}

static void retrigger_beat_flash(engine_t *e, uint32_t prev_tick, uint32_t new_tick) {
    uint32_t ticks_per_beat = ticks_per_human_beat(e);
    uint32_t prev_beat_start = (prev_tick / ticks_per_beat) * ticks_per_beat;
    uint32_t new_beat_start = (new_tick / ticks_per_beat) * ticks_per_beat;
    if (new_beat_start != prev_beat_start) {
        e->flash_end_tick = new_beat_start + beat_flash_duration_ticks(e);
    }
}

/* Apply a per-clip channel override to a status byte. The timeline status was
 * baked with the engine's output channel at build time; a per-clip override
 * (e.g. a dedicated count-in click channel) must replace the low nibble before
 * the event is queued, otherwise the override is silently lost in the
 * non-direct (queued) path. Returns the status byte with the override applied
 * (or unchanged when there is no override). */
static uint8_t apply_channel_override(uint8_t status, int8_t channel_override) {
    if (channel_override >= 0 && channel_override <= 15) {
        return (status & 0xF0) | (uint8_t)channel_override;
    }
    return status;
}

static void drain_events_up_to(engine_t *e, uint32_t target) {
    if (!e->running || e->live_slot.event_count == 0) return;
    while (e->event_cursor < e->live_slot.event_count) {
        const smf_event_t *ev = &e->live_slot.events[e->event_cursor];
        if (ev->tick >= target) break;
        e->last_event_channel_override = ev->channel_override;
        /* Follow-note instruments: emit the chord when a matching drum
         * note-on fires (e.g. bass follows the kick). */
        if ((ev->status & 0xF0) == 0x90 && ev->data2 > 0) {
            emit_instruments_follow(e, ev->data1, ev->tick);
        }
        if (e->emit_directly) {
            emit_direct_event(e, ev->status, ev->data1, ev->data2, ev->len);
        } else {
            uint8_t status = apply_channel_override(ev->status, ev->channel_override);
            queue_push(e, status, ev->data1, ev->data2, ev->len);
        }
        e->event_cursor++;
    }
}

/* Emit a single timeline event via the channel-override + emit_directly/
 * queue_push path shared by drain_events_up_to_guarded and
 * rescue_guard_window_events below. Deliberately does not trigger follow-note
 * instruments -- that is drain_events_up_to's own, separate behavior for
 * ordinary in-block playback, not shared with either of the swap-boundary
 * paths this helper serves. */
static void emit_timeline_event(engine_t *e, const smf_event_t *ev) {
    e->last_event_channel_override = ev->channel_override;
    if (e->emit_directly) {
        emit_direct_event(e, ev->status, ev->data1, ev->data2, ev->len);
    } else {
        uint8_t status = apply_channel_override(ev->status, ev->channel_override);
        queue_push(e, status, ev->data1, ev->data2, ev->len);
    }
}

/* Drain events up to `target`, suppressing note-ons at or after `guard_start`
 * (an absolute tick). This is used at a swap boundary so a groove that is cut
 * short by a transition doesn't fire a note-on in the guard window before the
 * seam (which would sound like a flam/glitch). Note-offs pass through so notes
 * don't get stuck. */
static void drain_events_up_to_guarded(engine_t *e, uint32_t target, uint32_t guard_start) {
    if (!e->running || e->live_slot.event_count == 0) return;
    while (e->event_cursor < e->live_slot.event_count) {
        const smf_event_t *ev = &e->live_slot.events[e->event_cursor];
        if (ev->tick >= target) break;
        uint8_t type = ev->status & 0xF0;
        int is_note_on = (type == 0x90 && ev->data2 > 0);
        if (is_note_on && ev->tick >= guard_start) {
            /* Suppress note-ons in the guard window before the boundary. */
            e->swap_guard_suppressed++;
            dsp_log_enqueue_worker("GUARD suppress note=%u tick=%u target=%u guardStart=%u dist=%u",
                    ev->data1, ev->tick, target, guard_start, target - ev->tick);
            e->event_cursor++;
            continue;
        }
        emit_timeline_event(e, ev);
        e->event_cursor++;
    }
}

/* When a swap resumes into a NEW timeline mid-clip, the forward walk that
 * positions event_cursor at the first event with tick >= resume_tick (done by
 * each caller, just before this) skips every earlier event outright --
 * including ones in the guard window just before resume_tick, which would
 * otherwise have played a beat or so ahead of the boundary (e.g. a kick
 * struck slightly ahead of the downbeat, a common pickup-note pattern in a
 * drum clip). Observed on hardware: a fill auto-swapping back into a
 * partially-played groove could silently drop such a note, since the
 * groove's own timeline resumes past it.
 *
 * Rather than filtering by message type (a short hit's note-on and note-off
 * can both land in the window; rescuing only the note-on would strand the
 * note-off and hang the note), this replays the WHOLE guard-window slice in
 * original order, right at the resume point -- the same events, compressed
 * to fire immediately instead of at their original, now-skipped ticks.
 *
 * Uses the same guard window (swap_guard_fraction) the outgoing side of a
 * swap already guards with, so a single "Swap Guard" setting governs both
 * ends of the seam. Call this AFTER the forward walk that sets event_cursor
 * for the newly-activated live_slot. */
static void rescue_guard_window_events(engine_t *e, uint32_t resume_tick, uint32_t guard_ticks) {
    if (e->event_cursor <= 0) return;
    uint32_t guard_start = (resume_tick > guard_ticks) ? (resume_tick - guard_ticks) : 0;
    int first = e->event_cursor;
    while (first > 0 && e->live_slot.events[first - 1].tick >= guard_start) {
        first--;
    }
    for (int i = first; i < e->event_cursor; i++) {
        emit_timeline_event(e, &e->live_slot.events[i]);
    }
}

static void engine_swap_to_staging(engine_t *e, const timeline_slot_t *src); /* defined below */

static void handle_loop_or_stop(engine_t *e, uint32_t *target) {
    if (*target >= e->live_slot.end_tick + 1 || e->event_cursor >= e->live_slot.event_count) {
        /* A published-but-not-yet-consumed staging build, with actual
         * events, is this block's AUTOSWAP candidate. */
        uint32_t staging_pub = atomic_load_explicit(&e->staging_ch.published_gen, memory_order_acquire);
        int staging_have_new = (staging_pub != e->staging_consumed_gen);
        /* memory_order_acquire (not relaxed) is required here: this load is
         * what establishes happens-before with the worker's release store to
         * .active in process_timeline_channel, so that staged->event_count
         * (dereferenced just below) is guaranteed to observe that build's
         * fully-written contents rather than a possibly-stale/torn read.
         * Caught by ThreadSanitizer during Step 3 validation -- exactly the
         * class of missing-acquire mistake this whole exercise exists to
         * catch before hardware, not after. */
        int staging_active = atomic_load_explicit(&e->staging_ch.active, memory_order_acquire);
        timeline_slot_t *staged = &e->staging_ch.slot[staging_active];
        dsp_log_enqueue_worker("LOOPSTOP target=%u end=%u cursor=%d/%d loop=%d staging=%d",
                *target, e->live_slot.end_tick, e->event_cursor, e->live_slot.event_count,
                e->loop, staging_have_new && staged->event_count > 0);
        if (e->loop) {
            if (e->live_slot.end_tick > 0) {
                *target = *target % e->live_slot.end_tick;
            } else {
                *target = 0;
            }
            e->playhead_tick = 0;
            e->stopped_at_end = 0;
            e->event_cursor = 0;
            /* A full loop wrap back to bar 1. */
            e->wrap_counter++;
            while (e->event_cursor < e->live_slot.event_count &&
                   e->live_slot.events[e->event_cursor].tick < *target) {
                e->event_cursor++;
            }
        } else if (staging_have_new && staged->event_count > 0) {
            /* Jam-mode: a non-looping clip (fill) reached its end and the
             * next clip is already staged. Hot-swap to the staged timeline
             * and keep running so the transition is sample-accurate and the
             * UI does not need to restart playback. The new clip starts at
             * its requested resume position (0 = start), then only the
             * overshoot past the fill's end carries it forward. */
            uint32_t old_end = e->live_slot.end_tick;
            uint32_t tpb = (e->ticks_per_bar > 0) ? e->ticks_per_bar : 1;
            /* The fill's full bar boundary: the swap must land on the exact
             * end of the fill's bar(s), not on the last event (which may end
             * early). Without this, the groove resumes slightly early. */
            uint32_t fill_full = ((old_end + tpb - 1) / tpb) * tpb;
            if (*target >= fill_full) {
                /* Overshoot = how far past the fill's full bar this block
                 * reached. */
                uint32_t overshoot = (*target > fill_full) ? (*target - fill_full) : 0;
                dsp_log_enqueue_worker("AUTOSWAP old_end=%u tpb=%u fill_full=%u target=%u overshoot=%u resume=%u",
                        old_end, tpb, fill_full, *target, overshoot, e->staging_resume_tick);
                engine_swap_to_staging(e, staged);
                e->staging_consumed_gen = staging_pub;
                uint32_t resume = e->swap_resume_tick;
                e->playhead_tick = resume;
                e->event_cursor = 0;
                while (e->event_cursor < e->live_slot.event_count &&
                       e->live_slot.events[e->event_cursor].tick < e->playhead_tick) {
                    e->event_cursor++;
                }
                /* Rescue any events in the guard window just before the
                 * resume point (e.g. a kick struck just ahead of the
                 * downbeat) that the forward walk above just skipped past --
                 * see rescue_guard_window_events. */
                {
                    double gf = e->swap_guard_fraction;
                    if (gf < 0.0) gf = 0.0;
                    if (gf > 1.0) gf = 1.0;
                    uint32_t guard = (uint32_t)(gf * e->ticks_per_beat);
                    if (guard == 0) guard = 1;
                    rescue_guard_window_events(e, resume, guard);
                }
                /* The timeline changed; track the new clip's starting bar. */
                e->last_bar = e->live_slot.end_tick > 0
                    ? (resume / e->ticks_per_bar)
                    : 0;
                uint32_t advanced = resume + overshoot;
                if (e->live_slot.end_tick > 0) {
                    *target = advanced % e->live_slot.end_tick;
                } else {
                    *target = advanced;
                }
                /* Emit the new clip's events up to the new target so the
                 * first beat of the return groove is not skipped. Previously
                 * this just advanced event_cursor past events < *target
                 * without emitting them, dropping the groove's downbeat when
                 * the audio block overshot the fill boundary. */
                drain_events_up_to(e, *target);
                e->stopped_at_end = 0;
            } else {
                /* The fill's events are drained but its full bar boundary
                 * hasn't been reached yet. Keep the playhead moving through
                 * the (silent) tail so the swap lands exactly on the bar
                 * end. */
                e->stopped_at_end = 0;
            }
        } else {
            /* A non-looping song with no staged clip. Events may drain before
             * the playhead reaches the timeline's full bar boundary (e.g. a
             * ritard outro whose last MIDI note lands before the bar end).
             * Stopping as soon as events run out would cut the ending short
             * and make the transition into the next clip start ~a bar early.
             * Keep the playhead running through the (silent) tail until it
             * reaches timeline_end_tick, then stop. */
            if (e->live_slot.end_tick > 0 && *target < e->live_slot.end_tick) {
                e->running = 1;
                e->stopped_at_end = 0;
            } else {
                e->running = 0;
                e->stopped_at_end = 1;
                emit_all_notes_off(e);
                /* Cut off any instrument chord notes still sounding. */
                emit_instruments_all_off(e);
                if (e->playhead_tick > e->live_slot.end_tick) e->playhead_tick = e->live_slot.end_tick;
            }
        }
    }
}

/* Promote the staged timeline to the active timeline. Used both for
 * synchronous swaps and for scheduled swaps inside the audio callback. */
/* Promote `src` (a channel's published slot) to the active timeline via a
 * bounded copy into e->live_slot -- never a pointer handoff, so there is
 * nothing left to free(). Caller (handle_loop_or_stop's AUTOSWAP branch) is
 * responsible for staging_consumed_gen bookkeeping, since it already holds
 * the generation this slot was published under. */
static void engine_swap_to_staging(engine_t *e, const timeline_slot_t *src) {
    copy_timeline_slot(&e->live_slot, src);

    e->tempo_bpm = e->live_slot.tempo_bpm;
    e->time_sig_num = e->live_slot.time_sig_num;
    e->time_sig_den = e->live_slot.time_sig_den;
    e->ticks_per_beat = e->live_slot.ticks_per_beat;
    e->ticks_per_bar = e->live_slot.ticks_per_bar;
    e->loop = e->staging_loop;

    /* Capture the staged resume position before clearing it. */
    e->swap_resume_tick = e->staging_resume_tick;
    e->staging_resume_tick = 0;

    /* A staged clip was activated via swap; expose it to the UI so same-path
     * restarts (which don't change active_source or bar/wrap counters) can be
     * detected. */
    e->swap_counter++;

    /* Update the active source path so the UI can follow the new clip. */
    copy_trunc(e->active_source, sizeof(e->active_source), e->live_slot.source);

    e->flash_end_tick = initial_flash_end_tick(e);
}

/* Advance the playhead by the exact audio-clock duration of the render block.
 * A fractional tick accumulator preserves sub-tick timing across small blocks
 * so the long-term tempo stays accurate. */

/* Bump the bar boundary counter if the playhead has moved into a new bar
 * (including a loop wrap, where the bar number goes backwards, and seeks).
 * The UI uses this monotonic counter to detect boundaries authoritatively
 * instead of inferring them from bar/beat deltas in JS. */
static void update_bar_counter(engine_t *e) {
    uint32_t bar = e->live_slot.end_tick > 0
        ? (e->playhead_tick / e->ticks_per_bar)
        : 0;
    if (bar != e->last_bar) {
        e->bar_counter++;
        e->last_bar = bar;
        /* Emit the chord for non-follow instruments at each bar boundary. */
        emit_instruments_at_tick(e, e->playhead_tick);
    }
}

static void advance_playhead(engine_t *e, int frames, int sample_rate) {
    if (!e->running || e->live_slot.event_count == 0) return;

    double seconds = (double)frames / (double)sample_rate;
    double ticks_per_second = e->tempo_bpm / 60.0 * e->ticks_per_beat;
    double tick_delta = ticks_per_second * seconds + e->tick_remainder;
    uint32_t advance = (uint32_t)tick_delta;
    e->tick_remainder = tick_delta - (double)advance;
    if (advance == 0) {
        /* Don't let tiny blocks stall; borrow from remainder next time. */
        return;
    }

    uint32_t target = e->playhead_tick + advance;

    /* Sample-accurate scheduled seek (performance section jumps): if a seek is
     * pending and this block crosses the seek tick, apply the seek exactly at
     * the boundary (stop the old clip's notes at the boundary), then continue
     * the remainder of the block in the target bar. */
    if (e->pending_seek && target >= e->pending_seek_tick) {
        uint32_t seek_tick = e->pending_seek_tick;
        if (seek_tick > e->playhead_tick) {
            retrigger_beat_flash(e, e->playhead_tick, seek_tick);
            /* Suppress note-ons in the guard window before the seek boundary
             * so a manual mid-section change doesn't flam at the seam (same
             * as Jam's swap guard). */
            drain_events_up_to_guarded(e, seek_tick, e->pending_seek_guard_start);
        }
        uint32_t seek_bar = e->pending_seek_bar;
        e->pending_seek = 0;
        e->pending_seek_tick = 0;
        /* Expose the seek to the UI (via seek_counter in the transport JSON) so
         * it can detect a repeat of the current section, where the playhead
         * stays in the same section and bar_counter's bar does not change. */
        e->seek_counter++;
        /* Seek to the start of the target bar. */
        e->playhead_tick = seek_bar * e->ticks_per_bar;
        e->event_cursor = 0;
        while (e->event_cursor < e->live_slot.event_count &&
               e->live_slot.events[e->event_cursor].tick < e->playhead_tick) {
            e->event_cursor++;
        }
        uint32_t remaining = (target > seek_tick) ? (target - seek_tick) : 0;
        if (e->live_slot.end_tick > 0) {
            target = (e->playhead_tick + remaining) % e->live_slot.end_tick;
        } else {
            target = e->playhead_tick + remaining;
        }
        retrigger_beat_flash(e, e->playhead_tick, target);
        drain_events_up_to(e, target);
        handle_loop_or_stop(e, &target);
        e->playhead_tick = target;
        update_bar_counter(e);
        return;
    }

    /* Sample-accurate scheduled clip swap: if a swap is pending and this
     * render block crosses the swap tick, drain old events up to the swap
     * point, hot-swap the timeline in the audio thread, then continue
     * draining the new timeline for the remaining ticks in the block. */
    if (e->pending_swap && target >= e->pending_swap_tick) {
        uint32_t swap_tick = e->pending_swap_tick;
        if (swap_tick > e->playhead_tick) {
            retrigger_beat_flash(e, e->playhead_tick, swap_tick);
            /* Suppress note-ons in the guard window before the swap boundary
             * so a groove cut short by the transition doesn't flam at the
             * seam. The guard window start was computed when the swap was
             * scheduled. */
            drain_events_up_to_guarded(e, swap_tick, e->pending_swap_guard_start);
        }
        /* Promote the captured pending-swap slot (the clip this swap was
         * scheduled for, e.g. a fill) into the active timeline via a bounded
         * copy -- never a pointer handoff, so there is nothing to free().
         * The return groove may have been preloaded into staging after this
         * swap was scheduled, so we must NOT promote from staging_ch here
         * (which would promote the return groove instead of the fill) --
         * pending_swap_slot is physically separate memory from
         * staging_ch.slot[], captured at schedule time, so it cannot have
         * been overwritten by that later preload. */
        copy_timeline_slot(&e->live_slot, &e->pending_swap_slot);
        e->tempo_bpm = e->live_slot.tempo_bpm;
        e->time_sig_num = e->live_slot.time_sig_num;
        e->time_sig_den = e->live_slot.time_sig_den;
        e->ticks_per_beat = e->live_slot.ticks_per_beat;
        e->ticks_per_bar = e->live_slot.ticks_per_bar;
        e->loop = e->pending_swap_loop;
        uint32_t resume = e->pending_swap_resume_tick;
        e->swap_resume_tick = resume;
        e->swap_counter++;
        copy_trunc(e->active_source, sizeof(e->active_source), e->live_slot.source);
        e->pending_swap = 0;
        e->pending_swap_tick = 0;
        e->pending_swap_guard_active = 0;
        /* Apply the remaining portion of this audio block to the new clip. */
        uint32_t remaining = (target > swap_tick) ? (target - swap_tick) : 0;
        /* Start the new clip at the requested resume position (0 = start),
         * then continue for the remainder of this audio block. */
        e->playhead_tick = resume;
        e->event_cursor = 0;
        while (e->event_cursor < e->live_slot.event_count &&
               e->live_slot.events[e->event_cursor].tick < e->playhead_tick) {
            e->event_cursor++;
        }
        /* Rescue any events in the guard window just before the resume
         * point that the forward walk above just skipped past -- see
         * rescue_guard_window_events. */
        {
            double gf = e->swap_guard_fraction;
            if (gf < 0.0) gf = 0.0;
            if (gf > 1.0) gf = 1.0;
            uint32_t guard = (uint32_t)(gf * e->ticks_per_beat);
            if (guard == 0) guard = 1;
            rescue_guard_window_events(e, resume, guard);
        }
        /* The timeline changed; track the new clip's starting bar. */
        e->last_bar = e->live_slot.end_tick > 0
            ? (resume / e->ticks_per_bar)
            : 0;
        if (e->live_slot.end_tick > 0) {
            target = (resume + remaining) % e->live_slot.end_tick;
        } else {
            target = resume + remaining;
        }
        retrigger_beat_flash(e, resume, target);
        drain_events_up_to(e, target);
        handle_loop_or_stop(e, &target);
        e->playhead_tick = target;
        update_bar_counter(e);
        return;
    }

    retrigger_beat_flash(e, e->playhead_tick, target);
    /* Activate the guard once the playhead reaches the guard window start, so
     * note-ons in the window are suppressed across every block leading up to a
     * pending swap (Jam mode) or pending seek (performance mid-section change),
     * not just the block that crosses the boundary. */
    if (e->pending_swap) {
        if (target > e->pending_swap_guard_start) {
            e->pending_swap_guard_active = 1;
        }
        if (e->pending_swap_guard_active) {
            drain_events_up_to_guarded(e, target, e->pending_swap_guard_start);
        } else {
            drain_events_up_to(e, target);
        }
    } else if (e->pending_seek) {
        if (target > e->pending_seek_guard_start) {
            e->pending_seek_guard_active = 1;
        }
        if (e->pending_seek_guard_active) {
            drain_events_up_to_guarded(e, target, e->pending_seek_guard_start);
        } else {
            drain_events_up_to(e, target);
        }
    } else {
        drain_events_up_to(e, target);
    }
    handle_loop_or_stop(e, &target);

    e->playhead_tick = target;
    /* Fire any scheduled instrument note-offs whose tick has been reached
     * (the note_gap before the next note-on, cutting the previous note short). */
    fire_pending_instrument_notes_off(e, e->playhead_tick);
    update_bar_counter(e);
}

/* -------------------------------------------------------------------------- */
/* Plugin API                                                                 */
/* -------------------------------------------------------------------------- */

static void engine_set_error(engine_t *e, const char *msg) {
    if (!e || !msg) return;
    snprintf(e->error_msg, sizeof(e->error_msg), "%.255s", msg);
}

static void engine_clear_error(engine_t *e) {
    if (!e) return;
    e->error_msg[0] = '\0';
}

/* DSP build version stamp. Keep in sync with UI_BUILD_VERSION in ui.js so the
 * running dsp.so can be confirmed from .dsp_log on module load. */
static const char *const DSP_BUILD_VERSION = "arranger-dsp-2026-09-09g";

static void* arr_create_instance(const char *module_dir, const char *config_json) {
    (void)module_dir;
    (void)config_json;
    engine_t *e = calloc(1, sizeof(engine_t));
    if (!e) return NULL;
    /* Log the build version unconditionally (not gated behind g_dsp_debug) so
     * a fresh module load always records which dsp.so is in memory. Routed
     * through the ring buffer so this one-time call still obeys the "no
     * logging on the audio thread" rule. */
    {
        char ver[64];
        snprintf(ver, sizeof(ver), "%s", DSP_BUILD_VERSION);
        log_ring_enqueue(&g_log_ring, ver);
    }
    snprintf(e->library_root, sizeof(e->library_root),
             "/data/UserData/UserLibrary/Arranger/MidiLibrary");
    snprintf(e->library_root_requested, sizeof(e->library_root_requested),
             "/data/UserData/UserLibrary/Arranger/MidiLibrary");
    e->guard_fraction = 0.125;
    e->swap_guard_fraction = 0.25; /* 25% of a beat at mid-clip swap boundaries */
    e->output_channel = 9; /* channel 10 for GM drums */
    e->output_target = OUTPUT_TARGET_EXTERNAL;
    e->move_channel = 9;     /* channel 10 for GM drums */
    e->schwung_channel = 9;  /* channel 10 for GM drums */
    e->last_event_channel_override = -1; /* no per-event override by default */
    e->loop = 1;          /* default to looping for performance mode */
    /* Pre-existing latent bug, newly reachable now that JS/the test harness
     * must poll get_param("state") for primary_published_gen BEFORE any
     * build has ever completed (to capture a baseline generation) rather
     * than only after: get_param("state"/"position") divides/mods by
     * ticks_per_bar/ticks_per_beat unconditionally, and calloc() leaves both
     * at 0 until the first activation (play/play_from_bar/a swap) sets them
     * from a real build. That first get_param call, before any song is ever
     * loaded, was an unconditional divide-by-zero. Default to the same 240
     * fallback used throughout parsing/building whenever a song doesn't
     * specify its own division. */
    e->ticks_per_bar = 240;
    e->ticks_per_beat = 240;

    /* Initialize the worker thread's wake semaphore and running flag, then
     * spawn it. The worker demotes itself off SCHED_FIFO as its first action
     * (see arranger_worker_thread). */
    if (sem_init(&e->worker_wake, 0, 0) != 0) {
        free(e);
        return NULL;
    }
    atomic_store_explicit(&e->worker_running, 1, memory_order_release);
    if (pthread_create(&e->worker_thread, NULL, arranger_worker_thread, e) != 0) {
        sem_destroy(&e->worker_wake);
        free(e);
        return NULL;
    }
    return e;
}

static void arr_destroy_instance(void *instance) {
    engine_t *e = instance;
    if (!e) return;
    /* Stop and join the worker thread before any cleanup. Once joined,
     * nothing is rendering, so the audio-thread-safety rules no longer
     * apply and the direct free()/clear calls below are safe.
     *
     * This join is NOT the same shape as the destroy_instance-on-the-SPI-
     * callback problem the rest of this file's rearchitecture exists to
     * fix. arranger is component_type "overtake" (src/module.json), and the
     * Schwung host gives overtake DSP instances a dedicated off-callback
     * teardown path: schwung_shim.c's overtake_dsp_retire_locked() runs on
     * the SPI thread but only ever stashes the live pointers and posts
     * SHIM_EVT_OVERTAKE_DSP_FREE; the actual destroy_instance() + dlclose()
     * pair runs later in overtake_dsp_free_pending() on the shim's own
     * SCHED_OTHER worker thread (shim_worker.c), whose own comment states
     * blocking there is free. So this function already runs off the SPI
     * callback, and dlclose() follows destroy_instance() immediately and
     * synchronously on that same worker thread -- which is exactly why this
     * MUST stay a real join and never become a detach: a detach would let
     * this function return (and dlclose() unmap the .so) while
     * arranger_worker_thread might still be executing code inside it, a
     * jump into unmapped memory. (An earlier version of this fix detached
     * instead of joining, reasoning only from the generic "destroy_instance
     * runs on the SPI callback" rule in docs/REALTIME_SAFETY.md/MODULES.md
     * -- true for the general case, false for this module's actual teardown
     * path once the overtake carve-out is accounted for. Reverted before
     * ever reaching hardware.) */
    atomic_store_explicit(&e->worker_running, 0, memory_order_release);
    sem_post(&e->worker_wake); /* wake the worker so it observes the flag and exits */
    pthread_join(e->worker_thread, NULL);
    sem_destroy(&e->worker_wake);
    clear_song(e);
    free_library_cache(e);
    free(e);
}

static void arr_on_midi(void *instance, const uint8_t *msg, int len, int source) {
    engine_t *e = instance;
    if (!e || len < 1) return;
    (void)source;
    uint8_t status = msg[0];

    if (status == 0xFA) {
        e->playhead_tick = 0;
        e->event_cursor = 0;
        e->running = 1;
        e->flash_end_tick = initial_flash_end_tick(e);
        queue_clear(e);
        return;
    }
    if (status == 0xFB) {
        e->running = 1;
        return;
    }
    if (status == 0xFC) {
        e->running = 0;
        queue_clear(e);
        emit_all_notes_off(e);
        return;
    }

    /* Arranger is a generator; do not pass through external input. */
}

static int arr_get_error(void *instance, char *buf, int buf_len) {
    engine_t *e = instance;
    if (!buf || buf_len < 1) return -1;
    /* e->error_msg is worker-owned scratch, overwritten on every build
     * attempt for either channel -- read the primary channel's *published*
     * slot instead, exactly like get_param("error"), so this reflects a
     * complete build's result rather than possibly-mid-write worker scratch
     * or the wrong channel's error. */
    if (e) {
        int active = atomic_load_explicit(&e->primary_ch.active, memory_order_acquire);
        const char *err = e->primary_ch.slot[active].build_error;
        if (err[0]) return snprintf(buf, buf_len, "%s", err);
    }
    buf[0] = '\0';
    return 0;
}

static void arr_render_block(void *instance, int16_t *out_interleaved_lr, int frames) {
    engine_t *e = instance;

    /* Generator tools are silent; clear the audio buffer if provided. */
    if (out_interleaved_lr && frames > 0) {
        memset(out_interleaved_lr, 0, frames * 2 * sizeof(int16_t));
    }

    if (!e) return;

    int sample_rate = g_host ? g_host->sample_rate : 44100;

    advance_playhead(e, frames, sample_rate);
}

/* Activate the most recently published primary build, if any: copies
 * primary_ch.slot[active] into e->live_slot (a bounded copy, never a pointer
 * handoff -- see copy_timeline_slot) and updates the scalars callers read
 * from live_slot's new content. Called at the top of
 * set_param("play"/"play_from_bar"), which JS only issues after confirming
 * state.primary_published_gen advanced past the generation it requested. A
 * no-op if there is nothing new to activate (e.g. play_from_bar seeking
 * within an already-active song). event_cursor/playhead_tick are NOT reset
 * here -- that stays each caller's own job (matching their existing
 * behavior), since "play" and "play_from_bar" reset to different positions. */
static void activate_primary_if_published(engine_t *e) {
    uint32_t pub = atomic_load_explicit(&e->primary_ch.published_gen, memory_order_acquire);
    if (pub == e->primary_committed_gen) return;
    int active = atomic_load_explicit(&e->primary_ch.active, memory_order_acquire);
    copy_timeline_slot(&e->live_slot, &e->primary_ch.slot[active]);
    e->primary_committed_gen = pub;
    e->tempo_bpm = e->live_slot.tempo_bpm;
    e->time_sig_num = e->live_slot.time_sig_num;
    e->time_sig_den = e->live_slot.time_sig_den;
    e->ticks_per_beat = e->live_slot.ticks_per_beat;
    e->ticks_per_bar = e->live_slot.ticks_per_bar;
    copy_trunc(e->active_source, sizeof(e->active_source), e->live_slot.source);
}

static void arr_set_param(void *instance, const char *key, const char *val) {
    engine_t *e = instance;
    if (!e || !key || !val) return;

    /* Diagnostic: log routing-related values explicitly so we can see what
     * the DSP actually receives vs what the UI thinks it sent. Uses arr_log
     * so it lands in .dsp_log alongside the other engine diagnostics. */
    if (strcmp(key, "output_target") == 0 || strcmp(key, "emit_directly") == 0 ||
        strcmp(key, "output_channel") == 0 || strcmp(key, "move_channel") == 0 ||
        strcmp(key, "schwung_channel") == 0) {
        dsp_log_enqueue_worker("SET_PARAM key=%s val=%s", key, val);
    } else {
        dsp_log_enqueue_worker("SET_PARAM key=%s val_len=%d", key, (int)strlen(val));
    }

    if (strcmp(key, "library_root") == 0) {
        /* Store the requested root on the audio thread; the worker copies it
         * into its working copy and rescans on the next wake. No I/O here. */
        snprintf(e->library_root_requested, sizeof(e->library_root_requested), "%s", val);
        atomic_store_explicit(&e->folder_dirty, 1, memory_order_release);
        atomic_store_explicit(&e->song_dirty, 1, memory_order_release);
        sem_post(&e->worker_wake);
        return;
    }
    if (strcmp(key, "scan_library") == 0) {
        /* Explicit request to refresh the cached library/song scans. Just
         * flags the worker; it rescans into the inactive slot and flips
         * active when done. No I/O on the audio thread. */
        atomic_store_explicit(&e->folder_dirty, 1, memory_order_release);
        atomic_store_explicit(&e->song_dirty, 1, memory_order_release);
        sem_post(&e->worker_wake);
        return;
    }
    if (strcmp(key, "debug") == 0) {
        /* Runtime toggle for the DSP debug log (.dsp_log + host log). */
        g_dsp_debug = (atoi(val) != 0);
        return;
    }
    if (strcmp(key, "song_json") == 0) {
        /* Default to one-shot unless loop is explicitly set afterwards.
         * This prevents stale loop state from causing preview/song to loop
         * when the timeline is rebuilt. */
        e->loop = 0;
        /* Hand the payload to the worker via the double-buffered request slot
         * and bump request_gen -- the build itself (parse + clip
         * resolution/loading + assembly) now runs entirely on the worker
         * thread, not inline here. This call returns in low microseconds
         * regardless of song complexity; JS polls state.primary_published_gen
         * to know when the build actually lands. Write the buffer
         * request_active does NOT currently point to, then flip it with a
         * release store -- see request_active's declaration. */
        {
            int cur = atomic_load_explicit(&e->primary_ch.request_active, memory_order_relaxed);
            int next = 1 - cur;
            copy_trunc(e->primary_ch.request_json[next], sizeof(e->primary_ch.request_json[next]), val);
            atomic_store_explicit(&e->primary_ch.request_active, next, memory_order_release);
        }
        atomic_fetch_add_explicit(&e->primary_ch.request_gen, 1, memory_order_release);
        sem_post(&e->worker_wake);
        return;
    }
    if (strcmp(key, "preload_song_json") == 0) {
        /* Jam-mode: build the next clip's timeline into staging while the
         * current clip keeps playing. Activate it later via "swap". Same
         * async request shape as song_json, above -- see
         * state.staging_published_gen. */
        {
            int cur = atomic_load_explicit(&e->staging_ch.request_active, memory_order_relaxed);
            int next = 1 - cur;
            copy_trunc(e->staging_ch.request_json[next], sizeof(e->staging_ch.request_json[next]), val);
            atomic_store_explicit(&e->staging_ch.request_active, next, memory_order_release);
        }
        atomic_fetch_add_explicit(&e->staging_ch.request_gen, 1, memory_order_release);
        sem_post(&e->worker_wake);
        return;
    }
    if (strcmp(key, "swap") == 0) {
        /* Jam-mode: schedule activation of the staged timeline at a musical
         * boundary inside the audio callback. The UI should have already set
         * "staging_loop"/"swap_resume" as desired and confirmed
         * state.staging_published_gen advanced past the generation it
         * requested before calling this -- staging_swap_rejected below is a
         * regression tripwire for exactly the race that skipping that
         * confirmation would reintroduce. */
        uint32_t pub = atomic_load_explicit(&e->staging_ch.published_gen, memory_order_acquire);
        if (pub == e->staging_consumed_gen) {
            atomic_fetch_add_explicit(&e->staging_swap_rejected, 1, memory_order_relaxed);
            dsp_log_enqueue_worker("swap: no staging ready");
            return;
        }
        int staging_active = atomic_load_explicit(&e->staging_ch.active, memory_order_acquire);
        timeline_slot_t *staged = &e->staging_ch.slot[staging_active];
        if (staged->event_count == 0) {
            /* The most recent staging build failed/produced nothing. Consume
             * the generation so we don't spin on it forever, but don't swap. */
            atomic_fetch_add_explicit(&e->staging_swap_rejected, 1, memory_order_relaxed);
            e->staging_consumed_gen = pub;
            dsp_log_enqueue_worker("swap: staging build had no events");
            return;
        }

        uint32_t target_tick = 0;
        if (val && *val) {
            target_tick = (uint32_t)atoi(val);
        }
        if (target_tick == 0) {
            /* Default: next bar boundary. */
            target_tick = ((e->playhead_tick / e->ticks_per_bar) + 1) * e->ticks_per_bar;
        }
        /* If the boundary has already passed (e.g. UI detected it slightly
         * late), perform the swap as soon as possible within this block. */
        if (target_tick <= e->playhead_tick) {
            target_tick = e->playhead_tick + 1;
        }

        e->pending_swap_tick = target_tick;
        e->pending_swap = 1;
        /* Capture the loop flag at schedule time. The UI may preload the next
         * clip (e.g. the return groove) after scheduling this swap, which
         * overwrites staging_loop before the swap fires. Applying the captured
         * value on swap guarantees the swapped-in clip uses the loop mode the
         * UI intended (e.g. a fill must be non-looping so it auto-swaps back
         * to the groove). */
        e->pending_swap_loop = e->staging_loop;
        e->pending_swap_resume_tick = e->staging_resume_tick;
        /* Capture the staged timeline into a dedicated pending-swap buffer (a
         * bounded copy, not a pointer hand-off) so a subsequent preload (the
         * return groove) does not overwrite the clip this swap is meant to
         * activate. Unlike the old pointer hand-off, pending_swap_slot is
         * physically separate memory from staging_ch.slot[] -- a later
         * preload's worker write can never alias it, so there is no hand-off
         * discipline left to violate. */
        copy_timeline_slot(&e->pending_swap_slot, staged);
        e->staging_consumed_gen = pub;
        e->staging_resume_tick = 0;
        /* Compute the guard window start: the swap boundary minus the guard
         * window (fraction of a beat). Note-ons at or after this tick are
         * suppressed across every block leading up to the swap. */
        {
            double gf = e->swap_guard_fraction;
            if (gf < 0.0) gf = 0.0;
            if (gf > 1.0) gf = 1.0;
            uint32_t guard = (uint32_t)(gf * e->ticks_per_beat);
            if (guard == 0) guard = 1;
            e->pending_swap_guard_start = (target_tick > guard) ? (target_tick - guard) : 0;
            e->pending_swap_guard_active = 0;
        }

        dsp_log_enqueue_worker("SWAP_SCHEDULED target=%u playhead=%u tpb=%u bars=%u resume=%u",
                     target_tick, e->playhead_tick, e->ticks_per_bar,
                     e->live_slot.end_tick / e->ticks_per_bar,
                     e->pending_swap_resume_tick);
        return;
    }
    if (strcmp(key, "swap_resume") == 0) {
        /* Set the resume position (in ticks) for the currently staged clip.
         * On the next swap, the staged timeline starts at this position
         * instead of bar 1. A value of 0 means start from the beginning. */
        uint32_t r = (uint32_t)atoi(val);
        e->staging_resume_tick = r;
        return;
    }
    if (strcmp(key, "guard_fraction") == 0) {
        e->guard_fraction = atof(val);
        return;
    }
    if (strcmp(key, "swap_guard_fraction") == 0) {
        double g = atof(val);
        if (g < 0.0) g = 0.0;
        if (g > 1.0) g = 1.0;
        e->swap_guard_fraction = g;
        return;
    }
    if (strcmp(key, "output_channel") == 0) {
        e->output_channel = atoi(val) & 0x0F;
        return;
    }
    if (strcmp(key, "output_target") == 0) {
        if (strcmp(val, "move") == 0) e->output_target = OUTPUT_TARGET_MOVE;
        else if (strcmp(val, "schwung") == 0) e->output_target = OUTPUT_TARGET_SCHWUNG;
        else e->output_target = OUTPUT_TARGET_EXTERNAL;
        return;
    }
    if (strcmp(key, "emit_directly") == 0) {
        e->emit_directly = atoi(val) ? 1 : 0;
        return;
    }
    if (strcmp(key, "move_channel") == 0) {
        e->move_channel = atoi(val) & 0x0F;
        return;
    }
    if (strcmp(key, "schwung_channel") == 0) {
        e->schwung_channel = atoi(val) & 0x0F;
        return;
    }
    if (strcmp(key, "loop") == 0) {
        /* Applies to the primary (currently-playing) song. Every call site
         * targeting the staged clip instead uses "staging_loop" (below) --
         * routing this on e->staging_ready used to be a same-thread ordering
         * trick that worked only because preload_song_json was synchronous;
         * now that it returns before staging is actually ready, that check
         * would race the just-issued preload, so each destination gets its
         * own unambiguous key instead of shared inference. */
        e->loop = (atoi(val) != 0);
        return;
    }
    if (strcmp(key, "staging_loop") == 0) {
        /* Loop flag to apply to the staged (preloaded) clip on swap. See
         * "loop", above, for why this is a separate key rather than
         * inferred from staging state. */
        e->staging_loop = (atoi(val) != 0);
        return;
    }
    if (strcmp(key, "tempo") == 0) {
        /* Live tempo change: update the playhead rate without rebuilding the
         * timeline. The playhead already advances using e->tempo_bpm, so this
         * takes effect immediately on the next render block. */
        double t = atof(val);
        if (t >= 20.0 && t <= 300.0) {
            e->tempo_bpm = t;
        }
        return;
    }
    if (strcmp(key, "play") == 0) {
        activate_primary_if_published(e);
        e->playhead_tick = 0;
        e->event_cursor = 0;
        e->running = 1;
        e->stopped_at_end = 0;
        e->last_playhead_tick = 0;
        e->tick_remainder = 0.0;
        e->last_bar = 0;
        for (int i = 0; i < MAX_INSTRUMENTS; i++) {
            e->last_inst_chord_set[i] = 0;
            e->pending_off_set[i] = 0;
        }
        e->flash_end_tick = initial_flash_end_tick(e);
        queue_clear(e);
        /* Emit the first bar's chord immediately (update_bar_counter only
         * fires on a bar *change*, so bar 0 would otherwise be silent). */
        emit_instruments_at_tick(e, 0);
        dsp_log_enqueue_worker("PLAY tempo=%.1f tpb=%u ts=%d/%d bars=%u",
                     e->tempo_bpm, e->ticks_per_beat,
                     e->time_sig_num, e->time_sig_den,
                     e->live_slot.end_tick / e->ticks_per_bar);
        return;
    }
    if (strcmp(key, "play_from_bar") == 0) {
        /* Start playback from a given bar. Activates a newly published
         * primary build if one is waiting (a fresh song_json for this song),
         * otherwise this is a pure seek within the already-active timeline --
         * either way, near-instant: the actual build already happened on the
         * worker, not here. */
        activate_primary_if_published(e);
        int bar = atoi(val);
        if (bar < 0) bar = 0;
        if (e->live_slot.event_count > 0 && e->live_slot.end_tick > 0) {
            uint32_t max_bar = e->live_slot.end_tick / e->ticks_per_bar;
            if ((uint32_t)bar > max_bar) bar = (int)max_bar;
        }
        e->playhead_tick = (uint32_t)bar * e->ticks_per_bar;
        e->event_cursor = 0;
        while (e->event_cursor < e->live_slot.event_count &&
               e->live_slot.events[e->event_cursor].tick < e->playhead_tick) {
            e->event_cursor++;
        }
        e->running = 1;
        e->stopped_at_end = 0;
        e->last_playhead_tick = 0;
        e->tick_remainder = 0.0;
        e->last_bar = (uint32_t)bar;
        for (int i = 0; i < MAX_INSTRUMENTS; i++) {
            e->last_inst_chord_set[i] = 0;
            e->pending_off_set[i] = 0;
        }
        e->flash_end_tick = initial_flash_end_tick(e);
        queue_clear(e);
        /* Emit the chord for the bar playback starts on. */
        emit_instruments_at_tick(e, e->playhead_tick);
        dsp_log_enqueue_worker("PLAY_FROM_BAR bar=%d playhead=%u running=1",
                     bar, e->playhead_tick);
        return;
    }
    if (strcmp(key, "stop") == 0) {
        e->running = 0;
        e->flash_end_tick = 0;
        queue_clear(e);
        emit_all_notes_off(e);
        /* Send note-offs for any instrument chords still sounding. */
        emit_instruments_all_off(e);
        /* Clear active_source so get_param("state") doesn't keep reporting a
         * clip that stopped as if it were still the current one. Found via a
         * real Jam-mode bug: ui.js's reactive active_source sync (which
         * follows DSP-side auto-swaps) has no way to tell a genuinely
         * current clip from a stale leftover from before a stop, so once
         * jamPlaying went true again for an unrelated clip, it wrongly
         * re-synced to this stale value. */
        e->active_source[0] = '\0';
        dsp_log_enqueue_worker("STOP");
        return;
    }
    if (strcmp(key, "events_ack") == 0) {
        queue_ack_all(e);
        return;
    }
    if (strcmp(key, "seek_bar") == 0) {
        int bar = atoi(val);
        if (e->live_slot.event_count > 0 && e->live_slot.end_tick > 0) {
            uint32_t max_bar = e->live_slot.end_tick / e->ticks_per_bar;
            if (max_bar < 1) max_bar = 1;
            if (bar < 0) bar = 0;
            if ((uint32_t)bar > max_bar) bar = (int)max_bar;
        } else {
            bar = 0;
        }
        e->playhead_tick = (uint32_t)bar * e->ticks_per_bar;
        e->event_cursor = 0;
        while (e->event_cursor < e->live_slot.event_count &&
               e->live_slot.events[e->event_cursor].tick < e->playhead_tick) {
            e->event_cursor++;
        }
        return;
    }
    if (strcmp(key, "seek_bar_scheduled") == 0) {
        /* Schedule a sample-accurate seek to `bar` at the next bar boundary.
         * The value encodes "bar:targetBar" where bar is the boundary to
         * fire on and targetBar is the destination. This lets a performance
         * section jump land exactly on the musical boundary instead of a
         * polling-latency later. */
        /* The boundary bar may be fractional (a section seam in the middle of
         * a bar, from beat-level trims). Parse it as a float and convert to
         * ticks so the seek fires exactly at the section seam — not at the
         * truncated whole bar (which cuts the current section short) nor at
         * the next whole bar (which bleeds into the next section). */
        double bar = atof(val);
        int target_bar = (int)bar; /* default: same bar */
        const char *colon = strchr(val, ':');
        if (colon) {
            bar = atof(val);
            target_bar = atoi(colon + 1);
        }
        if (e->live_slot.event_count > 0 && e->live_slot.end_tick > 0) {
            uint32_t max_bar = e->live_slot.end_tick / e->ticks_per_bar;
            if (max_bar < 1) max_bar = 1;
            if (bar < 0.0) bar = 0.0;
            /* Clamp the fractional boundary against the timeline's real end in
             * ticks (not a truncated whole-bar count), so a fractional value
             * like 4.9 against a true end of 4.5 bars is clamped to the end
             * rather than passing through and scheduling a seek that never
             * fires. */
            double max_bar_ticks = (double)e->live_slot.end_tick;
            if (bar * (double)e->ticks_per_bar > max_bar_ticks) {
                bar = max_bar_ticks / (double)e->ticks_per_bar;
            }
            if (target_bar < 0) target_bar = 0;
            if ((uint32_t)target_bar > max_bar) target_bar = (int)max_bar;
        }
        /* The boundary tick is the start of `bar` (0-based), converted to ticks
         * so fractional bars land at the exact seam. If it has already passed,
         * use the next bar. */
        uint32_t boundary = (uint32_t)(bar * (double)e->ticks_per_bar);
        if (boundary <= e->playhead_tick) {
            boundary = ((e->playhead_tick / e->ticks_per_bar) + 1) * e->ticks_per_bar;
        }
        e->pending_seek_tick = boundary;
        e->pending_seek_bar = (uint32_t)target_bar;
        e->pending_seek = 1;
        /* Compute the guard window start: the seek boundary minus the guard
         * window (fraction of a beat). Note-ons at or after this tick (and
         * before the boundary) are suppressed, so a manual mid-section change
         * doesn't flam at the seam — the same behaviour as Jam's swap guard. */
        {
            double gf = e->swap_guard_fraction;
            if (gf < 0.0) gf = 0.0;
            if (gf > 1.0) gf = 1.0;
            uint32_t guard = (uint32_t)(gf * e->ticks_per_beat);
            if (guard == 0) guard = 1;
            e->pending_seek_guard_start = (boundary > guard) ? (boundary - guard) : 0;
            e->pending_seek_guard_active = 0;
        }
        dsp_log_enqueue_worker("SEEK_SCHEDULED boundary=%u bar=%.3f target=%u playhead=%u",
                     boundary, bar, (uint32_t)target_bar, e->playhead_tick);
        return;
    }
}

static int arr_get_param(void *instance, const char *key, char *buf, int buf_len) {
    engine_t *e = instance;
    if (!e || !key || !buf || buf_len < 1) return -1;

    /* get_param runs on the SAME realtime SPI audio callback thread as
     * render_block/set_param (there is no separate control thread in this
     * host -- confirmed against the host's own plugin_api_v1.h threading
     * contract). Nothing here may allocate, free, or block. Every buffer
     * this function reads below (live_slot, primary_ch/staging_ch's
     * published slots, resolved_clips, folder/song caches) is a fixed array
     * published by the worker via the same double-buffer pattern, so plain
     * atomic/scalar reads are all that's needed -- there is nothing left to
     * free() here. */

    if (strcmp(key, "timeline_info") == 0) {
        /* Reports the latest PUBLISHED primary build (primary_ch.slot[active]),
         * not the currently-active live_slot -- this is a diagnostic ("did my
         * last song_json request build something") that ui.js's
         * playCurrentSong already reads immediately after song_json, before
         * "play" is ever issued, so it must reflect the build's own result
         * rather than lag until activation like live_slot does. Uses the
         * slot's own ticks_per_bar (not e->ticks_per_bar) so total_bars is
         * correct even before this build has been activated. */
        int active = atomic_load_explicit(&e->primary_ch.active, memory_order_acquire);
        const timeline_slot_t *slot = &e->primary_ch.slot[active];
        uint32_t tpb = slot->ticks_per_bar > 0 ? slot->ticks_per_bar : 1;
        return snprintf(buf, buf_len,
                        "{\"count\":%d,\"end_tick\":%u,\"total_bars\":%u}",
                        slot->event_count, slot->end_tick, slot->end_tick / tpb);
    }
    if (strcmp(key, "position") == 0) {
        uint32_t bar = e->playhead_tick / e->ticks_per_bar;
        uint32_t beat = (e->playhead_tick % e->ticks_per_bar) / e->ticks_per_beat;
        return snprintf(buf, buf_len, "%u.%u", bar + 1, beat + 1);
    }
    if (strcmp(key, "state") == 0) {
        /* Safely emit active_source even if it contains JSON-special chars.
         * Source paths are normally plain UTF-8 filesystem paths, but guard
         * quotes/backslashes so the JSON stays valid. */
        char escaped[sizeof(e->active_source) * 2 + 1];
        const char *src = e->active_source;
        int j = 0;
        for (int i = 0; src[i] && j < (int)sizeof(escaped) - 2; i++) {
            char c = src[i];
            if (c == '\\' || c == '"') {
                escaped[j++] = '\\';
            }
            escaped[j++] = c;
        }
        escaped[j] = '\0';

        /* primary_/staging_*_gen let JS confirm a specific async build/swap
         * request actually landed (compare against the generation captured
         * when the request was issued) instead of inferring completion from
         * a blocking set_param call returning, which stopped being a valid
         * proxy once song_json/preload_song_json return before the worker
         * has built anything. staging_swap_rejected is a live regression
         * tripwire: under correct JS-side gating it should never move. */
        return snprintf(buf, buf_len,
                        "{\"running\":%d,\"loop\":%d,\"stopped_at_end\":%d,\"position\":\"%u.%u\",\"active_source\":\"%s\","
                        "\"primary_request_gen\":%u,\"primary_published_gen\":%u,\"primary_committed_gen\":%u,"
                        "\"staging_request_gen\":%u,\"staging_published_gen\":%u,\"staging_consumed_gen\":%u,"
                        "\"staging_swap_rejected\":%u}",
                        e->running,
                        e->loop,
                        e->stopped_at_end,
                        e->playhead_tick / e->ticks_per_bar + 1,
                        (e->playhead_tick % e->ticks_per_bar) / e->ticks_per_beat + 1,
                        escaped,
                        atomic_load_explicit(&e->primary_ch.request_gen, memory_order_relaxed),
                        atomic_load_explicit(&e->primary_ch.published_gen, memory_order_relaxed),
                        e->primary_committed_gen,
                        atomic_load_explicit(&e->staging_ch.request_gen, memory_order_relaxed),
                        atomic_load_explicit(&e->staging_ch.published_gen, memory_order_relaxed),
                        e->staging_consumed_gen,
                        atomic_load_explicit(&e->staging_swap_rejected, memory_order_relaxed));
    }
    if (strcmp(key, "transport") == 0) {
        uint32_t bar = e->playhead_tick / e->ticks_per_bar;
        uint32_t tick_in_bar = e->playhead_tick % e->ticks_per_bar;
        uint32_t beat = tick_in_bar / e->ticks_per_beat;
        uint32_t tick_in_beat = tick_in_bar % e->ticks_per_beat;
        double beat_progress = e->ticks_per_beat > 0
            ? (double)tick_in_beat / (double)e->ticks_per_beat
            : 0.0;
        /* Fractional bar position (0-based, e.g. 3.5 = halfway through bar 4).
         * The integer `bar` can't represent a clip that ends mid-bar (Advanced
         * Trim / speed), so the UI uses this to switch sections and place the
         * white step at the exact musical boundary. */
        double bar_frac = e->ticks_per_bar > 0
            ? (double)e->playhead_tick / (double)e->ticks_per_bar
            : (double)bar;
        int beat_flash = e->running && e->playhead_tick < e->flash_end_tick ? 1 : 0;
        return snprintf(buf, buf_len,
                        "{\"running\":%d,\"bar\":%u,\"beat\":%u,\"beat_progress\":%.4f,\"bar_frac\":%.4f,\"beat_flash\":%d,\"bar_counter\":%u,\"wrap_counter\":%u,\"swap_counter\":%u,\"seek_counter\":%u,\"time_sig_num\":%d,\"time_sig_den\":%d,\"ticks_per_beat\":%u,\"ticks_per_bar\":%u,\"bpm\":%.2f}",
                        e->running,
                        bar + 1,
                        beat + 1,
                        beat_progress,
                        bar_frac,
                        beat_flash,
                        e->bar_counter,
                        e->wrap_counter,
                        e->swap_counter,
                        e->seek_counter,
                        e->time_sig_num,
                        e->time_sig_den,
                        e->ticks_per_beat,
                        e->ticks_per_bar,
                        e->tempo_bpm);
    }
    if (strcmp(key, "emit_directly") == 0) {
        return snprintf(buf, buf_len, "%d", e->emit_directly);
    }
    if (strcmp(key, "swap_guard_fraction") == 0) {
        return snprintf(buf, buf_len, "%.3f", e->swap_guard_fraction);
    }
    if (strcmp(key, "swap_guard_suppressed") == 0) {
        return snprintf(buf, buf_len, "%u", e->swap_guard_suppressed);
    }
    if (strcmp(key, "library_root") == 0) {
        return snprintf(buf, buf_len, "%s", e->library_root_requested);
    }
    if (strcmp(key, "folder_count") == 0) {
        int n = 0;
        folder_entry_t *folders = get_cached_folders(e, &n);
        (void)folders;
        return snprintf(buf, buf_len, "%d", n);
    }
    if (strncmp(key, "folder_name_", 12) == 0) {
        int idx = atoi(key + 12);
        int n = 0;
        folder_entry_t *folders = get_cached_folders(e, &n);
        if (!folders || idx < 0 || idx >= n) return -1;
        return snprintf(buf, buf_len, "%s", folders[idx].name);
    }
    if (strncmp(key, "folder_category_", 16) == 0) {
        int idx = atoi(key + 16);
        int n = 0;
        folder_entry_t *folders = get_cached_folders(e, &n);
        if (!folders || idx < 0 || idx >= n) return -1;
        return snprintf(buf, buf_len, "%s", folders[idx].category);
    }
    if (strncmp(key, "folder_clips_json_", 18) == 0) {
        int idx = atoi(key + 18);
        int n = 0;
        folder_entry_t *folders = get_cached_folders(e, &n);
        if (!folders || idx < 0 || idx >= n) return -1;
        char *p = buf;
        int left = buf_len;
        int w = snprintf(p, left, "[");
        if (w >= 0) { p += w; left -= w; }
        int first = 1;
        for (int i = 0; i < folders[idx].clip_count; i++) {
            const char *name = folders[idx].clip_names + (i * 128);
            const char *type = (strncmp(name, "Fills/", 6) == 0) ? "fill" : "groove";
            const char *leaf = name;
            const char *slash = strrchr(name, '/');
            if (slash) leaf = slash + 1;
            int ext_pos = -1;
            int leaf_len = (int)strlen(leaf);
            for (int k = leaf_len - 1; k >= 0; k--) {
                if (leaf[k] == '.') { ext_pos = k; break; }
            }
            int dn_len = (ext_pos > 0) ? ext_pos : leaf_len;
            uint32_t bars = folders[idx].clip_bars ? folders[idx].clip_bars[i] : 1;
            if (bars < 1) bars = 1;
            /* Build the whole object into a temp buffer so we only append
             * complete objects. If it doesn't fit, stop — this keeps the
             * JSON valid (no trailing comma / partial object) even when the
             * host's get_param buffer is smaller than the full clip list. */
            char obj[512];
            char *op = obj;
            int oleft = (int)sizeof(obj);
            /* Append a literal string, escaping nothing (fixed ASCII). */
            #define OBJ_APPEND_LIT(s) do { \
                const char *_s = (s); \
                while (*_s && oleft > 1) { *op++ = *_s++; oleft--; } \
            } while (0)
            OBJ_APPEND_LIT("{\"source\":\"");
            /* source = folder-relative path including subdir + extension */
            int src_len = (int)strlen(name);
            for (int k = 0; k < src_len && oleft > 1; k++) {
                if (name[k] == '"' || name[k] == '\\' || name[k] < 0x20 || name[k] > 0x7e) {
                    *op++ = '\\';
                    oleft--;
                }
                if (oleft <= 1) break;
                *op++ = name[k];
                oleft--;
            }
            OBJ_APPEND_LIT("\",\"type\":\"");
            OBJ_APPEND_LIT(type);
            OBJ_APPEND_LIT("\",\"bars\":");
            /* Append bars as decimal digits. */
            {
                char num[16];
                int nlen = snprintf(num, sizeof(num), "%u", bars);
                if (nlen > 0) {
                    for (int k = 0; k < nlen && oleft > 1; k++) { *op++ = num[k]; oleft--; }
                }
            }
            OBJ_APPEND_LIT(",\"display\":\"");
            for (int k = 0; k < dn_len && oleft > 1; k++) {
                if (leaf[k] == '"' || leaf[k] == '\\' || leaf[k] < 0x20 || leaf[k] > 0x7e) {
                    *op++ = '\\';
                    oleft--;
                }
                if (oleft <= 1) break;
                *op++ = leaf[k];
                oleft--;
            }
            if (oleft > 1) { *op++ = '"'; oleft--; }
            if (oleft > 1) { *op++ = '}'; oleft--; }
            *op = '\0';
            #undef OBJ_APPEND_LIT
            int obj_len = (int)strlen(obj);
            int need_comma = first ? 0 : 1;
            /* Need room for optional comma + object + closing ']'. */
            if (need_comma + obj_len + 1 > left) break;
            if (need_comma) { *p++ = ','; left--; }
            memcpy(p, obj, obj_len);
            p += obj_len;
            left -= obj_len;
            first = 0;
        }
        if (left > 0) snprintf(p, left, "]");
        return (int)strlen(buf);
    }
    if (strcmp(key, "events") == 0) {
        return queue_serialize_events(e, buf, buf_len);
    }
    if (strcmp(key, "song_count") == 0) {
        int n = 0;
        song_entry_t *songs = get_cached_songs(e, &n);
        (void)songs;
        return snprintf(buf, buf_len, "%d", n);
    }
    if (strncmp(key, "song_name_", 10) == 0) {
        int idx = atoi(key + 10);
        int n = 0;
        song_entry_t *songs = get_cached_songs(e, &n);
        if (!songs || idx < 0 || idx >= n) return -1;
        return snprintf(buf, buf_len, "%s", songs[idx].name);
    }
    if (strncmp(key, "song_path_", 10) == 0) {
        int idx = atoi(key + 10);
        int n = 0;
        song_entry_t *songs = get_cached_songs(e, &n);
        if (!songs || idx < 0 || idx >= n) return -1;
        return snprintf(buf, buf_len, "%s", songs[idx].path);
    }
    if (strcmp(key, "resolved_clips") == 0) {
        /* Report clips whose resolved location differs from their stored
         * folder, so the UI can persist the corrected source_folder and avoid
         * a recursive library search on every play. Each entry is
         * {"source":"<raw source>","folder":"<resolved folder relative to
         * library_root>"}. The diff itself is computed on the worker
         * (compute_resolved_clips, run as part of a successful primary
         * build) and published into e->resolved_clips exactly like the
         * folder/song scan caches -- this handler only reads the active slot
         * and JSON-escapes it, rather than walking e->live_slot.song/e->clips[] live
         * (which are worker-owned once builds move off the audio thread). */
        int active = atomic_load_explicit(&e->resolved_clips.active, memory_order_acquire);
        const resolved_clip_diff_t *diffs = e->resolved_clips.slot[active];
        int count = e->resolved_clips.count[active];

        char *p = buf;
        int left = buf_len;
        int w = snprintf(p, left, "[");
        if (w >= 0) { p += w; left -= w; }
        for (int i = 0; i < count; i++) {
            char obj[1024];
            char *op = obj;
            int oleft = (int)sizeof(obj);
            #define OBJ_APPEND_LIT(s) do { \
                const char *_s = (s); \
                while (*_s && oleft > 1) { *op++ = *_s++; oleft--; } \
            } while (0)
            OBJ_APPEND_LIT("{\"source\":\"");
            for (const char *q = diffs[i].source; *q && oleft > 1; q++) {
                if (*q == '"' || *q == '\\' || *q < 0x20 || *q > 0x7e) { *op++ = '\\'; oleft--; }
                if (oleft <= 1) break;
                *op++ = *q; oleft--;
            }
            OBJ_APPEND_LIT("\",\"folder\":\"");
            for (const char *q = diffs[i].folder; *q && oleft > 1; q++) {
                if (*q == '"' || *q == '\\' || *q < 0x20 || *q > 0x7e) { *op++ = '\\'; oleft--; }
                if (oleft <= 1) break;
                *op++ = *q; oleft--;
            }
            OBJ_APPEND_LIT("\"}");
            *op = '\0';
            #undef OBJ_APPEND_LIT
            int obj_len = (int)strlen(obj);
            int need_comma = (i == 0) ? 0 : 1;
            if (need_comma + obj_len + 1 > left) break;
            if (need_comma) { *p++ = ','; left--; }
            memcpy(p, obj, obj_len);
            p += obj_len;
            left -= obj_len;
        }
        if (left > 0) snprintf(p, left, "]");
        return (int)strlen(buf);
    }
    if (strcmp(key, "error") == 0) {
        return arr_get_error(e, buf, buf_len);
    }
    if (strcmp(key, "staging_error") == 0) {
        int active = atomic_load_explicit(&e->staging_ch.active, memory_order_acquire);
        return snprintf(buf, buf_len, "%s", e->staging_ch.slot[active].build_error);
    }
    return -1;
}

static plugin_api_v2_t g_api = {
    .api_version     = MOVE_PLUGIN_API_VERSION_2,
    .create_instance = arr_create_instance,
    .destroy_instance = arr_destroy_instance,
    .on_midi         = arr_on_midi,
    .set_param       = arr_set_param,
    .get_param       = arr_get_param,
    .get_error       = arr_get_error,
    .render_block    = arr_render_block,
};

plugin_api_v2_t* move_plugin_init_v2(const struct host_api_v1 *host) {
    g_host = host;
    return &g_api;
}
