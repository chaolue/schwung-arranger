/*
 * Regression test for per-bar chord inversion (root/1st/2nd/3rd), layered
 * on top of the existing per-bar octave/follow_note/voicing overrides.
 * Three bars, same explicit C major chord (retriggered each bar per the
 * explicit-repeat fix), each bar overriding "inversion" to a different
 * value, with track-default voicing "chord" and octave 3 (base = 48):
 *   bar 0: track default inversion (0, root)      -> 48, 52, 55
 *   bar 1: override inversion 1 (first inversion)  -> 52, 55, 60
 *   bar 2: override inversion 2 (second inversion)  -> 55, 60, 64
 *
 * Build (plain):
 *   gcc -Wall -Wextra -g -pthread tests/dsp/test_chord_inversion.c \
 *       src/dsp/arranger_engine.c -Isrc/dsp -ldl -lm -o /tmp/test_chord_inversion
 *
 * Usage: test_chord_inversion <library_root>
 * Expects the "Song 13" fixture (see test_async_channels.c).
 */

#include "test_common.h"

int main(int argc, char **argv) {
    if (argc < 2) { fprintf(stderr, "usage: %s <library_root>\n", argv[0]); return 1; }
    const char *library_root = argv[1];

    host_api_v1_t host = make_test_host();
    plugin_api_v2_t *api = move_plugin_init_v2(&host);
    void *inst = api->create_instance("/tmp/test_chord_inversion", NULL);
    if (!inst) { fprintf(stderr, "create_instance failed\n"); return 1; }

    char folder_name[128];
    if (!find_song13_folder(api, inst, library_root, folder_name, sizeof(folder_name))) {
        api->destroy_instance(inst);
        return 1;
    }

    const char *song_json_tmpl =
        "{\"source_folder\":\"%s\",\"name\":\"InversionTest\",\"tempo_bpm\":120,"
        "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
        "{\"name\":\"A\",\"clips\":["
        "{\"source\":\"Grooves/120 Intro Half-Time Stick.mid\",\"start_bar\":0,\"end_bar\":1},"
        "{\"source\":\"Grooves/120 Verse Half-Time.mid\",\"start_bar\":1,\"end_bar\":2},"
        "{\"source\":\"Grooves/120 Bridge Half-Time.mid\",\"start_bar\":2,\"end_bar\":3}"
        "],\"chords\":["
        "{\"root\":\"C\",\"quality\":\"maj\",\"bass\":\"\"},"
        "{\"root\":\"C\",\"quality\":\"maj\",\"bass\":\"\"},"
        "{\"root\":\"C\",\"quality\":\"maj\",\"bass\":\"\"}"
        "]}"
        "],\"instruments\":["
        "{\"enabled\":true,\"output\":\"schwung\",\"channel\":1,\"octave\":3,\"follow_note\":0,"
        "\"voicing\":\"chord\",\"inversion\":0,\"note_gap\":0.125,"
        "\"overrides\":["
        "{\"section\":0,\"bar\":1,\"inversion\":1},"
        "{\"section\":0,\"bar\":2,\"inversion\":2}"
        "]}"
        "]}";
    char song_json[4096];
    snprintf(song_json, sizeof(song_json), song_json_tmpl, folder_name);

    uint32_t base_primary = state_u32(api, inst, "primary_published_gen");
    api->set_param(inst, "song_json", song_json);
    CHECK(wait_field_change(api, inst, "primary_published_gen", base_primary, 3000),
          "primary channel published");

    api->set_param(inst, "loop", "0");
    api->set_param(inst, "play", "1");

    /* 3 bars at 120bpm 4/4 = 6s; bounded generously. */
    int16_t audio[MOVE_FRAMES_PER_BLOCK * 2];
    for (int b = 0; b < 5000; b++) {
        api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
    }
    api->set_param(inst, "stop", "1");

    /* Root position (bar 0, track default inversion 0): C E G -> 48 52 55. */
    CHECK(captured_has_note(0x90, 48), "bar 0 (root position): note 48 (C) present");
    CHECK(captured_has_note(0x90, 52), "bar 0 (root position): note 52 (E) present");
    CHECK(captured_has_note(0x90, 55), "bar 0 (root position): note 55 (G) present");

    /* First inversion (bar 1 override): E G C -> 52 55 60 (60 is the
     * distinguishing note -- root moved up an octave). */
    CHECK(captured_has_note(0x90, 60), "bar 1 (1st inversion override): note 60 (C, root moved up an octave) present");

    /* Second inversion (bar 2 override): G C E -> 55 60 64 (64 is the
     * distinguishing note -- 3rd moved up an octave too). */
    CHECK(captured_has_note(0x90, 64), "bar 2 (2nd inversion override): note 64 (E, 3rd moved up an octave) present");

    printf("captured %d events total\n", g_captured_count);

    if (g_failures == 0) {
        printf("\nALL TESTS PASSED\n");
    } else {
        printf("\n%d TEST(S) FAILED\n", g_failures);
    }
    api->destroy_instance(inst);
    return g_failures == 0 ? 0 : 1;
}
