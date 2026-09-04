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

#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <stdint.h>
#include <math.h>
#include <stdarg.h>
#include <time.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>
#include <dirent.h>
#include <ctype.h>
#include "plugin_api_v1.h"

static const host_api_v1_t *g_host;

/* Runtime debug flag. When 0 (default), arr_log skips the file write and the
 * host log call, so the hot audio path does no I/O. Set to 1 only when
 * debugging. */
static int g_dsp_debug = 0;

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

typedef struct {
    char name[64];
    int clip_count;
    section_clip_t clips[MAX_SECTION_CLIPS];
    uint32_t bars;           /* total bars after assembly */
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
} song_t;

/* Forward declarations for the library/song scan types and functions, used by
 * the engine's cached scan fields below. */
typedef struct engine engine_t;
typedef struct folder_entry folder_entry_t;
typedef struct song_entry song_entry_t;
static folder_entry_t* scan_library_heap(engine_t *e, int *out_count);
static song_entry_t* scan_songs_heap(engine_t *e, int *out_count);
static folder_entry_t* get_cached_folders(engine_t *e, int *out_count);
static const char* clip_lookup_find(engine_t *e, const char *leaf);
static void clip_lookup_free(engine_t *e);

/* -------------------------------------------------------------------------- */
/* Engine instance                                                            */
/* -------------------------------------------------------------------------- */

