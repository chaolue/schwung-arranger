/*
 * Regression tests for Jam mode's live-performed instruments
 * (jam_inst[]/jam_chord_live/jam_chord_pending, emit_jam_instruments_follow,
 * apply_pending_jam_chord -- src/dsp/arranger_engine.c) and the Perform/Jam
 * drum/instrument mute toggles (drum_enabled, inst1_enabled/inst2_enabled,
 * jam_inst1_enabled/jam_inst2_enabled).
 *
 * Each test group gets its OWN fresh plugin instance (create_instance,
 * scan, use, destroy_instance) rather than sharing one across the whole
 * file: jam_inst[]/jam_chord_live are deliberately engine-level state (see
 * their declaration -- same "direct field write, no rebuild" pattern as
 * tempo), so unlike everything else in this song-JSON-driven test suite,
 * they do NOT reset on a song_json reload. Sharing one instance across
 * scenarios that each need a known starting chord/enabled state would mean
 * every later scenario has to account for whatever the previous one left
 * live -- fresh instances sidestep that entirely and keep each test's
 * expected counts simple and exact.
 *
 * Build (plain):
 *   gcc -Wall -Wextra -g -pthread tests/dsp/test_jam_instruments.c \
 *       src/dsp/arranger_engine.c -Isrc/dsp -ldl -lm -o /tmp/test_jam_instruments
 *
 * Usage: test_jam_instruments <library_root>
 * Expects the "Song 13" fixture (see test_async_channels.c). Uses
 * "Grooves/120 Verse Half-Time.mid" trimmed to bars 0-4 with
 * "guard_fraction":0 (the engine's own default of 0.125 would otherwise
 * suppress the clip's own last kick, tick 3837, just 3 ticks before this
 * clip's own outgoing 3840-tick boundary -- confirmed while developing
 * this test, the same mechanism investigated for the real "shortened note"
 * bug this session; irrelevant to what these tests are actually checking,
 * so disabled here to isolate it). Kick (note 36) positions confirmed by
 * direct inspection of the clip: bar0 [0, 238], bar1 [1078, 1196, 1917],
 * bar2 [2156], bar3 [2996, 3113, 3837] (ticks_per_beat 240, bars every 960
 * ticks).
 */

#include "test_common.h"

/* Count captured note-on/off events for `st`/`nt` on exactly channel `ch`
 * (0-based) -- count_note (test_common.h) doesn't distinguish channel,
 * needed here since drum and jam_inst1 share the same "schwung" route. */
static int count_ch(uint8_t st, uint8_t nt, uint8_t ch) {
    int n = 0;
    for (int i = 0; i < g_captured_count; i++) {
        if (g_captured[i].status == st && g_captured[i].note == nt && g_captured[i].channel == ch) n++;
    }
    return n;
}

/* Create a fresh instance, route drum+instrument output through the shared
 * capture stub, and wait for the library scan. Returns NULL on failure. */
static void *fresh_instance(plugin_api_v2_t *api, const char *library_root, char *folder_name, size_t folder_name_size) {
    void *inst = api->create_instance("/tmp/test_jam_instruments", NULL);
    if (!inst) { fprintf(stderr, "create_instance failed\n"); return NULL; }
    if (!find_song13_folder(api, inst, library_root, folder_name, folder_name_size)) {
        api->destroy_instance(inst);
        return NULL;
    }
    api->set_param(inst, "emit_directly", "1");
    api->set_param(inst, "output_target", "schwung");
    api->set_param(inst, "schwung_channel", "0");
    return inst;
}

