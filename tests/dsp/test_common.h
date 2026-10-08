/*
 * Shared boilerplate for the arranger_engine host-mock test files
 * (test_instrument_overrides.c, test_instrument_bar_bugs.c,
 * test_chord_inversion.c, and the newer test_timeline_assembly.c/
 * test_chord_track.c/test_transport.c/test_json_robustness.c/
 * test_library_scan.c). Factored out so each test file is just its own
 * song JSON + assertions, not another copy of the host stub/capture/
 * folder-scan machinery.
 *
 * Not used by test_async_channels.c, which predates this header and has its
 * own narrower helpers (no MIDI capture) -- left as-is rather than churned
 * for a refactor with no behavior change to verify against.
 *
 * Every test file includes this, then defines main() using:
 *   - CHECK(cond, msg)                         -- assert + tally failures
 *   - g_captured[]/g_captured_count            -- every note-on/off sent via
 *                                                  midi_send_internal/
 *                                                  _external/midi_inject_to_
 *                                                  move (i.e. an instrument
 *                                                  or drum timeline with
 *                                                  output "schwung"/
 *                                                  "external"/"move")
 *   - captured_has_note(status, note)          -- any matching event at all
 *   - captured_has_note_route(status, note, route) -- route-specific variant
 *                                                  (ROUTE_INTERNAL/_MOVE/
 *                                                  _EXTERNAL)
 *   - count_note(status, note)                 -- how many times
 *   - make_test_host()                         -- a filled host_api_v1_t
 *   - state_u32(api, inst, field)              -- read one numeric field out
 *                                                  of get_param("state")
 *   - wait_field_change(api, inst, field, base, timeout_ms)
 *   - active_source(api, inst, buf, len)        -- get_param("state")'s
 *                                                  active_source field
 *   - find_song13_folder(api, folder_name, size) -- library_root scan +
 *                                                    locate the "Song 13"
 *                                                    fixture folder; returns
 *                                                    1 on success
 */
#ifndef TEST_COMMON_H
#define TEST_COMMON_H

#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <unistd.h>
#include "plugin_api_v1.h"

static int g_failures = 0;
#define CHECK(cond, msg) do { \
    if (!(cond)) { fprintf(stderr, "FAIL: %s (%s:%d)\n", msg, __FILE__, __LINE__); g_failures++; } \
    else { printf("ok: %s\n", msg); } \
} while (0)

/* Capture every note-on/off sent via midi_send_internal/midi_send_external/
 * midi_inject_to_move -- covering an instrument or drum timeline configured
 * with "output"/"output_target" of "schwung" (ROUTE_INTERNAL), "external"
 * (ROUTE_EXTERNAL), or "move" (ROUTE_MOVE) respectively (drum events need
 * set_param("emit_directly","1") too -- see test_timeline_assembly.c).
 * `channel` is the low nibble of the status byte's channel/cable word, so a
 * per-clip channel override or a per-instrument channel setting is directly
 * observable. */
#define ROUTE_INTERNAL 0
#define ROUTE_MOVE 1
#define ROUTE_EXTERNAL 2
typedef struct { uint8_t status; uint8_t note; uint8_t vel; uint8_t channel; uint8_t route; } captured_event_t;
#define MAX_CAPTURED 4096
static captured_event_t g_captured[MAX_CAPTURED];
static int g_captured_count = 0;

static void host_log(const char *msg) { (void)msg; }

static int host_capture_midi(const uint8_t *m, int l, uint8_t route) {
    if (l >= 4 && g_captured_count < MAX_CAPTURED) {
        uint8_t high = m[1] & 0xF0;
        if (high == 0x90 || high == 0x80) {
            /* A drum clip's raw SMF data (unlike instrument-track emission,
             * which always uses an explicit 0x80 for note-off) commonly
             * encodes a note-off as running-status "0x90 with velocity 0" --
             * standard MIDI practice, preserved as-is by build_timeline's
             * event copy. Normalize that here so status is always the TRUE
             * note-on/off distinction (0x90+vel>0 vs 0x80-or-0x90+vel==0):
             * every existing/future test's captured_has_note(0x90,...) or
             * count_note(0x90,...) then means "a real note-on", not
             * "either a real note-on or a disguised note-off". */
            uint8_t status = (high == 0x90 && m[3] == 0) ? 0x80 : high;
            g_captured[g_captured_count].status = status;
            g_captured[g_captured_count].channel = m[1] & 0x0F;
            g_captured[g_captured_count].note = m[2];
            g_captured[g_captured_count].vel = m[3];
            g_captured[g_captured_count].route = route;
            g_captured_count++;
        }
    }
    return l;
}
static int host_midi_send_internal(const uint8_t *m, int l) { return host_capture_midi(m, l, ROUTE_INTERNAL); }
static int host_midi_send_external(const uint8_t *m, int l) { return host_capture_midi(m, l, ROUTE_EXTERNAL); }
static int host_midi_inject_to_move(const uint8_t *m, int l) { return host_capture_midi(m, l, ROUTE_MOVE); }
static int host_clock_status(void) { return 0; }
static float host_bpm(void) { return 120.0f; }

extern plugin_api_v2_t *move_plugin_init_v2(const host_api_v1_t *host);

__attribute__((unused))
static host_api_v1_t make_test_host(void) {
    host_api_v1_t host = {
        .api_version = MOVE_PLUGIN_API_VERSION,
        .sample_rate = MOVE_SAMPLE_RATE,
        .frames_per_block = MOVE_FRAMES_PER_BLOCK,
        .log = host_log,
        .midi_send_internal = host_midi_send_internal,
        .midi_send_external = host_midi_send_external,
        .get_clock_status = host_clock_status,
        .get_bpm = host_bpm,
        .midi_inject_to_move = host_midi_inject_to_move,
    };
    return host;
}

