/*
 * Regression tests for the click track (update_click in
 * src/dsp/arranger_engine.c): a metronome on every beat while playing, the
 * accent note on beat 1, routed to its own output/channel, toggled by
 * click_enabled -- and a count-in timeline ("count_in":1), whose own clip is
 * not played and which the click track plays instead when
 * "count_in_sound":1.
 *
 * Build (plain):
 *   gcc -Wall -Wextra -g -pthread tests/dsp/test_click.c \
 *       src/dsp/arranger_engine.c -Isrc/dsp -ldl -lm -o /tmp/test_click
 *
 * Usage: test_click <library_root>  (expects the "Song 13" fixture)
 */

#include "test_common.h"

static int count_ch(uint8_t st, uint8_t nt, uint8_t ch) {
    int n = 0;
    for (int i = 0; i < g_captured_count; i++)
        if (g_captured[i].status == st && g_captured[i].note == nt && g_captured[i].channel == ch) n++;
    return n;
}

static int count_any_on(uint8_t ch) {
    int n = 0;
    for (int i = 0; i < g_captured_count; i++)
        if (g_captured[i].status == 0x90 && g_captured[i].channel == ch) n++;
    return n;
}

static void *fresh(plugin_api_v2_t *api, const char *lib, char *folder, size_t sz) {
    void *inst = api->create_instance("/tmp/test_click", NULL);
    if (!inst || !find_song13_folder(api, inst, lib, folder, sz)) return NULL;
    api->set_param(inst, "emit_directly", "1");
    api->set_param(inst, "output_target", "schwung");
    api->set_param(inst, "schwung_channel", "0");
    api->set_param(inst, "click_output", "schwung");
    api->set_param(inst, "click_channel", "9");
    api->set_param(inst, "click_accent_note", "76");
    api->set_param(inst, "click_normal_note", "77");
    return inst;
}

static int load(plugin_api_v2_t *api, void *inst, const char *folder, int count_in, int sound) {
    char json[2048];
    snprintf(json, sizeof(json),
        "{\"source_folder\":\"%s\",\"name\":\"T\",\"tempo_bpm\":120,"
        "\"time_sig_num\":4,\"time_sig_den\":4,\"ppq\":240,\"count_in\":%d,\"count_in_sound\":%d,"
        "\"sections\":[{\"name\":\"A\",\"clips\":["
        "{\"source\":\"Grooves/120 Verse Half-Time.mid\",\"start_bar\":0,\"end_bar\":4,\"guard_fraction\":0}"
        "]}]}", folder, count_in, sound);
    uint32_t base = state_u32(api, inst, "primary_published_gen");
    api->set_param(inst, "loop", "0");
    api->set_param(inst, "song_json", json);
    return wait_field_change(api, inst, "primary_published_gen", base, 3000);
}