int main(int argc, char **argv) {
    if (argc < 2) { fprintf(stderr, "usage: %s <library_root>\n", argv[0]); return 1; }
    const char *library_root = argv[1];

    host_api_v1_t host = make_test_host();
    plugin_api_v2_t *api = move_plugin_init_v2(&host);

    char folder_name[128];
    char json[2048];
    int16_t audio[MOVE_FRAMES_PER_BLOCK * 2];

    /* --- Test group 1: a chord set via "jam_chord" BEFORE play is promoted
     * to live immediately when "play" is issued (apply_pending_jam_chord is
     * now called from the "play" handler itself, not just at bar
     * boundaries -- a chord picked while stopped has no "current bar" to
     * defer to, so it must be what plays from bar 0). It then holds across
     * every matching drum hit until changed, and a change made mid-playback
     * still only takes effect at ITS next bar boundary (attack rhythm from
     * Follow Note, content from the pad). */
    {
        void *inst = fresh_instance(api, library_root, folder_name, sizeof(folder_name));
        if (!inst) return 1;
        snprintf(json, sizeof(json),
            "{\"source_folder\":\"%s\",\"name\":\"T\",\"tempo_bpm\":120,"
            "\"time_sig_num\":4,\"time_sig_den\":4,\"ppq\":240,\"sections\":["
            "{\"name\":\"A\",\"clips\":["
            "{\"source\":\"Grooves/120 Verse Half-Time.mid\",\"start_bar\":0,\"end_bar\":4,\"guard_fraction\":0}"
            "]}]}", folder_name);

        g_captured_count = 0;
        uint32_t base_primary = state_u32(api, inst, "primary_published_gen");
        api->set_param(inst, "loop", "0");
        api->set_param(inst, "song_json", json);
        CHECK(wait_field_change(api, inst, "primary_published_gen", base_primary, 3000),
              "jam chord: song published");

        api->set_param(inst, "jam_inst1_enabled", "1");
        api->set_param(inst, "jam_inst1_follow_note", "36");
        api->set_param(inst, "jam_inst1_octave", "3");
        api->set_param(inst, "jam_inst1_voicing", "bass");
        api->set_param(inst, "jam_inst1_note_gap", "0.125");
        api->set_param(inst, "jam_inst1_channel", "1");
        api->set_param(inst, "jam_inst1_output", "schwung");
        /* D major bass, octave 3 -> base 48 + D(pc2) = 50. Queued BEFORE
         * play: "play" promotes it to live immediately, so bar 0's own two
         * kicks (ticks 0, 238) sound it too, same as every later kick. */
        api->set_param(inst, "jam_chord", "D:maj:0");
        api->set_param(inst, "play", "1");

        /* Run to ~tick 2200 (120bpm, ticks_per_beat 240 -> ~1.39 ticks/
         * block): comfortably past bar0's 2 kicks, bar1's 3 kicks, and
         * bar2's own kick (2156), but well before bar2->3 (2880). */
        for (int b = 0; b < 1600; b++) api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);

        CHECK(count_ch(0x90, 50, 1) == 6,
              "jam chord: exactly 6 D-bass attacks (bar0's 2 kicks + bar1's 3 + bar2's 1, live from bar 0 onward)");
        CHECK(count_ch(0x90, 55, 1) == 0,
              "jam chord: no G-bass attacks yet (not queued)");

        /* Queue a new chord well inside bar2 (comfortably before its own
         * bar2->3 boundary at 2880) -- G major bass, octave 3 ->
         * 48 + G(pc7) = 55. Must not retroactively affect the D attacks
         * already counted, and (mid-playback, unlike the play-time case
         * above) must wait for that boundary. */
        api->set_param(inst, "jam_chord", "G:maj:0");
        for (int b = 0; b < 1300; b++) api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
        stop_and_ring_out(api, inst);

        CHECK(count_ch(0x90, 50, 1) == 6,
              "jam chord change: D-bass attack count unchanged after switching to G");
        CHECK(count_ch(0x90, 55, 1) == 3,
              "jam chord change: bar3's 3 kicks (2996, 3113, 3837) each sound the new G-bass chord, once live");
        CHECK(count_ch(0x80, 50, 1) == count_ch(0x90, 50, 1),
              "jam chord change: every D-bass note-on has a matching note-off, nothing stuck");
        CHECK(count_ch(0x80, 55, 1) == count_ch(0x90, 55, 1),
              "jam chord change: every G-bass note-on has a matching note-off (stop cuts off the last one)");
        /* Nothing else ever sounds on the jam instrument's channel --
         * confirms only the follow_note=36 hits ever trigger it (e.g.
         * never the note-38/42 snare/hihat hits also present in this
         * clip). */
        int other = 0;
        for (int i = 0; i < g_captured_count; i++) {
            if (g_captured[i].channel == 1 && g_captured[i].note != 50 && g_captured[i].note != 55) other++;
        }
        CHECK(other == 0, "jam chord: only the selected chord's own notes ever sound on the jam instrument's channel");

        api->destroy_instance(inst);
    }

    /* --- Test group 2: disabling jam_inst1_enabled mid-note cuts it off
     * immediately, not at its own scheduled/bar-boundary time. --- */
    {
        void *inst = fresh_instance(api, library_root, folder_name, sizeof(folder_name));
        if (!inst) return 1;
        snprintf(json, sizeof(json),
            "{\"source_folder\":\"%s\",\"name\":\"T\",\"tempo_bpm\":120,"
            "\"time_sig_num\":4,\"time_sig_den\":4,\"ppq\":240,\"sections\":["
            "{\"name\":\"A\",\"clips\":["
            "{\"source\":\"Grooves/120 Verse Half-Time.mid\",\"start_bar\":0,\"end_bar\":4,\"guard_fraction\":0}"
            "]}]}", folder_name);
        g_captured_count = 0;
        uint32_t base_primary = state_u32(api, inst, "primary_published_gen");
        api->set_param(inst, "loop", "0");
        api->set_param(inst, "song_json", json);
        CHECK(wait_field_change(api, inst, "primary_published_gen", base_primary, 3000),
              "jam instrument disable: song published");
        api->set_param(inst, "jam_inst1_enabled", "1");
        api->set_param(inst, "jam_inst1_follow_note", "36");
        api->set_param(inst, "jam_inst1_octave", "3");
        api->set_param(inst, "jam_inst1_voicing", "bass");
        api->set_param(inst, "jam_inst1_channel", "1");
        api->set_param(inst, "jam_inst1_output", "schwung");
        api->set_param(inst, "jam_chord", "D:maj:0");
        api->set_param(inst, "play", "1");
        /* Target ~tick 1100: D is live from bar 0 (see group 1), so bar0's
         * 2 kicks (0, 238) and bar1's first kick (1078) have already each
         * fired an attack, the first two already naturally released
         * (note_gap 0 here -> released as soon as the next kick lands), but
         * 1078's is still sounding (next matching kick 1196, off would
         * naturally land at 1196). ~1.393 ticks/block -> ~790 blocks. */
        for (int b = 0; b < 790; b++) api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
        CHECK(count_ch(0x90, 50, 1) == 3 && count_ch(0x80, 50, 1) == 2,
              "jam instrument disable: the 3rd D-bass note is sounding, not yet naturally off");
        api->set_param(inst, "jam_inst1_enabled", "0");
        api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
        CHECK(count_ch(0x80, 50, 1) == 3, "jam instrument disable: disabling mid-note cuts it off immediately");
        stop_and_ring_out(api, inst);
        api->destroy_instance(inst);
    }

    /* --- Test group 3: drum_enabled=0 suppresses drum note-ons while a
     * Jam follow-note instrument still fires correctly off the same
     * (unheard) drum hits. --- */
    {
        void *inst = fresh_instance(api, library_root, folder_name, sizeof(folder_name));
        if (!inst) return 1;
        snprintf(json, sizeof(json),
            "{\"source_folder\":\"%s\",\"name\":\"T\",\"tempo_bpm\":120,"
            "\"time_sig_num\":4,\"time_sig_den\":4,\"ppq\":240,\"sections\":["
            "{\"name\":\"A\",\"clips\":["
            "{\"source\":\"Grooves/120 Verse Half-Time.mid\",\"start_bar\":0,\"end_bar\":4,\"guard_fraction\":0}"
            "]}]}", folder_name);
        g_captured_count = 0;
        uint32_t base_primary = state_u32(api, inst, "primary_published_gen");
        api->set_param(inst, "loop", "0");
        api->set_param(inst, "song_json", json);
        CHECK(wait_field_change(api, inst, "primary_published_gen", base_primary, 3000),
              "drum_enabled: song published");
        api->set_param(inst, "jam_inst1_enabled", "1");
        api->set_param(inst, "jam_inst1_follow_note", "36");
        api->set_param(inst, "jam_inst1_octave", "3");
        api->set_param(inst, "jam_inst1_voicing", "bass");
        api->set_param(inst, "jam_inst1_channel", "1");
        api->set_param(inst, "jam_inst1_output", "schwung");
        api->set_param(inst, "jam_chord", "D:maj:0");
        api->set_param(inst, "drum_enabled", "0");
        api->set_param(inst, "play", "1");
        for (int b = 0; b < 1600; b++) api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
        stop_and_ring_out(api, inst);
        CHECK(count_ch(0x90, 36, 0) == 0, "drum_enabled=0: no drum kick note-ons captured on the drum channel");
        CHECK(count_ch(0x90, 50, 1) == 6,
              "drum_enabled=0: the Jam instrument still fires normally (D live from bar 0, see group 1) off the same (muted) kick hits");
        api->destroy_instance(inst);
    }

    /* --- Test group 4: inst1_enabled/inst2_enabled toggling off a
     * song-authored (bar-boundary chord) instrument cuts a sounding note
     * immediately. --- */
    {
        void *inst = fresh_instance(api, library_root, folder_name, sizeof(folder_name));
        if (!inst) return 1;
        snprintf(json, sizeof(json),
            "{\"source_folder\":\"%s\",\"name\":\"T\",\"tempo_bpm\":120,"
            "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
            "{\"name\":\"A\",\"clips\":["
            "{\"source\":\"Grooves/120 Intro Half-Time Stick.mid\",\"start_bar\":0,\"end_bar\":1}"
            "],\"chords\":[{\"root\":\"C\",\"quality\":\"maj\",\"bass\":\"\"}]}"
            "],\"instruments\":["
            "{\"enabled\":true,\"output\":\"schwung\",\"channel\":3,\"octave\":3,\"follow_note\":0,"
            "\"voicing\":\"bass\",\"note_gap\":0.125}"
            "]}", folder_name);
        g_captured_count = 0;
        uint32_t base_primary = state_u32(api, inst, "primary_published_gen");
        api->set_param(inst, "loop", "0");
        api->set_param(inst, "song_json", json);
        CHECK(wait_field_change(api, inst, "primary_published_gen", base_primary, 3000),
              "inst1_enabled: song published");
        api->set_param(inst, "play", "1");
        for (int b = 0; b < 50; b++) api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
        CHECK(count_ch(0x90, 48, 2) == 1 && count_ch(0x80, 48, 2) == 0,
              "inst1_enabled: bar 0's C-bass chord (note 48, channel 2) is sounding, not yet naturally off");
        api->set_param(inst, "inst1_enabled", "0");
        api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
        CHECK(count_ch(0x80, 48, 2) == 1, "inst1_enabled=0: disabling mid-note cuts the song instrument off immediately");
        stop_and_ring_out(api, inst);
        api->destroy_instance(inst);
    }

    /* --- Test group 5: Follow Note "off" (0) falls back to firing the live
     * chord fresh at every bar boundary (emit_jam_instruments_at_tick),
     * instead of staying silent. Reuses the same clip/chord as group 1, but
     * with jam_inst1_follow_note left at 0 -- so unlike group 1, drum hits
     * (kicks at 0, 238, 1078, 1196, 1917, 2156, 2996, 3113, 3837) are
     * irrelevant here; only bar boundaries (960, 1920, 2880, 3840) matter. */
    {
        void *inst = fresh_instance(api, library_root, folder_name, sizeof(folder_name));
        if (!inst) return 1;
        snprintf(json, sizeof(json),
            "{\"source_folder\":\"%s\",\"name\":\"T\",\"tempo_bpm\":120,"
            "\"time_sig_num\":4,\"time_sig_den\":4,\"ppq\":240,\"sections\":["
            "{\"name\":\"A\",\"clips\":["
            "{\"source\":\"Grooves/120 Verse Half-Time.mid\",\"start_bar\":0,\"end_bar\":4,\"guard_fraction\":0}"
            "]}]}", folder_name);

        g_captured_count = 0;
        uint32_t base_primary = state_u32(api, inst, "primary_published_gen");
        api->set_param(inst, "loop", "0");
        api->set_param(inst, "song_json", json);
        CHECK(wait_field_change(api, inst, "primary_published_gen", base_primary, 3000),
              "once-per-bar fallback: song published");

        api->set_param(inst, "jam_inst1_enabled", "1");
        api->set_param(inst, "jam_inst1_follow_note", "0");
        api->set_param(inst, "jam_inst1_octave", "3");
        api->set_param(inst, "jam_inst1_voicing", "bass");
        api->set_param(inst, "jam_inst1_note_gap", "0.125");
        api->set_param(inst, "jam_inst1_channel", "1");
        api->set_param(inst, "jam_inst1_output", "schwung");
        /* D major bass, octave 3 -> 50. Queued BEFORE play: "play" promotes
         * it to live immediately (see group 1), and since this fallback
         * path fires from the "play" handler's own direct
         * emit_jam_instruments_at_tick(e, 0) call too (not just bar
         * boundaries), bar 0 gets its own attack right away, same as every
         * later boundary. */
        api->set_param(inst, "jam_chord", "D:maj:0");
        api->set_param(inst, "play", "1");

        /* Run to ~tick 2200: past bar 0 itself (play-time attack), the
         * bar0->1 (960) and bar1->2 (1920) boundaries (3 fresh D-bass
         * retriggers total, chord unchanged throughout), but before
         * bar2->3 (2880). */
        for (int b = 0; b < 1600; b++) api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);

        CHECK(count_ch(0x90, 50, 1) == 3,
              "once-per-bar fallback: exactly 3 D-bass attacks so far (bar 0 at play-time, then bar1 and bar2 boundaries each retrigger)");
        CHECK(count_ch(0x80, 50, 1) == 2,
              "once-per-bar fallback: the first two attacks have already naturally released (note_gap before the next boundary), the 3rd is still sounding");

        /* Queue a new chord inside bar2, before its own bar2->3 boundary --
         * G major bass, octave 3 -> 55. Must take effect only at the next
         * boundary, same deferred-switch semantics as group 1. */
        api->set_param(inst, "jam_chord", "G:maj:0");
        for (int b = 0; b < 1300; b++) api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
        stop_and_ring_out(api, inst);

        CHECK(count_ch(0x90, 50, 1) == 3,
              "once-per-bar fallback: D-bass attack count unchanged after switching to G");
        CHECK(count_ch(0x80, 50, 1) == 3,
              "once-per-bar fallback: the 3rd D-bass attack released naturally too, nothing stuck when the chord switched");
        /* One G attack, at bar2->3 (2880). Tick 3840 is the end of this
         * non-looping 4-bar clip, not a new bar -- it used to fire another
         * G there after playback had stopped (see group 17). */
        CHECK(count_ch(0x90, 55, 1) == 1,
              "once-per-bar fallback: switching to G retriggers at the next bar boundary (bar2->3), and not again at the clip's end");
        CHECK(count_ch(0x80, 55, 1) == count_ch(0x90, 55, 1),
              "once-per-bar fallback: every G-bass attack has a matching release (last one via stop)");

        int other = 0;
        for (int i = 0; i < g_captured_count; i++) {
            if (g_captured[i].channel == 1 && g_captured[i].note != 50 && g_captured[i].note != 55) other++;
        }
        CHECK(other == 0, "once-per-bar fallback: only the selected chord's own notes ever sound on the jam instrument's channel");

        api->destroy_instance(inst);
    }

    /* --- Test group 6: stopping mid-performance leaves jam_chord_live
     * untouched (the pad grid highlights it green while stopped, per
     * ui.js's drawJamLEDs/jamQueuedChordDegree), so the next "play" resumes
     * the SAME chord immediately -- but a not-yet-promoted pending pick at
     * the moment of stop is discarded (it was queued for a bar boundary
     * that will now never arrive), not carried over. --- */
    {
        void *inst = fresh_instance(api, library_root, folder_name, sizeof(folder_name));
        if (!inst) return 1;
        snprintf(json, sizeof(json),
            "{\"source_folder\":\"%s\",\"name\":\"T\",\"tempo_bpm\":120,"
            "\"time_sig_num\":4,\"time_sig_den\":4,\"ppq\":240,\"sections\":["
            "{\"name\":\"A\",\"clips\":["
            "{\"source\":\"Grooves/120 Verse Half-Time.mid\",\"start_bar\":0,\"end_bar\":4,\"guard_fraction\":0}"
            "]}]}", folder_name);
        g_captured_count = 0;
        uint32_t base_primary = state_u32(api, inst, "primary_published_gen");
        api->set_param(inst, "loop", "0");
        api->set_param(inst, "song_json", json);
        CHECK(wait_field_change(api, inst, "primary_published_gen", base_primary, 3000),
              "stop/resume: song published");
        api->set_param(inst, "jam_inst1_enabled", "1");
        api->set_param(inst, "jam_inst1_follow_note", "36");
        api->set_param(inst, "jam_inst1_octave", "3");
        api->set_param(inst, "jam_inst1_voicing", "bass");
        api->set_param(inst, "jam_inst1_note_gap", "0.125");
        api->set_param(inst, "jam_inst1_channel", "1");
        api->set_param(inst, "jam_inst1_output", "schwung");
        /* D major bass -> 50. Play, let it become live and sound bar 0's
         * two kicks, then stop -- WITHOUT ever queuing a different chord. */
        api->set_param(inst, "jam_chord", "D:maj:0");
        api->set_param(inst, "play", "1");
        for (int b = 0; b < 100; b++) api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
        stop_and_ring_out(api, inst);
        int on_before_replay = count_ch(0x90, 50, 1);
        CHECK(on_before_replay > 0, "stop/resume: D-bass sounded at least once before stopping");

        /* Play again with no "jam_chord" call in between: the chord that
         * was live must resume immediately (bar 0 sounds it again), exactly
         * like a freshly-queued chord would (group 1). */
        g_captured_count = 0;
        api->set_param(inst, "play", "1");
        for (int b = 0; b < 100; b++) api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
        stop_and_ring_out(api, inst);
        CHECK(count_ch(0x90, 50, 1) == on_before_replay,
              "stop/resume: replaying with no new jam_chord resumes the same D-bass chord from bar 0, same attack count as before");

        api->destroy_instance(inst);
    }

    /* --- Test group 7: "jam_chord" with an "off" value (or empty string)
     * clears both the live and pending chord and cuts off any currently-
     * sounding Jam instrument note immediately -- the DSP side of ui.js's
     * "press the already-queued pad again to un-queue it" toggle. --- */
    {
        void *inst = fresh_instance(api, library_root, folder_name, sizeof(folder_name));
        if (!inst) return 1;
        snprintf(json, sizeof(json),
            "{\"source_folder\":\"%s\",\"name\":\"T\",\"tempo_bpm\":120,"
            "\"time_sig_num\":4,\"time_sig_den\":4,\"ppq\":240,\"sections\":["
            "{\"name\":\"A\",\"clips\":["
            "{\"source\":\"Grooves/120 Verse Half-Time.mid\",\"start_bar\":0,\"end_bar\":4,\"guard_fraction\":0}"
            "]}]}", folder_name);
        g_captured_count = 0;
        uint32_t base_primary = state_u32(api, inst, "primary_published_gen");
        api->set_param(inst, "loop", "0");
        api->set_param(inst, "song_json", json);
        CHECK(wait_field_change(api, inst, "primary_published_gen", base_primary, 3000),
              "jam_chord off: song published");
        api->set_param(inst, "jam_inst1_enabled", "1");
        api->set_param(inst, "jam_inst1_follow_note", "36");
        api->set_param(inst, "jam_inst1_octave", "3");
        api->set_param(inst, "jam_inst1_voicing", "bass");
        api->set_param(inst, "jam_inst1_note_gap", "0.125");
        api->set_param(inst, "jam_inst1_channel", "1");
        api->set_param(inst, "jam_inst1_output", "schwung");
        api->set_param(inst, "jam_chord", "D:maj:0");
        api->set_param(inst, "play", "1");
        /* ~tick 800: past bar0's 2 kicks, before bar1's first (1078). One of
         * bar0's attacks is still sounding (gap 0.125 -> off scheduled well
         * before the next kick at 238, so by tick 800 both are actually
         * already off -- see group 1/2's shape). */
        for (int b = 0; b < 570; b++) api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
        int on_count = count_ch(0x90, 50, 1);
        CHECK(on_count == 2, "jam_chord off: both of bar 0's D-bass attacks fired before clearing");
        /* Clear the chord entirely while a drum-triggered note might still
         * be sounding elsewhere -- must not leave anything stuck. */
        api->set_param(inst, "jam_chord", "off");
        api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
        CHECK(count_ch(0x80, 50, 1) == count_ch(0x90, 50, 1),
              "jam_chord off: clearing cuts off any currently-sounding note immediately, nothing stuck");
        /* Run well past bar1's kicks and the bar1->2/bar2->3 boundaries:
         * with the chord cleared, no further D-bass attacks should ever
         * fire, from either the drum-hit path or a bar boundary. */
        for (int b = 0; b < 2000; b++) api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
        stop_and_ring_out(api, inst);
        CHECK(count_ch(0x90, 50, 1) == on_count,
              "jam_chord off: no further D-bass attacks fire once cleared, even across later drum hits and bar boundaries");

        api->destroy_instance(inst);
    }

    /* --- Test group 8: a Follow Note attack landing within the Swap Guard
     * window of the next bar boundary picks up a chord that's already
     * queued for that boundary, instead of firing the outgoing chord a
     * beat early -- the same "pushed kick belongs to the bar it's leading
     * into" fix already applied to Song Builder/Perform's own follow-note
     * path (emit_instruments_follow), now mirrored in
     * emit_jam_instruments_follow for Jam's pending/live chord register.
     * Bar1's own kick at tick 1917 sits only 3 ticks before the bar1->2
     * boundary at 1920 -- well inside the default 60-tick (0.25 beat)
     * guard window -- so once a new chord is queued before that kick
     * fires, THAT kick (not the following bar2 kick) is the first to sound
     * it. --- */
    {
        void *inst = fresh_instance(api, library_root, folder_name, sizeof(folder_name));
        if (!inst) return 1;
        snprintf(json, sizeof(json),
            "{\"source_folder\":\"%s\",\"name\":\"T\",\"tempo_bpm\":120,"
            "\"time_sig_num\":4,\"time_sig_den\":4,\"ppq\":240,\"sections\":["
            "{\"name\":\"A\",\"clips\":["
            "{\"source\":\"Grooves/120 Verse Half-Time.mid\",\"start_bar\":0,\"end_bar\":4,\"guard_fraction\":0}"
            "]}]}", folder_name);
        g_captured_count = 0;
        uint32_t base_primary = state_u32(api, inst, "primary_published_gen");
        api->set_param(inst, "loop", "0");
        api->set_param(inst, "song_json", json);
        CHECK(wait_field_change(api, inst, "primary_published_gen", base_primary, 3000),
              "guard window: song published");
        api->set_param(inst, "jam_inst1_enabled", "1");
        api->set_param(inst, "jam_inst1_follow_note", "36");
        api->set_param(inst, "jam_inst1_octave", "3");
        api->set_param(inst, "jam_inst1_voicing", "bass");
        api->set_param(inst, "jam_inst1_note_gap", "0.125");
        api->set_param(inst, "jam_inst1_channel", "1");
        api->set_param(inst, "jam_inst1_output", "schwung");
        api->set_param(inst, "jam_chord", "D:maj:0");
        api->set_param(inst, "play", "1");

        /* Run to ~tick 1300: past bar0's 2 kicks and bar1's first 2 kicks
         * (1078, 1196) -- 4 D-bass attacks -- but well before the guard
         * window (which starts at 1920 - 60 = 1860). */
        for (int b = 0; b < 933; b++) api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
        CHECK(count_ch(0x90, 50, 1) == 4,
              "guard window: 4 D-bass attacks before queuing the change (bar0's 2 + bar1's first 2 kicks)");

        /* Queue G major bass (octave 3 -> 55) well before the guard window
         * starts. */
        api->set_param(inst, "jam_chord", "G:maj:0");
        /* Run to ~tick 2200: past bar1's pushed kick (1917, inside the
         * guard window), the bar1->2 boundary itself (1920), and bar2's own
         * kick (2156). */
        for (int b = 0; b < 650; b++) api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
        stop_and_ring_out(api, inst);

        CHECK(count_ch(0x90, 50, 1) == 4,
              "guard window: D-bass attack count unchanged -- the pushed kick at 1917 did NOT sound another D-bass note");
        CHECK(count_ch(0x90, 55, 1) == 2,
              "guard window: 2 G-bass attacks -- the pushed kick at 1917 already picked up the queued chord, then bar2's kick (2156) continues it");
        CHECK(count_ch(0x80, 50, 1) == count_ch(0x90, 50, 1),
              "guard window: every D-bass note-on has a matching note-off, nothing stuck");
        CHECK(count_ch(0x80, 55, 1) == count_ch(0x90, 55, 1),
              "guard window: every G-bass note-on has a matching note-off (stop cuts off the last one)");

        api->destroy_instance(inst);
    }

    /* --- Test group 9: a chord queued while a groove/fill swap is ALSO
     * queued for the same bar boundary must take effect right at that
     * swap, not an extra bar later. Found live: the scheduled-swap
     * execution path (set_param("swap")) pre-syncs e->last_bar to the new
     * clip's own starting bar before update_bar_counter runs, so that
     * function's own "bar != last_bar" change detection never sees this
     * transition -- apply_pending_jam_chord/emit_jam_instruments_at_tick
     * (which only fire from inside that branch, or from "play") were never
     * called for it. Uses the once-per-bar fallback (Follow Note off) so
     * every attack is bar-boundary-driven, not drum-hit-driven, isolating
     * the swap-boundary mechanics being tested here. */
    {
        void *inst = fresh_instance(api, library_root, folder_name, sizeof(folder_name));
        if (!inst) return 1;
        char json2[2048];
        snprintf(json, sizeof(json),
            "{\"source_folder\":\"%s\",\"name\":\"A\",\"tempo_bpm\":120,"
            "\"time_sig_num\":4,\"time_sig_den\":4,\"ppq\":240,\"sections\":["
            "{\"name\":\"A\",\"clips\":["
            "{\"source\":\"Grooves/120 Intro Half-Time Stick.mid\",\"start_bar\":0,\"end_bar\":1}"
            "]}]}", folder_name);
        snprintf(json2, sizeof(json2),
            "{\"source_folder\":\"%s\",\"name\":\"B\",\"tempo_bpm\":120,"
            "\"time_sig_num\":4,\"time_sig_den\":4,\"ppq\":240,\"sections\":["
            "{\"name\":\"B\",\"clips\":["
            "{\"source\":\"Grooves/120 Chorus 1 Ride 8th.mid\",\"start_bar\":0,\"end_bar\":1}"
            "]}]}", folder_name);

        g_captured_count = 0;
        uint32_t base_primary = state_u32(api, inst, "primary_published_gen");
        api->set_param(inst, "loop", "0");
        api->set_param(inst, "song_json", json);
        CHECK(wait_field_change(api, inst, "primary_published_gen", base_primary, 3000),
              "swap+chord: clip A published");

        api->set_param(inst, "jam_inst1_enabled", "1");
        api->set_param(inst, "jam_inst1_follow_note", "0");
        api->set_param(inst, "jam_inst1_octave", "3");
        api->set_param(inst, "jam_inst1_voicing", "bass");
        api->set_param(inst, "jam_inst1_note_gap", "0.125");
        api->set_param(inst, "jam_inst1_channel", "1");
        api->set_param(inst, "jam_inst1_output", "schwung");
        /* D major bass -> 50. Live from bar 0 (see group 5). */
        api->set_param(inst, "jam_chord", "D:maj:0");
        api->set_param(inst, "play", "1");
        CHECK(count_ch(0x90, 50, 1) == 1, "swap+chord: D-bass sounds immediately at play (bar 0)");

        uint32_t base_staging = state_u32(api, inst, "staging_published_gen");
        api->set_param(inst, "preload_song_json", json2);
        CHECK(wait_field_change(api, inst, "staging_published_gen", base_staging, 3000),
              "swap+chord: clip B staged");
        api->set_param(inst, "staging_loop", "1");
        /* Queue the swap for the default target (next bar boundary, tick
         * 960 at 120bpm/ppq240), exactly like a Jam groove/fill pad press
         * mid-performance. */
        api->set_param(inst, "swap", "0");
        /* ...and queue a NEW chord for that same boundary -- G major bass,
         * octave 3 -> 55 -- exactly like a chord pad pressed in the same
         * window, before the swap actually lands. */
        api->set_param(inst, "jam_chord", "G:maj:0");

        /* Run well past tick 960 (the swap boundary). ~1.393 ticks/block ->
         * ~750 blocks reaches ~tick 1300. */
        for (int b = 0; b < 750; b++) api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
        stop_and_ring_out(api, inst);

        uint32_t swap_counter = param_field_u32(api, inst, "transport", "swap_counter");
        CHECK(swap_counter >= 1, "swap+chord: the swap actually landed (swap_counter advanced)");
        CHECK(count_ch(0x90, 50, 1) == 1,
              "swap+chord: still exactly 1 D-bass attack -- clip A never reached its own next boundary before swapping out");
        CHECK(count_ch(0x90, 55, 1) == 1,
              "swap+chord: the queued G-bass chord sounds right at the swap, not delayed an extra bar");
        CHECK(count_ch(0x80, 50, 1) == 1, "swap+chord: the D-bass note was cut off, nothing left stuck");
        CHECK(count_ch(0x80, 55, 1) == count_ch(0x90, 55, 1),
              "swap+chord: the G-bass attack has a matching release (stop cuts off the last one)");

        api->destroy_instance(inst);
    }

    /* --- Test group 10: same bug as group 9, but for the OTHER swap site --
     * a non-looping clip (e.g. a fill) running out and auto-swapping to an
     * already-staged clip (e.g. the return groove), with no explicit
     * "swap" call at all (see the AUTOSWAP branch inside
     * handle_loop_or_stop). A chord queued while that staged clip is
     * waiting must sound right at the auto-swap, not an extra bar later. */
    {
        void *inst = fresh_instance(api, library_root, folder_name, sizeof(folder_name));
        if (!inst) return 1;
        char json2[2048];
        snprintf(json, sizeof(json),
            "{\"source_folder\":\"%s\",\"name\":\"A\",\"tempo_bpm\":120,"
            "\"time_sig_num\":4,\"time_sig_den\":4,\"ppq\":240,\"sections\":["
            "{\"name\":\"A\",\"clips\":["
            "{\"source\":\"Grooves/120 Intro Half-Time Stick.mid\",\"start_bar\":0,\"end_bar\":1}"
            "]}]}", folder_name);
        snprintf(json2, sizeof(json2),
            "{\"source_folder\":\"%s\",\"name\":\"B\",\"tempo_bpm\":120,"
            "\"time_sig_num\":4,\"time_sig_den\":4,\"ppq\":240,\"sections\":["
            "{\"name\":\"B\",\"clips\":["
            "{\"source\":\"Grooves/120 Chorus 1 Ride 8th.mid\",\"start_bar\":0,\"end_bar\":1}"
            "]}]}", folder_name);

        g_captured_count = 0;
        uint32_t base_primary = state_u32(api, inst, "primary_published_gen");
        /* loop=0 is required to reach the AUTOSWAP branch instead of the
         * ordinary loop-wrap branch. */
        api->set_param(inst, "loop", "0");
        api->set_param(inst, "song_json", json);
        CHECK(wait_field_change(api, inst, "primary_published_gen", base_primary, 3000),
              "autoswap+chord: clip A published");

        api->set_param(inst, "jam_inst1_enabled", "1");
        api->set_param(inst, "jam_inst1_follow_note", "0");
        api->set_param(inst, "jam_inst1_octave", "3");
        api->set_param(inst, "jam_inst1_voicing", "bass");
        api->set_param(inst, "jam_inst1_note_gap", "0.125");
        api->set_param(inst, "jam_inst1_channel", "1");
        api->set_param(inst, "jam_inst1_output", "schwung");
        api->set_param(inst, "jam_chord", "D:maj:0");
        api->set_param(inst, "play", "1");
        CHECK(count_ch(0x90, 50, 1) == 1, "autoswap+chord: D-bass sounds immediately at play (bar 0)");

        uint32_t base_staging = state_u32(api, inst, "staging_published_gen");
        api->set_param(inst, "preload_song_json", json2);
        CHECK(wait_field_change(api, inst, "staging_published_gen", base_staging, 3000),
              "autoswap+chord: clip B staged");
        api->set_param(inst, "staging_loop", "1");
        /* No explicit "swap" -- clip A (non-looping) runs out on its own and
         * auto-swaps to the staged clip B once it reaches its own full bar. */
        api->set_param(inst, "jam_chord", "G:maj:0");

        /* Run well past clip A's own 1-bar length (960 ticks). ~1.393
         * ticks/block -> ~800 blocks reaches ~tick 1100. */
        for (int b = 0; b < 800; b++) api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
        stop_and_ring_out(api, inst);

        CHECK(count_ch(0x90, 50, 1) == 1,
              "autoswap+chord: still exactly 1 D-bass attack -- clip A never reached a second bar of its own before auto-swapping out");
        CHECK(count_ch(0x90, 55, 1) == 1,
              "autoswap+chord: the queued G-bass chord sounds right at the auto-swap, not delayed an extra bar");
        CHECK(count_ch(0x80, 50, 1) == 1, "autoswap+chord: the D-bass note was cut off, nothing left stuck");
        CHECK(count_ch(0x80, 55, 1) == count_ch(0x90, 55, 1),
              "autoswap+chord: the G-bass attack has a matching release (stop cuts off the last one)");

        api->destroy_instance(inst);
    }

    /* --- Test group 11: a ONE-bar looping groove. Each loop wraps from bar
     * 0 straight back to bar 0, so update_bar_counter's "bar != last_bar"
     * check never fired and a queued chord was never promoted (nor did the
     * once-per-bar fallback re-fire). Found live. Now the playhead moving
     * backwards counts as a bar boundary on its own. --- */
    {
        void *inst = fresh_instance(api, library_root, folder_name, sizeof(folder_name));
        if (!inst) return 1;
        snprintf(json, sizeof(json),
            "{\"source_folder\":\"%s\",\"name\":\"A\",\"tempo_bpm\":120,"
            "\"time_sig_num\":4,\"time_sig_den\":4,\"ppq\":240,\"sections\":["
            "{\"name\":\"A\",\"clips\":["
            "{\"source\":\"Grooves/120 Intro Half-Time Stick.mid\",\"start_bar\":0,\"end_bar\":1}"
            "]}]}", folder_name);
        g_captured_count = 0;
        uint32_t base_primary = state_u32(api, inst, "primary_published_gen");
        api->set_param(inst, "song_json", json);
        CHECK(wait_field_change(api, inst, "primary_published_gen", base_primary, 3000),
              "one-bar loop: clip published");
        api->set_param(inst, "loop", "1");
        api->set_param(inst, "jam_inst1_enabled", "1");
        api->set_param(inst, "jam_inst1_follow_note", "0");
        api->set_param(inst, "jam_inst1_octave", "3");
        api->set_param(inst, "jam_inst1_voicing", "bass");
        api->set_param(inst, "jam_inst1_note_gap", "0.125");
        api->set_param(inst, "jam_inst1_channel", "1");
        api->set_param(inst, "jam_inst1_output", "schwung");
        api->set_param(inst, "jam_chord", "D:maj:0");
        api->set_param(inst, "play", "1");
        /* ~tick 400, mid-way through the first pass of the loop. */
        for (int b = 0; b < 290; b++) api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
        CHECK(count_ch(0x90, 50, 1) == 1, "one-bar loop: D-bass sounds at play");
        api->set_param(inst, "jam_chord", "G:maj:0");
        /* Run to ~tick 2300: past two loop wraps (960 and 1920). */
        for (int b = 0; b < 1360; b++) api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
        stop_and_ring_out(api, inst);
        CHECK(param_field_u32(api, inst, "transport", "bar_counter") >= 2,
              "one-bar loop: each loop wrap counted as a bar boundary");
        CHECK(count_ch(0x90, 50, 1) == 1,
              "one-bar loop: no further D-bass attacks after G was queued");
        CHECK(count_ch(0x90, 55, 1) == 2,
              "one-bar loop: the queued G-bass takes over at the first wrap and retriggers at the next");
        CHECK(count_ch(0x80, 50, 1) == count_ch(0x90, 50, 1) &&
              count_ch(0x80, 55, 1) == count_ch(0x90, 55, 1),
              "one-bar loop: every note-on has a matching note-off");
        api->destroy_instance(inst);
    }

    /* --- Test group 12: an inst1_enabled mute set while stopped must survive
     * the song_json rebuild that Perform's Play issues. Found live: the mute
     * used to be written into the song's own instruments[].enabled, which
     * the rebuild overwrote with the saved song's value, so Inst 1/2 kept
     * playing while the UI showed them muted. --- */
    {
        void *inst = fresh_instance(api, library_root, folder_name, sizeof(folder_name));
        if (!inst) return 1;
        snprintf(json, sizeof(json),
            "{\"source_folder\":\"%s\",\"name\":\"T\",\"tempo_bpm\":120,"
            "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
            "{\"name\":\"A\",\"clips\":["
            "{\"source\":\"Grooves/120 Intro Half-Time Stick.mid\",\"start_bar\":0,\"end_bar\":1}"
            "],\"chords\":[{\"root\":\"C\",\"quality\":\"maj\",\"bass\":\"\"}]}"
            "],\"instruments\":["
            "{\"enabled\":true,\"output\":\"schwung\",\"channel\":3,\"octave\":3,\"follow_note\":0,"
            "\"voicing\":\"bass\",\"note_gap\":0.125}"
            "]}", folder_name);
        g_captured_count = 0;
        /* Muted while stopped, before the song is even (re)built -- exactly
         * Perform's order: mute pushed, then Play rebuilds and plays. */
        api->set_param(inst, "inst1_enabled", "0");
        uint32_t base_primary = state_u32(api, inst, "primary_published_gen");
        api->set_param(inst, "loop", "0");
        api->set_param(inst, "song_json", json);
        CHECK(wait_field_change(api, inst, "primary_published_gen", base_primary, 3000),
              "mute survives rebuild: song published");
        api->set_param(inst, "play", "1");
        for (int b = 0; b < 200; b++) api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
        CHECK(count_ch(0x90, 48, 2) == 0,
              "mute survives rebuild: Inst 1 muted before the rebuild stays silent after Play");
        /* Un-muting takes effect again at the next bar-boundary chord. */
        stop_and_ring_out(api, inst);
        api->set_param(inst, "inst1_enabled", "1");
        api->set_param(inst, "play", "1");
        for (int b = 0; b < 50; b++) api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
        stop_and_ring_out(api, inst);
        CHECK(count_ch(0x90, 48, 2) == 1, "mute survives rebuild: un-muting makes Inst 1 audible again");
        api->destroy_instance(inst);
    }

    /* --- Test group 13: a looping clip must play its downbeat on every
     * wrap. Found live: when the audio block crossing the loop end overshot
     * it (the new position lands on tick 1+), the loop-wrap branch stepped
     * past every event before that position without playing it, dropping
     * the tick-0 kick -- and the follow-note bass it triggers -- on roughly
     * every other loop. --- */
    {
        void *inst = fresh_instance(api, library_root, folder_name, sizeof(folder_name));
        if (!inst) return 1;
        snprintf(json, sizeof(json),
            "{\"source_folder\":\"%s\",\"name\":\"T\",\"tempo_bpm\":120,"
            "\"time_sig_num\":4,\"time_sig_den\":4,\"ppq\":240,\"sections\":["
            "{\"name\":\"A\",\"clips\":["
            "{\"source\":\"Grooves/120 Verse Half-Time.mid\",\"start_bar\":0,\"end_bar\":2,\"guard_fraction\":0}"
            "]}]}", folder_name);
        g_captured_count = 0;
        uint32_t base_primary = state_u32(api, inst, "primary_published_gen");
        api->set_param(inst, "song_json", json);
        CHECK(wait_field_change(api, inst, "primary_published_gen", base_primary, 3000),
              "loop downbeat: clip published");
        api->set_param(inst, "loop", "1");
        api->set_param(inst, "jam_inst1_enabled", "1");
        api->set_param(inst, "jam_inst1_follow_note", "36");
        api->set_param(inst, "jam_inst1_octave", "3");
        api->set_param(inst, "jam_inst1_voicing", "bass");
        api->set_param(inst, "jam_inst1_note_gap", "0.125");
        api->set_param(inst, "jam_inst1_channel", "1");
        api->set_param(inst, "jam_inst1_output", "schwung");
        api->set_param(inst, "jam_chord", "D:maj:0");
        api->set_param(inst, "play", "1");
        /* ~9800 ticks: five full passes of the 1920-tick loop (kicks at 0,
         * 238, 1078, 1196, 1917 -> 5 per pass) plus the start of a sixth,
         * whose tick-0 kick is already past. */
        for (int b = 0; b < 7040; b++) api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
        stop_and_ring_out(api, inst);
        CHECK(param_field_u32(api, inst, "transport", "wrap_counter") >= 5,
              "loop downbeat: the clip looped at least five times");
        int kicks = count_ch(0x90, 36, 0), bass = count_ch(0x90, 50, 1);
        CHECK(kicks == 26, "loop downbeat: every loop's kicks played, including each downbeat (5 per pass x 5 + the 6th pass's downbeat)");
        /* The kick at 1917 is 3 ticks before each loop end, so it and the
         * next pass's downbeat count as one bass attack (see group 14) --
         * 5 wraps, 5 merged pairs. */
        CHECK(bass == kicks - 5,
              "loop downbeat: every kick triggered its follow-note bass (a pushed kick and the downbeat after the wrap as one attack)");
        api->destroy_instance(inst);
    }

    /* --- Test group 14: a chord queued for a loop wrap is what the
     * downbeat kick plays. Found live: the queued chord was only applied at
     * the end of the audio block, after that block's drum hits had played,
     * so the tick-0 kick after the wrap played the OLD chord. Also checks
     * the pushed kick 3 ticks before the wrap and the downbeat just after it
     * count as one attack, not two, across the wrap. --- */
    {
        void *inst = fresh_instance(api, library_root, folder_name, sizeof(folder_name));
        if (!inst) return 1;
        snprintf(json, sizeof(json),
            "{\"source_folder\":\"%s\",\"name\":\"T\",\"tempo_bpm\":120,"
            "\"time_sig_num\":4,\"time_sig_den\":4,\"ppq\":240,\"sections\":["
            "{\"name\":\"A\",\"clips\":["
            "{\"source\":\"Grooves/120 Verse Half-Time.mid\",\"start_bar\":0,\"end_bar\":2,\"guard_fraction\":0}"
            "]}]}", folder_name);
        g_captured_count = 0;
        uint32_t base_primary = state_u32(api, inst, "primary_published_gen");
        api->set_param(inst, "song_json", json);
        CHECK(wait_field_change(api, inst, "primary_published_gen", base_primary, 3000),
              "downbeat chord: clip published");
        api->set_param(inst, "loop", "1");
        api->set_param(inst, "jam_inst1_enabled", "1");
        api->set_param(inst, "jam_inst1_follow_note", "36");
        api->set_param(inst, "jam_inst1_octave", "3");
        api->set_param(inst, "jam_inst1_voicing", "bass");
        api->set_param(inst, "jam_inst1_note_gap", "0.125");
        api->set_param(inst, "jam_inst1_channel", "1");
        api->set_param(inst, "jam_inst1_output", "schwung");
        api->set_param(inst, "jam_chord", "D:maj:0");
        api->set_param(inst, "play", "1");
        /* ~tick 1390: kicks 0, 238, 1078, 1196 have played D. */
        for (int b = 0; b < 1000; b++) api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
        CHECK(count_ch(0x90, 50, 1) == 4, "downbeat chord: 4 D-bass attacks before the change");
        api->set_param(inst, "jam_chord", "G:maj:0");
        /* Past the pushed kick (1917), the wrap (1920 -> 0) and kick 238. */
        for (int b = 0; b < 600; b++) api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
        stop_and_ring_out(api, inst);
        CHECK(count_ch(0x90, 50, 1) == 4,
              "downbeat chord: the downbeat after the wrap did NOT play the old D-bass chord");
        CHECK(count_ch(0x90, 55, 1) == 2,
              "downbeat chord: G-bass from the pushed kick (held through the downbeat as one attack) and from kick 238");
        CHECK(count_ch(0x80, 55, 1) == count_ch(0x90, 55, 1) &&
              count_ch(0x80, 50, 1) == count_ch(0x90, 50, 1),
              "downbeat chord: every note-on has a matching note-off");
        api->destroy_instance(inst);
    }

    /* --- Test group 15: Auto inversion (4) voice-leads by scale degree and
     * places each chord so its lowest note is the one nearest the key's root.
     * In C at octave 3 (C3 = 48): I C E G, ii D F A, iii B E G, IV C F A,
     * V B D G, vi C E A, vii B D F, and the octave pad I an octave up. --- */
    {
        void *inst = fresh_instance(api, library_root, folder_name, sizeof(folder_name));
        if (!inst) return 1;
        snprintf(json, sizeof(json),
            "{\"source_folder\":\"%s\",\"name\":\"T\",\"tempo_bpm\":120,"
            "\"time_sig_num\":4,\"time_sig_den\":4,\"ppq\":240,\"sections\":["
            "{\"name\":\"A\",\"clips\":["
            "{\"source\":\"Grooves/120 Verse Half-Time.mid\",\"start_bar\":0,\"end_bar\":1,\"guard_fraction\":0}"
            "]}]}", folder_name);
        uint32_t base_primary = state_u32(api, inst, "primary_published_gen");
        api->set_param(inst, "song_json", json);
        CHECK(wait_field_change(api, inst, "primary_published_gen", base_primary, 3000),
              "auto inversion: clip published");
        api->set_param(inst, "jam_inst1_enabled", "1");
        api->set_param(inst, "jam_inst1_follow_note", "0");
        api->set_param(inst, "jam_inst1_octave", "3");
        api->set_param(inst, "jam_inst1_voicing", "chord");
        api->set_param(inst, "jam_inst1_inversion", "4");
        api->set_param(inst, "jam_inst1_channel", "1");
        api->set_param(inst, "jam_inst1_output", "schwung");
        const struct { const char *param; int n[3]; const char *name; } cases[] = {
            { "C:maj:0:0:C", {48, 52, 55}, "I = C3 E3 G3" },
            { "D:min:0:1:C", {50, 53, 57}, "ii = D3 F3 A3" },
            { "E:min:0:2:C", {47, 52, 55}, "iii = B2 E3 G3 (2nd inv)" },
            { "F:maj:0:3:C", {48, 53, 57}, "IV = C3 F3 A3 (2nd inv)" },
            { "G:maj:0:4:C", {47, 50, 55}, "V = B2 D3 G3 (1st inv)" },
            { "A:min:0:5:C", {48, 52, 57}, "vi = C3 E3 A3 (1st inv)" },
            { "B:dim:0:6:C", {47, 50, 53}, "vii = B2 D3 F3" },
            { "C:maj:1:7:C", {60, 64, 67}, "octave pad = C4 E4 G4" },
        };
        for (unsigned c = 0; c < sizeof(cases) / sizeof(cases[0]); c++) {
            g_captured_count = 0;
            api->set_param(inst, "jam_chord", cases[c].param);
            api->set_param(inst, "play", "1");  /* promotes it and plays bar 0 */
            stop_and_ring_out(api, inst);
            int ok = 1, on = 0;
            for (int i = 0; i < g_captured_count; i++) {
                if (g_captured[i].channel != 1 || g_captured[i].status != 0x90) continue;
                on++;
                if (g_captured[i].note != cases[c].n[0] && g_captured[i].note != cases[c].n[1] &&
                    g_captured[i].note != cases[c].n[2]) ok = 0;
            }
            char msg[128];
            snprintf(msg, sizeof(msg), "auto inversion: %s", cases[c].name);
            CHECK(ok && on == 3, msg);
        }
        api->destroy_instance(inst);
    }

    /* --- Test group 16: the same Auto inversion for a song-authored
     * instrument, with degree/key carried on the section's chord (as the UI
     * sends them). V in C must play B2 D3 G3. --- */
    {
        void *inst = fresh_instance(api, library_root, folder_name, sizeof(folder_name));
        if (!inst) return 1;
        snprintf(json, sizeof(json),
            "{\"source_folder\":\"%s\",\"name\":\"T\",\"tempo_bpm\":120,"
            "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
            "{\"name\":\"A\",\"clips\":["
            "{\"source\":\"Grooves/120 Intro Half-Time Stick.mid\",\"start_bar\":0,\"end_bar\":1}"
            "],\"chords\":[{\"root\":\"G\",\"quality\":\"maj\",\"bass\":\"\",\"degree\":4,\"key\":\"C\"}]}"
            "],\"instruments\":["
            "{\"enabled\":true,\"output\":\"schwung\",\"channel\":3,\"octave\":3,\"follow_note\":0,"
            "\"voicing\":\"chord\",\"inversion\":4,\"note_gap\":0.125}"
            "]}", folder_name);
        g_captured_count = 0;
        uint32_t base_primary = state_u32(api, inst, "primary_published_gen");
        api->set_param(inst, "loop", "0");
        api->set_param(inst, "song_json", json);
        CHECK(wait_field_change(api, inst, "primary_published_gen", base_primary, 3000),
              "song auto inversion: song published");
        api->set_param(inst, "play", "1");
        stop_and_ring_out(api, inst);
        CHECK(count_ch(0x90, 47, 2) == 1 && count_ch(0x90, 50, 2) == 1 && count_ch(0x90, 55, 2) == 1,
              "song auto inversion: V in C plays B2 D3 G3");
        api->destroy_instance(inst);
    }

    /* --- Test group 17: no chord after a non-looping clip ends by itself.
     * Found live: the end tick of the clip counted as a new bar, so the
     * once-per-bar chord (and a song instrument's bar chord in Perform) fired
     * AFTER the natural stop had sent its note-offs, and hung until the UI's
     * own "stop". --- */
    {
        void *inst = fresh_instance(api, library_root, folder_name, sizeof(folder_name));
        if (!inst) return 1;
        snprintf(json, sizeof(json),
            "{\"source_folder\":\"%s\",\"name\":\"T\",\"tempo_bpm\":120,"
            "\"time_sig_num\":4,\"time_sig_den\":4,\"ppq\":240,\"sections\":["
            "{\"name\":\"A\",\"clips\":["
            "{\"source\":\"Grooves/120 Intro Half-Time Stick.mid\",\"start_bar\":0,\"end_bar\":1}"
            "],\"chords\":[{\"root\":\"C\",\"quality\":\"maj\",\"bass\":\"\"}]}"
            "],\"instruments\":["
            "{\"enabled\":true,\"output\":\"schwung\",\"channel\":3,\"octave\":3,\"follow_note\":0,"
            "\"voicing\":\"bass\",\"note_gap\":0.125}"
            "]}", folder_name);
        g_captured_count = 0;
        uint32_t base_primary = state_u32(api, inst, "primary_published_gen");
        api->set_param(inst, "song_json", json);
        CHECK(wait_field_change(api, inst, "primary_published_gen", base_primary, 3000),
              "end of clip: published");
        api->set_param(inst, "loop", "0");
        api->set_param(inst, "jam_inst1_enabled", "1");
        api->set_param(inst, "jam_inst1_follow_note", "0");
        api->set_param(inst, "jam_inst1_octave", "3");
        api->set_param(inst, "jam_inst1_voicing", "bass");
        api->set_param(inst, "jam_inst1_note_gap", "0.125");
        api->set_param(inst, "jam_inst1_channel", "1");
        api->set_param(inst, "jam_inst1_output", "schwung");
        api->set_param(inst, "jam_chord", "D:maj:0");
        api->set_param(inst, "play", "1");
        /* Well past the 960-tick end; no "stop" -- the clip stops itself. */
        for (int b = 0; b < 1000; b++) api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
        CHECK(state_u32(api, inst, "stopped_at_end") == 1, "end of clip: playback stopped by itself");
        CHECK(count_ch(0x90, 50, 1) == 1 && count_ch(0x80, 50, 1) == 1,
              "end of clip: the Jam chord played once, with nothing new after the stop");
        CHECK(count_ch(0x90, 48, 2) == 1 && count_ch(0x80, 48, 2) == 1,
              "end of clip: the song instrument's bar chord played once, with nothing new after the stop");
        api->destroy_instance(inst);
    }

    /* --- Test group 18: no instrument note is left held after stopping a
     * looping Jam groove. Found live: for the last kick before a wrap there
     * is no later kick in the timeline, so its scheduled off landed at the
     * loop end -- never reached once the playhead wrapped -- and the next
     * attack overwrote the only record of those notes, so they hung after
     * Stop until the module closed. Swap guard 0 so that kick (3 ticks
     * before the end) isn't merged with the downbeat. --- */
    {
        void *inst = fresh_instance(api, library_root, folder_name, sizeof(folder_name));
        if (!inst) return 1;
        snprintf(json, sizeof(json),
            "{\"source_folder\":\"%s\",\"name\":\"T\",\"tempo_bpm\":120,"
            "\"time_sig_num\":4,\"time_sig_den\":4,\"ppq\":240,\"sections\":["
            "{\"name\":\"A\",\"clips\":["
            "{\"source\":\"Grooves/120 Verse Half-Time.mid\",\"start_bar\":0,\"end_bar\":2,\"guard_fraction\":0}"
            "]}]}", folder_name);
        g_captured_count = 0;
        uint32_t base_primary = state_u32(api, inst, "primary_published_gen");
        api->set_param(inst, "song_json", json);
        CHECK(wait_field_change(api, inst, "primary_published_gen", base_primary, 3000),
              "no held notes: clip published");
        api->set_param(inst, "loop", "1");
        api->set_param(inst, "swap_guard_fraction", "0");
        api->set_param(inst, "jam_inst1_enabled", "1");
        api->set_param(inst, "jam_inst1_follow_note", "36");
        api->set_param(inst, "jam_inst1_octave", "3");
        api->set_param(inst, "jam_inst1_voicing", "chord");
        api->set_param(inst, "jam_inst1_note_gap", "0");
        api->set_param(inst, "jam_inst1_channel", "1");
        api->set_param(inst, "jam_inst1_output", "schwung");
        api->set_param(inst, "jam_chord", "D:maj:0");
        api->set_param(inst, "play", "1");
        for (int b = 0; b < 2000; b++) api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
        api->set_param(inst, "jam_chord", "G:maj:0");
        for (int b = 0; b < 3000; b++) api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
        stop_and_ring_out(api, inst);
        int held = 0;
        for (int n = 0; n < 128; n++) {
            int d = count_ch(0x90, (uint8_t)n, 1) - count_ch(0x80, (uint8_t)n, 1);
            if (d != 0) held += d;
        }
        CHECK(count_ch(0x90, 50, 1) > 0 && count_ch(0x90, 55, 1) > 0, "no held notes: both chords played");
        CHECK(held == 0, "no held notes: after Stop every instrument note-on has a note-off");
        api->destroy_instance(inst);
    }

    if (g_failures == 0) {
        printf("\nALL TESTS PASSED\n");
    } else {
        printf("\n%d TEST(S) FAILED\n", g_failures);
    }
    return g_failures == 0 ? 0 : 1;
}
