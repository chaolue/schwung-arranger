/*
 * Instrument velocity: a track's own (default 100 when it sets none), and an
 * item changing it from a bar and beat -- which re-strikes a chord already
 * held there at the new velocity, or a per-beat accent on a held chord would
 * never be heard.
 *
 * Usage: test_inst_velocity <library_root>  (expects the "Song 13" fixture)
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

/* Velocity of the first matching note-on at or after `from`, or -1. */
static int vel_at(int n, int ch, int note, int from, int *tick) {
    for (int i = 0; i < n; i++)
        if (g_captured[i].channel == ch && g_captured[i].status == 0x90 && g_captured[i].note == note &&
            ev_tick[i] >= from) { if (tick) *tick = ev_tick[i]; return g_captured[i].vel; }
    return -1;
}

int main(int argc, char **argv) {
    if (argc < 2) { fprintf(stderr, "usage: %s <library_root>\n", argv[0]); return 1; }
    host_api_v1_t host = make_test_host();
    plugin_api_v2_t *api = move_plugin_init_v2(&host);
    int16_t audio[MOVE_FRAMES_PER_BLOCK * 2];
    char folder[128], json[4096];

    void *inst = api->create_instance("/tmp/test_inst_velocity", NULL);
    if (!inst || !find_song13_folder(api, inst, argv[1], folder, sizeof folder)) return 1;
    api->set_param(inst, "emit_directly", "1");
    api->set_param(inst, "output_target", "schwung");
    api->set_param(inst, "schwung_channel", "0");
    api->set_param(inst, "swap_guard_fraction", "0");
    /* One section, 4 bars of D. Inst 1 (bar chords, channel 2, D3 = 50):
     * velocity 80; bar 2: 120; bar 3 beat 3: 60 (velocity only, mid-chord);
     * bar 4: back to the track's 80. Inst 2 (channel 3) sets no velocity. */
    snprintf(json, sizeof(json),
        "{\"source_folder\":\"%s\",\"name\":\"T\",\"tempo_bpm\":120,"
        "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
        "{\"name\":\"A\",\"clips\":[{\"source\":\"Grooves/120 Verse Half-Time.mid\",\"start_bar\":0,\"end_bar\":4,\"guard_fraction\":0}],"
        "\"chords\":[{\"root\":\"D\",\"quality\":\"maj\",\"bass\":\"\"}]}"
        "],\"instruments\":["
        "{\"enabled\":true,\"output\":\"schwung\",\"channel\":2,\"octave\":3,\"follow_note\":0,"
        "\"voicing\":\"bass\",\"note_gap\":0.125,\"velocity\":80,\"items\":["
        "{\"section\":0,\"bar\":1,\"beat\":1,\"velocity\":120},"
        "{\"section\":0,\"bar\":2,\"beat\":3,\"velocity\":60},"
        "{\"section\":0,\"bar\":3,\"beat\":1}]},"
        "{\"enabled\":true,\"output\":\"schwung\",\"channel\":3,\"octave\":2,\"follow_note\":0,"
        "\"voicing\":\"bass\",\"note_gap\":0.125}"
        "]}", folder);
    uint32_t base = state_u32(api, inst, "primary_published_gen");
    api->set_param(inst, "loop", "0");
    api->set_param(inst, "song_json", json);
    CHECK(wait_field_change(api, inst, "primary_published_gen", base, 3000), "song published");

    g_captured_count = 0;
    api->set_param(inst, "play", "1");
    int prev = 0;
    for (int b = 0; b < 3000; b++) {
        api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
        if (g_captured_count > prev) {
            int t = transport_tick(api, inst);
            for (int i = prev; i < g_captured_count && i < MAXEV; i++) ev_tick[i] = t;
            prev = g_captured_count;
        }
    }
    int n = g_captured_count < MAXEV ? g_captured_count : MAXEV;
    int t1 = -1, t2 = -1, t3 = -1, t4 = -1;
    int v1 = vel_at(n, 1, 50, 0, &t1), v2 = vel_at(n, 1, 50, 900, &t2);
    int v3 = vel_at(n, 1, 50, 2300, &t3), v4 = vel_at(n, 1, 50, 2800, &t4);
    int vdef = vel_at(n, 2, 38, 0, NULL);
    printf("info: bar 1 vel %d @%d, bar 2 vel %d @%d, bar 3.3 vel %d @%d, bar 4 vel %d @%d, no-velocity track %d\n",
           v1, t1, v2, t2, v3, t3, v4, t4, vdef);
    CHECK(v1 == 80, "bar 1: the track's velocity (80)");
    CHECK(v2 == 120 && t2 >= 960 && t2 < 970, "bar 2 item: 120, the held chord re-struck at the bar");
    CHECK(v3 == 60 && t3 >= 2400 && t3 < 2410, "bar 3 beat 3 item (velocity only): re-struck mid-bar at 60");
    CHECK(v4 == 80 && t4 >= 2880 && t4 < 2890, "bar 4 empty item: back to the track's 80");
    CHECK(vdef == 100, "a track that sets no velocity plays at 100, as before");

    stop_and_ring_out(api, inst);
    api->destroy_instance(inst);
    if (g_failures == 0) printf("\nALL TESTS PASSED\n");
    else printf("\n%d TEST(S) FAILED\n", g_failures);
    return g_failures == 0 ? 0 : 1;
}
