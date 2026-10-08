/*
 * Regression tests for transport control: play_from_bar seeking, loop wrap,
 * stop cutting off sounding notes, tempo/time-signature derivation, and the
 * Swap Guard "pushed note anticipates the next bar" window in
 * emit_instruments_follow (src/dsp/arranger_engine.c) -- previously untested
 * at this level; this session's other new tests only ever used swap_guard's
 * effectively-zero default.
 *
 * Build (plain):
 *   gcc -Wall -Wextra -g -pthread tests/dsp/test_transport.c \
 *       src/dsp/arranger_engine.c -Isrc/dsp -ldl -lm -o /tmp/test_transport
 *
 * Usage: test_transport <library_root>
 * Expects the "Song 13" fixture (see test_async_channels.c). The Swap Guard
 * test specifically relies on "Grooves/120 Verse Half-Time.mid" carrying a
 * kick hit just 3 ticks before a bar boundary (confirmed while developing
 * this suite -- raw tick 1917 against a 1920-tick bar boundary).
 */

#include "test_common.h"

static plugin_api_v2_t *g_api;
static void *g_inst;

int main(int argc, char **argv) {
    if (argc < 2) { fprintf(stderr, "usage: %s <library_root>\n", argv[0]); return 1; }
    const char *library_root = argv[1];

    host_api_v1_t host = make_test_host();
    g_api = move_plugin_init_v2(&host);
    g_inst = g_api->create_instance("/tmp/test_transport", NULL);
    if (!g_inst) { fprintf(stderr, "create_instance failed\n"); return 1; }

    char folder_name[128];
    if (!find_song13_folder(g_api, g_inst, library_root, folder_name, sizeof(folder_name))) {
        g_api->destroy_instance(g_inst);
        return 1;
    }

    char tmpl[8192], json[8192];
    int16_t audio[MOVE_FRAMES_PER_BLOCK * 2];

    /* --- Test 1: play_from_bar seeks to the exact bar, not just bar 0.
     * A 3-bar song (3 distinct clips), each with its own explicit chord;
     * play_from_bar(2) should land directly on bar 2's chord (E major bass,
     * octave 3 -> base 48 + E pc4 = 52) without ever sounding bar 0's (C,
     * note 48) or bar 1's (D, note 50) first. --- */
    snprintf(tmpl, sizeof(tmpl),
        "{\"source_folder\":\"%%s\",\"name\":\"T\",\"tempo_bpm\":120,"
        "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
        "{\"name\":\"A\",\"clips\":["
        "{\"source\":\"Grooves/120 Intro Half-Time Stick.mid\",\"start_bar\":0,\"end_bar\":1},"
        "{\"source\":\"Grooves/120 Bridge Half-Time.mid\",\"start_bar\":1,\"end_bar\":2},"
        "{\"source\":\"Grooves/120 Chorus 2 Half-Time.mid\",\"start_bar\":2,\"end_bar\":3}"
        "],\"chords\":["
        "{\"root\":\"C\",\"quality\":\"maj\",\"bass\":\"\"},"
        "{\"root\":\"D\",\"quality\":\"maj\",\"bass\":\"\"},"
        "{\"root\":\"E\",\"quality\":\"maj\",\"bass\":\"\"}"
        "]}"
        "],\"instruments\":["
        "{\"enabled\":true,\"output\":\"schwung\",\"channel\":1,\"octave\":3,\"follow_note\":0,"
        "\"voicing\":\"bass\",\"note_gap\":0.125}"
        "]}");
    snprintf(json, sizeof(json), tmpl, folder_name);
    g_captured_count = 0;
    uint32_t base_primary = state_u32(g_api, g_inst, "primary_published_gen");
    g_api->set_param(g_inst, "song_json", json);
    CHECK(wait_field_change(g_api, g_inst, "primary_published_gen", base_primary, 3000),
          "play_from_bar: song published");
    g_api->set_param(g_inst, "loop", "0");
    g_api->set_param(g_inst, "play_from_bar", "2");
    for (int b = 0; b < 2000; b++) g_api->render_block(g_inst, audio, MOVE_FRAMES_PER_BLOCK);
    stop_and_ring_out(g_api, g_inst);
    CHECK(captured_has_note(0x90, 52), "play_from_bar(2): lands directly on bar 2's chord (E, note 52)");
    CHECK(!captured_has_note(0x90, 48), "play_from_bar(2): bar 0's chord (C, note 48) never sounds");
    CHECK(!captured_has_note(0x90, 50), "play_from_bar(2): bar 1's chord (D, note 50) never sounds");

    /* --- Test 2: loop wrap. A 2-bar song (C then G), loop=1, run well past
     * several full cycles. wrap_counter must have advanced (confirms
     * looping actually happened), and every note that sounded must have an
     * equal number of note-offs by the time we stop -- nothing left stuck
     * across the wrap boundary. --- */
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
        "\"voicing\":\"bass\",\"note_gap\":0.125}"
        "]}");
    snprintf(json, sizeof(json), tmpl, folder_name);
    g_captured_count = 0;
    base_primary = state_u32(g_api, g_inst, "primary_published_gen");
    g_api->set_param(g_inst, "song_json", json);
    CHECK(wait_field_change(g_api, g_inst, "primary_published_gen", base_primary, 3000),
          "loop wrap: song published");
    g_api->set_param(g_inst, "loop", "1");
    g_api->set_param(g_inst, "play", "1");
    /* 2 bars ~= 4s at 120bpm; run ~20s so it wraps several times. */
    for (int b = 0; b < 7000; b++) g_api->render_block(g_inst, audio, MOVE_FRAMES_PER_BLOCK);
    char transport[1024];
    g_api->get_param(g_inst, "transport", transport, sizeof(transport));
    unsigned wrap_counter = 0;
    sscanf(strstr(transport, "\"wrap_counter\":"), "\"wrap_counter\":%u", &wrap_counter);
    CHECK(wrap_counter > 0, "loop wrap: wrap_counter advanced (looped at least once)");
    stop_and_ring_out(g_api, g_inst);
    /* base (3+1)*12=48; C(pc0)->48, G(pc7)->55. */
    CHECK(count_note(0x90, 48) == count_note(0x80, 48), "loop wrap: note 48 (C) has a matching off for every on, nothing stuck");
    CHECK(count_note(0x90, 55) == count_note(0x80, 55), "loop wrap: note 55 (G) has a matching off for every on, nothing stuck");
    CHECK(count_note(0x90, 48) > 1, "loop wrap: note 48 (C) actually retriggered across multiple wraps");

    /* --- Test 3: stop turns off a still-sounding note even though its
     * natural note_gap-scheduled off never fires. Run only a fraction of a
     * bar (well before the note-off is scheduled near the bar's end), then
     * stop, and confirm the note was explicitly turned off anyway -- once
     * the 10 s after-Stop hold that lets it ring out has ended. --- */
    snprintf(tmpl, sizeof(tmpl),
        "{\"source_folder\":\"%%s\",\"name\":\"T\",\"tempo_bpm\":120,"
        "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
        "{\"name\":\"A\",\"clips\":["
        "{\"source\":\"Grooves/120 Intro Half-Time Stick.mid\",\"start_bar\":0,\"end_bar\":1}"
        "],\"chords\":[{\"root\":\"C\",\"quality\":\"maj\",\"bass\":\"\"}]}"
        "],\"instruments\":["
        "{\"enabled\":true,\"output\":\"schwung\",\"channel\":1,\"octave\":3,\"follow_note\":0,"
        "\"voicing\":\"bass\",\"note_gap\":0.125}"
        "]}");
    snprintf(json, sizeof(json), tmpl, folder_name);
    g_captured_count = 0;
    base_primary = state_u32(g_api, g_inst, "primary_published_gen");
    g_api->set_param(g_inst, "song_json", json);
    CHECK(wait_field_change(g_api, g_inst, "primary_published_gen", base_primary, 3000),
          "early stop: song published");
    g_api->set_param(g_inst, "loop", "0");
    g_api->set_param(g_inst, "play", "1");
    /* A handful of blocks -- well under a quarter of the 2s bar, long
     * before the note_gap-scheduled off near the bar's end. */
    for (int b = 0; b < 50; b++) g_api->render_block(g_inst, audio, MOVE_FRAMES_PER_BLOCK);
    CHECK(captured_has_note(0x90, 48) && !captured_has_note(0x80, 48),
          "early stop: note 48 is sounding and has NOT naturally turned off yet");
    stop_and_ring_out(g_api, g_inst);
    CHECK(captured_has_note(0x80, 48), "early stop: stop explicitly turns off the still-sounding note");

    /* --- Test 4: tempo/time-signature derivation. A 3/4 song at 100bpm
     * must report exactly that back, with ticks_per_bar = 3 * ticks_per_beat
     * (not the 4/4 default). --- */
    snprintf(tmpl, sizeof(tmpl),
        "{\"source_folder\":\"%%s\",\"name\":\"T\",\"tempo_bpm\":100,"
        "\"time_sig_num\":3,\"time_sig_den\":4,\"sections\":["
        "{\"name\":\"A\",\"clips\":["
        "{\"source\":\"Grooves/120 Intro Half-Time Stick.mid\",\"start_bar\":0,\"end_bar\":1}"
        "]}]}");
    snprintf(json, sizeof(json), tmpl, folder_name);
    base_primary = state_u32(g_api, g_inst, "primary_published_gen");
    g_api->set_param(g_inst, "song_json", json);
    CHECK(wait_field_change(g_api, g_inst, "primary_published_gen", base_primary, 3000),
          "3/4 100bpm: song published");
    g_api->set_param(g_inst, "loop", "0");
    g_api->set_param(g_inst, "play", "1");
    for (int b = 0; b < 10; b++) g_api->render_block(g_inst, audio, MOVE_FRAMES_PER_BLOCK);
    g_api->get_param(g_inst, "transport", transport, sizeof(transport));
    stop_and_ring_out(g_api, g_inst);
    int ts_num = 0, ts_den = 0; double bpm = 0; unsigned tpbeat = 0, tpbar = 0;
    sscanf(strstr(transport, "\"time_sig_num\":"), "\"time_sig_num\":%d", &ts_num);
    sscanf(strstr(transport, "\"time_sig_den\":"), "\"time_sig_den\":%d", &ts_den);
    sscanf(strstr(transport, "\"bpm\":"), "\"bpm\":%lf", &bpm);
    sscanf(strstr(transport, "\"ticks_per_beat\":"), "\"ticks_per_beat\":%u", &tpbeat);
    sscanf(strstr(transport, "\"ticks_per_bar\":"), "\"ticks_per_bar\":%u", &tpbar);
    CHECK(ts_num == 3 && ts_den == 4, "3/4 100bpm: time signature reported correctly");
    CHECK(bpm > 99.0 && bpm < 101.0, "3/4 100bpm: tempo reported correctly");
    CHECK(tpbar == tpbeat * 3, "3/4 100bpm: ticks_per_bar = 3 * ticks_per_beat, not the 4/4 default");

    /* --- Test 5: Swap Guard "pushed note" window. A single clip instance
     * spanning the source's bars 1-2 (raw ticks 960-2880) carries kicks at
     * raw ticks 1078, 1196 (clearly within its own bar 0, assembled ticks
     * 118, 236) and 1917 (assembled tick 957 -- just 3 ticks before the
     * 960-tick bar boundary). With swap_guard_fraction wide enough to cover
     * that gap, the tick-957 kick must be treated as belonging to the NEXT
     * bar (its chord), not the bar it technically falls tick-wise within --
     * the two earlier kicks (118, 236) are unaffected and still fire the
     * CURRENT bar's chord. Bar 0 = C (bass, note 48), bar 1 = G (note 55);
     * with no guard, note 55 could only come from a kick actually inside
     * bar 1, and this clip's own window has none -- so note 55 appearing
     * at all is only explained by the guard window correctly reassigning
     * the pushed kick to bar 1. --- */
    g_api->set_param(g_inst, "swap_guard_fraction", "0.5");
    snprintf(tmpl, sizeof(tmpl),
        "{\"source_folder\":\"%%s\",\"name\":\"T\",\"tempo_bpm\":120,"
        "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
        "{\"name\":\"A\",\"clips\":["
        "{\"source\":\"Grooves/120 Verse Half-Time.mid\",\"start_bar\":1,\"end_bar\":3}"
        "],\"chords\":["
        "{\"root\":\"C\",\"quality\":\"maj\",\"bass\":\"\"},"
        "{\"root\":\"G\",\"quality\":\"maj\",\"bass\":\"\"}"
        "]}"
        "],\"instruments\":["
        "{\"enabled\":true,\"output\":\"schwung\",\"channel\":1,\"octave\":3,\"follow_note\":36,"
        "\"voicing\":\"bass\",\"note_gap\":0.125}"
        "]}");
    snprintf(json, sizeof(json), tmpl, folder_name);
    g_captured_count = 0;
    base_primary = state_u32(g_api, g_inst, "primary_published_gen");
    g_api->set_param(g_inst, "song_json", json);
    CHECK(wait_field_change(g_api, g_inst, "primary_published_gen", base_primary, 3000),
          "swap guard: song published");
    g_api->set_param(g_inst, "loop", "0");
    g_api->set_param(g_inst, "play", "1");
    for (int b = 0; b < 2000; b++) g_api->render_block(g_inst, audio, MOVE_FRAMES_PER_BLOCK);
    stop_and_ring_out(g_api, g_inst);
    CHECK(captured_has_note(0x90, 48), "swap guard: bar 0's chord (C, note 48) fires from the two early, non-pushed kicks");
    CHECK(captured_has_note(0x90, 55), "swap guard: the pushed kick (3 ticks before the boundary) fires bar 1's chord (G, note 55), not bar 0's");

    /* --- Test 6: Swap Guard duplicate-attack suppression. Investigated from
     * a real user report of "a distinct shortened note at the start of a
     * bar" in a song using "Grooves/096 Outro 42TF F8 Ritard.mid" (in the
     * "Song 07 4-4 096 BPM" folder of this same library), which was found
     * (by directly parsing the file) to carry a kick just 4 source ticks
     * before its own 4-bar (3840-tick) end, at tick 3836. NOTE: in the
     * user's actual song this specific clip is used with an explicit
     * per-clip guard_fraction (0.13, ~31 ticks) which -- confirmed while
     * building this test -- already suppresses that tick-3836 kick entirely
     * in build_timeline_targeted's own outgoing-boundary guard, before it
     * ever reaches emit_instruments_follow; the reported bug's exact cause
     * in THAT song is therefore still open (see the reply to the user).
     * What IS a genuine, independently-confirmed bug: with little/no
     * per-clip guard_fraction (0 here, isolating the mechanism), a kick that
     * close to a bar boundary gets correctly reassigned to the NEXT bar's
     * chord by the Swap Guard window (swap_guard_fraction, default 0.25
     * beat = 60 ticks at ticks_per_beat=240) -- and when this SAME clip is
     * placed a second time immediately after (as an 8-bar section built
     * from two 4-bar copies), that second copy's own downbeat kick lands
     * only ~4 ticks later, firing a SECOND, redundant note-on for the same
     * chord with a near-zero-length gap from the first. Fixed by
     * recognizing a second same-chord follow-note hit within the guard
     * window of the first as the same logical attack rather than a fresh
     * one. Exact expected note-on count for the count-check below was
     * derived from this clip's own known kick positions (verified against
     * the fix, and confirmed the pre-fix count is exactly one higher). */
    snprintf(tmpl, sizeof(tmpl),
        "{\"source_folder\":\"%%s\",\"name\":\"T\",\"tempo_bpm\":120,\"ppq\":240,"
        "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
        "{\"name\":\"Intro\",\"clips\":["
        "{\"source\":\"Grooves/096 Outro 42TF F8 Ritard.mid\",\"source_folder\":\"Song 07 4-4 096 BPM\",\"start_bar\":0,\"end_bar\":4,\"guard_fraction\":0},"
        "{\"source\":\"Grooves/096 Outro 42TF F8 Ritard.mid\",\"source_folder\":\"Song 07 4-4 096 BPM\",\"start_bar\":0,\"end_bar\":4,\"guard_fraction\":0}"
        "],\"chords\":["
        "{\"root\":\"D\",\"quality\":\"maj\",\"bass\":\"\"},"
        "{\"root\":\"D\",\"quality\":\"maj\",\"bass\":\"\"},"
        "{\"root\":\"G\",\"quality\":\"maj\",\"bass\":\"\"},"
        "{\"root\":\"G\",\"quality\":\"maj\",\"bass\":\"\"},"
        "{\"root\":\"D\",\"quality\":\"maj\",\"bass\":\"\"},"
        "{\"root\":\"D\",\"quality\":\"maj\",\"bass\":\"\"},"
        "{\"root\":\"G\",\"quality\":\"maj\",\"bass\":\"\"},"
        "{\"root\":\"G\",\"quality\":\"maj\",\"bass\":\"\"}"
        "]}"
        "],\"instruments\":["
        "{\"enabled\":true,\"output\":\"schwung\",\"channel\":1,\"octave\":3,\"follow_note\":36,"
        "\"voicing\":\"bass\",\"note_gap\":0.125}"
        "]}");
    snprintf(json, sizeof(json), tmpl, folder_name);
    g_captured_count = 0;
    base_primary = state_u32(g_api, g_inst, "primary_published_gen");
    g_api->set_param(g_inst, "swap_guard_fraction", "0.25");
    g_api->set_param(g_inst, "song_json", json);
    CHECK(wait_field_change(g_api, g_inst, "primary_published_gen", base_primary, 3000),
          "swap guard duplicate-attack: song published");
    g_api->set_param(g_inst, "loop", "0");
    g_api->set_param(g_inst, "play", "1");
    /* 8 bars at 120bpm 4/4 = 16s; bounded generously. */
    for (int b = 0; b < 8000; b++) g_api->render_block(g_inst, audio, MOVE_FRAMES_PER_BLOCK);
    stop_and_ring_out(g_api, g_inst);
    /* D (pc2) bass, octave 3 -> base 48 + 2 = 50. */
    CHECK(captured_has_note(0x90, 50), "swap guard duplicate-attack: chord D (note 50) sounds");
    /* Exact count, derived from this clip's own known kick positions: 9
     * kicks in bars 0-1 (D) + 1 pushed kick (source tick 3836, reassigned
     * to D at the seam) + 8 of the second copy's own 9 bar-4/5 kicks (its
     * own tick-0 downbeat is the duplicate this fix suppresses) = 18. The
     * pre-fix count is exactly 19 (confirmed directly while developing this
     * test, by temporarily reverting just this fix). */
    CHECK(count_note(0x90, 50) == 18,
          "swap guard duplicate-attack: exactly 18 D attacks, not 19 (the seam's redundant retrigger is suppressed)");

    /* --- Test 7: the Swap Guard's anticipated note must survive the bar
     * boundary it anticipated, not get cut off the instant the playhead
     * actually crosses it. Real user report: "a distinct shortened note at
     * the start of a bar" -- traced to emit_instruments_at_tick's
     * bar-boundary cleanup, which unconditionally sent a note-off for any
     * still-sounding instrument note whenever the current bar is follow-note
     * mode, on the assumption a leftover note could only be stale (held over
     * from a bar-boundary-mode bar via a per-bar override). That assumption
     * is wrong when the sounding note is the follow path's OWN note,
     * anticipated a few ticks early by the Swap Guard window right before
     * this exact boundary: the cleanup fired immediately at the boundary and
     * killed it before its own note_gap-scheduled off ever got a chance to.
     * Reuses Test 5's exact song (single clip, bars 1-3 of "Grooves/120
     * Verse Half-Time.mid", one pushed kick 3 ticks before the 960-tick
     * bar 0/1 boundary). Bar 1 has its own next kick at relative tick 1196
     * (raw 2156), so the follow path's own note_gap-based scheduling for the
     * anticipated note should hold it until 1196 - gap(30) = 1166 -- not cut
     * it off the instant the 960 boundary is crossed. Buggy behavior fires
     * an extra, immediate off around tick 961; fixed behavior holds to
     * ~1166. Polling the transport every block distinguishes the two
     * directly by tick (confirmed empirically against both the buggy and
     * fixed engine while developing this test: 961 vs 1165). */
    g_api->set_param(g_inst, "swap_guard_fraction", "0.5");
    snprintf(tmpl, sizeof(tmpl),
        "{\"source_folder\":\"%%s\",\"name\":\"T\",\"tempo_bpm\":120,"
        "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
        "{\"name\":\"A\",\"clips\":["
        "{\"source\":\"Grooves/120 Verse Half-Time.mid\",\"start_bar\":1,\"end_bar\":3}"
        "],\"chords\":["
        "{\"root\":\"C\",\"quality\":\"maj\",\"bass\":\"\"},"
        "{\"root\":\"G\",\"quality\":\"maj\",\"bass\":\"\"}"
        "]}"
        "],\"instruments\":["
        "{\"enabled\":true,\"output\":\"schwung\",\"channel\":1,\"octave\":3,\"follow_note\":36,"
        "\"voicing\":\"bass\",\"note_gap\":0.125}"
        "]}");
    snprintf(json, sizeof(json), tmpl, folder_name);
    g_captured_count = 0;
    base_primary = state_u32(g_api, g_inst, "primary_published_gen");
    g_api->set_param(g_inst, "song_json", json);
    CHECK(wait_field_change(g_api, g_inst, "primary_published_gen", base_primary, 3000),
          "anticipated note survives boundary: song published");
    g_api->set_param(g_inst, "loop", "0");
    g_api->set_param(g_inst, "play", "1");
    int off55_tick = -1;
    int prev_captured = g_captured_count;
    for (int b = 0; b < 2000; b++) {
        g_api->render_block(g_inst, audio, MOVE_FRAMES_PER_BLOCK);
        if (g_captured_count > prev_captured) {
            char t[1024];
            g_api->get_param(g_inst, "transport", t, sizeof(t));
            unsigned bar = 0, beat = 0, tpbeat = 0, tpbar = 0;
            double beat_progress = 0.0;
            sscanf(strstr(t, "\"bar\":"), "\"bar\":%u", &bar);
            sscanf(strstr(t, "\"beat\":"), "\"beat\":%u", &beat);
            sscanf(strstr(t, "\"beat_progress\":"), "\"beat_progress\":%lf", &beat_progress);
            sscanf(strstr(t, "\"ticks_per_beat\":"), "\"ticks_per_beat\":%u", &tpbeat);
            sscanf(strstr(t, "\"ticks_per_bar\":"), "\"ticks_per_bar\":%u", &tpbar);
            int abs_tick = (int)((bar - 1) * tpbar + (beat - 1) * tpbeat + beat_progress * tpbeat);
            for (int c = prev_captured; c < g_captured_count; c++) {
                if (off55_tick < 0 && g_captured[c].status == 0x80 && g_captured[c].note == 55) {
                    off55_tick = abs_tick;
                }
            }
            prev_captured = g_captured_count;
        }
    }
    stop_and_ring_out(g_api, g_inst);
    CHECK(captured_has_note(0x90, 55), "anticipated note survives boundary: bar 1's chord (G, note 55) still fires");
    CHECK(off55_tick >= 0, "anticipated note survives boundary: note 55 got an off at all (not left stuck)");
    /* Buggy: cut off within a handful of ticks of the 960 boundary (~961).
     * Fixed: held until the note_gap-scheduled off ahead of bar 1's own next
     * kick (~1166). 1050 sits comfortably between the two. */
    CHECK(off55_tick > 1050,
          "anticipated note survives boundary: note 55's off is scheduled off its own next kick (~1166), not an immediate cutoff at the 960 boundary (~961)");

    if (g_failures == 0) {
        printf("\nALL TESTS PASSED\n");
    } else {
        printf("\n%d TEST(S) FAILED\n", g_failures);
    }
    g_api->destroy_instance(g_inst);
    return g_failures == 0 ? 0 : 1;
}
