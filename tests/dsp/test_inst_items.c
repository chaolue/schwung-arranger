/*
 * Regression test: instrument "items" -- settings changes from a
 * section/bar/beat, holding until the section's next item, each section
 * starting on the track defaults.
 *
 * Asked for: Song Builder's Inst tracks edit a list of items like the Drum
 * track's clips, rather than per-bar mutes/overrides.
 *
 * Build (plain):
 *   gcc -Wall -Wextra -g -pthread tests/dsp/test_inst_items.c \
 *       src/dsp/arranger_engine.c -Isrc/dsp -ldl -lm -o /tmp/test_inst_items
 *
 * Usage: test_inst_items <library_root>  (expects the "Song 13" fixture)
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

#define MAXEV 4096
static int ev_tick[MAXEV];

/* First tick of a matching event at or after `from`, or -1. */
static int first(int n, int ch, int status, int note, int from) {
    for (int i = 0; i < n; i++)
        if (g_captured[i].channel == ch && g_captured[i].status == status &&
            (note < 0 || g_captured[i].note == note) && ev_tick[i] >= from) return ev_tick[i];
    return -1;
}

int main(int argc, char **argv) {
    if (argc < 2) { fprintf(stderr, "usage: %s <library_root>\n", argv[0]); return 1; }
    host_api_v1_t host = make_test_host();
    plugin_api_v2_t *api = move_plugin_init_v2(&host);
    int16_t audio[MOVE_FRAMES_PER_BLOCK * 2];
    char folder[128], json[4096];

    void *inst = api->create_instance("/tmp/test_inst_items", NULL);
    if (!inst || !find_song13_folder(api, inst, argv[1], folder, sizeof folder)) return 1;
    api->set_param(inst, "emit_directly", "1");
    api->set_param(inst, "output_target", "schwung");
    api->set_param(inst, "schwung_channel", "0");
    api->set_param(inst, "swap_guard_fraction", "0");
    /* Section A: 4 bars of D. Section B: 2 bars of G.
     * Inst 1 (bar chords, wire channel 1, octave 3: D 50, G 55):
     *   A bar 2: octave 4 (D 62); A bar 3 beat 3: mute; A bar 4: defaults.
     * Inst 2 (follows the kick, wire channel 2): muted from A bar 3. */
    snprintf(json, sizeof(json),
        "{\"source_folder\":\"%s\",\"name\":\"T\",\"tempo_bpm\":120,"
        "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
        "{\"name\":\"A\",\"clips\":[{\"source\":\"Grooves/120 Verse Half-Time.mid\",\"start_bar\":0,\"end_bar\":4,\"guard_fraction\":0}],"
        "\"chords\":[{\"root\":\"D\",\"quality\":\"maj\",\"bass\":\"\"}]},"
        "{\"name\":\"B\",\"clips\":[{\"source\":\"Grooves/120 Verse Half-Time.mid\",\"start_bar\":0,\"end_bar\":2,\"guard_fraction\":0}],"
        "\"chords\":[{\"root\":\"G\",\"quality\":\"maj\",\"bass\":\"\"}]}"
        "],\"instruments\":["
        "{\"enabled\":true,\"output\":\"schwung\",\"channel\":2,\"octave\":3,\"follow_note\":0,"
        "\"voicing\":\"bass\",\"note_gap\":0.125,\"items\":["
        "{\"section\":0,\"bar\":1,\"beat\":1,\"octave\":4},"
        "{\"section\":0,\"bar\":2,\"beat\":3,\"mute\":true},"
        "{\"section\":0,\"bar\":3,\"beat\":1}]},"
        "{\"enabled\":true,\"output\":\"schwung\",\"channel\":3,\"octave\":2,\"follow_note\":36,"
        "\"voicing\":\"bass\",\"note_gap\":0.125,\"items\":["
        "{\"section\":0,\"bar\":2,\"beat\":1,\"mute\":true}]}"
        "]}", folder);
    uint32_t base = state_u32(api, inst, "primary_published_gen");
    api->set_param(inst, "loop", "0");
    api->set_param(inst, "song_json", json);
    CHECK(wait_field_change(api, inst, "primary_published_gen", base, 3000), "song published");

    g_captured_count = 0;
    api->set_param(inst, "play", "1");
    int prev = 0;
    for (int b = 0; b < 4300; b++) {
        api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
        if (g_captured_count > prev) {
            int t = transport_tick(api, inst);
            for (int i = prev; i < g_captured_count && i < MAXEV; i++) ev_tick[i] = t;
            prev = g_captured_count;
        }
    }
    int n = g_captured_count < MAXEV ? g_captured_count : MAXEV;

    int on50 = first(n, 1, 0x90, 50, 0), on62 = first(n, 1, 0x90, 62, 0), off62 = first(n, 1, 0x80, 62, 0);
    int back50 = first(n, 1, 0x90, 50, 960), on55 = first(n, 1, 0x90, 55, 0);
    int any_in_mute = 0;
    for (int i = 0; i < n; i++)
        if (g_captured[i].channel == 1 && g_captured[i].status == 0x90 && ev_tick[i] > 2400 && ev_tick[i] < 2880) any_in_mute++;
    printf("info: D3 on %d, D4 on %d off %d, D3 again %d, G on %d, notes while muted %d\n",
           on50, on62, off62, back50, on55, any_in_mute);
    CHECK(on50 >= 0 && on50 < 10, "bar 1: the track defaults (octave 3)");
    CHECK(on62 >= 960 && on62 < 970, "bar 2 item: octave 4, re-voiced at the bar");
    CHECK(off62 >= 2400 && off62 < 2410, "bar 3 beat 3 item: muted there, mid-bar");
    CHECK(any_in_mute == 0, "nothing while muted");
    CHECK(back50 >= 2880 && back50 < 2890, "bar 4 empty item: back to the defaults, sounding again");
    CHECK(on55 >= 3840 && on55 < 3850, "section B starts on the defaults (octave 3), nothing carried over");

    /* Inst 2: kicks in A bars 1-2 and B play; none in A bars 3-4. */
    int f_a = 0, f_muted = 0, f_b = 0;
    for (int i = 0; i < n; i++) {
        if (g_captured[i].channel != 2 || g_captured[i].status != 0x90) continue;
        if (ev_tick[i] < 1920) f_a++;
        else if (ev_tick[i] < 3840) f_muted++;
        else f_b++;
    }
    printf("info: follow notes A bars 1-2 %d, muted span %d, section B %d\n", f_a, f_muted, f_b);
    CHECK(f_a > 0 && f_b > 0, "the kick-following bass plays before the mute and in section B");
    CHECK(f_muted == 0, "a mute item silences the kick-following bass until the section ends");

    stop_and_ring_out(api, inst);
    api->destroy_instance(inst);
    if (g_failures == 0) printf("\nALL TESTS PASSED\n");
    else printf("\n%d TEST(S) FAILED\n", g_failures);
    return g_failures == 0 ? 0 : 1;
}
