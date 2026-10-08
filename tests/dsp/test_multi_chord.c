/*
 * Regression test: several chords in a bar, each on its own beat.
 *
 * Asked for: a bar can hold more than one chord, and a chord can start on a
 * chosen beat (half-beats in Advanced). The UI sends a bar as a chord object
 * or an array of them, each with an optional "beat" (1-based; 2.5 = the
 * "and" of beat 2).
 *
 * Build (plain):
 *   gcc -Wall -Wextra -g -pthread tests/dsp/test_multi_chord.c \
 *       src/dsp/arranger_engine.c -Isrc/dsp -ldl -lm -o /tmp/test_multi_chord
 *
 * Usage: test_multi_chord <library_root>  (expects the "Song 13" fixture)
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

/* Captured note events with the tick each was seen at. */
#define MAXEV 4096
static int ev_tick[MAXEV];

/* Pitch class expected to sound at a tick (-1 = silence): D [0,480),
 * G [480,1320), A [1320,1920), E [1920,2400), then nothing. */
static int expected_pc(int t) {
    if (t < 480) return 2;
    if (t < 1320) return 7;
    if (t < 1920) return 9;
    if (t < 2400) return 4;
    return -1;
}

int main(int argc, char **argv) {
    if (argc < 2) { fprintf(stderr, "usage: %s <library_root>\n", argv[0]); return 1; }
    host_api_v1_t host = make_test_host();
    plugin_api_v2_t *api = move_plugin_init_v2(&host);
    int16_t audio[MOVE_FRAMES_PER_BLOCK * 2];
    char folder[128], json[4096];

    void *inst = api->create_instance("/tmp/test_multi_chord", NULL);
    if (!inst || !find_song13_folder(api, inst, argv[1], folder, sizeof folder)) return 1;
    api->set_param(inst, "emit_directly", "1");
    api->set_param(inst, "output_target", "schwung");
    api->set_param(inst, "schwung_channel", "0");
    api->set_param(inst, "swap_guard_fraction", "0");
    /* Bar 1: D (beat 1), G (beat 3). Bar 2: A on beat 2.5 (G holds until
     * then). Bar 3: E, then No Chord on beat 3. Bar 4: empty (silent).
     * Inst 1: a bar-chord bass on wire channel 1 (octave 3: D 50, G 55,
     * A 57, E 52). Inst 2: a bass following the kick on wire channel 2. */
    snprintf(json, sizeof(json),
        "{\"source_folder\":\"%s\",\"name\":\"T\",\"tempo_bpm\":120,"
        "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
        "{\"name\":\"A\",\"clips\":[{\"source\":\"Grooves/120 Verse Half-Time.mid\",\"start_bar\":0,\"end_bar\":4,\"guard_fraction\":0}],"
        "\"chords\":["
        "[{\"root\":\"D\",\"quality\":\"maj\",\"bass\":\"\",\"beat\":1},{\"root\":\"G\",\"quality\":\"maj\",\"bass\":\"\",\"beat\":3}],"
        "{\"root\":\"A\",\"quality\":\"maj\",\"bass\":\"\",\"beat\":2.5},"
        "[{\"root\":\"E\",\"quality\":\"maj\",\"bass\":\"\"},{\"none\":true,\"beat\":3}],"
        "null]}"
        "],\"instruments\":["
        "{\"enabled\":true,\"output\":\"schwung\",\"channel\":2,\"octave\":3,\"follow_note\":0,"
        "\"voicing\":\"bass\",\"note_gap\":0.125},"
        "{\"enabled\":true,\"output\":\"schwung\",\"channel\":3,\"octave\":2,\"follow_note\":36,"
        "\"voicing\":\"bass\",\"note_gap\":0.125}]}", folder);
    uint32_t base = state_u32(api, inst, "primary_published_gen");
    api->set_param(inst, "loop", "0");
    api->set_param(inst, "song_json", json);
    CHECK(wait_field_change(api, inst, "primary_published_gen", base, 3000), "song published");

    g_captured_count = 0;
    api->set_param(inst, "play", "1");
    int prev = 0;
    for (int b = 0; b < 2800; b++) {
        api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
        if (g_captured_count > prev) {
            int t = transport_tick(api, inst);
            for (int i = prev; i < g_captured_count && i < MAXEV; i++) ev_tick[i] = t;
            prev = g_captured_count;
        }
    }
    int n = g_captured_count < MAXEV ? g_captured_count : MAXEV;

    /* Inst 1 (bar chords, channel 1): note-on ticks per note. */
    int on50 = -1, off50 = -1, on55 = -1, on57 = -1, on52 = -1, ons55 = 0, off55 = -1, off52 = -1, late_on = 0;
    for (int i = 0; i < n; i++) {
        if (g_captured[i].channel != 1) continue;
        int t = ev_tick[i], nt = g_captured[i].note;
        if (g_captured[i].status == 0x90) {
            if (nt == 50 && on50 < 0) on50 = t;
            if (nt == 55) { if (on55 < 0) on55 = t; ons55++; }
            if (nt == 57 && on57 < 0) on57 = t;
            if (nt == 52 && on52 < 0) on52 = t;
            if (t >= 2400) late_on++;
        } else {
            if (nt == 50 && off50 < 0) off50 = t;
            if (nt == 55 && off55 < 0) off55 = t;
            if (nt == 52 && off52 < 0) off52 = t;
        }
    }
    printf("info: D on %d, G on %d (x%d) off %d, A on %d, E on %d off %d, ons after the No Chord %d\n",
           on50, on55, ons55, off55, on57, on52, off52, late_on);
    CHECK(on50 >= 0 && on50 < 10, "bar 1 beat 1: D");
    CHECK(off50 >= 440 && off50 < 480, "D released note_gap ahead of G, mid-bar");
    CHECK(on55 >= 480 && on55 < 490, "bar 1 beat 3: G");
    CHECK(ons55 == 1, "G holds over the bar line into bar 2 (no retrigger at bar 2)");
    CHECK(off55 >= 1280 && off55 < 1320, "G released note_gap ahead of A");
    CHECK(on57 >= 1320 && on57 < 1330, "bar 2 beat 2.5 (Advanced half-beat): A");
    CHECK(on52 >= 1920 && on52 < 1930, "bar 3 beat 1: E");
    CHECK(off52 >= 2360 && off52 < 2400, "E released ahead of the No Chord on beat 3");
    CHECK(late_on == 0, "No Chord mid-bar, and the empty bar after it, stay silent");

    /* Inst 2 (follows the kick, channel 2): every note is the root of the
     * chord sounding at that kick (octave 2). */
    int follow_ons = 0, wrong = 0;
    for (int i = 0; i < n; i++) {
        if (g_captured[i].channel != 2 || g_captured[i].status != 0x90) continue;
        follow_ons++;
        int want = expected_pc(ev_tick[i]);
        if (want < 0 || g_captured[i].note % 12 != want) {
            wrong++;
            printf("info: follow note %d at tick %d, expected pc %d\n", g_captured[i].note, ev_tick[i], want);
        }
    }
    printf("info: %d follow notes\n", follow_ons);
    CHECK(follow_ons >= 3, "the kick-following bass played");
    CHECK(wrong == 0, "each kick plays the chord sounding at that beat, nothing after the No Chord");

    stop_and_ring_out(api, inst);
    api->destroy_instance(inst);
    if (g_failures == 0) printf("\nALL TESTS PASSED\n");
    else printf("\n%d TEST(S) FAILED\n", g_failures);
    return g_failures == 0 ? 0 : 1;
}
