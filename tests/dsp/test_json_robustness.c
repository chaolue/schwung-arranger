/*
 * Regression tests for song-JSON parsing robustness: missing/default
 * fields, bounds safety on malformed indices, and a real bug found (and
 * fixed) while writing this test suite.
 *
 * THE BUG: parse_song_json's clip scanner (src/dsp/arranger_engine.c)
 * counted ANY nested object at section depth as a clip (clip_idx++,
 * bounded by MAX_SECTION_CLIPS), with no awareness that a section's
 * "chords" array -- a sibling of "clips", parsed separately -- also
 * contains nested objects at that same depth. A section combining clips
 * and chords whose COMBINED count reached MAX_SECTION_CLIPS made the
 * entire parse_song_json call return -1, silently aborting the whole song
 * build (not just that section) with total_bars/count both 0 and no error
 * message at all -- and even below that cap, every chord entry ate a real
 * clip_idx slot, producing a spurious "clip not resolved" build error.
 * Fixed by skipping the "chords" array's content entirely in this
 * scanner (skip_json_array) instead of walking into it. Test 2 below pins
 * it directly; the fix also incidentally resolved the "clip not resolved"
 * false positive test_instrument_overrides.c and test_instrument_bar_bugs.c
 * previously had to work around/document.
 *
 * Build (plain):
 *   gcc -Wall -Wextra -g -pthread tests/dsp/test_json_robustness.c \
 *       src/dsp/arranger_engine.c -Isrc/dsp -ldl -lm -o /tmp/test_json_robustness
 *
 * Usage: test_json_robustness <library_root>
 * Expects the "Song 13" fixture (see test_async_channels.c).
 */

#include "test_common.h"

static plugin_api_v2_t *g_api;
static void *g_inst;

static void run_song(const char *song_json) {
    g_captured_count = 0;
    uint32_t base_primary = state_u32(g_api, g_inst, "primary_published_gen");
    g_api->set_param(g_inst, "song_json", song_json);
    CHECK(wait_field_change(g_api, g_inst, "primary_published_gen", base_primary, 3000),
          "song published");
    g_api->set_param(g_inst, "loop", "0");
    g_api->set_param(g_inst, "play", "1");
    int16_t audio[MOVE_FRAMES_PER_BLOCK * 2];
    for (int b = 0; b < 8000; b++) {
        g_api->render_block(g_inst, audio, MOVE_FRAMES_PER_BLOCK);
    }
    g_api->set_param(g_inst, "stop", "1");
}

