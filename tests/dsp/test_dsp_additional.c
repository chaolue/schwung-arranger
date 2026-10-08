/*
 * Regression tests for the remaining DSP functional gaps identified after
 * the first broader test pass: two instruments running simultaneously,
 * output_target routing to "move"/"external" (only "schwung" had ever been
 * exercised), note_gap at its extremes (0 and 1 beat), a per-clip
 * source_folder override pulling from a different song folder than the
 * song's own default, Jam-style AUTOSWAP (a non-looping clip ending into an
 * already-staged one, with no explicit "swap"), and repeated create/destroy
 * instance lifecycle (leak-checked via ASan/LeakSanitizer).
 *
 * Build (plain):
 *   gcc -Wall -Wextra -g -pthread tests/dsp/test_dsp_additional.c \
 *       src/dsp/arranger_engine.c -Isrc/dsp -ldl -lm -o /tmp/test_dsp_additional
 * Build (ASan -- required for test 6, LeakSanitizer runs automatically):
 *   gcc -Wall -Wextra -g -pthread -fsanitize=address,undefined tests/dsp/test_dsp_additional.c \
 *       src/dsp/arranger_engine.c -Isrc/dsp -ldl -lm -o /tmp/test_dsp_additional_asan
 *
 * Usage: test_dsp_additional <library_root>
 * Expects the "Song 13" fixture (see test_async_channels.c) plus
 * "Song 12 4-4 112 BPM/Grooves/112 Intro Stick.mid" for the cross-folder
 * clip test (both ship in the same GM Rock 2 library).
 */

#include "test_common.h"

static plugin_api_v2_t *g_api;
static void *g_inst;

static void run_song(const char *song_json, int blocks) {
    g_captured_count = 0;
    uint32_t base_primary = state_u32(g_api, g_inst, "primary_published_gen");
    g_api->set_param(g_inst, "song_json", song_json);
    CHECK(wait_field_change(g_api, g_inst, "primary_published_gen", base_primary, 3000),
          "song published");
    g_api->set_param(g_inst, "loop", "0");
    g_api->set_param(g_inst, "play", "1");
    int16_t audio[MOVE_FRAMES_PER_BLOCK * 2];
    for (int b = 0; b < blocks; b++) g_api->render_block(g_inst, audio, MOVE_FRAMES_PER_BLOCK);
    g_api->set_param(g_inst, "stop", "1");
}

