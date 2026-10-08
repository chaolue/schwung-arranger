/*
 * Regression test: a "No Chord" bar is silent and stops the previous chord
 * carrying forward.
 *
 * Asked for: an empty chord bar holds the previous chord, so there was no way
 * to have a silent bar mid-section. {"none":true} marks one.
 *
 * Build (plain):
 *   gcc -Wall -Wextra -g -pthread tests/dsp/test_no_chord.c \
 *       src/dsp/arranger_engine.c -Isrc/dsp -ldl -lm -o /tmp/test_no_chord
 *
 * Usage: test_no_chord <library_root>  (expects the "Song 13" fixture)
 */

#include "test_common.h"

static int transport_tick(plugin_api_v2_t *api, void *inst) {
    char t[1024];
    api->get_param(inst, "transport", t, sizeof(t));
    unsigned bar = 0, beat = 0, tpbeat = 0, tpbar = 0;
    double beat_progress = 0.0;
    sscanf(strstr(t, "\"bar\":"), "\"bar\":%u", &bar);
    sscanf(strstr(t, "\"beat\":"), "\"beat\":%u", &beat);
    sscanf(strstr(t, "\"beat_progress\":"), "\"beat_progress\":%lf", &beat_progress);
    sscanf(strstr(t, "\"ticks_per_beat\":"), "\"ticks_per_beat\":%u", &tpbeat);
    sscanf(strstr(t, "\"ticks_per_bar\":"), "\"ticks_per_bar\":%u", &tpbar);
    return (int)((bar - 1) * tpbar + (beat - 1) * tpbeat + beat_progress * tpbeat);
}

int main(int argc, char **argv) {
    if (argc < 2) { fprintf(stderr, "usage: %s <library_root>\n", argv[0]); return 1; }
    host_api_v1_t host = make_test_host();
    plugin_api_v2_t *api = move_plugin_init_v2(&host);
    int16_t audio[MOVE_FRAMES_PER_BLOCK * 2];
    char folder[128], json[2048];

    void *inst = api->create_instance("/tmp/test_no_chord", NULL);
    if (!inst || !find_song13_folder(api, inst, argv[1], folder, sizeof folder)) return 1;
    api->set_param(inst, "emit_directly", "1");
    api->set_param(inst, "output_target", "schwung");
    api->set_param(inst, "schwung_channel", "0");
    /* Bars: D, No Chord, (empty: carries the No Chord), G. A bar-boundary
     * bass on wire channel 1: D -> 50, G -> 55. Bars are 960 ticks. */
    snprintf(json, sizeof(json),
        "{\"source_folder\":\"%s\",\"name\":\"T\",\"tempo_bpm\":120,"
        "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
        "{\"name\":\"A\",\"clips\":[{\"source\":\"Grooves/120 Verse Half-Time.mid\",\"start_bar\":0,\"end_bar\":4,\"guard_fraction\":0}],"
        "\"chords\":[{\"root\":\"D\",\"quality\":\"maj\",\"bass\":\"\"},{\"none\":true},null,"
        "{\"root\":\"G\",\"quality\":\"maj\",\"bass\":\"\"}]}"
        "],\"instruments\":["
        "{\"enabled\":true,\"output\":\"schwung\",\"channel\":2,\"octave\":3,\"follow_note\":0,"
        "\"voicing\":\"bass\",\"note_gap\":0.125}]}", folder);
    uint32_t base = state_u32(api, inst, "primary_published_gen");
    api->set_param(inst, "loop", "0");
    api->set_param(inst, "song_json", json);
    CHECK(wait_field_change(api, inst, "primary_published_gen", base, 3000), "song published");

    g_captured_count = 0;
    api->set_param(inst, "play", "1");
    int off50 = -1, on55 = -1, other_on = 0, prev = 0;
    for (int b = 0; b < 2400 && on55 < 0; b++) {
        api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
        if (g_captured_count > prev) {
            int t = transport_tick(api, inst);
            for (int i = prev; i < g_captured_count; i++) {
                if (g_captured[i].channel != 1) continue;
                if (g_captured[i].status == 0x80 && g_captured[i].note == 50 && off50 < 0) off50 = t;
                if (g_captured[i].status == 0x90) {
                    if (g_captured[i].note == 55) on55 = t;
                    else if (t >= 960) other_on++;
                }
            }
            prev = g_captured_count;
        }
    }
    printf("info: D off at %d, G on at %d, other note-ons in bars 2-3: %d\n", off50, on55, other_on);
    CHECK(off50 >= 900 && off50 < 960, "D is released before the No Chord bar (note_gap ahead of bar 2)");
    CHECK(other_on == 0, "No Chord bar and the empty bar after it are silent (D does not carry on)");
    CHECK(on55 >= 2880 && on55 < 2890, "the chord after them (G, bar 4) plays on time");
    stop_and_ring_out(api, inst);

    api->destroy_instance(inst);
    if (g_failures == 0) printf("\nALL TESTS PASSED\n");
    else printf("\n%d TEST(S) FAILED\n", g_failures);
    return g_failures == 0 ? 0 : 1;
}