int main(int argc, char **argv) {
    if (argc < 2) { fprintf(stderr, "usage: %s <library_root>\n", argv[0]); return 1; }
    const char *library_root = argv[1];

    host_api_v1_t host = make_test_host();
    g_api = move_plugin_init_v2(&host);
    g_inst = g_api->create_instance("/tmp/test_json_robustness", NULL);
    if (!g_inst) { fprintf(stderr, "create_instance failed\n"); return 1; }

    char folder_name[128];
    if (!find_song13_folder(g_api, g_inst, library_root, folder_name, sizeof(folder_name))) {
        g_api->destroy_instance(g_inst);
        return 1;
    }

    char tmpl[8192], json[8192];

    /* --- Test 1: missing tempo_bpm/time_sig_num/time_sig_den fall back to
     * the documented defaults (120bpm, 4/4) instead of failing the
     * build. --- */
    snprintf(tmpl, sizeof(tmpl),
        "{\"source_folder\":\"%%s\",\"name\":\"T\",\"sections\":["
        "{\"name\":\"A\",\"clips\":["
        "{\"source\":\"Grooves/120 Intro Half-Time Stick.mid\",\"start_bar\":0,\"end_bar\":1}"
        "]}]}");
    snprintf(json, sizeof(json), tmpl, folder_name);
    run_song(json);
    char transport[1024];
    g_api->get_param(g_inst, "transport", transport, sizeof(transport));
    int ts_num = 0, ts_den = 0; double bpm = 0;
    sscanf(strstr(transport, "\"time_sig_num\":"), "\"time_sig_num\":%d", &ts_num);
    sscanf(strstr(transport, "\"time_sig_den\":"), "\"time_sig_den\":%d", &ts_den);
    sscanf(strstr(transport, "\"bpm\":"), "\"bpm\":%lf", &bpm);
    CHECK(ts_num == 4 && ts_den == 4, "missing time_sig_num/den defaults to 4/4");
    CHECK(bpm > 119.0 && bpm < 121.0, "missing tempo_bpm defaults to 120");

    /* --- Test 2: THE BUG. A section combining clips + chords whose
     * combined count crosses MAX_SECTION_CLIPS (16) must still build
     * correctly -- 10 clips + 10 chords (20 total) previously aborted the
     * entire parse with an empty timeline and no error at all. --- */
    {
        char clips_buf[4096]; clips_buf[0] = '\0';
        char chords_buf[2048]; chords_buf[0] = '\0';
        const char *sources[] = {
            "120 Intro Half-Time Stick.mid", "120 Verse Half-Time.mid", "120 Bridge Half-Time.mid",
            "120 Chorus 2 Half-Time.mid", "120 Chorus 1 Ride 8th.mid", "120 Outro Half-Time F1.mid",
            "120 Outro Half-Time F2.mid", "120 Outro Half-Time F3.mid", "120 Outro Half-Time F4.mid",
            "120 Outro Half-Time F5.mid",
        };
        const int n = 10;
        for (int i = 0; i < n; i++) {
            char e[256];
            snprintf(e, sizeof(e), "%s{\"source\":\"Grooves/%s\",\"start_bar\":%d,\"end_bar\":%d}",
                     i ? "," : "", sources[i], i, i + 1);
            strncat(clips_buf, e, sizeof(clips_buf) - strlen(clips_buf) - 1);
            char c[64];
            snprintf(c, sizeof(c), "%s{\"root\":\"C\",\"quality\":\"maj\",\"bass\":\"\"}", i ? "," : "");
            strncat(chords_buf, c, sizeof(chords_buf) - strlen(chords_buf) - 1);
        }
        snprintf(tmpl, sizeof(tmpl),
            "{\"source_folder\":\"%%s\",\"name\":\"T\",\"tempo_bpm\":120,"
            "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
            "{\"name\":\"A\",\"clips\":[%s],\"chords\":[%s]}]}", clips_buf, chords_buf);
        snprintf(json, sizeof(json), tmpl, folder_name);
        uint32_t base_primary = state_u32(g_api, g_inst, "primary_published_gen");
        g_api->set_param(g_inst, "song_json", json);
        CHECK(wait_field_change(g_api, g_inst, "primary_published_gen", base_primary, 3000),
              "10 clips + 10 chords: song published");
        char info[512], err[512];
        g_api->get_param(g_inst, "timeline_info", info, sizeof(info));
        g_api->get_param(g_inst, "error", err, sizeof(err));
        int total_bars = -1;
        sscanf(strstr(info, "\"total_bars\":"), "\"total_bars\":%d", &total_bars);
        CHECK(total_bars == n, "10 clips + 10 chords: builds all 10 bars, not an empty/aborted timeline");
        CHECK(err[0] == '\0', "10 clips + 10 chords: no spurious 'clip not resolved' error");
    }

    /* --- Test 3: an out-of-range override section/bar index is safely
     * ignored (bounds-checked -- run this file under ASan to confirm no
     * OOB write into instrument_t.overrides[]) rather than corrupting
     * state or crashing. --- */
    snprintf(tmpl, sizeof(tmpl),
        "{\"source_folder\":\"%%s\",\"name\":\"T\",\"tempo_bpm\":120,"
        "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
        "{\"name\":\"A\",\"clips\":["
        "{\"source\":\"Grooves/120 Intro Half-Time Stick.mid\",\"start_bar\":0,\"end_bar\":1}"
        "],\"chords\":[{\"root\":\"C\",\"quality\":\"maj\",\"bass\":\"\"}]}"
        "],\"instruments\":["
        "{\"enabled\":true,\"output\":\"schwung\",\"channel\":1,\"octave\":3,\"follow_note\":0,"
        "\"voicing\":\"bass\",\"note_gap\":0.125,"
        "\"overrides\":["
        "{\"section\":99,\"bar\":99,\"octave\":7},"
        "{\"section\":0,\"bar\":0,\"octave\":5}"
        "]}"
        "]}");
    snprintf(json, sizeof(json), tmpl, folder_name);
    run_song(json);
    /* section 0 bar 0's own override (octave 5) must still apply: base
     * (5+1)*12=72, root C (pc0) -> note 72. The out-of-range entry
     * (section 99) must simply be ignored, not crash and not affect bar 0. */
    CHECK(captured_has_note(0x90, 72), "out-of-range override ignored; the real bar-0 override (octave 5, note 72) still applies");

    /* --- Test 4: a "bars" array shorter than the section's actual bar
     * count leaves the remaining (unspecified) bars at their "on"
     * default. Only bar 0 is explicitly muted; bars 1 and 2 have no entry
     * at all in the array and must still sound. --- */
    snprintf(tmpl, sizeof(tmpl),
        "{\"source_folder\":\"%%s\",\"name\":\"T\",\"tempo_bpm\":120,"
        "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
        "{\"name\":\"A\",\"clips\":["
        "{\"source\":\"Grooves/120 Intro Half-Time Stick.mid\",\"start_bar\":0,\"end_bar\":1},"
        "{\"source\":\"Grooves/120 Verse Half-Time.mid\",\"start_bar\":1,\"end_bar\":2},"
        "{\"source\":\"Grooves/120 Bridge Half-Time.mid\",\"start_bar\":2,\"end_bar\":3}"
        "],\"chords\":["
        "{\"root\":\"C\",\"quality\":\"maj\",\"bass\":\"\"},"
        "{\"root\":\"D\",\"quality\":\"maj\",\"bass\":\"\"},"
        "{\"root\":\"E\",\"quality\":\"maj\",\"bass\":\"\"}"
        "]}"
        "],\"instruments\":["
        "{\"enabled\":true,\"output\":\"schwung\",\"channel\":1,\"octave\":3,\"follow_note\":0,"
        "\"voicing\":\"bass\",\"note_gap\":0.125,"
        "\"bars\":[[0]]}"
        "]}");
    snprintf(json, sizeof(json), tmpl, folder_name);
    run_song(json);
    /* C(pc0)->48 muted (bars[0][0]=0); D(pc2)->50 and E(pc4)->52 have no
     * entry in the sparse bars array and must default to "on". */
    CHECK(!captured_has_note(0x90, 48), "short bars array: bar 0's explicit mute (0) still applies");
    CHECK(captured_has_note(0x90, 50), "short bars array: bar 1 (no entry) defaults to on");
    CHECK(captured_has_note(0x90, 52), "short bars array: bar 2 (no entry) defaults to on");

    /* --- Test 5: unknown/extra JSON fields (top-level and per-instrument)
     * are ignored rather than breaking the parse of fields that follow
     * them. --- */
    snprintf(tmpl, sizeof(tmpl),
        "{\"source_folder\":\"%%s\",\"name\":\"T\",\"tempo_bpm\":120,"
        "\"time_sig_num\":4,\"time_sig_den\":4,\"totally_unknown_field\":{\"nested\":[1,2,3]},"
        "\"sections\":["
        "{\"name\":\"A\",\"clips\":["
        "{\"source\":\"Grooves/120 Intro Half-Time Stick.mid\",\"start_bar\":0,\"end_bar\":1}"
        "],\"chords\":[{\"root\":\"C\",\"quality\":\"maj\",\"bass\":\"\"}]}"
        "],\"instruments\":["
        "{\"enabled\":true,\"output\":\"schwung\",\"channel\":1,\"unknown_instrument_field\":\"xyz\","
        "\"octave\":3,\"follow_note\":0,\"voicing\":\"bass\",\"note_gap\":0.125}"
        "]}");
    snprintf(json, sizeof(json), tmpl, folder_name);
    run_song(json);
    CHECK(captured_has_note(0x90, 48), "unknown top-level and per-instrument fields don't break parsing of the fields around them");

    if (g_failures == 0) {
        printf("\nALL TESTS PASSED\n");
    } else {
        printf("\n%d TEST(S) FAILED\n", g_failures);
    }
    g_api->destroy_instance(g_inst);
    return g_failures == 0 ? 0 : 1;
}
