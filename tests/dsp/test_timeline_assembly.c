/*
 * Regression tests for drum-clip timeline assembly (build_timeline_targeted
 * and its trim/speed/velocity/snare/kick/channel helpers,
 * src/dsp/arranger_engine.c:1298-1700ish) -- previously untested at this
 * level (existing tests only exercise instrument-track behavior driven off
 * an already-assembled timeline).
 *
 * Drum events are normally queued for the JS UI to poll via
 * get_param("events"), not sent through a host MIDI callback -- so these
 * tests use set_param("emit_directly","1") + set_param("output_target",
 * "schwung") to route them synchronously through midi_send_internal instead,
 * where the shared test_common.h capture stub can see them (channel field
 * included, unlike the instrument-only tests).
 *
 * Build (plain):
 *   gcc -Wall -Wextra -g -pthread tests/dsp/test_timeline_assembly.c \
 *       src/dsp/arranger_engine.c -Isrc/dsp -ldl -lm -o /tmp/test_timeline_assembly
 *
 * Usage: test_timeline_assembly <library_root>
 * Expects the "Song 13" fixture (see test_async_channels.c). Reuses four of
 * its Grooves clips, confirmed (this session) to carry: kick hits on note 36
 * (Intro Half-Time Stick, Verse Half-Time, Bridge Half-Time, Chorus 2
 * Half-Time) and a snare hit on note 38 (Verse Half-Time).
 */

#include "test_common.h"

static plugin_api_v2_t *g_api;
static void *g_inst;

/* Build+play the given song JSON, run it out, and return timeline_info's
 * total_bars/count/end_tick. Resets the capture buffer and stops playback
 * first so each call starts clean. */
static void run_song(const char *song_json, int *out_count, uint32_t *out_end_tick, uint32_t *out_total_bars) {
    g_captured_count = 0;
    uint32_t base_primary = state_u32(g_api, g_inst, "primary_published_gen");
    g_api->set_param(g_inst, "song_json", song_json);
    CHECK(wait_field_change(g_api, g_inst, "primary_published_gen", base_primary, 3000),
          "song published");

    char info[512];
    g_api->get_param(g_inst, "timeline_info", info, sizeof(info));
    int count = 0; unsigned end_tick = 0, total_bars = 0;
    sscanf(info, "{\"count\":%d,\"end_tick\":%u,\"total_bars\":%u}", &count, &end_tick, &total_bars);
    if (out_count) *out_count = count;
    if (out_end_tick) *out_end_tick = end_tick;
    if (out_total_bars) *out_total_bars = total_bars;

    g_api->set_param(g_inst, "loop", "0");
    g_api->set_param(g_inst, "play", "1");
    int16_t audio[MOVE_FRAMES_PER_BLOCK * 2];
    for (int b = 0; b < 6000; b++) {
        g_api->render_block(g_inst, audio, MOVE_FRAMES_PER_BLOCK);
    }
    g_api->set_param(g_inst, "stop", "1");
}

