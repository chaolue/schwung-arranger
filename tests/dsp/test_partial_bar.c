/*
 * Regression test: chords follow sections that end mid-bar.
 *
 * Found live: a section whose clip is trimmed to end mid-bar (Advanced Trim,
 * end_beat) made every later section's chords come early -- the chord bars
 * were counted as whole bars from the song start, dropping the partial bar,
 * while the drums played the full trimmed length. Chord bars now count from
 * each section's own start, and Perform's section jumps seek to fractional
 * bars.
 *
 * Build (plain):
 *   gcc -Wall -Wextra -g -pthread tests/dsp/test_partial_bar.c \
 *       src/dsp/arranger_engine.c -Isrc/dsp -ldl -lm -o /tmp/test_partial_bar
 *
 * Usage: test_partial_bar <library_root>  (expects the "Song 13" fixture)
 */

#include "test_common.h"

/* Absolute playhead tick, from the transport JSON. */
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

    void *inst = api->create_instance("/tmp/test_partial_bar", NULL);
    if (!inst || !find_song13_folder(api, inst, argv[1], folder, sizeof folder)) return 1;
    api->set_param(inst, "emit_directly", "1");
    api->set_param(inst, "output_target", "schwung");
    api->set_param(inst, "schwung_channel", "0");
    /* Section A: 1.5 bars (bars 0-2, ending after beat 2), chord C.
     * Section B: 2 bars, chord G. A bar-boundary bass on channel 1:
     * C -> note 48, G -> note 55. B starts at tick 1440 (PPQ 240, 4/4). */
    snprintf(json, sizeof(json),
        "{\"source_folder\":\"%s\",\"name\":\"T\",\"tempo_bpm\":120,"
        "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
        "{\"name\":\"A\",\"clips\":["
        "{\"source\":\"Grooves/120 Verse Half-Time.mid\",\"start_bar\":0,\"end_bar\":2,"
        "\"start_beat\":1,\"end_beat\":2,\"guard_fraction\":0}],"
        "\"chords\":[{\"root\":\"C\",\"quality\":\"maj\",\"bass\":\"\"},"
        "{\"root\":\"C\",\"quality\":\"maj\",\"bass\":\"\"}]},"
        "{\"name\":\"B\",\"clips\":["
        "{\"source\":\"Grooves/120 Verse Half-Time.mid\",\"start_bar\":0,\"end_bar\":2,\"guard_fraction\":0}],"
        "\"chords\":[{\"root\":\"G\",\"quality\":\"maj\",\"bass\":\"\"},"
        "{\"root\":\"G\",\"quality\":\"maj\",\"bass\":\"\"}]}"
        "],\"instruments\":["
        "{\"enabled\":true,\"output\":\"schwung\",\"channel\":2,\"octave\":3,\"follow_note\":0,"
        "\"voicing\":\"bass\",\"note_gap\":0.125}]}", folder);
    uint32_t base = state_u32(api, inst, "primary_published_gen");
    api->set_param(inst, "loop", "0");
    api->set_param(inst, "song_json", json);
    CHECK(wait_field_change(api, inst, "primary_published_gen", base, 3000), "song published");

    /* 1. Played through: B's chord starts with B, and A's chord is released
     * just ahead of it (note_gap), not on the absolute bar grid. */
    g_captured_count = 0;
    api->set_param(inst, "play", "1");
    int on55 = -1, off48 = -1, prev = 0;
    for (int b = 0; b < 2000 && on55 < 0; b++) {
        api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
        if (g_captured_count > prev) {
            int t = transport_tick(api, inst);
            for (int i = prev; i < g_captured_count; i++) {
                if (g_captured[i].channel != 1) continue;
                if (on55 < 0 && g_captured[i].status == 0x90 && g_captured[i].note == 55) on55 = t;
                /* The last C off before G: A's second bar retriggers C. */
                if (on55 < 0 && g_captured[i].status == 0x80 && g_captured[i].note == 48) off48 = t;
            }
            prev = g_captured_count;
        }
    }
    printf("info: G on at tick %d, C off at tick %d (section B starts at 1440)\n", on55, off48);
    CHECK(on55 >= 1440 && on55 < 1450, "B's chord starts with B at 1.5 bars, not at bar 1 (960) or bar 2 (1920)");
    CHECK(off48 >= 1400 && off48 < 1440, "A's chord is released note_gap ahead of B's start");
    stop_and_ring_out(api, inst);

    /* 2. Perform's jump to B: play_from_bar takes the fractional section
     * start and lands on it, with B's chord. */
    g_captured_count = 0;
    api->set_param(inst, "play_from_bar", "1.5");
    int t = transport_tick(api, inst);
    printf("info: play_from_bar 1.5 -> tick %d\n", t);
    CHECK(t >= 1438 && t <= 1442, "play_from_bar 1.5 seeks to tick 1440, not bar 1");
    CHECK(captured_has_note(0x90, 55) && !captured_has_note(0x90, 48), "play_from_bar into B sounds B's chord");
    stop_and_ring_out(api, inst);

    api->destroy_instance(inst);
    if (g_failures == 0) printf("\nALL TESTS PASSED\n");
    else printf("\n%d TEST(S) FAILED\n", g_failures);
    return g_failures == 0 ? 0 : 1;
}
