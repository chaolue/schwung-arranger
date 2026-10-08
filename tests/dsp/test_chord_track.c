/*
 * Regression tests for the chord track's carry-forward, slash-bass, and
 * per-quality voicing behavior (chord_at_bar/chord_quality_intervals,
 * src/dsp/arranger_engine.c). Complements test_instrument_bar_bugs.c, which
 * already covers the EXPLICIT-repeat retrigger fix -- this file covers the
 * complementary "no explicit chord = hold, don't retrigger" case, the
 * slash-bass note, the full interval table (only "maj" was ever exercised
 * before this session), and a genuine chord-quality change correctly
 * cutting the old notes.
 *
 * Build (plain):
 *   gcc -Wall -Wextra -g -pthread tests/dsp/test_chord_track.c \
 *       src/dsp/arranger_engine.c -Isrc/dsp -ldl -lm -o /tmp/test_chord_track
 *
 * Usage: test_chord_track <library_root>
 * Expects the "Song 13" fixture (see test_async_channels.c).
 */

#include "test_common.h"

static plugin_api_v2_t *g_api;
static void *g_inst;

static void run_song(const char *song_json, int bars) {
    g_captured_count = 0;
    uint32_t base_primary = state_u32(g_api, g_inst, "primary_published_gen");
    g_api->set_param(g_inst, "song_json", song_json);
    CHECK(wait_field_change(g_api, g_inst, "primary_published_gen", base_primary, 3000),
          "song published");
    g_api->set_param(g_inst, "loop", "0");
    g_api->set_param(g_inst, "play", "1");
    int16_t audio[MOVE_FRAMES_PER_BLOCK * 2];
    /* ~2s/bar at 120bpm 4/4; bounded generously past bars*2s. */
    int blocks = (bars + 2) * 2000;
    for (int b = 0; b < blocks; b++) {
        g_api->render_block(g_inst, audio, MOVE_FRAMES_PER_BLOCK);
    }
    g_api->set_param(g_inst, "stop", "1");
}

