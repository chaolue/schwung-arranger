/*
 * Regression test: after Perform's count-in, the song's first chord plays
 * on its first bar.
 *
 * Found live: with a one-bar count-in, the chords started a bar late (the
 * first bar's chord was silent). The count-in timeline has no instruments,
 * so the chord-change key stayed at "section 0, bar 0" from Play; the song
 * auto-swapped in at its own section 0, bar 0 -- the same key -- so no
 * chord fired until bar 2.
 *
 * Build (plain):
 *   gcc -Wall -Wextra -g -pthread tests/dsp/test_countin_chord.c \
 *       src/dsp/arranger_engine.c -Isrc/dsp -ldl -lm -o /tmp/test_countin_chord
 *
 * Usage: test_countin_chord <library_root>  (expects the "Song 13" fixture)
 */

#include "test_common.h"

int main(int argc, char **argv) {
    if (argc < 2) { fprintf(stderr, "usage: %s <library_root>\n", argv[0]); return 1; }
    host_api_v1_t host = make_test_host();
    plugin_api_v2_t *api = move_plugin_init_v2(&host);
    int16_t audio[MOVE_FRAMES_PER_BLOCK * 2];
    char folder[128], json[2048];

    void *inst = api->create_instance("/tmp/test_countin_chord", NULL);
    if (!inst || !find_song13_folder(api, inst, argv[1], folder, sizeof folder)) return 1;
    api->set_param(inst, "emit_directly", "1");
    api->set_param(inst, "output_target", "schwung");
    api->set_param(inst, "schwung_channel", "0");

    /* 1. The one-bar count-in (silent), as Perform loads it. */
    snprintf(json, sizeof(json),
        "{\"source_folder\":\"%s\",\"name\":\"Click\",\"tempo_bpm\":120,"
        "\"time_sig_num\":4,\"time_sig_den\":4,\"count_in\":1,\"count_in_sound\":0,"
        "\"sections\":[{\"name\":\"Click\",\"clips\":["
        "{\"source\":\"Grooves/120 Verse Half-Time.mid\",\"start_bar\":0,\"end_bar\":1,\"guard_fraction\":0}]}]}",
        folder);
    uint32_t base = state_u32(api, inst, "primary_published_gen");
    api->set_param(inst, "loop", "0");
    api->set_param(inst, "song_json", json);
    CHECK(wait_field_change(api, inst, "primary_published_gen", base, 3000), "count-in published");

    /* 2. The song staged behind it: D on bar 1, G on bar 2, bar chords on
     * wire channel 1 (bass: D 50, G 55). */
    snprintf(json, sizeof(json),
        "{\"source_folder\":\"%s\",\"name\":\"T\",\"tempo_bpm\":120,"
        "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
        "{\"name\":\"A\",\"clips\":[{\"source\":\"Grooves/120 Verse Half-Time.mid\",\"start_bar\":0,\"end_bar\":2,\"guard_fraction\":0}],"
        "\"chords\":[{\"root\":\"D\",\"quality\":\"maj\",\"bass\":\"\"},{\"root\":\"G\",\"quality\":\"maj\",\"bass\":\"\"}]}"
        "],\"instruments\":[{\"enabled\":true,\"output\":\"schwung\",\"channel\":2,\"octave\":3,"
        "\"follow_note\":0,\"voicing\":\"bass\",\"note_gap\":0.125}]}", folder);
    uint32_t sbase = state_u32(api, inst, "staging_published_gen");
    api->set_param(inst, "preload_song_json", json);
    CHECK(wait_field_change(api, inst, "staging_published_gen", sbase, 3000), "song staged");

    /* 3. Play: one bar of count-in (~690 blocks), then the song. */
    g_captured_count = 0;
    api->set_param(inst, "play", "1");
    int d_block = -1, g_block = -1, prev = 0;
    for (int b = 0; b < 2400 && g_block < 0; b++) {
        api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
        for (int i = prev; i < g_captured_count; i++) {
            if (g_captured[i].channel != 1 || g_captured[i].status != 0x90) continue;
            if (g_captured[i].note == 50 && d_block < 0) d_block = b;
            if (g_captured[i].note == 55 && g_block < 0) g_block = b;
        }
        prev = g_captured_count;
    }
    printf("info: D first at block %d, G at block %d (a bar is ~690 blocks)\n", d_block, g_block);
    CHECK(d_block >= 600 && d_block < 760, "the song's first chord (D) plays as the song starts, right after the count-in bar");
    CHECK(g_block > d_block + 600, "G follows a bar later");

    stop_and_ring_out(api, inst);
    api->destroy_instance(inst);
    if (g_failures == 0) printf("\nALL TESTS PASSED\n");
    else printf("\n%d TEST(S) FAILED\n", g_failures);
    return g_failures == 0 ? 0 : 1;
}