typedef struct engine {
    /* Library root */
    char library_root[MAX_PATH_LEN];

    /* Loaded clips (one per unique source file referenced by current song) */
    clip_t clips[MAX_CLIPS_PER_FOLDER];
    int clip_count;

    /* Current song */
    song_t song;

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

    /* Old timeline handed off by engine_swap_to_staging on the audio thread.
     * It is freed on the next control-thread preload call instead of inline,
     * so the audio thread never calls free(). */
    smf_event_t *retired_timeline;

    /* Assembled timeline */
    smf_event_t *timeline;
    int timeline_count;
    uint32_t timeline_end_tick;

    /* Source path of the clip currently playing in the active timeline.
     * Exposed to the JS UI via the "state" get_param so Jam mode can keep
     * the display/pads in sync with DSP-side auto-swaps. */
    char active_source[MAX_PATH_LEN];

    /* Staging timeline for seamless clip switching (Jam mode). The next clip's
     * timeline is built here ahead of time (via preload_song_json) while the
     * current clip keeps playing; a "swap" then activates it instantly with
     * no synchronous build_timeline delay at the musical boundary. */
    smf_event_t *staging_timeline;
    int staging_timeline_count;
    uint32_t staging_timeline_end_tick;
    int staging_ready;             /* 1 when a preloaded timeline is ready to swap */
    double staging_tempo_bpm;      /* tempo to apply on swap */
    int staging_time_sig_num;
    int staging_time_sig_den;
    uint32_t staging_ticks_per_beat;
    uint32_t staging_ticks_per_bar;
    int staging_loop;              /* loop flag to apply on swap */
    char staging_source[MAX_PATH_LEN]; /* source path of the staged clip */
    uint32_t staging_resume_tick;  /* resume position (ticks) for the staged clip on swap; 0 = start */
    uint32_t swap_resume_tick;     /* resume position captured at swap time for the caller to apply */

    /* Scheduled clip swap for sample-accurate transitions in Jam mode. The
     * clip to swap in is captured into a dedicated buffer at schedule time so
     * a subsequent preload (e.g. the return groove) does not overwrite it
     * before the swap fires. */
    uint32_t pending_swap_tick;    /* tick at which to swap -> active */
    int pending_swap;              /* 1 if a swap is scheduled */
    int pending_swap_loop;         /* loop flag captured at swap-schedule time, applied on swap */
    smf_event_t *pending_swap_timeline;      /* captured timeline to swap in */
    int pending_swap_timeline_count;
    uint32_t pending_swap_timeline_end_tick;
    double pending_swap_tempo_bpm;
    int pending_swap_time_sig_num;
    int pending_swap_time_sig_den;
    uint32_t pending_swap_ticks_per_beat;
    uint32_t pending_swap_ticks_per_bar;
    uint32_t pending_swap_resume_tick;
    char pending_swap_source[MAX_PATH_LEN];
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

    /* Cached library scan. The JS UI queries folder_count/folder_name_* and
     * song_count/song_name_* repeatedly; scanning the filesystem on every
     * get_param is wasteful. We cache the scan and only refresh when the
     * library_root changes or scan_library is explicitly requested. */
    folder_entry_t *lib_cache;
    int lib_cache_count;
    song_entry_t *song_cache;
    int song_cache_count;
    int lib_cache_valid;
    int song_cache_valid;

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
     * confirm which host function the DSP actually routes to. Uses arr_log so
     * it lands in .dsp_log. */
    {
        static int route_log_count[3] = {0,0,0};
        int ri = e->output_target; /* 0=ext,1=move,2=schwung */
        if (ri >= 0 && ri < 3 && route_log_count[ri] < 5) {
            arr_log("DSPEMIT route=%s target=%d cable=%d cin=0x%02X status=0x%02X d1=%d d2=%d sent=%d",
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
     * already loaded in the clip cache (which persists across songs via
     * clear_song_keep_clips), return it immediately. This avoids repeated
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
    memset(&e->song, 0, sizeof(e->song));
    if (e->timeline) { free(e->timeline); e->timeline = NULL; }
    e->timeline_count = 0;
    e->timeline_end_tick = 0;
    e->playhead_tick = 0;
    e->event_cursor = 0;
    e->running = 0;
    free_library_cache(e);
    queue_clear(e);
    if (e->staging_timeline) { free(e->staging_timeline); e->staging_timeline = NULL; }
    e->staging_timeline_count = 0;
    e->staging_timeline_end_tick = 0;
    e->staging_ready = 0;
    e->staging_loop = 1;
    if (e->pending_swap_timeline) { free(e->pending_swap_timeline); e->pending_swap_timeline = NULL; }
    e->pending_swap_timeline_count = 0;
    e->pending_swap_timeline_end_tick = 0;
    e->pending_swap = 0;
}

/* Reset the song/timeline but keep the parsed clip cache. Used when reloading
 * a song (e.g. a section jump) so clips are not re-parsed from disk, which
 * causes an audible delay when jumping to a non-adjacent section. */
static void clear_song_keep_clips(engine_t *e) {
    memset(&e->song, 0, sizeof(e->song));
    if (e->timeline) { free(e->timeline); e->timeline = NULL; }
    e->timeline_count = 0;
    e->timeline_end_tick = 0;
    e->playhead_tick = 0;
    e->event_cursor = 0;
    e->running = 0;
    queue_clear(e);
    if (e->staging_timeline) { free(e->staging_timeline); e->staging_timeline = NULL; }
    e->staging_timeline_count = 0;
    e->staging_timeline_end_tick = 0;
    e->staging_ready = 0;
    e->staging_loop = 1;
    if (e->pending_swap_timeline) { free(e->pending_swap_timeline); e->pending_swap_timeline = NULL; }
    e->pending_swap_timeline_count = 0;
    e->pending_swap_timeline_end_tick = 0;
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
    }

    qsort(*out_timeline, *out_count, sizeof(smf_event_t), event_cmp);
    return 0;
}

/* Build the assembled timeline from e->song into the active timeline fields.
 * This is the legacy synchronous entry point used by song_json. */
static int build_timeline(engine_t *e) {
    int rc = build_timeline_targeted(e, &e->song, e->tempo_bpm,
                                     e->time_sig_num, e->time_sig_den,
                                     e->ticks_per_beat, e->ticks_per_bar,
                                     &e->timeline, &e->timeline_count,
                                     &e->timeline_end_tick);
    if (rc == 0) {
        e->event_cursor = 0;
        e->playhead_tick = 0;
    }
    return rc;
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
    return 0;
}

/* Load a song JSON into the active engine song and rebuild the active
 * timeline. Used by the Arranger song-JSON load path. */
static int load_song_from_json(engine_t *e, const char *json) {
    engine_clear_error(e);
    /* Keep the parsed clip cache so reloading a song (e.g. a section jump)
     * does not re-parse MIDI clips from disk, which causes an audible delay. */
    clear_song_keep_clips(e);

    uint32_t tpb = 240, tpbar = 240;
    parse_song_json(e, json, &e->song, &e->tempo_bpm, &e->time_sig_num,
                    &e->time_sig_den, &tpb, &tpbar);
    e->ticks_per_beat = tpb;
    e->ticks_per_bar = tpbar;

    /* Track the source of the first clip so the UI can follow DSP swaps. */
    if (e->song.section_count > 0 && e->song.sections[0].clip_count > 0) {
        section_clip_t *sc = &e->song.sections[0].clips[0];
        if (sc->clip_index >= 0 && sc->clip_index < e->clip_count) {
            copy_trunc(e->active_source, sizeof(e->active_source),
                       e->clips[sc->clip_index].path);
        } else {
            e->active_source[0] = '\0';
        }
    } else {
        e->active_source[0] = '\0';
    }

    /* Reset host-sync state on every song load. */
    e->last_playhead_tick = 0;

    return 0;
}

/* Preload a song JSON into the staging timeline while the current timeline
 * keeps playing. The next musical boundary can then activate it via "swap"
 * with no synchronous rebuild delay. */
static int preload_song_from_json(engine_t *e, const char *json) {
    engine_clear_error(e);

    /* Free any timeline retired by a swap on the audio thread. This runs on
     * the control thread, so free() is safe here. */
    if (e->retired_timeline) { free(e->retired_timeline); e->retired_timeline = NULL; }

    /* Discard any previous staging buffer. */
    if (e->staging_timeline) { free(e->staging_timeline); e->staging_timeline = NULL; }
    e->staging_timeline_count = 0;
    e->staging_timeline_end_tick = 0;
    e->staging_ready = 0;
    e->staging_resume_tick = 0; /* no resume position for the new staged clip by default */

    song_t staging_song;
    memset(&staging_song, 0, sizeof(staging_song));

    double tempo_bpm = 120.0;
    int ts_num = 4, ts_den = 4;
    uint32_t tpb = 240, tpbar = 240;
    if (parse_song_json(e, json, &staging_song, &tempo_bpm, &ts_num, &ts_den, &tpb, &tpbar) != 0) {
        return -1;
    }

    if (build_timeline_targeted(e, &staging_song, tempo_bpm, ts_num, ts_den,
                               tpb, tpbar, &e->staging_timeline,
                               &e->staging_timeline_count,
                               &e->staging_timeline_end_tick) != 0) {
        memset(&staging_song, 0, sizeof(staging_song));
        return -1;
    }

    e->staging_tempo_bpm = tempo_bpm;
    e->staging_time_sig_num = ts_num;
    e->staging_time_sig_den = ts_den;
    e->staging_ticks_per_beat = tpb;
    e->staging_ticks_per_bar = tpbar;
    e->staging_ready = 1;
    e->staging_loop = e->loop; /* inherit current loop unless overridden before swap */

    /* Remember the staged clip's source path for active_source on swap. */
    if (staging_song.section_count > 0 && staging_song.sections[0].clip_count > 0) {
        section_clip_t *sc = &staging_song.sections[0].clips[0];
        if (sc->clip_index >= 0 && sc->clip_index < e->clip_count) {
            copy_trunc(e->staging_source, sizeof(e->staging_source),
                       e->clips[sc->clip_index].path);
        } else {
            e->staging_source[0] = '\0';
        }
    } else {
        e->staging_source[0] = '\0';
    }

    dsp_host_log("PRELOAD sections=%d events=%d end_tick=%u tempo=%.1f tpb=%u loop=%d",
                 staging_song.section_count, e->staging_timeline_count,
                 e->staging_timeline_end_tick, tempo_bpm, tpb,
                 e->staging_loop);

    memset(&staging_song, 0, sizeof(staging_song));
    return 0;
}

/* -------------------------------------------------------------------------- */
/* Library scanning (for JS UI via get_param)                                */
/* -------------------------------------------------------------------------- */

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

static void free_folders(folder_entry_t *folders, int count) {
    if (!folders) return;
    for (int i = 0; i < count; i++) {
        if (folders[i].clip_names) { free(folders[i].clip_names); folders[i].clip_names = NULL; }
        if (folders[i].clip_bars) { free(folders[i].clip_bars); folders[i].clip_bars = NULL; }
    }
    free(folders);
}

/* -------------------------------------------------------------------------- */
/* Song file scanning (for JS UI via get_param)                                */
/* -------------------------------------------------------------------------- */

struct song_entry {
    char name[128];
    char path[MAX_PATH_LEN];
};

static int song_entry_cmp(const void *a, const void *b) {
    const song_entry_t *sa = a, *sb = b;
    return strcasecmp(sa->name, sb->name);
}

static void free_songs(song_entry_t *songs) {
    if (songs) free(songs);
}

/* Free the cached library/song scans, if any. */
static void free_library_cache(engine_t *e) {
    if (e->lib_cache) { free_folders(e->lib_cache, e->lib_cache_count); e->lib_cache = NULL; }
    e->lib_cache_count = 0;
    e->lib_cache_valid = 0;
    if (e->song_cache) { free_songs(e->song_cache); e->song_cache = NULL; }
    e->song_cache_count = 0;
    e->song_cache_valid = 0;
    clip_lookup_free(e);
}

/* Return the cached folder scan, scanning once and reusing it until the
 * library_root changes or scan_library is requested. */
static folder_entry_t* get_cached_folders(engine_t *e, int *out_count) {
    if (!e->lib_cache_valid) {
        if (e->lib_cache) { free_folders(e->lib_cache, e->lib_cache_count); e->lib_cache = NULL; }
        e->lib_cache = scan_library_heap(e, &e->lib_cache_count);
        e->lib_cache_valid = 1;
    }
    *out_count = e->lib_cache_count;
    return e->lib_cache;
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

/* Return the cached song scan, scanning once and reusing it. */
static song_entry_t* get_cached_songs(engine_t *e, int *out_count) {
    if (!e->song_cache_valid) {
        if (e->song_cache) { free_songs(e->song_cache); e->song_cache = NULL; }
        e->song_cache = scan_songs_heap(e, &e->song_cache_count);
        e->song_cache_valid = 1;
    }
    *out_count = e->song_cache_count;
    return e->song_cache;
}

static song_entry_t* scan_songs_heap(engine_t *e, int *out_count) {
    *out_count = 0;
    char songs_dir[MAX_PATH_LEN];
    char parent[MAX_PATH_LEN];
    /* library_root is a folder; derive sibling Songs dir without using '..'
     * because some host file functions do not normalize relative paths. */
    int n = snprintf(parent, sizeof(parent), "%s", e->library_root);
    if (n < 0 || (size_t)n >= sizeof(parent)) return NULL;
    char *last_slash = strrchr(parent, '/');
    if (!last_slash) return NULL;
    *last_slash = '\0';
    n = snprintf(songs_dir, sizeof(songs_dir), "%s/Songs", parent);
    if (n < 0 || (size_t)n >= sizeof(songs_dir)) return NULL;

    DIR *d = opendir(songs_dir);
    if (!d) return NULL;
    song_entry_t *songs = calloc(MAX_SOURCE_FOLDERS, sizeof(song_entry_t));
    if (!songs) { closedir(d); return NULL; }
    int count = 0;
    struct dirent *ent;
    while ((ent = readdir(d)) && count < MAX_SOURCE_FOLDERS) {
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
    return songs;
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

static folder_entry_t* scan_library_heap(engine_t *e, int *out_count) {
    *out_count = 0;
    DIR *d = opendir(e->library_root);
    if (!d) return NULL;
    folder_entry_t *folders = calloc(MAX_SOURCE_FOLDERS, sizeof(folder_entry_t));
    if (!folders) { closedir(d); return NULL; }
    int count = 0;
    struct dirent *ent;
    while ((ent = readdir(d)) && count < MAX_SOURCE_FOLDERS) {
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
    return folders;
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
    if (!e->running || e->timeline_count == 0) return;
    while (e->event_cursor < e->timeline_count) {
        const smf_event_t *ev = &e->timeline[e->event_cursor];
        if (ev->tick >= target) break;
        e->last_event_channel_override = ev->channel_override;
        if (e->emit_directly) {
            emit_direct_event(e, ev->status, ev->data1, ev->data2, ev->len);
        } else {
            uint8_t status = apply_channel_override(ev->status, ev->channel_override);
            queue_push(e, status, ev->data1, ev->data2, ev->len);
        }
        e->event_cursor++;
    }
}

/* Drain events up to `target`, suppressing note-ons at or after `guard_start`
 * (an absolute tick). This is used at a swap boundary so a groove that is cut
 * short by a transition doesn't fire a note-on in the guard window before the
 * seam (which would sound like a flam/glitch). Note-offs pass through so notes
 * don't get stuck. */
static void drain_events_up_to_guarded(engine_t *e, uint32_t target, uint32_t guard_start) {
    if (!e->running || e->timeline_count == 0) return;
    while (e->event_cursor < e->timeline_count) {
        const smf_event_t *ev = &e->timeline[e->event_cursor];
        if (ev->tick >= target) break;
        uint8_t type = ev->status & 0xF0;
        int is_note_on = (type == 0x90 && ev->data2 > 0);
        if (is_note_on && ev->tick >= guard_start) {
            /* Suppress note-ons in the guard window before the boundary. */
            e->swap_guard_suppressed++;
            arr_log("GUARD suppress note=%u tick=%u target=%u guardStart=%u dist=%u",
                    ev->data1, ev->tick, target, guard_start, target - ev->tick);
            e->event_cursor++;
            continue;
        }
        e->last_event_channel_override = ev->channel_override;
        if (e->emit_directly) {
            emit_direct_event(e, ev->status, ev->data1, ev->data2, ev->len);
        } else {
            uint8_t status = apply_channel_override(ev->status, ev->channel_override);
            queue_push(e, status, ev->data1, ev->data2, ev->len);
        }
        e->event_cursor++;
    }
}

static void engine_swap_to_staging(engine_t *e); /* defined below */

static void handle_loop_or_stop(engine_t *e, uint32_t *target) {
    if (*target >= e->timeline_end_tick + 1 || e->event_cursor >= e->timeline_count) {
        arr_log("LOOPSTOP target=%u end=%u cursor=%d/%d loop=%d staging=%d",
                *target, e->timeline_end_tick, e->event_cursor, e->timeline_count,
                e->loop, e->staging_ready);
        if (e->loop) {
            if (e->timeline_end_tick > 0) {
                *target = *target % e->timeline_end_tick;
            } else {
                *target = 0;
            }
            e->playhead_tick = 0;
            e->stopped_at_end = 0;
            e->event_cursor = 0;
            /* A full loop wrap back to bar 1. */
            e->wrap_counter++;
            while (e->event_cursor < e->timeline_count &&
                   e->timeline[e->event_cursor].tick < *target) {
                e->event_cursor++;
            }
        } else if (e->staging_ready && e->staging_timeline && e->staging_timeline_count > 0) {
            /* Jam-mode: a non-looping clip (fill) reached its end and the
             * next clip is already staged. Hot-swap to the staged timeline
             * and keep running so the transition is sample-accurate and the
             * UI does not need to restart playback. The new clip starts at
             * its requested resume position (0 = start), then only the
             * overshoot past the fill's end carries it forward. */
            uint32_t old_end = e->timeline_end_tick;
            uint32_t tpb = (e->ticks_per_bar > 0) ? e->ticks_per_bar : 1;
            /* The fill's full bar boundary: the swap must land on the exact
             * end of the fill's bar(s), not on the last event (which may end
             * early). Without this, the groove resumes slightly early. */
            uint32_t fill_full = ((old_end + tpb - 1) / tpb) * tpb;
            if (*target >= fill_full) {
                /* Overshoot = how far past the fill's full bar this block
                 * reached. */
                uint32_t overshoot = (*target > fill_full) ? (*target - fill_full) : 0;
                arr_log("AUTOSWAP old_end=%u tpb=%u fill_full=%u target=%u overshoot=%u resume=%u",
                        old_end, tpb, fill_full, *target, overshoot, e->staging_resume_tick);
                engine_swap_to_staging(e);
                uint32_t resume = e->swap_resume_tick;
                e->playhead_tick = resume;
                e->event_cursor = 0;
                while (e->event_cursor < e->timeline_count &&
                       e->timeline[e->event_cursor].tick < e->playhead_tick) {
                    e->event_cursor++;
                }
                /* The timeline changed; track the new clip's starting bar. */
                e->last_bar = e->timeline_end_tick > 0
                    ? (resume / e->ticks_per_bar)
                    : 0;
                uint32_t advanced = resume + overshoot;
                if (e->timeline_end_tick > 0) {
                    *target = advanced % e->timeline_end_tick;
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
            if (e->timeline_end_tick > 0 && *target < e->timeline_end_tick) {
                e->running = 1;
                e->stopped_at_end = 0;
            } else {
                e->running = 0;
                e->stopped_at_end = 1;
                emit_all_notes_off(e);
                if (e->playhead_tick > e->timeline_end_tick) e->playhead_tick = e->timeline_end_tick;
            }
        }
    }
}

/* Promote the staged timeline to the active timeline. Used both for
 * synchronous swaps and for scheduled swaps inside the audio callback. */
static void engine_swap_to_staging(engine_t *e) {
    if (!e->staging_ready || !e->staging_timeline || e->staging_timeline_count == 0) return;

    /* Hand the old timeline off to be freed on the next control-thread preload
     * call, rather than freeing it here on the audio thread. */
    if (e->retired_timeline) { free(e->retired_timeline); }
    e->retired_timeline = e->timeline;
    e->timeline = e->staging_timeline;
    e->timeline_count = e->staging_timeline_count;
    e->timeline_end_tick = e->staging_timeline_end_tick;

    e->tempo_bpm = e->staging_tempo_bpm;
    e->time_sig_num = e->staging_time_sig_num;
    e->time_sig_den = e->staging_time_sig_den;
    e->ticks_per_beat = e->staging_ticks_per_beat;
    e->ticks_per_bar = e->staging_ticks_per_bar;
    e->loop = e->staging_loop;

    /* Capture the staged resume position before clearing staging. */
    e->swap_resume_tick = e->staging_resume_tick;

    /* A staged clip was activated via swap; expose it to the UI so same-path
     * restarts (which don't change active_source or bar/wrap counters) can be
     * detected. */
    e->swap_counter++;

    e->staging_timeline = NULL;
    e->staging_timeline_count = 0;
    e->staging_timeline_end_tick = 0;
    e->staging_ready = 0;
    e->staging_resume_tick = 0;

    /* Update the active source path so the UI can follow the new clip. */
    copy_trunc(e->active_source, sizeof(e->active_source), e->staging_source);
    e->staging_source[0] = '\0';

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
    uint32_t bar = e->timeline_end_tick > 0
        ? (e->playhead_tick / e->ticks_per_bar)
        : 0;
    if (bar != e->last_bar) {
        e->bar_counter++;
        e->last_bar = bar;
    }
}

static void advance_playhead(engine_t *e, int frames, int sample_rate) {
    if (!e->running || e->timeline_count == 0) return;

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
        while (e->event_cursor < e->timeline_count &&
               e->timeline[e->event_cursor].tick < e->playhead_tick) {
            e->event_cursor++;
        }
        uint32_t remaining = (target > seek_tick) ? (target - seek_tick) : 0;
        if (e->timeline_end_tick > 0) {
            target = (e->playhead_tick + remaining) % e->timeline_end_tick;
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
        /* Promote the captured pending-swap timeline (the clip this swap was
         * scheduled for, e.g. a fill) into the active timeline. The return
         * groove may have been preloaded into staging after this swap was
         * scheduled, so we must NOT use engine_swap_to_staging (which would
         * promote the return groove instead of the fill). */
        if (e->retired_timeline) { free(e->retired_timeline); }
        e->retired_timeline = e->timeline;
        e->timeline = e->pending_swap_timeline;
        e->timeline_count = e->pending_swap_timeline_count;
        e->timeline_end_tick = e->pending_swap_timeline_end_tick;
        e->tempo_bpm = e->pending_swap_tempo_bpm;
        e->time_sig_num = e->pending_swap_time_sig_num;
        e->time_sig_den = e->pending_swap_time_sig_den;
        e->ticks_per_beat = e->pending_swap_ticks_per_beat;
        e->ticks_per_bar = e->pending_swap_ticks_per_bar;
        e->loop = e->pending_swap_loop;
        uint32_t resume = e->pending_swap_resume_tick;
        e->swap_resume_tick = resume;
        e->swap_counter++;
        copy_trunc(e->active_source, sizeof(e->active_source), e->pending_swap_source);
        e->pending_swap_timeline = NULL;
        e->pending_swap_timeline_count = 0;
        e->pending_swap_timeline_end_tick = 0;
        e->pending_swap_source[0] = '\0';
        e->pending_swap = 0;
        e->pending_swap_tick = 0;
        e->pending_swap_guard_active = 0;
        /* Apply the remaining portion of this audio block to the new clip. */
        uint32_t remaining = (target > swap_tick) ? (target - swap_tick) : 0;
        /* Start the new clip at the requested resume position (0 = start),
         * then continue for the remainder of this audio block. */
        e->playhead_tick = resume;
        e->event_cursor = 0;
        while (e->event_cursor < e->timeline_count &&
               e->timeline[e->event_cursor].tick < e->playhead_tick) {
            e->event_cursor++;
        }
        /* The timeline changed; track the new clip's starting bar. */
        e->last_bar = e->timeline_end_tick > 0
            ? (resume / e->ticks_per_bar)
            : 0;
        if (e->timeline_end_tick > 0) {
            target = (resume + remaining) % e->timeline_end_tick;
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
static const char *const DSP_BUILD_VERSION = "arranger-dsp-2026-09-04e";

static void* arr_create_instance(const char *module_dir, const char *config_json) {
    (void)module_dir;
    (void)config_json;
    engine_t *e = calloc(1, sizeof(engine_t));
    if (!e) return NULL;
    /* Log the build version unconditionally (not gated behind g_dsp_debug) so
     * a fresh module load always records which dsp.so is in memory. */
    {
        char ver[64];
        snprintf(ver, sizeof(ver), "%s", DSP_BUILD_VERSION);
        if (g_host && g_host->log) g_host->log(ver);
    }
    snprintf(e->library_root, sizeof(e->library_root),
             "/data/UserData/UserLibrary/Arranger/MidiLibrary");
    e->guard_fraction = 0.125;
    e->swap_guard_fraction = 0.25; /* 25% of a beat at mid-clip swap boundaries */
    e->output_channel = 9; /* channel 10 for GM drums */
    e->output_target = OUTPUT_TARGET_EXTERNAL;
    e->move_channel = 9;     /* channel 10 for GM drums */
    e->schwung_channel = 9;  /* channel 10 for GM drums */
    e->last_event_channel_override = -1; /* no per-event override by default */
    e->loop = 1;          /* default to looping for performance mode */
    return e;
}

static void arr_destroy_instance(void *instance) {
    engine_t *e = instance;
    if (!e) return;
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
    if (e && e->error_msg[0]) {
        return snprintf(buf, buf_len, "%s", e->error_msg);
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

static void arr_set_param(void *instance, const char *key, const char *val) {
    engine_t *e = instance;
    if (!e || !key || !val) return;

    /* Diagnostic: log routing-related values explicitly so we can see what
     * the DSP actually receives vs what the UI thinks it sent. Uses arr_log
     * so it lands in .dsp_log alongside the other engine diagnostics. */
    if (strcmp(key, "output_target") == 0 || strcmp(key, "emit_directly") == 0 ||
        strcmp(key, "output_channel") == 0 || strcmp(key, "move_channel") == 0 ||
        strcmp(key, "schwung_channel") == 0) {
        arr_log("SET_PARAM key=%s val=%s", key, val);
    } else {
        arr_log("SET_PARAM key=%s val_len=%d", key, (int)strlen(val));
    }

    if (strcmp(key, "library_root") == 0) {
        snprintf(e->library_root, sizeof(e->library_root), "%s", val);
        free_library_cache(e);
        return;
    }
    if (strcmp(key, "scan_library") == 0) {
        /* Explicit request to refresh the cached library/song scans. */
        free_library_cache(e);
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
        load_song_from_json(e, val);
        build_timeline(e);
        return;
    }
    if (strcmp(key, "preload_song_json") == 0) {
        /* Jam-mode: build the next clip's timeline into staging while the
         * current clip keeps playing. Activate it later via "swap". */
        preload_song_from_json(e, val);
        return;
    }
    if (strcmp(key, "swap") == 0) {
        /* Jam-mode: schedule activation of the staged timeline at a musical
         * boundary inside the audio callback. The UI should have already set
         * "loop" as desired. */
        if (!e->staging_ready || !e->staging_timeline || e->staging_timeline_count == 0) {
            dsp_host_log("swap: no staging ready");
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
        /* Capture the staged timeline into a dedicated pending-swap buffer so
         * a subsequent preload (the return groove) does not overwrite the clip
         * this swap is meant to activate. Without this, the return-groove
         * preload replaces the fill in staging, and when the fill's swap fires
         * it promotes the return groove instead — playing a partial bar of the
         * groove while the UI still shows the fill. */
        if (e->pending_swap_timeline) { free(e->pending_swap_timeline); }
        e->pending_swap_timeline = e->staging_timeline;
        e->pending_swap_timeline_count = e->staging_timeline_count;
        e->pending_swap_timeline_end_tick = e->staging_timeline_end_tick;
        e->pending_swap_tempo_bpm = e->staging_tempo_bpm;
        e->pending_swap_time_sig_num = e->staging_time_sig_num;
        e->pending_swap_time_sig_den = e->staging_time_sig_den;
        e->pending_swap_ticks_per_beat = e->staging_ticks_per_beat;
        e->pending_swap_ticks_per_bar = e->staging_ticks_per_bar;
        e->pending_swap_resume_tick = e->staging_resume_tick;
        copy_trunc(e->pending_swap_source, sizeof(e->pending_swap_source), e->staging_source);
        /* Clear staging so the next preload (return groove) can use it. */
        e->staging_timeline = NULL;
        e->staging_timeline_count = 0;
        e->staging_timeline_end_tick = 0;
        e->staging_ready = 0;
        e->staging_resume_tick = 0;
        e->staging_source[0] = '\0';
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

        dsp_host_log("SWAP_SCHEDULED target=%u playhead=%u tpb=%u bars=%u resume=%u",
                     target_tick, e->playhead_tick, e->ticks_per_bar,
                     e->timeline_end_tick / e->ticks_per_bar,
                     e->staging_resume_tick);
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
        /* When a staged timeline is waiting, loop only affects the upcoming
         * clip so the current clip keeps its own loop mode until swapped. */
        if (e->staging_timeline || e->staging_ready) {
            e->staging_loop = (atoi(val) != 0);
        } else {
            e->loop = (atoi(val) != 0);
        }
        return;
    }
    if (strcmp(key, "tempo") == 0) {
        /* Live tempo change: update the playhead rate without rebuilding the
         * timeline. The playhead already advances using e->tempo_bpm, so this
         * takes effect immediately on the next render block. */
        double t = atof(val);
        if (t >= 20.0 && t <= 300.0) {
            e->tempo_bpm = t;
            e->song.tempo_bpm = t;
        }
        return;
    }
    if (strcmp(key, "play") == 0) {
        e->playhead_tick = 0;
        e->event_cursor = 0;
        e->running = 1;
        e->stopped_at_end = 0;
        e->last_playhead_tick = 0;
        e->tick_remainder = 0.0;
        e->last_bar = 0;
        e->flash_end_tick = initial_flash_end_tick(e);
        queue_clear(e);
        dsp_host_log("PLAY tempo=%.1f tpb=%u ts=%d/%d bars=%u",
                     e->tempo_bpm, e->ticks_per_beat,
                     e->time_sig_num, e->time_sig_den,
                     e->timeline_end_tick / e->ticks_per_bar);
        return;
    }
    if (strcmp(key, "play_from_bar") == 0) {
        /* Start playback from a given bar in the already-loaded timeline.
         * Unlike "play", this does NOT rebuild the timeline, so a section
         * jump is near-instant (no synchronous build_timeline delay). */
        int bar = atoi(val);
        if (bar < 0) bar = 0;
        if (e->timeline_count > 0 && e->timeline_end_tick > 0) {
            uint32_t max_bar = e->timeline_end_tick / e->ticks_per_bar;
            if ((uint32_t)bar > max_bar) bar = (int)max_bar;
        }
        e->playhead_tick = (uint32_t)bar * e->ticks_per_bar;
        e->event_cursor = 0;
        while (e->event_cursor < e->timeline_count &&
               e->timeline[e->event_cursor].tick < e->playhead_tick) {
            e->event_cursor++;
        }
        e->running = 1;
        e->stopped_at_end = 0;
        e->last_playhead_tick = 0;
        e->tick_remainder = 0.0;
        e->last_bar = (uint32_t)bar;
        e->flash_end_tick = initial_flash_end_tick(e);
        queue_clear(e);
        dsp_host_log("PLAY_FROM_BAR bar=%d playhead=%u running=1",
                     bar, e->playhead_tick);
        return;
    }
    if (strcmp(key, "stop") == 0) {
        e->running = 0;
        e->flash_end_tick = 0;
        queue_clear(e);
        emit_all_notes_off(e);
        dsp_host_log("STOP");
        return;
    }
    if (strcmp(key, "events_ack") == 0) {
        queue_ack_all(e);
        return;
    }
    if (strcmp(key, "seek_bar") == 0) {
        int bar = atoi(val);
        if (e->timeline_count > 0 && e->timeline_end_tick > 0) {
            uint32_t max_bar = e->timeline_end_tick / e->ticks_per_bar;
            if (max_bar < 1) max_bar = 1;
            if (bar < 0) bar = 0;
            if ((uint32_t)bar > max_bar) bar = (int)max_bar;
        } else {
            bar = 0;
        }
        e->playhead_tick = (uint32_t)bar * e->ticks_per_bar;
        e->event_cursor = 0;
        while (e->event_cursor < e->timeline_count &&
               e->timeline[e->event_cursor].tick < e->playhead_tick) {
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
        if (e->timeline_count > 0 && e->timeline_end_tick > 0) {
            uint32_t max_bar = e->timeline_end_tick / e->ticks_per_bar;
            if (max_bar < 1) max_bar = 1;
            if (bar < 0.0) bar = 0.0;
            /* Clamp the fractional boundary against the timeline's real end in
             * ticks (not a truncated whole-bar count), so a fractional value
             * like 4.9 against a true end of 4.5 bars is clamped to the end
             * rather than passing through and scheduling a seek that never
             * fires. */
            double max_bar_ticks = (double)e->timeline_end_tick;
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
        dsp_host_log("SEEK_SCHEDULED boundary=%u bar=%.3f target=%u playhead=%u",
                     boundary, bar, (uint32_t)target_bar, e->playhead_tick);
        return;
    }
}

static int arr_get_param(void *instance, const char *key, char *buf, int buf_len) {
    engine_t *e = instance;
    if (!e || !key || !buf || buf_len < 1) return -1;

    /* This runs on the CONTROL thread (the UI polls it every tick), so free
     * any timelines retired by a swap on the audio thread here, unconditionally.
     * Relying on the next preload call to drain it is unreliable — in Jam mode
     * a fill auto-returns to its groove with no new preload in between, which
     * would otherwise leave the free() to the RT thread. */
    if (e->retired_timeline) {
        free(e->retired_timeline);
        e->retired_timeline = NULL;
    }

    if (strcmp(key, "timeline_info") == 0) {
        return snprintf(buf, buf_len,
                        "{\"count\":%d,\"end_tick\":%u,\"total_bars\":%u}",
                        e->timeline_count, e->timeline_end_tick,
                        e->timeline_end_tick / e->ticks_per_bar);
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

        return snprintf(buf, buf_len,
                        "{\"running\":%d,\"loop\":%d,\"stopped_at_end\":%d,\"position\":\"%u.%u\",\"active_source\":\"%s\"}",
                        e->running,
                        e->loop,
                        e->stopped_at_end,
                        e->playhead_tick / e->ticks_per_bar + 1,
                        (e->playhead_tick % e->ticks_per_bar) / e->ticks_per_beat + 1,
                        escaped);
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
        return snprintf(buf, buf_len, "%s", e->library_root);
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
         * library_root>"}. Only clips that resolved to a different folder than
         * their effective (per-clip or song) folder are emitted, keeping the
         * payload small. */
        char *p = buf;
        int left = buf_len;
        int w = snprintf(p, left, "[");
        if (w >= 0) { p += w; left -= w; }
        int first = 1;
        for (int s = 0; s < e->song.section_count; s++) {
            section_t *sec = &e->song.sections[s];
            for (int c = 0; c < sec->clip_count; c++) {
                section_clip_t *sc = &sec->clips[c];
                if (!sc->source_path[0]) continue;
                if (sc->clip_index < 0 || sc->clip_index >= e->clip_count) continue;
                const char *full = e->clips[sc->clip_index].path;
                /* Effective folder: per-clip source_folder if set, else song's. */
                const char *eff = sc->source_folder[0] ? sc->source_folder : e->song.source_folder;
                /* Derive the resolved SONG folder (the folder that directly
                 * holds the .mid files) by stripping the source_path from the
                 * end of the resolved full path, then removing the library_root
                 * prefix. This yields the same relative form as source_folder. */
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
                /* Only emit when the resolved folder differs from the stored
                 * effective folder (i.e. the clip moved). */
                if (!folder[0] || strcmp(folder, eff) == 0) continue;
                /* Build {"source":"...","folder":"..."} */
                char obj[1024];
                char *op = obj;
                int oleft = (int)sizeof(obj);
                #define OBJ_APPEND_LIT(s) do { \
                    const char *_s = (s); \
                    while (*_s && oleft > 1) { *op++ = *_s++; oleft--; } \
                } while (0)
                OBJ_APPEND_LIT("{\"source\":\"");
                for (const char *q = sc->source_path; *q && oleft > 1; q++) {
                    if (*q == '"' || *q == '\\' || *q < 0x20 || *q > 0x7e) { *op++ = '\\'; oleft--; }
                    if (oleft <= 1) break;
                    *op++ = *q; oleft--;
                }
                OBJ_APPEND_LIT("\",\"folder\":\"");
                for (const char *q = folder; *q && oleft > 1; q++) {
                    if (*q == '"' || *q == '\\' || *q < 0x20 || *q > 0x7e) { *op++ = '\\'; oleft--; }
                    if (oleft <= 1) break;
                    *op++ = *q; oleft--;
                }
                OBJ_APPEND_LIT("\"}");
                *op = '\0';
                #undef OBJ_APPEND_LIT
                int obj_len = (int)strlen(obj);
                int need_comma = first ? 0 : 1;
                if (need_comma + obj_len + 1 > left) break;
                if (need_comma) { *p++ = ','; left--; }
                memcpy(p, obj, obj_len);
                p += obj_len;
                left -= obj_len;
                first = 0;
            }
        }
        if (left > 0) snprintf(p, left, "]");
        return (int)strlen(buf);
    }
    if (strcmp(key, "error") == 0) {
        return arr_get_error(e, buf, buf_len);
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
