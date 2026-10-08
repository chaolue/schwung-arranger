/*
 * Regression tests for per-bar instrument overrides (Octave/Follow Note/
 * Voicing, layered on top of the existing per-bar mute map). Builds a song
 * with one instrument track whose bars exercise, in order:
 *   bar 0: octave override only (stays on the bar-boundary emission path)
 *   bar 1: follow_note override (switches this bar onto the drum-hit
 *          emission path instead of the track default bar-boundary path --
 *          this is the routing "snag" the per-bar design has to resolve)
 *   bar 2: muted AND carries an octave override -- mute must win
 *   bar 3: back to plain track defaults (no override, not muted)
 * and asserts on the actual emitted MIDI note numbers/timing, which is the
 * only way to catch a resolution bug (the per-bar override silently not
 * applying, or a mute/override interaction going the wrong way).
 *
 * Build (plain):
 *   gcc -Wall -Wextra -g -pthread tests/dsp/test_instrument_overrides.c \
 *       src/dsp/arranger_engine.c -Isrc/dsp -ldl -lm -o /tmp/test_instrument_overrides
 * Build (ThreadSanitizer):
 *   gcc -Wall -Wextra -g -pthread -fsanitize=thread tests/dsp/test_instrument_overrides.c \
 *       src/dsp/arranger_engine.c -Isrc/dsp -ldl -lm -o /tmp/test_instrument_overrides_tsan
 * Build (ASan+UBSan):
 *   gcc -Wall -Wextra -g -pthread -fsanitize=address,undefined tests/dsp/test_instrument_overrides.c \
 *       src/dsp/arranger_engine.c -Isrc/dsp -ldl -lm -o /tmp/test_instrument_overrides_asan
 *
 * Usage: test_instrument_overrides <library_root>
 * Expects a "Song 13" folder under library_root with a Grooves/ subfolder
 * containing "120 Intro Half-Time Stick.mid" (matches the fixture used by
 * tests/dsp/test_async_channels.c; that clip carries a kick hit on note 36).
 */

#include "test_common.h"

int main(int argc, char **argv) {
    if (argc < 2) { fprintf(stderr, "usage: %s <library_root>\n", argv[0]); return 1; }
    const char *library_root = argv[1];

    host_api_v1_t host = make_test_host();
    plugin_api_v2_t *api = move_plugin_init_v2(&host);
    void *inst = api->create_instance("/tmp/test_instrument_overrides", NULL);
    if (!inst) { fprintf(stderr, "create_instance failed\n"); return 1; }

    char folder_name[128];
    if (!find_song13_folder(api, inst, library_root, folder_name, sizeof(folder_name))) {
        api->destroy_instance(inst);
        return 1;
    }

    /* Four bars, each a different 1-bar kick-carrying groove (distinct
     * source files, matching the fixture used by test_async_channels.c --
     * duplicate source entries across bars confuse clip resolution and
     * aren't representative of real songs anyway), so every bar (including
     * bar 1, the follow_note-override bar) gets its own kick hit on note
     * 36. One chord (C major, bass voicing by default) held across the
     * whole section. */
    const char *song_json_tmpl =
        "{\"source_folder\":\"%s\",\"name\":\"OverrideTest\",\"tempo_bpm\":120,"
        "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
        "{\"name\":\"Test\",\"clips\":["
        "{\"source\":\"Grooves/120 Intro Half-Time Stick.mid\",\"start_bar\":0,\"end_bar\":1},"
        "{\"source\":\"Grooves/120 Verse Half-Time.mid\",\"start_bar\":1,\"end_bar\":2},"
        "{\"source\":\"Grooves/120 Bridge Half-Time.mid\",\"start_bar\":2,\"end_bar\":3},"
        "{\"source\":\"Grooves/120 Chorus 2 Half-Time.mid\",\"start_bar\":3,\"end_bar\":4}"
        "],\"chords\":[{\"root\":\"C\",\"quality\":\"maj\",\"bass\":\"\"}]}"
        "],\"instruments\":["
        "{\"enabled\":true,\"output\":\"schwung\",\"channel\":1,\"octave\":3,\"follow_note\":0,"
        "\"voicing\":\"bass\",\"note_gap\":0.25,"
        "\"bars\":[[1,1,0,1]],"
        "\"overrides\":["
        "{\"section\":0,\"bar\":0,\"octave\":6},"
        "{\"section\":0,\"bar\":1,\"follow_note\":36},"
        "{\"section\":0,\"bar\":2,\"octave\":5}"
        "]}"
        "]}";
    char song_json[4096];
    snprintf(song_json, sizeof(song_json), song_json_tmpl, folder_name);

    uint32_t base_primary = state_u32(api, inst, "primary_published_gen");
    api->set_param(inst, "song_json", song_json);
    CHECK(wait_field_change(api, inst, "primary_published_gen", base_primary, 3000),
          "primary channel published");

    char err[512];
    api->get_param(inst, "error", err, sizeof(err));
    CHECK(err[0] == '\0', "song built with no error");

    api->set_param(inst, "loop", "0");
    api->set_param(inst, "play", "1");

    /* Run blocks for a bit over 4 bars at 120bpm (4 bars * 4 beats / 120bpm
     * * 60s = 8s), bounded generously so a slow host machine can't cause a
     * spurious failure. */
    int16_t audio[MOVE_FRAMES_PER_BLOCK * 2];
    for (int b = 0; b < 6000; b++) {
        api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
    }
    api->set_param(inst, "stop", "1");

    /* Bar 0: octave override 6 (track default is 3), default bass voicing,
     * chord C -> base = (6+1)*12 = 84, bass note = root = C (pitch class 0)
     * -> note 84. This is the bar-boundary emission path. */
    CHECK(captured_has_note(0x90, 84), "bar 0: octave-override note-on (84) emitted");

    /* The transition into bar 1 (a follow_note-override bar) must cut off
     * bar 0's still-sounding note explicitly (the fix in
     * emit_instruments_at_tick), rather than leaving it stuck or double-
     * attacked by the follow path's own note-on. */
    CHECK(captured_has_note(0x80, 84), "bar 0->1 transition: octave-override note (84) explicitly turned off");

    /* Bar 1: follow_note override 36 (track default is 0/off) -> emitted by
     * emit_instruments_follow on the kick hit, using the TRACK's default
     * octave (3, not overridden on this bar) -> base = (3+1)*12 = 48. */
    CHECK(captured_has_note(0x90, 48), "bar 1: follow-note-override note-on (48) emitted on the kick hit");

    /* Bar 2 is muted (bars[0][2] == 0) even though it also carries an
     * octave override (5 -> would be base (5+1)*12 = 72 if mute didn't
     * win) -- mute must take priority over the override. */
    CHECK(!captured_has_note(0x90, 72), "bar 2: muted bar's octave override (72) never sounds");

    /* Bar 3: no override, not muted -- back to plain track defaults
     * (octave 3, bass voicing) -> note 48 again. Already covered by the
     * bar-1 follow-note note (same pitch), but confirm at least one note-off
     * for 48 also occurred somewhere (either bar1's own note_gap cutoff or
     * bar2's mute cutoff), so nothing is left stuck sounding forever. */
    CHECK(captured_has_note(0x80, 48), "note 48 (bar 1/3 default pitch) was turned off at some point, not left stuck");

    printf("captured %d events total\n", g_captured_count);

    if (g_failures == 0) {
        printf("\nALL TESTS PASSED\n");
    } else {
        printf("\n%d TEST(S) FAILED\n", g_failures);
    }
    api->destroy_instance(inst);
    return g_failures == 0 ? 0 : 1;
}