int main(int argc, char **argv) {
    if (argc < 2) { fprintf(stderr, "usage: %s <library_root>\n", argv[0]); return 1; }
    const char *library_root = argv[1];

    host_api_v1_t host = make_test_host();
    g_api = move_plugin_init_v2(&host);
    g_inst = g_api->create_instance("/tmp/test_chord_track", NULL);
    if (!g_inst) { fprintf(stderr, "create_instance failed\n"); return 1; }

    char folder_name[128];
    if (!find_song13_folder(g_api, g_inst, library_root, folder_name, sizeof(folder_name))) {
        g_api->destroy_instance(g_inst);
        return 1;
    }

    char tmpl[8192], json[8192];

    /* --- Test 1: carry-forward, no retrigger. A chord set explicitly only
     * on bar 0 (the "chords" array has just one entry) holds across bars 1
     * and 2 with no explicit entry of their own -- exactly ONE note-on for
     * the whole 3-bar span, not one per bar. Bass voicing, octave 3, C major
     * -> base (3+1)*12=48, root C (pc 0) -> note 48. --- */
    snprintf(tmpl, sizeof(tmpl),
        "{\"source_folder\":\"%%s\",\"name\":\"T\",\"tempo_bpm\":120,"
        "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
        "{\"name\":\"A\",\"clips\":["
        "{\"source\":\"Grooves/120 Intro Half-Time Stick.mid\",\"start_bar\":0,\"end_bar\":1},"
        "{\"source\":\"Grooves/120 Verse Half-Time.mid\",\"start_bar\":1,\"end_bar\":2},"
        "{\"source\":\"Grooves/120 Bridge Half-Time.mid\",\"start_bar\":2,\"end_bar\":3}"
        "],\"chords\":[{\"root\":\"C\",\"quality\":\"maj\",\"bass\":\"\"}]}"
        "],\"instruments\":["
        "{\"enabled\":true,\"output\":\"schwung\",\"channel\":1,\"octave\":3,\"follow_note\":0,"
        "\"voicing\":\"bass\",\"note_gap\":0.125}"
        "]}");
    snprintf(json, sizeof(json), tmpl, folder_name);
    run_song(json, 3);
    CHECK(count_note(0x90, 48) == 1, "carry-forward: a chord set on bar 0 only produces exactly one note-on across 3 bars (no retrigger)");

    /* --- Test 2: slash bass. "bass":"G" on a C major chord must use G (pc
     * 7), not the root C (pc 0), for "bass" voicing -> note (3+1)*12+7=55,
     * never 48. --- */
    snprintf(tmpl, sizeof(tmpl),
        "{\"source_folder\":\"%%s\",\"name\":\"T\",\"tempo_bpm\":120,"
        "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
        "{\"name\":\"A\",\"clips\":["
        "{\"source\":\"Grooves/120 Intro Half-Time Stick.mid\",\"start_bar\":0,\"end_bar\":1}"
        "],\"chords\":[{\"root\":\"C\",\"quality\":\"maj\",\"bass\":\"G\"}]}"
        "],\"instruments\":["
        "{\"enabled\":true,\"output\":\"schwung\",\"channel\":1,\"octave\":3,\"follow_note\":0,"
        "\"voicing\":\"bass\",\"note_gap\":0.125}"
        "]}");
    snprintf(json, sizeof(json), tmpl, folder_name);
    run_song(json, 1);
    CHECK(captured_has_note(0x90, 55), "slash bass: C/G uses the slash note G (55), not the root");
    CHECK(!captured_has_note(0x90, 48), "slash bass: C/G does not use the plain root C (48)");

    /* --- Test 3: the full chord-quality interval table, one bar per
     * quality, each an explicit C-rooted chord (retriggers per-bar per the
     * explicit-repeat fix, so each bar's own notes are unambiguous), full
     * "chord" voicing, inversion 0 (root position), octave 3 -> base 48.
     * Expected absolute notes = 48 + each quality's own semitone intervals
     * (mirrors chord_quality_intervals in arranger_engine.c). --- */
    struct { const char *quality; int intervals[4]; int n; } qualities[] = {
        { "maj",  {0,4,7,0},   3 },
        { "min",  {0,3,7,0},   3 },
        { "dim",  {0,3,6,0},   3 },
        { "aug",  {0,4,8,0},   3 },
        { "7",    {0,4,7,10},  4 },
        { "m7",   {0,3,7,10},  4 },
        { "maj7", {0,4,7,11},  4 },
        { "dim7", {0,3,6,9},   4 },
        { "sus2", {0,2,7,0},   3 },
        { "sus4", {0,5,7,0},   3 },
    };
    const int n_qualities = (int)(sizeof(qualities) / sizeof(qualities[0]));
    const char *clip_sources[] = {
        "120 Intro Half-Time Stick.mid", "120 Verse Half-Time.mid", "120 Bridge Half-Time.mid",
        "120 Chorus 2 Half-Time.mid", "120 Chorus 1 Ride 8th.mid", "120 Outro Half-Time F1.mid",
        "120 Outro Half-Time F2.mid", "120 Outro Half-Time F3.mid", "120 Outro Half-Time F4.mid",
        "120 Outro Half-Time F5.mid",
    };
    char clips_buf[4096]; clips_buf[0] = '\0';
    char chords_buf[2048]; chords_buf[0] = '\0';
    for (int q = 0; q < n_qualities; q++) {
        char clip_entry[256];
        snprintf(clip_entry, sizeof(clip_entry),
            "%s{\"source\":\"Grooves/%s\",\"start_bar\":%d,\"end_bar\":%d}",
            q ? "," : "", clip_sources[q], q, q + 1);
        strncat(clips_buf, clip_entry, sizeof(clips_buf) - strlen(clips_buf) - 1);
        char chord_entry[64];
        snprintf(chord_entry, sizeof(chord_entry),
            "%s{\"root\":\"C\",\"quality\":\"%s\",\"bass\":\"\"}",
            q ? "," : "", qualities[q].quality);
        strncat(chords_buf, chord_entry, sizeof(chords_buf) - strlen(chords_buf) - 1);
    }
    snprintf(tmpl, sizeof(tmpl),
        "{\"source_folder\":\"%%s\",\"name\":\"T\",\"tempo_bpm\":120,"
        "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
        "{\"name\":\"A\",\"clips\":[%s],\"chords\":[%s]}"
        "],\"instruments\":["
        "{\"enabled\":true,\"output\":\"schwung\",\"channel\":1,\"octave\":3,\"follow_note\":0,"
        "\"voicing\":\"chord\",\"inversion\":0,\"note_gap\":0.125}"
        "]}", clips_buf, chords_buf);
    snprintf(json, sizeof(json), tmpl, folder_name);
    run_song(json, n_qualities);
    for (int q = 0; q < n_qualities; q++) {
        char msg[128];
        int all_present = 1;
        for (int i = 0; i < qualities[q].n; i++) {
            int note = 48 + qualities[q].intervals[i];
            if (!captured_has_note(0x90, note)) all_present = 0;
        }
        snprintf(msg, sizeof(msg), "chord quality '%s': all expected root-position notes present", qualities[q].quality);
        CHECK(all_present, msg);
    }

    /* --- Test 4: a real quality/root change cuts the old notes and starts
     * the new ones. Bar 0: C major (bass voicing, note 48). Bar 1: G7 (bass
     * voicing uses the root, G = pc 7 -> note (3+1)*12+7=55). Both notes
     * must appear, and 48 must be explicitly turned off (not just left
     * hanging under the new chord). --- */
    snprintf(tmpl, sizeof(tmpl),
        "{\"source_folder\":\"%%s\",\"name\":\"T\",\"tempo_bpm\":120,"
        "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
        "{\"name\":\"A\",\"clips\":["
        "{\"source\":\"Grooves/120 Intro Half-Time Stick.mid\",\"start_bar\":0,\"end_bar\":1},"
        "{\"source\":\"Grooves/120 Verse Half-Time.mid\",\"start_bar\":1,\"end_bar\":2}"
        "],\"chords\":["
        "{\"root\":\"C\",\"quality\":\"maj\",\"bass\":\"\"},"
        "{\"root\":\"G\",\"quality\":\"7\",\"bass\":\"\"}"
        "]}"
        "],\"instruments\":["
        "{\"enabled\":true,\"output\":\"schwung\",\"channel\":1,\"octave\":3,\"follow_note\":0,"
        "\"voicing\":\"bass\",\"note_gap\":0.125}"
        "]}");
    snprintf(json, sizeof(json), tmpl, folder_name);
    run_song(json, 2);
    CHECK(captured_has_note(0x90, 48), "chord change: bar 0 (C major bass, note 48) sounds");
    CHECK(captured_has_note(0x80, 48), "chord change: bar 0's note (48) is explicitly turned off, not left hanging");
    CHECK(captured_has_note(0x90, 55), "chord change: bar 1 (G7 bass, note 55) sounds");

    if (g_failures == 0) {
        printf("\nALL TESTS PASSED\n");
    } else {
        printf("\n%d TEST(S) FAILED\n", g_failures);
    }
    g_api->destroy_instance(g_inst);
    return g_failures == 0 ? 0 : 1;
}