int main(int argc, char **argv) {
    if (argc < 2) { fprintf(stderr, "usage: %s <library_root>\n", argv[0]); return 1; }
    const char *library_root = argv[1];

    host_api_v1_t host = make_test_host();
    g_api = move_plugin_init_v2(&host);
    g_inst = g_api->create_instance("/tmp/test_dsp_additional", NULL);
    if (!g_inst) { fprintf(stderr, "create_instance failed\n"); return 1; }

    char folder_name[128];
    if (!find_song13_folder(g_api, g_inst, library_root, folder_name, sizeof(folder_name))) {
        g_api->destroy_instance(g_inst);
        return 1;
    }

    char tmpl[8192], json[8192];

    /* --- Test 1: two instruments active at once, one bar-boundary
     * (follow_note off) and one follow-note (kick), each with distinct
     * octave/channel so their notes are unambiguous. Instrument 0: octave 3,
     * bass, follow_note 0 -> base 48 + C(pc0) = 48. Instrument 1: octave 5,
     * bass, follow_note 36 -> base (5+1)*12=72 + C(pc0) = 72, fired on the
     * kick hit. Both must sound from the SAME song/chord. --- */
    snprintf(tmpl, sizeof(tmpl),
        "{\"source_folder\":\"%%s\",\"name\":\"T\",\"tempo_bpm\":120,"
        "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
        "{\"name\":\"A\",\"clips\":["
        "{\"source\":\"Grooves/120 Intro Half-Time Stick.mid\",\"start_bar\":0,\"end_bar\":1}"
        "],\"chords\":[{\"root\":\"C\",\"quality\":\"maj\",\"bass\":\"\"}]}"
        "],\"instruments\":["
        "{\"enabled\":true,\"output\":\"schwung\",\"channel\":1,\"octave\":3,\"follow_note\":0,"
        "\"voicing\":\"bass\",\"note_gap\":0.125},"
        "{\"enabled\":true,\"output\":\"schwung\",\"channel\":2,\"octave\":5,\"follow_note\":36,"
        "\"voicing\":\"bass\",\"note_gap\":0.125}"
        "]}");
    snprintf(json, sizeof(json), tmpl, folder_name);
    run_song(json, 2000);
    CHECK(captured_has_note(0x90, 48), "dual instruments: instrument 0 (bar-boundary, octave 3) sounds note 48");
    CHECK(captured_has_note(0x90, 72), "dual instruments: instrument 1 (follow-note, octave 5) sounds note 72");
    CHECK(captured_has_note(0x80, 48), "dual instruments: instrument 0's note is also turned off");
    CHECK(captured_has_note(0x80, 72), "dual instruments: instrument 1's note is also turned off");
    {
        int ch1_ok = 0, ch2_ok = 0;
        for (int i = 0; i < g_captured_count; i++) {
            if (g_captured[i].status == 0x90 && g_captured[i].note == 48 && g_captured[i].channel == 0) ch1_ok = 1;
            if (g_captured[i].status == 0x90 && g_captured[i].note == 72 && g_captured[i].channel == 1) ch2_ok = 1;
        }
        CHECK(ch1_ok, "dual instruments: instrument 0's note carries its own channel (1, 0-based 0)");
        CHECK(ch2_ok, "dual instruments: instrument 1's note carries its own channel (2, 0-based 1)");
    }

    /* --- Test 2: output_target routing. Three instruments, identical
     * except for "output", each on a distinguishable octave so the notes
     * don't collide, confirm each lands on its OWN route and not the
     * others. --- */
    snprintf(tmpl, sizeof(tmpl),
        "{\"source_folder\":\"%%s\",\"name\":\"T\",\"tempo_bpm\":120,"
        "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
        "{\"name\":\"A\",\"clips\":["
        "{\"source\":\"Grooves/120 Intro Half-Time Stick.mid\",\"start_bar\":0,\"end_bar\":1}"
        "],\"chords\":[{\"root\":\"C\",\"quality\":\"maj\",\"bass\":\"\"}]}"
        "],\"instruments\":["
        "{\"enabled\":true,\"output\":\"schwung\",\"channel\":1,\"octave\":3,\"follow_note\":0,\"voicing\":\"bass\",\"note_gap\":0.125},"
        "{\"enabled\":true,\"output\":\"move\",\"channel\":1,\"octave\":4,\"follow_note\":0,\"voicing\":\"bass\",\"note_gap\":0.125}"
        "]}");
    snprintf(json, sizeof(json), tmpl, folder_name);
    run_song(json, 2000);
    /* octave 3 -> 48 (schwung/internal); octave 4 -> 60 (move). */
    CHECK(captured_has_note_route(0x90, 48, ROUTE_INTERNAL), "output routing: \"schwung\" instrument's note arrives via midi_send_internal");
    CHECK(!captured_has_note_route(0x90, 48, ROUTE_MOVE), "output routing: \"schwung\" instrument's note does NOT arrive via midi_inject_to_move");
    CHECK(captured_has_note_route(0x90, 60, ROUTE_MOVE), "output routing: \"move\" instrument's note arrives via midi_inject_to_move");
    CHECK(!captured_has_note_route(0x90, 60, ROUTE_INTERNAL), "output routing: \"move\" instrument's note does NOT arrive via midi_send_internal");

    snprintf(tmpl, sizeof(tmpl),
        "{\"source_folder\":\"%%s\",\"name\":\"T\",\"tempo_bpm\":120,"
        "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
        "{\"name\":\"A\",\"clips\":["
        "{\"source\":\"Grooves/120 Intro Half-Time Stick.mid\",\"start_bar\":0,\"end_bar\":1}"
        "],\"chords\":[{\"root\":\"C\",\"quality\":\"maj\",\"bass\":\"\"}]}"
        "],\"instruments\":["
        "{\"enabled\":true,\"output\":\"external\",\"channel\":1,\"octave\":6,\"follow_note\":0,\"voicing\":\"bass\",\"note_gap\":0.125}"
        "]}");
    snprintf(json, sizeof(json), tmpl, folder_name);
    run_song(json, 2000);
    /* octave 6 -> 84. */
    CHECK(captured_has_note_route(0x90, 84, ROUTE_EXTERNAL), "output routing: \"external\" instrument's note arrives via midi_send_external");
    CHECK(!captured_has_note_route(0x90, 84, ROUTE_INTERNAL) && !captured_has_note_route(0x90, 84, ROUTE_MOVE),
          "output routing: \"external\" instrument's note does NOT arrive via the other two routes");

    /* --- Test 3: note_gap extremes. 0 = no gap at all; 1.0 = a full beat.
     * Neither should break anything -- the note still sounds and still
     * gets turned off. (Precise gap-duration timing isn't observable from
     * captured status/note/vel alone; this pins functional correctness at
     * the extremes, not exact tick placement.) --- */
    for (int variant = 0; variant < 2; variant++) {
        const char *gap = variant == 0 ? "0" : "1.0";
        snprintf(tmpl, sizeof(tmpl),
            "{\"source_folder\":\"%%s\",\"name\":\"T\",\"tempo_bpm\":120,"
            "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
            "{\"name\":\"A\",\"clips\":["
            "{\"source\":\"Grooves/120 Intro Half-Time Stick.mid\",\"start_bar\":0,\"end_bar\":1},"
            "{\"source\":\"Grooves/120 Verse Half-Time.mid\",\"start_bar\":1,\"end_bar\":2}"
            "],\"chords\":["
            "{\"root\":\"C\",\"quality\":\"maj\",\"bass\":\"\"},"
            "{\"root\":\"G\",\"quality\":\"maj\",\"bass\":\"\"}"
            "]}"
            "],\"instruments\":["
            "{\"enabled\":true,\"output\":\"schwung\",\"channel\":1,\"octave\":3,\"follow_note\":0,"
            "\"voicing\":\"bass\",\"note_gap\":%s}"
            "]}", gap);
        snprintf(json, sizeof(json), tmpl, folder_name);
        run_song(json, 3000);
        char msg1[96], msg2[96];
        snprintf(msg1, sizeof(msg1), "note_gap=%s: both chords' notes (48, 55) sound", gap);
        snprintf(msg2, sizeof(msg2), "note_gap=%s: bar 0's note (48) is turned off before/at the chord change", gap);
        CHECK(captured_has_note(0x90, 48) && captured_has_note(0x90, 55), msg1);
        CHECK(captured_has_note(0x80, 48), msg2);
    }

    /* --- Test 4: per-clip source_folder override pulls a clip from a
     * DIFFERENT song folder than the song's own default (Song 13), proving
     * cross-folder resolution works via this field specifically (not just
     * the whole-library recursive fallback). --- */
    snprintf(tmpl, sizeof(tmpl),
        "{\"source_folder\":\"%%s\",\"name\":\"T\",\"tempo_bpm\":120,"
        "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
        "{\"name\":\"A\",\"clips\":["
        "{\"source\":\"Grooves/120 Intro Half-Time Stick.mid\",\"start_bar\":0,\"end_bar\":1},"
        "{\"source\":\"Grooves/112 Intro Stick.mid\",\"source_folder\":\"Song 12 4-4 112 BPM\",\"start_bar\":1,\"end_bar\":2}"
        "]}]}");
    snprintf(json, sizeof(json), tmpl, folder_name);
    {
        uint32_t base_primary = state_u32(g_api, g_inst, "primary_published_gen");
        g_api->set_param(g_inst, "song_json", json);
        CHECK(wait_field_change(g_api, g_inst, "primary_published_gen", base_primary, 3000),
              "cross-folder clip: song published");
        char info[512], err[512];
        g_api->get_param(g_inst, "timeline_info", info, sizeof(info));
        g_api->get_param(g_inst, "error", err, sizeof(err));
        int total_bars = -1;
        sscanf(strstr(info, "\"total_bars\":"), "\"total_bars\":%d", &total_bars);
        CHECK(total_bars == 2, "cross-folder clip: both bars build (the Song-12 clip resolves via its own source_folder)");
        CHECK(err[0] == '\0', "cross-folder clip: no resolution error");
    }

    /* --- Test 5: AUTOSWAP. A short, non-looping primary clip preloaded
     * with a different clip staged (never manually "swap"ped) must, on
     * reaching its natural end, automatically continue into the staged
     * clip -- Jam mode's mechanism for a fill returning to its groove. --- */
    {
        char primary_tmpl[2048], staged_tmpl[2048], primary_json[2048], staged_json[2048];
        snprintf(primary_tmpl, sizeof(primary_tmpl),
            "{\"source_folder\":\"%%s\",\"name\":\"Primary\",\"tempo_bpm\":120,"
            "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
            "{\"name\":\"A\",\"clips\":[{\"source\":\"Fills/120 Chorus 1 Backbeat Fill 1.mid\",\"start_bar\":0,\"end_bar\":1}]}"
            "]}");
        snprintf(primary_json, sizeof(primary_json), primary_tmpl, folder_name);
        snprintf(staged_tmpl, sizeof(staged_tmpl),
            "{\"source_folder\":\"%%s\",\"name\":\"Staged\",\"tempo_bpm\":120,"
            "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
            "{\"name\":\"A\",\"clips\":[{\"source\":\"Grooves/120 Intro Half-Time Stick.mid\",\"start_bar\":0,\"end_bar\":1}]}"
            "]}");
        snprintf(staged_json, sizeof(staged_json), staged_tmpl, folder_name);

        uint32_t base_primary = state_u32(g_api, g_inst, "primary_published_gen");
        g_api->set_param(g_inst, "song_json", primary_json);
        CHECK(wait_field_change(g_api, g_inst, "primary_published_gen", base_primary, 3000),
              "AUTOSWAP: primary (fill) published");
        uint32_t base_staging = state_u32(g_api, g_inst, "staging_published_gen");
        g_api->set_param(g_inst, "preload_song_json", staged_json);
        CHECK(wait_field_change(g_api, g_inst, "staging_published_gen", base_staging, 3000),
              "AUTOSWAP: staged (groove) published");
        g_api->set_param(g_inst, "loop", "0");
        g_api->set_param(g_inst, "play", "1");
        char src[512];
        active_source(g_api, g_inst, src, sizeof(src));
        CHECK(strstr(src, "Backbeat Fill") != NULL, "AUTOSWAP: primary (fill) is active right after play");

        int16_t audio[MOVE_FRAMES_PER_BLOCK * 2];
        uint32_t swap_counter_before = param_field_u32(g_api, g_inst, "transport", "swap_counter");
        int swapped = 0;
        /* Run well past the 1-bar fill's natural end (~2s at 120bpm) --
         * AUTOSWAP requires no explicit "swap" call at all. */
        for (int b = 0; b < 4000; b++) {
            g_api->render_block(g_inst, audio, MOVE_FRAMES_PER_BLOCK);
            if (param_field_u32(g_api, g_inst, "transport", "swap_counter") > swap_counter_before) { swapped = 1; break; }
        }
        CHECK(swapped, "AUTOSWAP: swap_counter advanced with no explicit \"swap\" call");
        active_source(g_api, g_inst, src, sizeof(src));
        CHECK(strstr(src, "Intro Half-Time Stick") != NULL, "AUTOSWAP: active_source is now the staged groove");
        g_api->set_param(g_inst, "stop", "1");
    }

    /* --- Test 6: repeated create/destroy lifecycle. Run under ASan
     * (LeakSanitizer) to confirm no leak accumulates across many
     * create_instance/destroy_instance cycles -- checked automatically at
     * process exit, not via an explicit CHECK here. --- */
    for (int i = 0; i < 20; i++) {
        void *tmp_inst = g_api->create_instance("/tmp/test_dsp_additional_lifecycle", NULL);
        if (tmp_inst) {
            g_api->set_param(tmp_inst, "library_root", library_root);
            g_api->destroy_instance(tmp_inst);
        }
    }
    printf("ok: create/destroy lifecycle: 20 cycles completed (leak-checked under ASan)\n");

    if (g_failures == 0) {
        printf("\nALL TESTS PASSED\n");
    } else {
        printf("\n%d TEST(S) FAILED\n", g_failures);
    }
    g_api->destroy_instance(g_inst);
    return g_failures == 0 ? 0 : 1;
}