/* Read one numeric field out of an arbitrary get_param(param) JSON blob
 * (e.g. "state" or "transport"). */
__attribute__((unused))
static uint32_t param_field_u32(plugin_api_v2_t *api, void *inst, const char *param, const char *field) {
    char buf[4096], needle[128];
    snprintf(needle, sizeof(needle), "\"%s\":", field);
    if (api->get_param(inst, param, buf, sizeof(buf)) <= 0) return 0;
    char *p = strstr(buf, needle);
    return p ? (uint32_t)strtoul(p + strlen(needle), NULL, 10) : 0;
}

__attribute__((unused))
static uint32_t state_u32(plugin_api_v2_t *api, void *inst, const char *field) {
    return param_field_u32(api, inst, "state", field);
}

__attribute__((unused))
static int wait_field_change(plugin_api_v2_t *api, void *inst, const char *field,
                              uint32_t baseline, int timeout_ms) {
    for (int t = 0; t < timeout_ms; t++) {
        if (state_u32(api, inst, field) != baseline) return 1;
        usleep(1000);
    }
    return state_u32(api, inst, field) != baseline;
}

/* Not every test file uses both of these -- __attribute__((unused)) since
 * this header is a shared grab-bag, not a per-file tailored include. */
__attribute__((unused))
static int captured_has_note(uint8_t status, uint8_t note) {
    for (int i = 0; i < g_captured_count; i++) {
        if (g_captured[i].status == status && g_captured[i].note == note) return 1;
    }
    return 0;
}

__attribute__((unused))
static int count_note(uint8_t status, uint8_t note) {
    int n = 0;
    for (int i = 0; i < g_captured_count; i++) {
        if (g_captured[i].status == status && g_captured[i].note == note) n++;
    }
    return n;
}

/* Route-aware variant of captured_has_note -- e.g. captured_has_note_route(
 * 0x90, 48, ROUTE_MOVE) to confirm a note went out via midi_inject_to_move
 * specifically, not just midi_send_internal. */
__attribute__((unused))
static int captured_has_note_route(uint8_t status, uint8_t note, uint8_t route) {
    for (int i = 0; i < g_captured_count; i++) {
        if (g_captured[i].status == status && g_captured[i].note == note && g_captured[i].route == route) return 1;
    }
    return 0;
}

/* get_param("state")'s "active_source" field: the path of the clip
 * currently active in the live timeline. Used to confirm an AUTOSWAP (or a
 * manual swap) actually landed on the expected clip. */
__attribute__((unused))
static const char *active_source(plugin_api_v2_t *api, void *inst, char *buf, int buf_len) {
    char state[4096];
    if (api->get_param(inst, "state", state, sizeof(state)) <= 0) { buf[0] = '\0'; return buf; }
    char *p = strstr(state, "\"active_source\":\"");
    if (!p) { buf[0] = '\0'; return buf; }
    p += strlen("\"active_source\":\"");
    char *end = strchr(p, '"');
    int len = end ? (int)(end - p) : 0;
    if (len >= buf_len) len = buf_len - 1;
    memcpy(buf, p, len);
    buf[len] = '\0';
    return buf;
}

/* Scan library_root, wait for the folder scan to populate, and locate the
 * "Song 13 4-4 120 BPM" fixture folder (Grooves/Fills subfolders, kick hits
 * on note 36 -- see test_async_channels.c's original header comment).
 * Writes the resolved folder name into folder_name (size folder_name_size)
 * and returns 1, or prints an error and returns 0. */
__attribute__((unused))
static int find_song13_folder(plugin_api_v2_t *api, void *inst, const char *library_root,
                               char *folder_name, int folder_name_size) {
    char buf[8192];
    api->set_param(inst, "library_root", library_root);
    int folder_count = 0;
    for (int waited = 0; waited < 3000; waited++) {
        int rc = api->get_param(inst, "folder_count", buf, sizeof(buf));
        folder_count = rc > 0 ? atoi(buf) : 0;
        if (folder_count > 0) break;
        usleep(1000);
    }
    int song13_idx = -1;
    for (int i = 0; i < folder_count; i++) {
        char key[64];
        snprintf(key, sizeof(key), "folder_name_%d", i);
        if (api->get_param(inst, key, buf, sizeof(buf)) > 0 && strstr(buf, "Song 13")) {
            song13_idx = i;
            break;
        }
    }
    if (song13_idx < 0) {
        fprintf(stderr, "No 'Song 13' folder found under %s; cannot run tests.\n", library_root);
        return 0;
    }
    char key[64];
    snprintf(key, sizeof(key), "folder_name_%d", song13_idx);
    int rc = api->get_param(inst, key, buf, sizeof(buf));
    snprintf(folder_name, folder_name_size, "%s", (rc > 0) ? buf : "Song 13 4-4 120 BPM");
    return 1;
}

/* Stop, then render while stopped until instrument notes held after Stop
 * (10 s) are released and the All Notes Off 2 s after that has gone out --
 * so checks see every note-off, and none leaks into the next case. */
__attribute__((unused))
static void stop_and_ring_out(plugin_api_v2_t *api, void *inst) {
    int16_t audio[MOVE_FRAMES_PER_BLOCK * 2];
    api->set_param(inst, "stop", "1");
    for (int b = 0; b < 4200; b++) api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
}

#endif /* TEST_COMMON_H */
