/*
 * Regression test: a jump mid-play releases the instrument notes sounding.
 *
 * Found live: Inst 1 notes stuck in Perform (not Song Builder). Perform jumps
 * sections by moving the playhead mid-play (play_from_bar, or a scheduled
 * seek), which wiped the record of what the instruments were sounding
 * without sending note-offs, and left the bar-boundary chord's note-off
 * scheduled for the old position -- so those notes hung until Stop.
 *
 * Build (plain):
 *   gcc -Wall -Wextra -g -pthread tests/dsp/test_seek_release.c \
 *       src/dsp/arranger_engine.c -Isrc/dsp -ldl -lm -o /tmp/test_seek_release
 *
 * Usage: test_seek_release <library_root>  (expects the "Song 13" fixture)
 */

#include "test_common.h"

/* Which notes are sounding after replaying captured events [0, upto). */
static void sounding_at(int upto, uint8_t on[16][128]) {
    memset(on, 0, 16 * 128);
    for (int i = 0; i < upto && i < g_captured_count; i++) {
        uint8_t c = g_captured[i].channel & 0x0F, n = g_captured[i].note & 0x7F;
        if (g_captured[i].status == 0x90) on[c][n] = 1;
        else if (g_captured[i].status == 0x80) on[c][n] = 0;
    }
}

/* Instrument notes (channels 1, 2) sounding at the jump that got no
 * note-off by `upto`. */
static int hung_after_jump(int jump_at, int upto) {
    uint8_t before[16][128];
    sounding_at(jump_at, before);
    int hung = 0;
    for (int c = 1; c <= 2; c++)
        for (int n = 0; n < 128; n++) {
            if (!before[c][n]) continue;
            int released = 0;
            for (int i = jump_at; i < upto && i < g_captured_count; i++)
                if ((g_captured[i].channel & 0x0F) == c && g_captured[i].note == n &&
                    g_captured[i].status == 0x80) { released = 1; break; }
            if (!released) hung++;
        }
    return hung;
}

/* how: 0 = play_from_bar, 1 = seek_bar, 2 = seek_bar_scheduled */
static int run(plugin_api_v2_t *api, const char *lib, int blocks, int how) {
    char folder[128], json[2048];
    int16_t audio[MOVE_FRAMES_PER_BLOCK * 2];
    void *inst = api->create_instance("/tmp/test_seek_release", NULL);
    if (!inst || !find_song13_folder(api, inst, lib, folder, sizeof folder)) return -1;
    api->set_param(inst, "emit_directly", "1");
    api->set_param(inst, "output_target", "schwung");
    api->set_param(inst, "schwung_channel", "0");
    /* Two sections with different chords; Inst 1 a bass following the kick
     * (wire channel 2), Inst 2 a held bar chord (wire channel 1). */
    snprintf(json, sizeof(json),
        "{\"source_folder\":\"%s\",\"name\":\"T\",\"tempo_bpm\":120,"
        "\"time_sig_num\":4,\"time_sig_den\":4,\"key\":\"D\",\"sections\":["
        "{\"name\":\"A\",\"clips\":[{\"source\":\"Grooves/120 Verse Half-Time.mid\",\"start_bar\":0,\"end_bar\":4,\"guard_fraction\":0}],"
        "\"chords\":[{\"root\":\"D\",\"quality\":\"maj\",\"bass\":\"\"},{\"root\":\"G\",\"quality\":\"maj\",\"bass\":\"\"},"
        "{\"root\":\"A\",\"quality\":\"maj\",\"bass\":\"\"},{\"root\":\"D\",\"quality\":\"maj\",\"bass\":\"\"}]},"
        "{\"name\":\"B\",\"clips\":[{\"source\":\"Grooves/120 Verse Half-Time.mid\",\"start_bar\":0,\"end_bar\":4,\"guard_fraction\":0}],"
        "\"chords\":[{\"root\":\"E\",\"quality\":\"min\",\"bass\":\"\"},{\"root\":\"B\",\"quality\":\"min\",\"bass\":\"\"},"
        "{\"root\":\"C\",\"quality\":\"maj\",\"bass\":\"\"},{\"root\":\"F\",\"quality\":\"maj\",\"bass\":\"\"}]}"
        "],\"instruments\":["
        "{\"enabled\":true,\"output\":\"schwung\",\"channel\":3,\"octave\":2,\"follow_note\":36,\"voicing\":\"bass\",\"note_gap\":0.125},"
        "{\"enabled\":true,\"output\":\"schwung\",\"channel\":2,\"octave\":3,\"follow_note\":0,\"voicing\":\"chord\",\"note_gap\":0.125}]}",
        folder);
    uint32_t base = state_u32(api, inst, "primary_published_gen");
    api->set_param(inst, "loop", "0");
    api->set_param(inst, "song_json", json);
    if (!wait_field_change(api, inst, "primary_published_gen", base, 3000)) return -1;
    g_captured_count = 0;
    api->set_param(inst, "play_from_bar", "0");
    for (int b = 0; b < blocks; b++) api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
    int jump_at = g_captured_count;
    /* Jump to section B (bar 4), as Perform does. */
    if (how == 0) api->set_param(inst, "play_from_bar", "4");
    else if (how == 1) api->set_param(inst, "seek_bar", "4");
    else {
        /* Fires at the next bar boundary, mid-section A. */
        char t[1024];
        api->get_param(inst, "transport", t, sizeof t);
        unsigned bar = 1;
        sscanf(strstr(t, "\"bar\":"), "\"bar\":%u", &bar);
        char v[32];
        snprintf(v, sizeof v, "%u:4", bar);
        api->set_param(inst, "seek_bar_scheduled", v);
        if (bar >= 4) { api->destroy_instance(inst); return 0; } /* boundary past A */
    }
    if (how == 2) {
        /* What was sounding when the seek fires must be released there.
         * Render until it fires. */
        for (int b = 0; b < 800; b++) {
            api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
            char t[1024];
            api->get_param(inst, "transport", t, sizeof t);
            unsigned sc = 0;
            char *p = strstr(t, "\"seek_counter\":");
            if (p) sscanf(p, "\"seek_counter\":%u", &sc);
            if (sc > 0) break;
            jump_at = g_captured_count; /* notes before the seek fires */
        }
    }
    /* Shortly after the jump -- well before any note-off section B would
     * schedule for a note from section A. */
    for (int b = 0; b < 20; b++) api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
    int hung = hung_after_jump(jump_at, g_captured_count);
    stop_and_ring_out(api, inst);
    api->destroy_instance(inst);
    return hung;
}

int main(int argc, char **argv) {
    if (argc < 2) { fprintf(stderr, "usage: %s <library_root>\n", argv[0]); return 1; }
    host_api_v1_t host = make_test_host();
    plugin_api_v2_t *api = move_plugin_init_v2(&host);

    const char *names[3] = { "play_from_bar", "seek_bar", "seek_bar_scheduled" };
    for (int how = 0; how < 3; how++) {
        int worst = 0;
        for (int blocks = 60; blocks <= 2000; blocks += 97) {
            int h = run(api, argv[1], blocks, how);
            if (h < 0) { fprintf(stderr, "setup failed\n"); return 1; }
            if (h > worst) worst = h;
        }
        char msg[160];
        snprintf(msg, sizeof msg, "%s mid-play: every Inst 1/2 note sounding at the jump is released at it (worst left: %d)",
                 names[how], worst);
        CHECK(worst == 0, msg);
    }

    if (g_failures == 0) printf("\nALL TESTS PASSED\n");
    else printf("\n%d TEST(S) FAILED\n", g_failures);
    return g_failures == 0 ? 0 : 1;
}
