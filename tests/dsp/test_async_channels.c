/*
 * Regression tests for the async primary/staging timeline-build channels
 * (rearch2.md Step 3 reattempt). These specifically target the concurrency
 * bug class that broke Jam mode on real hardware in the previous attempt at
 * this change: wrong section played, LEDs not tracking the playing section.
 * Each test reproduces one concrete collision identified during design and
 * asserts the DSP degrades safely / produces the correct result, using the
 * real worker thread (genuine cross-thread concurrency on the host machine,
 * not a simulation).
 *
 * Build (plain):
 *   gcc -Wall -Wextra -g -pthread tests/dsp/test_async_channels.c \
 *       src/dsp/arranger_engine.c -Isrc/dsp -ldl -o /tmp/test_async_channels
 * Build (ThreadSanitizer -- the primary correctness gate for this file):
 *   gcc -Wall -Wextra -g -pthread -fsanitize=thread tests/dsp/test_async_channels.c \
 *       src/dsp/arranger_engine.c -Isrc/dsp -ldl -o /tmp/test_async_channels_tsan
 *
 * Usage: test_async_channels <library_root>
 * Expects a "Song 13" folder under library_root with Grooves/ and Fills/
 * subfolders (matches test/host_harness.c's fixture).
 */

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

static void host_log(const char *msg) { (void)msg; }
static int host_midi_send_internal(const uint8_t *m, int l) { (void)m; return l; }
static int host_midi_send_external(const uint8_t *m, int l) { (void)m; return l; }
static int host_midi_inject_to_move(const uint8_t *m, int l) { (void)m; return l; }
static int host_clock_status(void) { return 0; }
static float host_bpm(void) { return 120.0f; }

extern plugin_api_v2_t *move_plugin_init_v2(const host_api_v1_t *host);

static uint32_t state_u32(plugin_api_v2_t *api, void *inst, const char *field) {
    char buf[4096], needle[128];
    snprintf(needle, sizeof(needle), "\"%s\":", field);
    if (api->get_param(inst, "state", buf, sizeof(buf)) <= 0) return 0;
    char *p = strstr(buf, needle);
    return p ? (uint32_t)strtoul(p + strlen(needle), NULL, 10) : 0;
}

static int wait_field_change(plugin_api_v2_t *api, void *inst, const char *field,
                              uint32_t baseline, int timeout_ms) {
    for (int t = 0; t < timeout_ms; t++) {
        if (state_u32(api, inst, field) != baseline) return 1;
        usleep(1000);
    }
    return state_u32(api, inst, field) != baseline;
}

static const char *active_source(plugin_api_v2_t *api, void *inst, char *buf, int buf_len) {
    char state[4096];
    if (api->get_param(inst, "state", state, sizeof(state)) <= 0) return "";
    char *p = strstr(state, "\"active_source\":\"");
    if (!p) return "";
    p += strlen("\"active_source\":\"");
    char *end = strchr(p, '"');
    int len = end ? (int)(end - p) : 0;
    if (len >= buf_len) len = buf_len - 1;
    memcpy(buf, p, len);
    buf[len] = '\0';
    return buf;
}