int main(int argc, char **argv) {
    if (argc < 2) { fprintf(stderr, "usage: %s <library_root>\n", argv[0]); return 1; }
    const char *lib = argv[1];
    host_api_v1_t host = make_test_host();
    plugin_api_v2_t *api = move_plugin_init_v2(&host);
    char folder[128];
    int16_t audio[MOVE_FRAMES_PER_BLOCK * 2];

    /* 1. Click on: one note per beat, accent (76) on beat 1 of each bar.
     * ~1590 blocks at ~1.393 ticks/block reaches ~tick 2215: beats at 0,
     * 240, ... 2160 = 10 beats, 3 of them bar starts (0, 960, 1920). */
    {
        void *inst = fresh(api, lib, folder, sizeof folder);
        if (!inst) return 1;
        CHECK(load(api, inst, folder, 0, 0), "click: song published");
        g_captured_count = 0;
        api->set_param(inst, "click_enabled", "1");
        api->set_param(inst, "play", "1");
        for (int b = 0; b < 1590; b++) api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
        api->set_param(inst, "stop", "1");
        CHECK(count_ch(0x90, 76, 9) == 3, "click: accent on beat 1 of each bar (3)");
        CHECK(count_ch(0x90, 77, 9) == 7, "click: normal note on the other beats (7)");
        CHECK(count_ch(0x80, 76, 9) == 3 && count_ch(0x80, 77, 9) == 7,
              "click: every click note is released, the last by Stop");
        CHECK(count_any_on(0) > 0, "click: the drums still play alongside it");
        api->destroy_instance(inst);
    }

    /* 2. Click off: nothing on the click channel. */
    {
        void *inst = fresh(api, lib, folder, sizeof folder);
        if (!inst) return 1;
        CHECK(load(api, inst, folder, 0, 0), "click off: song published");
        g_captured_count = 0;
        api->set_param(inst, "play", "1");
        for (int b = 0; b < 1590; b++) api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
        api->set_param(inst, "stop", "1");
        CHECK(count_any_on(9) == 0, "click off: no click notes");
        api->destroy_instance(inst);
    }

    /* 3. Count-in with sound: the clip itself plays nothing (no drum notes),
     * the click track plays it even with the toggle off. */
    {
        void *inst = fresh(api, lib, folder, sizeof folder);
        if (!inst) return 1;
        CHECK(load(api, inst, folder, 1, 1), "count-in: published");
        g_captured_count = 0;
        api->set_param(inst, "play", "1");
        for (int b = 0; b < 1590; b++) api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
        api->set_param(inst, "stop", "1");
        CHECK(count_any_on(0) == 0, "count-in: none of the count-in clip's own notes are played");
        CHECK(count_ch(0x90, 76, 9) == 3 && count_ch(0x90, 77, 9) == 7,
              "count-in: the click track plays every beat with the toggle off");
        api->destroy_instance(inst);
    }

    /* 4. Count-in without sound: silent. */
    {
        void *inst = fresh(api, lib, folder, sizeof folder);
        if (!inst) return 1;
        CHECK(load(api, inst, folder, 1, 0), "silent count-in: published");
        g_captured_count = 0;
        api->set_param(inst, "click_enabled", "1");
        api->set_param(inst, "play", "1");
        for (int b = 0; b < 1590; b++) api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
        api->set_param(inst, "stop", "1");
        CHECK(g_captured_count == 0 || (count_any_on(0) == 0 && count_any_on(9) == 0),
              "silent count-in: nothing at all, even with the click toggle on");
        api->destroy_instance(inst);
    }

    /* 5. Click volume: the default (click_volume 80), then the song's click
     * items -- 50% from bar 2, silent from bar 3 beat 3 (holding to the
     * section end). Velocities: accent 127, normal 100, scaled. */
    {
        void *inst = fresh(api, lib, folder, sizeof folder);
        if (!inst) return 1;
        char json[2048];
        snprintf(json, sizeof(json),
            "{\"source_folder\":\"%s\",\"name\":\"T\",\"tempo_bpm\":120,"
            "\"time_sig_num\":4,\"time_sig_den\":4,"
            "\"sections\":[{\"name\":\"A\",\"clips\":["
            "{\"source\":\"Grooves/120 Verse Half-Time.mid\",\"start_bar\":0,\"end_bar\":4,\"guard_fraction\":0}"
            "]}],\"click_items\":[{\"section\":0,\"bar\":1,\"beat\":1,\"volume\":50},"
            "{\"section\":0,\"bar\":2,\"beat\":3,\"volume\":0}]}", folder);
        uint32_t base = state_u32(api, inst, "primary_published_gen");
        api->set_param(inst, "loop", "0");
        api->set_param(inst, "song_json", json);
        CHECK(wait_field_change(api, inst, "primary_published_gen", base, 3000), "click volume: published");
        api->set_param(inst, "click_volume", "80");
        api->set_param(inst, "click_enabled", "1");
        g_captured_count = 0;
        api->set_param(inst, "play", "1");
        for (int b = 0; b < 2800; b++) api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
        api->set_param(inst, "stop", "1");
        int vels[32], nv = 0;
        for (int i = 0; i < g_captured_count && nv < 32; i++)
            if (g_captured[i].status == 0x90 && g_captured[i].channel == 9) vels[nv++] = g_captured[i].vel;
        printf("info: click velocities:");
        for (int i = 0; i < nv; i++) printf(" %d", vels[i]);
        printf("\n");
        CHECK(nv == 10, "click volume: bars 1-2 and bar 3 beats 1-2 click, then silent (10 clicks)");
        CHECK(nv >= 10 && vels[0] == 102 && vels[1] == 80 && vels[3] == 80, "bar 1 at the default 80%: accent 102, normal 80");
        CHECK(nv >= 10 && vels[4] == 64 && vels[5] == 50 && vels[8] == 64 && vels[9] == 50,
              "bar 2 on at the item's 50% (held into bar 3): accent 64, normal 50");
        api->destroy_instance(inst);
    }

    if (g_failures == 0) printf("\nALL TESTS PASSED\n");
    else printf("\n%d TEST(S) FAILED\n", g_failures);
    return g_failures == 0 ? 0 : 1;
}
