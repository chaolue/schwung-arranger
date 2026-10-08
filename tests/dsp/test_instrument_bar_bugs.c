/*
 * Regression tests for two bugs found (and fixed) while investigating a
 * real user-reported "instrument not playing even when unmuted" song:
 *
 * 1. parse_instrument_bars only correctly attributed per-bar mute data to a
 *    song's FIRST section -- every section after it had its digits silently
 *    concatenated into section 0's array at shifted bar indices (it keyed
 *    the section boundary off the array's own single outer '[', which only
 *    fires once, instead of each inner section array's own '['). On any
 *    multi-section song, this could both wrongly mute section 0's bars
 *    (corrupted by a later section's mute data) AND fail to apply a later
 *    section's own intended mutes (since the section index never actually
 *    advanced) -- exactly the real-world symptom reported.
 *
 * 2. emit_instruments_at_tick never retriggered a note-on for an explicit
 *    chord repeated on consecutive bars (it only fired on an actual chord
 *    CHANGE) -- a bar carrying its own explicit chord entry that happens to
 *    match the previous bar's chord was silently treated as "still the same
 *    held note" instead of a fresh attack.
 *
 * Build (plain):
 *   gcc -Wall -Wextra -g -pthread tests/dsp/test_instrument_bar_bugs.c \
 *       src/dsp/arranger_engine.c -Isrc/dsp -ldl -lm -o /tmp/test_instrument_bar_bugs
 * Build (ThreadSanitizer / ASan+UBSan): same as test_instrument_overrides.c.
 *
 * Usage: test_instrument_bar_bugs <library_root>
 * Expects the "Song 13" fixture (see test_async_channels.c).
 */

#include "test_common.h"

int main(int argc, char **argv) {
    if (argc < 2) { fprintf(stderr, "usage: %s <library_root>\n", argv[0]); return 1; }
    const char *library_root = argv[1];

    host_api_v1_t host = make_test_host();
    plugin_api_v2_t *api = move_plugin_init_v2(&host);
    void *inst = api->create_instance("/tmp/test_instrument_bar_bugs", NULL);
    if (!inst) { fprintf(stderr, "create_instance failed\n"); return 1; }

    char folder_name[128];
    if (!find_song13_folder(api, inst, library_root, folder_name, sizeof(folder_name))) {
        api->destroy_instance(inst);
        return 1;
    }

    /* Section A (2 bars): explicit C major on BOTH bars -- tests that an
     * explicit repeated chord retriggers (fix 2). Its instrument bars entry
     * is EMPTY ([]) -- both bars should stay on by default; under the old
     * parse_instrument_bars bug, section B's mute digit below would leak
     * into THIS section's array and wrongly mute bar 0 here (fix 1).
     * Section B (1 bar): explicit D major, and explicitly MUTED via the
     * instrument's bars map -- must never sound; under the old bug this
     * mute would never actually apply (section index stuck at 0), so D
     * (note 50) would incorrectly play. */
    const char *song_json_tmpl =
        "{\"source_folder\":\"%s\",\"name\":\"BarBugsTest\",\"tempo_bpm\":120,"
        "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
        "{\"name\":\"A\",\"clips\":["
        "{\"source\":\"Grooves/120 Intro Half-Time Stick.mid\",\"start_bar\":0,\"end_bar\":1},"
        "{\"source\":\"Grooves/120 Verse Half-Time.mid\",\"start_bar\":1,\"end_bar\":2}"
        "],\"chords\":[{\"root\":\"C\",\"quality\":\"maj\",\"bass\":\"\"},{\"root\":\"C\",\"quality\":\"maj\",\"bass\":\"\"}]},"
        "{\"name\":\"B\",\"clips\":["
        "{\"source\":\"Grooves/120 Bridge Half-Time.mid\",\"start_bar\":0,\"end_bar\":1}"
        "],\"chords\":[{\"root\":\"D\",\"quality\":\"maj\",\"bass\":\"\"}]}"
        "],\"instruments\":["
        "{\"enabled\":true,\"output\":\"schwung\",\"channel\":1,\"octave\":3,\"follow_note\":0,"
        "\"voicing\":\"bass\",\"note_gap\":0.125,"
        "\"bars\":[[],[0]]}"
        "]}";
    char song_json[4096];
    snprintf(song_json, sizeof(song_json), song_json_tmpl, folder_name);

    uint32_t base_primary = state_u32(api, inst, "primary_published_gen");
    api->set_param(inst, "song_json", song_json);
    CHECK(wait_field_change(api, inst, "primary_published_gen", base_primary, 3000),
          "primary channel published");

    api->set_param(inst, "loop", "0");
    api->set_param(inst, "play", "1");

    /* 3 bars at 120bpm 4/4 = 6s; bounded generously. */
    int16_t audio[MOVE_FRAMES_PER_BLOCK * 2];
    for (int b = 0; b < 5000; b++) {
        api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
    }
    api->set_param(inst, "stop", "1");

    /* C major, bass voicing, octave 3 -> base (3+1)*12 = 48, root C (pc 0)
     * -> note 48. */
    int c_on_count = count_note(0x90, 48);
    /* D major, same octave/voicing -> base 48, root D (pc 2) -> note 50. */
    int d_on_count = count_note(0x90, 50);

    /* Fix 1 (section attribution): section A's bar 0 must actually sound --
     * under the old bug it would have been silently corrupted to muted by
     * section B's mute digit leaking into section A's array. */
    CHECK(c_on_count >= 1, "fix 1: section A bar 0 (C) plays -- not corrupted by section B's mute data");

    /* Fix 1 (the other direction): section B's own explicit mute must
     * actually apply -- under the old bug the section index never advanced
     * past 0, so section B's mute never really wrote anywhere and D would
     * incorrectly sound. */
    CHECK(d_on_count == 0, "fix 1: section B bar 0 (D) never sounds -- its own mute correctly applies");

    /* Fix 2 (explicit-repeat retrigger): section A's bar 0 and bar 1 both
     * carry an explicit C chord -- must be two separate attacks (note-on
     * fired twice), not one bar silently holding into the next. */
    CHECK(c_on_count >= 2, "fix 2: explicit repeated chord on consecutive bars retriggers (2+ note-ons)");

    printf("captured %d events total (C note-ons=%d, D note-ons=%d)\n",
           g_captured_count, c_on_count, d_on_count);

    if (g_failures == 0) {
        printf("\nALL TESTS PASSED\n");
    } else {
        printf("\n%d TEST(S) FAILED\n", g_failures);
    }
    api->destroy_instance(inst);
    return g_failures == 0 ? 0 : 1;
}