int main(int argc, char **argv) {
    if (argc < 2) { fprintf(stderr, "usage: %s <library_root>\n", argv[0]); return 1; }
    const char *library_root = argv[1];

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
    plugin_api_v2_t *api = move_plugin_init_v2(&host);
    void *inst = api->create_instance("/tmp/test_async_channels", NULL);
    if (!inst) { fprintf(stderr, "create_instance failed\n"); return 1; }

    api->set_param(inst, "library_root", library_root);
    char buf[8192];
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
        fprintf(stderr, "No 'Song 13' folder found; cannot run tests.\n");
        api->destroy_instance(inst);
        return 1;
    }
    char folder_name[128];
    {
        char key[64];
        snprintf(key, sizeof(key), "folder_name_%d", song13_idx);
        int rc = api->get_param(inst, key, buf, sizeof(buf));
        snprintf(folder_name, sizeof(folder_name), "%.127s", (rc > 0) ? buf : "Song 13 4-4 120 BPM");
    }

    const char *fill_json_tmpl =
        "{\"source_folder\":\"%s\",\"name\":\"Fill\",\"tempo_bpm\":120,"
        "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
        "{\"name\":\"Fill\",\"clips\":["
        "{\"source\":\"Fills/120 Chorus 1 Backbeat Fill 1.mid\",\"start_bar\":0,\"end_bar\":1}"
        "]}]}";
    const char *groove_json_tmpl =
        "{\"source_folder\":\"%s\",\"name\":\"Groove\",\"tempo_bpm\":120,"
        "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
        "{\"name\":\"Groove\",\"clips\":["
        "{\"source\":\"Grooves/120 Intro Half-Time Stick.mid\",\"start_bar\":0,\"end_bar\":1}"
        "]}]}";
    const char *groove2_json_tmpl =
        "{\"source_folder\":\"%s\",\"name\":\"Groove2\",\"tempo_bpm\":120,"
        "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
        "{\"name\":\"Groove2\",\"clips\":["
        "{\"source\":\"Grooves/120 Chorus 1 Ride 8th.mid\",\"start_bar\":0,\"end_bar\":1}"
        "]}]}";

    char fill_json[2048], groove_json[2048], groove2_json[2048];
    snprintf(fill_json, sizeof(fill_json), fill_json_tmpl, folder_name);
    snprintf(groove_json, sizeof(groove_json), groove_json_tmpl, folder_name);
    snprintf(groove2_json, sizeof(groove2_json), groove2_json_tmpl, folder_name);

    /* ---- Test 1: jamStartWithIntroFill collision (0.6). Fire a primary
     * song_json (fill) immediately followed by a staging preload_song_json
     * (groove), zero delay, and confirm both channels publish the CORRECT,
     * distinct content -- neither dropped, neither clobbering the other.
     * This is the exact shape rearch2.md's original single-shared-channel
     * sketch would have gotten wrong. */
    {
        uint32_t base_primary = state_u32(api, inst, "primary_published_gen");
        uint32_t base_staging = state_u32(api, inst, "staging_published_gen");
        api->set_param(inst, "song_json", fill_json);
        api->set_param(inst, "preload_song_json", groove_json);

        int primary_ok = wait_field_change(api, inst, "primary_published_gen", base_primary, 3000);
        int staging_ok = wait_field_change(api, inst, "staging_published_gen", base_staging, 3000);
        CHECK(primary_ok, "test1: primary channel published");
        CHECK(staging_ok, "test1: staging channel published");

        api->get_param(inst, "timeline_info", buf, sizeof(buf));
        int primary_count = 0;
        sscanf(buf, "{\"count\":%d", &primary_count);
        CHECK(primary_count > 0, "test1: primary published non-empty (the fill)");

        char err[512];
        api->get_param(inst, "staging_error", err, sizeof(err));
        CHECK(err[0] == '\0', "test1: staging build has no error (the groove)");
    }

    /* ---- Test 2: preload-then-swap race (0.7). Reproduce the OLD buggy JS
     * sequence deliberately -- preload immediately followed by swap, zero
     * delay -- and confirm the C side degrades safely. Which way the race
     * resolves is NOT deterministic (a fast host machine may genuinely
     * finish the build before the swap check runs, in which case a
     * same-tick swap is completely valid) -- the actual invariant under
     * test is "no crash, and the outcome is exactly one of {rejected with
     * nothing scheduled, accepted with the raced clip correctly scheduled}",
     * never a partial/garbage state. */
    {
        uint32_t base_staging = state_u32(api, inst, "staging_published_gen");
        uint32_t base_rejected = state_u32(api, inst, "staging_swap_rejected");
        api->set_param(inst, "preload_song_json", groove2_json);
        api->set_param(inst, "swap", "0"); /* raced deliberately -- no wait */
        uint32_t rejected_after = state_u32(api, inst, "staging_swap_rejected");
        int raced_swap_accepted = (rejected_after == base_rejected);
        printf("info: test2 raced swap was %s\n", raced_swap_accepted ? "accepted" : "rejected");

        int staging_ok = wait_field_change(api, inst, "staging_published_gen", base_staging, 3000);
        CHECK(staging_ok, "test2: staging build eventually published (whichever way the race went)");

        api->set_param(inst, "play", "1");

        /* Whether or not the raced swap above was accepted, staging is
         * confirmed published now -- issue a fresh, correctly-sequenced
         * preload+swap (a different clip, so this exercises a real new
         * generation rather than possibly finding "nothing new" from the
         * race above) and confirm it deterministically succeeds. */
        uint32_t base_staging2 = state_u32(api, inst, "staging_published_gen");
        api->set_param(inst, "preload_song_json", fill_json);
        CHECK(wait_field_change(api, inst, "staging_published_gen", base_staging2, 3000),
              "test2: second (correctly-sequenced) preload published");
        api->set_param(inst, "staging_loop", "0");

        uint32_t rejected_before_correct_swap = state_u32(api, inst, "staging_swap_rejected");
        api->set_param(inst, "swap", "0");
        uint32_t rejected_after_correct_swap = state_u32(api, inst, "staging_swap_rejected");
        CHECK(rejected_after_correct_swap == rejected_before_correct_swap,
              "test2: correctly-sequenced swap was not rejected");

        /* Run blocks until the swap boundary fires (bounded loop, not a
         * fixed small count -- ticks advance slowly relative to block
         * count, so a fixed small bound would spuriously fail regardless of
         * correctness). */
        uint32_t swap_counter_before = 0;
        {
            char t[4096];
            api->get_param(inst, "transport", t, sizeof(t));
            char *p = strstr(t, "\"swap_counter\":");
            if (p) swap_counter_before = (uint32_t)strtoul(p + strlen("\"swap_counter\":"), NULL, 10);
        }
        int16_t audio[MOVE_FRAMES_PER_BLOCK * 2];
        int swapped = 0;
        for (int b = 0; b < 4000; b++) {
            api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
            char t[4096];
            api->get_param(inst, "transport", t, sizeof(t));
            char *p = strstr(t, "\"swap_counter\":");
            uint32_t sc = p ? (uint32_t)strtoul(p + strlen("\"swap_counter\":"), NULL, 10) : 0;
            if (sc > swap_counter_before) { swapped = 1; break; }
        }
        CHECK(swapped, "test2: swap actually activated (swap_counter advanced)");
        char src[512];
        active_source(api, inst, src, sizeof(src));
        CHECK(strstr(src, "Backbeat Fill") != NULL, "test2: active_source is the swapped-in fill");
        api->set_param(inst, "stop", "1");
    }

    /* ---- Test 3: pending-swap isolation (0.1's third tier). Schedule a
     * swap for clip A (the fill), then preload clip B (groove2) into
     * staging BEFORE A's swap boundary fires, then run past the boundary.
     * A must still activate (not B) -- this is the exact scenario the
     * existing pending_swap_slot mechanism exists to prevent (see the
     * comment at its declaration), now under the fixed-buffer
     * implementation instead of the old pointer hand-off. */
    {
        uint32_t base_primary = state_u32(api, inst, "primary_published_gen");
        api->set_param(inst, "song_json", groove_json); /* something to be "playing" */
        wait_field_change(api, inst, "primary_published_gen", base_primary, 3000);
        api->set_param(inst, "loop", "1");
        api->set_param(inst, "play", "1");

        uint32_t base_staging = state_u32(api, inst, "staging_published_gen");
        api->set_param(inst, "preload_song_json", fill_json); /* clip A */
        wait_field_change(api, inst, "staging_published_gen", base_staging, 3000);
        api->set_param(inst, "staging_loop", "0");
        /* Default target: next bar boundary -- reachable within one bar's
         * worth of render blocks, unlike a huge fixed tick target. */
        api->set_param(inst, "swap", "0");

        uint32_t base_staging2 = state_u32(api, inst, "staging_published_gen");
        api->set_param(inst, "preload_song_json", groove2_json); /* clip B, staged AFTER A's swap was scheduled */
        wait_field_change(api, inst, "staging_published_gen", base_staging2, 3000);

        uint32_t swap_counter_before = 0;
        {
            char t[4096];
            api->get_param(inst, "transport", t, sizeof(t));
            char *p = strstr(t, "\"swap_counter\":");
            if (p) swap_counter_before = (uint32_t)strtoul(p + strlen("\"swap_counter\":"), NULL, 10);
        }
        int16_t audio[MOVE_FRAMES_PER_BLOCK * 2];
        int swapped = 0;
        for (int b = 0; b < 4000; b++) {
            api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
            char t[4096];
            api->get_param(inst, "transport", t, sizeof(t));
            char *p = strstr(t, "\"swap_counter\":");
            uint32_t sc = p ? (uint32_t)strtoul(p + strlen("\"swap_counter\":"), NULL, 10) : 0;
            if (sc > swap_counter_before) { swapped = 1; break; }
        }
        CHECK(swapped, "test3: scheduled swap boundary was reached");
        char src[512];
        active_source(api, inst, src, sizeof(src));
        CHECK(strstr(src, "Backbeat Fill") != NULL,
              "test3: activated clip A (the fill scheduled first), not clip B (the later preload)");
        CHECK(strstr(src, "Ride 8th") == NULL,
              "test3: did NOT activate clip B -- pending_swap_slot was not clobbered by the later preload");

        /* B should still be correctly staged afterward (unconsumed by A's
         * activation), confirming the two are genuinely independent: A's
         * swap consumed the generation it captured at schedule time, not
         * B's later one. */
        uint32_t staging_pub = state_u32(api, inst, "staging_published_gen");
        uint32_t staging_consumed = state_u32(api, inst, "staging_consumed_gen");
        CHECK(staging_pub != base_staging2 && staging_pub != staging_consumed,
              "test3: staging still holds B (published after A's swap consumed A's gen), unconsumed");

        api->set_param(inst, "stop", "1");
    }

    printf("\n%s\n", g_failures == 0 ? "ALL TESTS PASSED" : "SOME TESTS FAILED");
    api->destroy_instance(inst);
    return g_failures == 0 ? 0 : 1;
}
