/*
 * Regression test: Stop leaves no drum note sounding.
 *
 * Found live: pressing Play to stop in Perform didn't always stop every note.
 * A drum note stopped mid-sound never gets its own note-off (it comes later
 * in the timeline), Drop Note-Offs withholds them on purpose, and All Notes
 * Off (CC 123) alone needn't be honoured by a Schwung chain synth.
 * emit_drum_notes_release now sends an explicit note-off for each.
 *
 * Build (plain):
 *   gcc -Wall -Wextra -g -pthread tests/dsp/test_stop.c \
 *       src/dsp/arranger_engine.c -Isrc/dsp -ldl -lm -o /tmp/test_stop
 *
 * Usage: test_stop <library_root>  (expects the "Song 13" fixture)
 */

#include "test_common.h"

/* All Notes Off (CC 123) per channel on the Schwung route. The shared
 * capture only keeps notes, so this wraps the host's send. */
static int g_cc123[16];
static int g_notes_before_cc = -1; /* captured notes when the first CC 123 came */
static int (*g_inner_send_internal)(const uint8_t *, int);
static int counting_send_internal(const uint8_t *m, int l) {
    if (l >= 4 && (m[1] & 0xF0) == 0xB0 && m[2] == 123) {
        if (g_notes_before_cc < 0) g_notes_before_cc = g_captured_count;
        g_cc123[m[1] & 0x0F]++;
    }
    return g_inner_send_internal(m, l);
}

/* Replay every captured note message; count notes left sounding on one
 * channel (or all, ch < 0). */
static int notes_left_on(int only_ch) {
    static uint8_t on[16][128];
    memset(on, 0, sizeof on);
    for (int i = 0; i < g_captured_count; i++) {
        uint8_t ch = g_captured[i].channel & 0x0F, n = g_captured[i].note & 0x7F;
        if (g_captured[i].status == 0x90) on[ch][n] = 1;
        else if (g_captured[i].status == 0x80) on[ch][n] = 0;
    }
    int left = 0;
    for (int c = 0; c < 16; c++)
        if (only_ch < 0 || c == only_ch)
            for (int n = 0; n < 128; n++) left += on[c][n];
    return left;
}
static int notes_left_sounding(void) { return notes_left_on(-1); }

/* All Notes Off reached each channel that played, once, and no other (wire
 * channels: drums 0, Inst 1 2, Inst 2 1 -- the JSON's are 1-based). It used
 * to go 16 times to the drum channel only. */
static int cc123_on_played_channels(int with_insts) {
    int others = 0;
    for (int c = 3; c < 16; c++) others += g_cc123[c];
    if (with_insts) return g_cc123[0] == 1 && g_cc123[1] == 1 && g_cc123[2] == 1 && others == 0;
    return g_cc123[0] == 1 && g_cc123[1] == 0 && g_cc123[2] == 0 && others == 0;
}

static int any_cc123(void) {
    int n = 0;
    for (int c = 0; c < 16; c++) n += g_cc123[c];
    return n;
}

/* Instrument notes found still sounding right after a Stop (the hold). */
static int g_held_seen;

/* Blocks of 128 frames at 44.1 kHz: the 10 s instrument hold after Stop,
 * and the 2 s before All Notes Off follows it. */
#define HOLD_BLOCKS 3446
#define CC_DELAY_BLOCKS 690

