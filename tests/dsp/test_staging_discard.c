/*
 * Regression test: loading a song discards a song staged to follow the old
 * one.
 *
 * Found live: Perform staged the next song during a count-in and was
 * stopped before the swap; Song Builder then loaded and played its own song,
 * which at its end auto-swapped into that leftover instead of stopping.
 * Staging made AFTER the load (Perform's and Jam's order) must still swap.
 *
 * Build (plain):
 *   gcc -Wall -Wextra -g -pthread tests/dsp/test_staging_discard.c \
 *       src/dsp/arranger_engine.c -Isrc/dsp -ldl -lm -o /tmp/test_staging_discard
 *
 * Usage: test_staging_discard <library_root>  (expects the "Song 13" fixture)
 */

#include "test_common.h"

static char g_folder[128];

static int load(plugin_api_v2_t *api, void *inst, const char *key, int bars) {
    char json[1024];
    snprintf(json, sizeof(json),
        "{\"source_folder\":\"%s\",\"name\":\"T\",\"tempo_bpm\":120,\"time_sig_num\":4,\"time_sig_den\":4,"
        "\"sections\":[{\"name\":\"A\",\"clips\":[{\"source\":\"Grooves/120 Verse Half-Time.mid\","
        "\"start_bar\":0,\"end_bar\":%d,\"guard_fraction\":0}]}]}", g_folder, bars);
    const char *field = strcmp(key, "song_json") == 0 ? "primary_published_gen" : "staging_published_gen";
    uint32_t base = state_u32(api, inst, field);
    api->set_param(inst, key, json);
    return wait_field_change(api, inst, field, base, 3000);
}

static uint32_t swap_count(plugin_api_v2_t *api, void *inst) {
    char t[1024];
    api->get_param(inst, "transport", t, sizeof t);
    unsigned v = 0;
    const char *p = strstr(t, "\"swap_counter\":");
    if (p) sscanf(p, "\"swap_counter\":%u", &v);
    return v;
}

/* Play until the playhead stops (or a swap); returns the swap count seen. */
static int play_out(plugin_api_v2_t *api, void *inst, int blocks) {
    int16_t audio[MOVE_FRAMES_PER_BLOCK * 2];
    uint32_t swaps = swap_count(api, inst);
    api->set_param(inst, "play", "1");
    for (int b = 0; b < blocks; b++) api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
    return (int)(swap_count(api, inst) - swaps);
}

int main(int argc, char **argv) {
    if (argc < 2) { fprintf(stderr, "usage: %s <library_root>\n", argv[0]); return 1; }
    host_api_v1_t host = make_test_host();
    plugin_api_v2_t *api = move_plugin_init_v2(&host);
    void *inst = api->create_instance("/tmp/test_staging_discard", NULL);
    if (!inst || !find_song13_folder(api, inst, argv[1], g_folder, sizeof g_folder)) return 1;
    api->set_param(inst, "emit_directly", "1");
    api->set_param(inst, "loop", "0");

    /* 1. Perform: a count-in, the next song staged behind it -- then stopped
     * before the swap. */
    CHECK(load(api, inst, "song_json", 1), "count-in loaded");
    CHECK(load(api, inst, "preload_song_json", 4), "next song staged");
    api->set_param(inst, "play", "1");
    api->set_param(inst, "stop", "1");

    /* 2. Song Builder loads and plays its own 1-bar song to the end: it
     * stops there, no swap into the leftover. */
    CHECK(load(api, inst, "song_json", 1), "Song Builder's song loaded");
    api->set_param(inst, "loop", "0");
    int swaps = play_out(api, inst, 1500);
    CHECK(swaps == 0, "the old staged song is discarded: no swap at the end");
    char st[4096];
    api->get_param(inst, "state", st, sizeof st);
    CHECK(strstr(st, "\"running\":0") != NULL, "playback stopped at the song's end");

    /* 3. Staging made after a load still swaps in (Perform/Jam order). */
    CHECK(load(api, inst, "song_json", 1), "count-in loaded again");
    CHECK(load(api, inst, "preload_song_json", 4), "next song staged after it");
    api->set_param(inst, "loop", "0");
    swaps = play_out(api, inst, 1000);
    CHECK(swaps == 1, "staged after the load: swapped in at the count-in's end");

    stop_and_ring_out(api, inst);
    api->destroy_instance(inst);
    if (g_failures == 0) printf("\nALL TESTS PASSED\n");
    else printf("\n%d TEST(S) FAILED\n", g_failures);
    return g_failures == 0 ? 0 : 1;
}
