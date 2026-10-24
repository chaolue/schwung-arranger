/*
 * Keys and Pads.
 *
 * Keys: Perform/Jam's playable pads. Pad notes reach the engine's on_midi
 * (Schwung delivers them on the audio thread); while keys_on they play the
 * layout's note on the Keys route. Checked: the layouts' notes, the route
 * and channel, a note-off matching its note-on after an octave change, Keys
 * off releasing a held key, and nothing played while off.
 *
 * Pads: a third song instrument, playing every chord; inst3_enabled mutes it
 * live.
 *
 * Usage: test_keys_pads <library_root>  (expects the "Song 13" fixture)
 */

#include "test_common.h"

static void pad(plugin_api_v2_t *api, void *inst, int idx, int vel) {
    uint8_t m[3] = { (uint8_t)(vel ? 0x90 : 0x80), (uint8_t)(68 + idx), (uint8_t)vel };
    api->on_midi(inst, m, 3, 0);
}

/* The last captured event, or NULL. */
static captured_event_t *last_ev(void) {
    return g_captured_count > 0 ? &g_captured[g_captured_count - 1] : NULL;
}

int main(int argc, char **argv) {
    if (argc < 2) { fprintf(stderr, "usage: %s <library_root>\n", argv[0]); return 1; }
    host_api_v1_t host = make_test_host();
    plugin_api_v2_t *api = move_plugin_init_v2(&host);
    int16_t audio[MOVE_FRAMES_PER_BLOCK * 2];
    char folder[128], json[4096];

    void *inst = api->create_instance("/tmp/test_keys_pads", NULL);
    if (!inst) return 1;

    /* ---- Keys ---- */
    api->set_param(inst, "keys_output", "schwung");
    api->set_param(inst, "keys_channel", "5");
    api->set_param(inst, "keys_root", "2");      /* D */
    api->set_param(inst, "keys_octave", "3");    /* bottom left D3 = 50 */
    api->set_param(inst, "keys_layout", "0");    /* In Key, rows a 4th apart */
    api->set_param(inst, "keys_scale", "0");     /* major */

    g_captured_count = 0;
    pad(api, inst, 0, 100);
    CHECK(g_captured_count == 0, "Keys off: a pad plays nothing");

    api->set_param(inst, "keys_on", "1");
    pad(api, inst, 0, 100);
    captured_event_t *ev = last_ev();
    CHECK(ev && ev->status == 0x90 && ev->note == 50 && ev->vel == 100 && ev->channel == 4 && ev->route == ROUTE_INTERNAL,
          "In Key: the bottom-left pad is D3 (50), on Schwung channel 5, at the pad's velocity");
    pad(api, inst, 0, 0);
    ev = last_ev();
    CHECK(ev && (ev->status == 0x80 || (ev->status == 0x90 && ev->vel == 0)) && ev->note == 50, "its release: D3 off");

    int expect_key[][2] = { { 1, 52 }, { 2, 54 }, { 7, 62 }, { 8, 55 }, { 16, 61 } };
    int ok = 1;
    for (unsigned i = 0; i < sizeof expect_key / sizeof expect_key[0]; i++) {
        pad(api, inst, expect_key[i][0], 90);
        ev = last_ev();
        if (!ev || ev->note != expect_key[i][1]) { ok = 0; printf("info: pad %d -> %d, expected %d\n", expect_key[i][0], ev ? ev->note : -1, expect_key[i][1]); }
        pad(api, inst, expect_key[i][0], 0);
    }
    CHECK(ok, "In Key 4ths: E F# along the row, D4 at its end, G3 (a 4th up) above, C#4 two rows up");

    api->set_param(inst, "keys_layout", "3");    /* Chromatic 4ths */
    pad(api, inst, 9, 80);
    ev = last_ev();
    CHECK(ev && ev->note == 50 + 1 + 5, "Chromatic 4ths: one pad right and a row up is 6 semitones up (56)");
    /* Change octave while it is held: its release still turns off 56. */
    api->set_param(inst, "keys_octave", "4");
    pad(api, inst, 9, 0);
    ev = last_ev();
    CHECK(ev && ev->note == 56, "a key released after an octave change turns off the note it played");
    pad(api, inst, 0, 70);
    ev = last_ev();
    CHECK(ev && ev->note == 62, "the new octave: the bottom-left pad is D4");

    /* Keys off releases the held D4. */
    int before = g_captured_count;
    api->set_param(inst, "keys_on", "0");
    ev = last_ev();
    CHECK(g_captured_count == before + 1 && ev && ev->note == 62 &&
          (ev->status == 0x80 || ev->vel == 0), "Keys off releases the held key");
    before = g_captured_count;
    pad(api, inst, 0, 0);
    CHECK(g_captured_count == before, "...and that pad's own release sends nothing more");

    api->set_param(inst, "keys_on", "1");
    api->set_param(inst, "keys_output", "external");
    api->set_param(inst, "keys_channel", "1");
    pad(api, inst, 0, 100);
    ev = last_ev();
    CHECK(ev && ev->route == ROUTE_EXTERNAL && ev->channel == 0, "the External route, channel 1");
    pad(api, inst, 0, 0);
    api->set_param(inst, "keys_on", "0");

    /* ---- Pads: a third instrument ---- */
    if (!find_song13_folder(api, inst, argv[1], folder, sizeof folder)) return 1;
    api->set_param(inst, "emit_directly", "1");
    api->set_param(inst, "output_target", "schwung");
    api->set_param(inst, "schwung_channel", "0");
    snprintf(json, sizeof(json),
        "{\"source_folder\":\"%s\",\"name\":\"T\",\"tempo_bpm\":120,"
        "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
        "{\"name\":\"A\",\"clips\":[{\"source\":\"Grooves/120 Verse Half-Time.mid\",\"start_bar\":0,\"end_bar\":4,\"guard_fraction\":0}],"
        "\"chords\":[{\"root\":\"D\",\"quality\":\"maj\",\"bass\":\"\"},{\"root\":\"G\",\"quality\":\"maj\",\"bass\":\"\"}]}"
        "],\"instruments\":["
        "{\"enabled\":false,\"output\":\"schwung\",\"channel\":2,\"octave\":2,\"follow_note\":0,\"voicing\":\"bass\"},"
        "{\"enabled\":false,\"output\":\"schwung\",\"channel\":3,\"octave\":3,\"follow_note\":0,\"voicing\":\"chord\"},"
        "{\"enabled\":true,\"output\":\"schwung\",\"channel\":7,\"octave\":4,\"follow_note\":0,\"voicing\":\"chord\","
        "\"inversion\":0,\"note_gap\":0.125}"
        "]}", folder);
    uint32_t base = state_u32(api, inst, "primary_published_gen");
    api->set_param(inst, "loop", "0");
    api->set_param(inst, "song_json", json);
    CHECK(wait_field_change(api, inst, "primary_published_gen", base, 3000), "song with Pads published");
    g_captured_count = 0;
    api->set_param(inst, "play", "1");
    for (int b = 0; b < 700; b++) api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
    int d = 0, g = 0;
    for (int i = 0; i < g_captured_count; i++) {
        if (g_captured[i].channel != 6 || g_captured[i].status != 0x90 || g_captured[i].vel == 0) continue;
        if (g_captured[i].note == 62 || g_captured[i].note == 66 || g_captured[i].note == 69) d++;
        if (g_captured[i].note == 67 || g_captured[i].note == 71 || g_captured[i].note == 74) g++;
    }
    CHECK(d == 3 && g == 3, "Pads play D (62 66 69) then G (67 71 74) on channel 7");
    /* Live mute, as Perform does: cut at once, nothing more. */
    api->set_param(inst, "inst3_enabled", "0");
    int ons = 0;
    g_captured_count = 0;
    for (int b = 0; b < 1400; b++) api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
    for (int i = 0; i < g_captured_count; i++)
        if (g_captured[i].channel == 6 && g_captured[i].status == 0x90 && g_captured[i].vel > 0) ons++;
    CHECK(ons == 0, "inst3_enabled 0: Pads play no more");
    api->set_param(inst, "inst3_enabled", "1");

    stop_and_ring_out(api, inst);

    /* ---- Live instrument updates (Song Builder's settings while playing) ----
     * A song with only Inst 1: bass, octave 2, D held for 4 bars (D2 38).
     * Mid-bar, inst1_live moves it to octave 4: D2 is released at once and
     * D4 (62) sounds straight away. inst3_live then adds Pads the song never
     * had (a chord, octave 4: 62 66 69). A new song_json drops the updates. */
    snprintf(json, sizeof(json),
        "{\"source_folder\":\"%s\",\"name\":\"T\",\"tempo_bpm\":120,"
        "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
        "{\"name\":\"A\",\"clips\":[{\"source\":\"Grooves/120 Verse Half-Time.mid\",\"start_bar\":0,\"end_bar\":4,\"guard_fraction\":0}],"
        "\"chords\":[{\"root\":\"D\",\"quality\":\"maj\",\"bass\":\"\"}]}"
        "],\"instruments\":["
        "{\"enabled\":true,\"output\":\"schwung\",\"channel\":2,\"octave\":2,\"follow_note\":0,\"voicing\":\"bass\",\"note_gap\":0.125}"
        "]}", folder);
    base = state_u32(api, inst, "primary_published_gen");
    api->set_param(inst, "song_json", json);
    CHECK(wait_field_change(api, inst, "primary_published_gen", base, 3000), "live: song published");
    g_captured_count = 0;
    api->set_param(inst, "play", "1");
    for (int b = 0; b < 300; b++) api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
    int d2_on = 0;
    for (int i = 0; i < g_captured_count; i++)
        if (g_captured[i].channel == 1 && g_captured[i].status == 0x90 && g_captured[i].vel > 0 && g_captured[i].note == 38) d2_on++;
    CHECK(d2_on == 1, "Inst 1 holds D2");
    g_captured_count = 0;
    api->set_param(inst, "inst1_live", "[{\"enabled\":true,\"output\":\"schwung\",\"channel\":2,\"octave\":4,"
                                       "\"follow_note\":0,\"voicing\":\"bass\",\"note_gap\":0.125}]");
    int d2_off = 0, d4_on = 0;
    for (int i = 0; i < g_captured_count; i++)
        if (g_captured[i].channel == 1 && g_captured[i].note == 38 &&
            (g_captured[i].status == 0x80 || (g_captured[i].status == 0x90 && g_captured[i].vel == 0))) d2_off++;
    CHECK(d2_off == 1, "the live update releases D2 at once");
    for (int b = 0; b < 3; b++) api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
    for (int i = 0; i < g_captured_count; i++)
        if (g_captured[i].channel == 1 && g_captured[i].status == 0x90 && g_captured[i].vel > 0 && g_captured[i].note == 62) d4_on++;
    CHECK(d4_on == 1, "...and D4 sounds within a block or two, mid-bar");
    g_captured_count = 0;
    api->set_param(inst, "inst3_live", "[{\"enabled\":true,\"output\":\"schwung\",\"channel\":7,\"octave\":4,"
                                       "\"follow_note\":0,\"voicing\":\"chord\",\"inversion\":0,\"note_gap\":0.125}]");
    for (int b = 0; b < 3; b++) api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
    int pads_on = 0;
    for (int i = 0; i < g_captured_count; i++)
        if (g_captured[i].channel == 6 && g_captured[i].status == 0x90 && g_captured[i].vel > 0) pads_on++;
    CHECK(pads_on == 3, "Pads added live to a song without them play the chord: " );
    stop_and_ring_out(api, inst);
    base = state_u32(api, inst, "primary_published_gen");
    api->set_param(inst, "song_json", json);
    CHECK(wait_field_change(api, inst, "primary_published_gen", base, 3000), "live: song sent again");
    g_captured_count = 0;
    api->set_param(inst, "play", "1");
    for (int b = 0; b < 300; b++) api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
    int d2_again = 0, pads_again = 0;
    for (int i = 0; i < g_captured_count; i++) {
        if (g_captured[i].status != 0x90 || g_captured[i].vel == 0) continue;
        if (g_captured[i].channel == 1 && g_captured[i].note == 38) d2_again++;
        if (g_captured[i].channel == 6) pads_again++;
    }
    CHECK(d2_again == 1 && pads_again == 0, "a new song_json drops the live updates: the song's own D2, no Pads");
    stop_and_ring_out(api, inst);

    /* ---- A live edit to an item playback has not reached waits for it ----
     * Inst 1: bass, octave 2, D for 4 bars, an item at bar 3 (index 2)
     * setting octave 5. While bar 1 plays, the item is edited to octave 6:
     * D2 (38) keeps sounding -- no release, no re-strike -- and at bar 3 the
     * edited octave plays (D6 = 86), not the old one (D5 = 74). */
    snprintf(json, sizeof(json),
        "{\"source_folder\":\"%s\",\"name\":\"T\",\"tempo_bpm\":120,"
        "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
        "{\"name\":\"A\",\"clips\":[{\"source\":\"Grooves/120 Verse Half-Time.mid\",\"start_bar\":0,\"end_bar\":4,\"guard_fraction\":0}],"
        "\"chords\":[{\"root\":\"D\",\"quality\":\"maj\",\"bass\":\"\"}]}"
        "],\"instruments\":["
        "{\"enabled\":true,\"output\":\"schwung\",\"channel\":2,\"octave\":2,\"follow_note\":0,\"voicing\":\"bass\","
        "\"note_gap\":0.125,\"items\":[{\"section\":0,\"bar\":2,\"octave\":5}]}"
        "]}", folder);
    base = state_u32(api, inst, "primary_published_gen");
    api->set_param(inst, "song_json", json);
    CHECK(wait_field_change(api, inst, "primary_published_gen", base, 3000), "later item: song published");
    g_captured_count = 0;
    api->set_param(inst, "play", "1");
    for (int b = 0; b < 200; b++) api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
    g_captured_count = 0;
    api->set_param(inst, "inst1_live", "[{\"enabled\":true,\"output\":\"schwung\",\"channel\":2,\"octave\":2,"
        "\"follow_note\":0,\"voicing\":\"bass\",\"note_gap\":0.125,\"items\":[{\"section\":0,\"bar\":2,\"octave\":6}]}]");
    for (int b = 0; b < 5; b++) api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
    int touched = 0;
    for (int i = 0; i < g_captured_count; i++) if (g_captured[i].channel == 1) touched++;
    CHECK(touched == 0, "editing an item at bar 3 while bar 1 plays leaves the sounding D2 alone");
    /* Bar 3 starts 4 s in at 120 BPM (~1380 blocks); 205 have played. */
    for (int b = 0; b < 1300; b++) api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
    int d6 = 0, d5 = 0;
    for (int i = 0; i < g_captured_count; i++) {
        if (g_captured[i].channel != 1 || g_captured[i].status != 0x90 || g_captured[i].vel == 0) continue;
        if (g_captured[i].note == 86) d6++;
        if (g_captured[i].note == 74) d5++;
    }
    CHECK(d6 == 1 && d5 == 0, "at bar 3 the edited item plays (D6), not the old one (D5)");
    /* A change to what plays NOW is still heard at once. */
    g_captured_count = 0;
    api->set_param(inst, "inst1_live", "[{\"enabled\":true,\"output\":\"schwung\",\"channel\":2,\"octave\":2,"
        "\"follow_note\":0,\"voicing\":\"bass\",\"note_gap\":0.125,\"items\":[{\"section\":0,\"bar\":2,\"octave\":4}]}]");
    for (int b = 0; b < 3; b++) api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
    int d4 = 0;
    for (int i = 0; i < g_captured_count; i++)
        if (g_captured[i].channel == 1 && g_captured[i].status == 0x90 && g_captured[i].vel > 0 && g_captured[i].note == 62) d4++;
    CHECK(d4 == 1, "editing the item now playing re-strikes at once (D4)");
    stop_and_ring_out(api, inst);

    /* ---- A five-note chord: m7(4) ----
     * Pads, D m7add4 at octave 4, root position: D F G A C (62 65 67 69 72). */
    snprintf(json, sizeof(json),
        "{\"source_folder\":\"%s\",\"name\":\"T\",\"tempo_bpm\":120,"
        "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
        "{\"name\":\"A\",\"clips\":[{\"source\":\"Grooves/120 Verse Half-Time.mid\",\"start_bar\":0,\"end_bar\":4,\"guard_fraction\":0}],"
        "\"chords\":[{\"root\":\"D\",\"quality\":\"m7add4\",\"bass\":\"\"}]}"
        "],\"instruments\":[{\"enabled\":false},{\"enabled\":false},"
        "{\"enabled\":true,\"output\":\"schwung\",\"channel\":7,\"octave\":4,\"follow_note\":0,\"voicing\":\"chord\","
        "\"inversion\":0,\"note_gap\":0.125}]}", folder);
    base = state_u32(api, inst, "primary_published_gen");
    api->set_param(inst, "song_json", json);
    CHECK(wait_field_change(api, inst, "primary_published_gen", base, 3000), "m7(4): song published");
    g_captured_count = 0;
    api->set_param(inst, "play", "1");
    for (int b = 0; b < 100; b++) api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
    int want[5] = { 62, 65, 67, 69, 72 }, got = 0;
    for (int w = 0; w < 5; w++)
        for (int i = 0; i < g_captured_count; i++)
            if (g_captured[i].channel == 6 && g_captured[i].status == 0x90 && g_captured[i].vel > 0 && g_captured[i].note == want[w]) { got++; break; }
    CHECK(got == 5, "D m7(4) plays all five notes: D F G A C");
    stop_and_ring_out(api, inst);
    api->destroy_instance(inst);
    if (g_failures == 0) printf("\nALL TESTS PASSED\n");
    else printf("\n%d TEST(S) FAILED\n", g_failures);
    return g_failures == 0 ? 0 : 1;
}