static int run(plugin_api_v2_t *api, const char *lib, int drop_note_offs, int blocks, int with_insts, int from_bar) {
    char folder[128], json[2048];
    int16_t audio[MOVE_FRAMES_PER_BLOCK * 2];
    void *inst = api->create_instance("/tmp/test_stop", NULL);
    if (!inst || !find_song13_folder(api, inst, lib, folder, sizeof folder)) return -1;
    api->set_param(inst, "emit_directly", "1");
    api->set_param(inst, "output_target", "schwung");
    api->set_param(inst, "schwung_channel", "0");
    api->set_param(inst, "drop_note_offs", drop_note_offs ? "1" : "0");
    /* With instruments: Inst 1 a bass following the kick, Inst 2 a once-per-
     * bar chord (Auto inversion), as in the song from the device log. */
    snprintf(json, sizeof(json),
        "{\"source_folder\":\"%s\",\"name\":\"T\",\"tempo_bpm\":120,"
        "\"time_sig_num\":4,\"time_sig_den\":4,\"ppq\":240,\"key\":\"D\",\"sections\":["
        "{\"name\":\"A\",\"clips\":["
        "{\"source\":\"Grooves/120 Verse Half-Time.mid\",\"start_bar\":0,\"end_bar\":4,\"guard_fraction\":0}"
        "],\"chords\":[{\"root\":\"D\",\"quality\":\"maj\",\"bass\":\"\",\"degree\":0,\"key\":\"D\"},"
        "{\"root\":\"D\",\"quality\":\"maj\",\"bass\":\"\",\"degree\":0,\"key\":\"D\"},"
        "{\"root\":\"G\",\"quality\":\"maj\",\"bass\":\"\",\"degree\":3,\"key\":\"D\"},"
        "{\"root\":\"A\",\"quality\":\"maj\",\"bass\":\"\",\"degree\":4,\"key\":\"D\"}]}"
        "]%s}", folder, with_insts ?
        ",\"instruments\":["
        "{\"enabled\":true,\"output\":\"schwung\",\"channel\":3,\"octave\":2,\"follow_note\":36,\"voicing\":\"bass\",\"note_gap\":0.125},"
        "{\"enabled\":true,\"output\":\"schwung\",\"channel\":2,\"octave\":3,\"follow_note\":0,\"voicing\":\"chord\",\"inversion\":4,\"note_gap\":0.125}]"
        : "");
    uint32_t base = state_u32(api, inst, "primary_published_gen");
    api->set_param(inst, "loop", "0");
    api->set_param(inst, "song_json", json);
    if (!wait_field_change(api, inst, "primary_published_gen", base, 3000)) return -1;
    g_captured_count = 0;
    memset(g_cc123, 0, sizeof g_cc123);
    api->set_param(inst, from_bar ? "play_from_bar" : "play", from_bar ? "0" : "1");
    for (int b = 0; b < blocks; b++) api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
    api->set_param(inst, "stop", "1");
    /* Stop releases drums at once but holds instrument notes so they ring
     * out (asked for), and sends no All Notes Off yet (many synths cut dead
     * on CC 123). */
    int left = notes_left_on(0);
    if (with_insts && notes_left_sounding() > 0) g_held_seen = 1;
    if (any_cc123()) left += 1000;
    if (from_bar) {
        /* A restart during the hold releases the held notes and sends All
         * Notes Off before any new note-on -- never after one. */
        for (int b = 0; b < 170; b++) api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
        if (any_cc123()) left += 1000;
        int notes_at_restart = g_captured_count;
        g_notes_before_cc = -1;
        api->set_param(inst, "play_from_bar", "0");
        for (int b = 0; b < 50; b++) api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
        if (g_notes_before_cc < notes_at_restart) left += 1000;
        for (int i = notes_at_restart; i < g_notes_before_cc && i < g_captured_count; i++)
            if (g_captured[i].status == 0x90) left += 1000;
        if (!cc123_on_played_channels(with_insts)) left += 1000;
        memset(g_cc123, 0, sizeof g_cc123);
        for (int b = 0; b < 800; b++) api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
        if (any_cc123()) left += 1000; /* no late one */
        api->set_param(inst, "stop", "1");
    }
    /* After the hold every note is released, still without All Notes Off,
     * which follows 2 s later. With nothing held, it follows the Stop by 2 s. */
    int held = notes_left_sounding() > notes_left_on(0);
    if (held) {
        for (int b = 0; b < HOLD_BLOCKS + 5; b++) api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
        left += notes_left_sounding();
        if (any_cc123()) left += 1000;
    }
    for (int b = 0; b < CC_DELAY_BLOCKS + 5; b++) api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
    left += notes_left_sounding();
    if (!cc123_on_played_channels(with_insts)) left += 1000;
    api->destroy_instance(inst);
    return left;
}

int main(int argc, char **argv) {
    if (argc < 2) { fprintf(stderr, "usage: %s <library_root>\n", argv[0]); return 1; }
    host_api_v1_t host = make_test_host();
    g_inner_send_internal = host.midi_send_internal;
    host.midi_send_internal = counting_send_internal;
    plugin_api_v2_t *api = move_plugin_init_v2(&host);

    /* Stop at a spread of points mid-groove, so some land inside notes. */
    int worst_drop = 0, worst_plain = 0, worst_inst = 0, worst_inst_bar = 0;
    for (int blocks = 100; blocks <= 2500; blocks += 137) {
        int a = run(api, argv[1], 1, blocks, 0, 0);
        int b = run(api, argv[1], 0, blocks, 0, 0);
        int c = run(api, argv[1], 0, blocks, 1, 0);
        int d = run(api, argv[1], 0, blocks, 1, 1);
        if (a < 0 || b < 0 || c < 0 || d < 0) { fprintf(stderr, "setup failed\n"); return 1; }
        if (a > worst_drop) worst_drop = a;
        if (b > worst_plain) worst_plain = b;
        if (c > worst_inst) worst_inst = c;
        if (d > worst_inst_bar) worst_inst_bar = d;
    }
    printf("info: notes left sounding, worst case: drop-note-offs %d, plain %d, with instruments %d, from bar %d\n",
           worst_drop, worst_plain, worst_inst, worst_inst_bar);
    /* A worst case of 1000+ means All Notes Off went out wrongly: too soon,
     * after a new note, or to the wrong channels. */
    CHECK(worst_drop == 0, "stop with Drop Note-Offs on: no drum note left sounding");
    CHECK(worst_plain == 0, "stop mid-groove: no drum note left sounding");
    CHECK(worst_inst == 0, "stop with a bass and a once-per-bar chord: no note left sounding");
    CHECK(g_held_seen, "stop with instruments sounding holds them (they ring out)");
    CHECK(worst_inst_bar == 0, "same, started with play_from_bar (as Perform does): no note left sounding");

    if (g_failures == 0) printf("\nALL TESTS PASSED\n");
    else printf("\n%d TEST(S) FAILED\n", g_failures);
    return g_failures == 0 ? 0 : 1;
}