int main(int argc, char **argv) {
    if (argc < 2) { fprintf(stderr, "usage: %s <library_root>\n", argv[0]); return 1; }
    const char *library_root = argv[1];

    host_api_v1_t host = make_test_host();
    g_api = move_plugin_init_v2(&host);
    g_inst = g_api->create_instance("/tmp/test_timeline_assembly", NULL);
    if (!g_inst) { fprintf(stderr, "create_instance failed\n"); return 1; }

    char folder_name[128];
    if (!find_song13_folder(g_api, g_inst, library_root, folder_name, sizeof(folder_name))) {
        g_api->destroy_instance(g_inst);
        return 1;
    }

    /* Route the drum timeline itself through midi_send_internal so the
     * capture stub can see it (see file header). */
    g_api->set_param(g_inst, "emit_directly", "1");
    g_api->set_param(g_inst, "output_target", "schwung");
    g_api->set_param(g_inst, "schwung_channel", "0");

    char tmpl[2048], json[4096];

    /* --- Test 1: multi-clip assembly -- three distinct 1-bar clips placed
     * back to back produce a 3-bar total, one bar contributed by each. --- */
    snprintf(tmpl, sizeof(tmpl),
        "{\"source_folder\":\"%%s\",\"name\":\"T\",\"tempo_bpm\":120,"
        "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
        "{\"name\":\"A\",\"clips\":["
        "{\"source\":\"Grooves/120 Intro Half-Time Stick.mid\",\"start_bar\":0,\"end_bar\":1},"
        "{\"source\":\"Grooves/120 Verse Half-Time.mid\",\"start_bar\":1,\"end_bar\":2},"
        "{\"source\":\"Grooves/120 Bridge Half-Time.mid\",\"start_bar\":2,\"end_bar\":3}"
        "]}]}");
    snprintf(json, sizeof(json), tmpl, folder_name);
    { uint32_t total_bars = 0;
      run_song(json, NULL, NULL, &total_bars);
      CHECK(total_bars == 3, "multi-clip assembly: 3 one-bar clips -> 3-bar total"); }

    /* --- Test 2: start_beat trim reduces event count. A clip trimmed to
     * just its last beat must produce strictly fewer captured note-on/off
     * events than the same clip played whole (a real drum groove has events
     * spread across all 4 beats of its bar). --- */
    snprintf(tmpl, sizeof(tmpl),
        "{\"source_folder\":\"%%s\",\"name\":\"T\",\"tempo_bpm\":120,"
        "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
        "{\"name\":\"A\",\"clips\":["
        "{\"source\":\"Grooves/120 Verse Half-Time.mid\",\"start_bar\":0,\"start_beat\":1,\"end_bar\":1,\"end_beat\":0}"
        "]}]}");
    snprintf(json, sizeof(json), tmpl, folder_name);
    int full_count = 0;
    run_song(json, &full_count, NULL, NULL);
    int full_events = g_captured_count;

    snprintf(tmpl, sizeof(tmpl),
        "{\"source_folder\":\"%%s\",\"name\":\"T\",\"tempo_bpm\":120,"
        "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
        "{\"name\":\"A\",\"clips\":["
        "{\"source\":\"Grooves/120 Verse Half-Time.mid\",\"start_bar\":0,\"start_beat\":4,\"end_bar\":1,\"end_beat\":0}"
        "]}]}");
    snprintf(json, sizeof(json), tmpl, folder_name);
    int trimmed_count = 0;
    run_song(json, &trimmed_count, NULL, NULL);
    int trimmed_events = g_captured_count;
    CHECK(trimmed_count < full_count, "start_beat trim: timeline_info.count drops when starting on beat 4 vs beat 1");
    CHECK(trimmed_events < full_events, "start_beat trim: captured events drop when starting on beat 4 vs beat 1");

    /* --- Test 3: speed scaling. 2x compresses a clip into roughly half the
     * ticks; 0.5x stretches it to roughly double. Compare against the same
     * clip at speed 1.0 (some tolerance for rounding). --- */
    snprintf(tmpl, sizeof(tmpl),
        "{\"source_folder\":\"%%s\",\"name\":\"T\",\"tempo_bpm\":120,"
        "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
        "{\"name\":\"A\",\"clips\":["
        "{\"source\":\"Grooves/120 Verse Half-Time.mid\",\"start_bar\":0,\"end_bar\":1,\"speed\":1.0}"
        "]}]}");
    snprintf(json, sizeof(json), tmpl, folder_name);
    uint32_t end_tick_1x = 0;
    run_song(json, NULL, &end_tick_1x, NULL);

    snprintf(tmpl, sizeof(tmpl),
        "{\"source_folder\":\"%%s\",\"name\":\"T\",\"tempo_bpm\":120,"
        "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
        "{\"name\":\"A\",\"clips\":["
        "{\"source\":\"Grooves/120 Verse Half-Time.mid\",\"start_bar\":0,\"end_bar\":1,\"speed\":2.0}"
        "]}]}");
    snprintf(json, sizeof(json), tmpl, folder_name);
    uint32_t end_tick_2x = 0;
    run_song(json, NULL, &end_tick_2x, NULL);
    CHECK(end_tick_1x > 0 && end_tick_2x > 0 &&
          end_tick_2x < end_tick_1x && end_tick_2x > end_tick_1x / 3,
          "speed=2.0 roughly halves end_tick vs speed=1.0");

    snprintf(tmpl, sizeof(tmpl),
        "{\"source_folder\":\"%%s\",\"name\":\"T\",\"tempo_bpm\":120,"
        "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
        "{\"name\":\"A\",\"clips\":["
        "{\"source\":\"Grooves/120 Verse Half-Time.mid\",\"start_bar\":0,\"end_bar\":1,\"speed\":0.5}"
        "]}]}");
    snprintf(json, sizeof(json), tmpl, folder_name);
    uint32_t end_tick_half = 0;
    run_song(json, NULL, &end_tick_half, NULL);
    CHECK(end_tick_half > end_tick_1x && end_tick_half < end_tick_1x * 3,
          "speed=0.5 roughly doubles end_tick vs speed=1.0");

    /* --- Test 4: velocity_scale halves captured velocities. --- */
    snprintf(tmpl, sizeof(tmpl),
        "{\"source_folder\":\"%%s\",\"name\":\"T\",\"tempo_bpm\":120,"
        "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
        "{\"name\":\"A\",\"clips\":["
        "{\"source\":\"Grooves/120 Verse Half-Time.mid\",\"start_bar\":0,\"end_bar\":1,\"velocity_scale\":1.0}"
        "]}]}");
    snprintf(json, sizeof(json), tmpl, folder_name);
    run_song(json, NULL, NULL, NULL);
    int max_vel_full = 0;
    for (int i = 0; i < g_captured_count; i++) {
        if (g_captured[i].status == 0x90 && g_captured[i].vel > max_vel_full) max_vel_full = g_captured[i].vel;
    }

    snprintf(tmpl, sizeof(tmpl),
        "{\"source_folder\":\"%%s\",\"name\":\"T\",\"tempo_bpm\":120,"
        "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
        "{\"name\":\"A\",\"clips\":["
        "{\"source\":\"Grooves/120 Verse Half-Time.mid\",\"start_bar\":0,\"end_bar\":1,\"velocity_scale\":0.5}"
        "]}]}");
    snprintf(json, sizeof(json), tmpl, folder_name);
    run_song(json, NULL, NULL, NULL);
    int max_vel_half = 0;
    for (int i = 0; i < g_captured_count; i++) {
        if (g_captured[i].status == 0x90 && g_captured[i].vel > max_vel_half) max_vel_half = g_captured[i].vel;
    }
    CHECK(max_vel_full > 0, "velocity_scale baseline: at least one note-on captured");
    CHECK(max_vel_half > 0 && max_vel_half < max_vel_full,
          "velocity_scale 0.5 produces lower captured velocities than 1.0");

    /* --- Test 5: snare_velocity_scale=0 drops the snare note entirely. --- */
    snprintf(tmpl, sizeof(tmpl),
        "{\"source_folder\":\"%%s\",\"name\":\"T\",\"tempo_bpm\":120,"
        "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
        "{\"name\":\"A\",\"clips\":["
        "{\"source\":\"Grooves/120 Verse Half-Time.mid\",\"start_bar\":0,\"end_bar\":1,\"snare_note\":38,\"snare_velocity_scale\":1.0}"
        "]}]}");
    snprintf(json, sizeof(json), tmpl, folder_name);
    run_song(json, NULL, NULL, NULL);
    CHECK(captured_has_note(0x90, 38), "snare baseline: note 38 present with snare_velocity_scale=1.0");

    snprintf(tmpl, sizeof(tmpl),
        "{\"source_folder\":\"%%s\",\"name\":\"T\",\"tempo_bpm\":120,"
        "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
        "{\"name\":\"A\",\"clips\":["
        "{\"source\":\"Grooves/120 Verse Half-Time.mid\",\"start_bar\":0,\"end_bar\":1,\"snare_note\":38,\"snare_velocity_scale\":0.0}"
        "]}]}");
    snprintf(json, sizeof(json), tmpl, folder_name);
    run_song(json, NULL, NULL, NULL);
    CHECK(!captured_has_note(0x90, 38), "snare_velocity_scale=0.0 drops note 38 entirely");

    /* --- Test 6: kick_target thinning reduces the kick-note count while
     * respecting the protected downbeat(s). This clip's bar 0 carries two
     * kicks close together, both within beat 1 (confirmed while developing
     * this test) -- only the earliest is ever protected as "the beat 1
     * downbeat", so kick_target=1 has a genuinely droppable second kick to
     * remove, unlike a target at or above the clip's real baseline count
     * (which would trivially pass with no thinning actually exercised). --- */
    snprintf(tmpl, sizeof(tmpl),
        "{\"source_folder\":\"%%s\",\"name\":\"T\",\"tempo_bpm\":120,"
        "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
        "{\"name\":\"A\",\"clips\":["
        "{\"source\":\"Grooves/120 Verse Half-Time.mid\",\"start_bar\":0,\"end_bar\":1,\"kick_note\":36,\"kick_target\":0}"
        "]}]}");
    snprintf(json, sizeof(json), tmpl, folder_name);
    run_song(json, NULL, NULL, NULL);
    int kick_baseline = count_note(0x90, 36);
    CHECK(kick_baseline > 1, "kick_target baseline: more than one kick note-on with thinning disabled");

    snprintf(tmpl, sizeof(tmpl),
        "{\"source_folder\":\"%%s\",\"name\":\"T\",\"tempo_bpm\":120,"
        "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
        "{\"name\":\"A\",\"clips\":["
        "{\"source\":\"Grooves/120 Verse Half-Time.mid\",\"start_bar\":0,\"end_bar\":1,\"kick_note\":36,\"kick_target\":1}"
        "]}]}");
    snprintf(json, sizeof(json), tmpl, folder_name);
    run_song(json, NULL, NULL, NULL);
    int kick_thinned = count_note(0x90, 36);
    CHECK(kick_thinned < kick_baseline, "kick_target=1 thins the kick count below the untargeted baseline");
    CHECK(kick_thinned >= 1, "kick_target=1 still keeps at least the protected downbeat kick");

    /* --- Test 7: per-clip channel override changes the emitted channel
     * nibble (default schwung_channel is 0; the clip requests channel 5,
     * i.e. 0-based 4). --- */
    snprintf(tmpl, sizeof(tmpl),
        "{\"source_folder\":\"%%s\",\"name\":\"T\",\"tempo_bpm\":120,"
        "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
        "{\"name\":\"A\",\"clips\":["
        "{\"source\":\"Grooves/120 Verse Half-Time.mid\",\"start_bar\":0,\"end_bar\":1,\"channel\":5}"
        "]}]}");
    snprintf(json, sizeof(json), tmpl, folder_name);
    run_song(json, NULL, NULL, NULL);
    int saw_channel_4 = 0;
    for (int i = 0; i < g_captured_count; i++) {
        if (g_captured[i].status == 0x90 && g_captured[i].channel == 4) { saw_channel_4 = 1; break; }
    }
    CHECK(saw_channel_4, "per-clip channel:5 override emits on 0-based channel 4");

    /* --- Test 8: "Drop Note-Offs" Drums option (arranger_engine.c's
     * drop_note_offs field / should_suppress_note_off helper). Some drum
     * playback modules/samplers hard-cut a still-ringing one-shot the
     * instant they get a note-off, so the drum timeline's own recorded
     * note-off (copied straight from the source clip) cuts the sound short
     * right before the next hit. When set_param("drop_note_offs","1") is on,
     * a note-off that a LATER note-on for the same note is going to
     * retrigger anyway is withheld -- but the FINAL occurrence of a note in
     * the timeline gets its own, correctly-timed note-off through
     * unchanged. That carve-out was added after a real report against this
     * exact option: unconditionally withholding every note-off (this
     * option's first cut) left a GATED patch (one that only releases on an
     * explicit note-off, rather than decaying on its own) held open in
     * silence for the rest of the song, releasing all at once -- audible as
     * a phantom extra hit -- only when stop's CC123 "all notes off" finally
     * reached it. Letting the last occurrence's off through avoids that,
     * while still protecting every EARLIER occurrence from an early cutoff.
     * The instrument (chord) track's own note-offs, scheduled deliberately
     * for musical note length rather than copied from a clip, must NOT be
     * affected either way. Two-bar drum clip -- "Grooves/120 Verse
     * Half-Time.mid" bars 0-2 -- carries exactly 4 kick (note 36) hits, at
     * raw ticks 0, 1078, 1196, 1917 (confirmed by direct inspection of the
     * clip while developing this test), each paired with its own explicit
     * note-off in the raw SMF data -- on the default schwung channel 0, plus
     * a bar-boundary chord instrument on channel 2 (0-based 1) so the two
     * tracks are distinguishable by channel. --- */
    snprintf(tmpl, sizeof(tmpl),
        "{\"source_folder\":\"%%s\",\"name\":\"T\",\"tempo_bpm\":120,"
        "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
        "{\"name\":\"A\",\"clips\":["
        "{\"source\":\"Grooves/120 Verse Half-Time.mid\",\"start_bar\":0,\"end_bar\":2}"
        "],\"chords\":["
        "{\"root\":\"C\",\"quality\":\"maj\",\"bass\":\"\"},"
        "{\"root\":\"G\",\"quality\":\"maj\",\"bass\":\"\"}"
        "]}"
        "],\"instruments\":["
        "{\"enabled\":true,\"output\":\"schwung\",\"channel\":2,\"octave\":3,\"follow_note\":0,"
        "\"voicing\":\"bass\",\"note_gap\":0.125}"
        "]}");
    snprintf(json, sizeof(json), tmpl, folder_name);

    /* Baseline: drop_note_offs off (the default) -- both tracks' note-offs
     * fire normally. */
    g_api->set_param(g_inst, "drop_note_offs", "0");
    run_song(json, NULL, NULL, NULL);
    CHECK(count_note(0x90, 36) == 4, "drop note-offs baseline: all 4 drum kick note-ons fire");
    CHECK(count_note(0x80, 36) == 4, "drop note-offs baseline: all 4 drum kick note-offs fire normally");
    int inst_off_baseline = 0;
    for (int i = 0; i < g_captured_count; i++) {
        if (g_captured[i].status == 0x80 && g_captured[i].note == 48 && g_captured[i].channel == 1) inst_off_baseline = 1;
    }
    CHECK(inst_off_baseline, "drop note-offs baseline: instrument chord (C bass, note 48, channel 1) gets its own note-off");

    /* Enabled: every kick note-on still fires, but only the LAST kick's
     * note-off survives (4 kicks total -- see the comment above -- so 3 of
     * the 4 offs are withheld, exactly 1 gets through); the instrument
     * track's own note-off is unaffected. */
    g_api->set_param(g_inst, "drop_note_offs", "1");
    run_song(json, NULL, NULL, NULL);
    CHECK(count_note(0x90, 36) == 4, "drop note-offs on: all 4 drum kick note-ons still fire");
    CHECK(count_note(0x80, 36) == 1, "drop note-offs on: only the last of the 4 kick note-offs gets through (the other 3 are withheld)");
    int inst_off_enabled = 0;
    for (int i = 0; i < g_captured_count; i++) {
        if (g_captured[i].status == 0x80 && g_captured[i].note == 48 && g_captured[i].channel == 1) inst_off_enabled = 1;
    }
    CHECK(inst_off_enabled, "drop note-offs on: instrument chord's own note-off is unaffected (only the drum timeline is gated)");
    g_api->set_param(g_inst, "drop_note_offs", "0");

    if (g_failures == 0) {
        printf("\nALL TESTS PASSED\n");
    } else {
        printf("\n%d TEST(S) FAILED\n", g_failures);
    }
    g_api->destroy_instance(g_inst);
    return g_failures == 0 ? 0 : 1;
}
