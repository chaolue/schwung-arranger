/*
 * Instrument playing variety: Vel Follow, bass patterns, approach notes, the
 * arpeggio voicing, strum and chance -- against the real fixture's kick
 * (note 36 on drum channel 0), whose hits and velocities are read back from
 * the capture rather than assumed.
 *
 * Usage: test_inst_variety <library_root>  (expects the "Song 13" fixture)
 */

#include "test_common.h"

static int transport_tick(plugin_api_v2_t *api, void *inst) {
    char t[1024];
    api->get_param(inst, "transport", t, sizeof(t));
    unsigned bar = 0, beat = 0, tpbeat = 0, tpbar = 0;
    double beat_progress = 0.0;
    sscanf(strstr(t, "\"bar\":"), "\"bar\":%u", &bar);
    sscanf(strstr(t, "\"beat\":"), "\"beat\":%u", &beat);
    sscanf(strstr(t, "\"beat_progress\":"), "\"beat_progress\":%lf", &beat_progress);
    sscanf(strstr(t, "\"ticks_per_beat\":"), "\"ticks_per_beat\":%u", &tpbeat);
    sscanf(strstr(t, "\"ticks_per_bar\":"), "\"ticks_per_bar\":%u", &tpbar);
    return (int)((bar - 1) * tpbar + (beat - 1) * tpbeat + beat_progress * tpbeat);
}

#define MAXEV 4096
static int ev_tick[MAXEV];
static int n_ev;

/* Note-ons on a channel, in order: notes, velocities, ticks. */
static int note_ons(int ch, int *notes, int *vels, int *ticks, int max) {
    int k = 0;
    for (int i = 0; i < n_ev && k < max; i++) {
        if (g_captured[i].channel != ch || g_captured[i].status != 0x90 || g_captured[i].vel == 0) continue;
        if (notes) notes[k] = g_captured[i].note;
        if (vels) vels[k] = g_captured[i].vel;
        if (ticks) ticks[k] = ev_tick[i];
        k++;
    }
    return k;
}

/* Every note-on on `ch` has a later note-off (nothing left hanging). */
static int all_released(int ch) {
    int on[128] = {0};
    for (int i = 0; i < n_ev; i++) {
        if (g_captured[i].channel != ch) continue;
        int n = g_captured[i].note;
        if (g_captured[i].status == 0x90 && g_captured[i].vel > 0) on[n]++;
        else if (g_captured[i].status == 0x80 || g_captured[i].status == 0x90) { if (on[n] > 0) on[n]--; }
    }
    for (int n = 0; n < 128; n++) if (on[n]) return 0;
    return 1;
}

static int play_song(plugin_api_v2_t *api, void *inst, const char *json, int blocks) {
    int16_t audio[MOVE_FRAMES_PER_BLOCK * 2];
    uint32_t base = state_u32(api, inst, "primary_published_gen");
    api->set_param(inst, "loop", "0");
    api->set_param(inst, "song_json", json);
    if (!wait_field_change(api, inst, "primary_published_gen", base, 3000)) return 0;
    api->set_param(inst, "rng_seed", "12345");
    g_captured_count = 0;
    api->set_param(inst, "play", "1");
    int prev = 0;
    for (int b = 0; b < blocks; b++) {
        api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
        if (g_captured_count > prev) {
            int t = transport_tick(api, inst);
            for (int i = prev; i < g_captured_count && i < MAXEV; i++) ev_tick[i] = t;
            prev = g_captured_count;
        }
    }
    stop_and_ring_out(api, inst);
    n_ev = g_captured_count < MAXEV ? g_captured_count : MAXEV;
    return 1;
}

#define CLIP "{\"source\":\"Grooves/120 Verse Half-Time.mid\",\"start_bar\":0,\"end_bar\":4,\"guard_fraction\":0}"

int main(int argc, char **argv) {
    if (argc < 2) { fprintf(stderr, "usage: %s <library_root>\n", argv[0]); return 1; }
    host_api_v1_t host = make_test_host();
    plugin_api_v2_t *api = move_plugin_init_v2(&host);
    char folder[128], json[4096];

    void *inst = api->create_instance("/tmp/test_inst_variety", NULL);
    if (!inst || !find_song13_folder(api, inst, argv[1], folder, sizeof folder)) return 1;
    api->set_param(inst, "emit_directly", "1");
    api->set_param(inst, "output_target", "schwung");
    api->set_param(inst, "schwung_channel", "0");
    api->set_param(inst, "swap_guard_fraction", "0");

    int kv[256], an[256], av[256], at[256];

    /* ---- Run 1: Root/5th + Vel Follow on the kick; Approach on chord bars ----
     * D for bars 1-2, G for bars 3-4. Inst 1 (wire ch 1): bass, octave 3,
     * follows the kick, Root/5th, Vel Follow, velocity 100 -- D3 50 / A3 57,
     * then G3 55 / D4 62. Inst 2 (wire ch 2): bass on the chord bars,
     * octave 2 (D2 38, G2 43), Approach below: F#2 42 half a beat before G. */
    snprintf(json, sizeof(json),
        "{\"source_folder\":\"%s\",\"name\":\"T\",\"tempo_bpm\":120,"
        "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
        "{\"name\":\"A\",\"clips\":[" CLIP "],"
        "\"chords\":[{\"root\":\"D\",\"quality\":\"maj\",\"bass\":\"\"},null,"
        "{\"root\":\"G\",\"quality\":\"maj\",\"bass\":\"\"}]}"
        "],\"instruments\":["
        "{\"enabled\":true,\"output\":\"schwung\",\"channel\":2,\"octave\":3,\"follow_note\":36,"
        "\"voicing\":\"bass\",\"note_gap\":0.125,\"velocity\":100,\"pattern\":1,\"vel_follow\":true},"
        "{\"enabled\":true,\"output\":\"schwung\",\"channel\":3,\"octave\":2,\"follow_note\":0,"
        "\"voicing\":\"bass\",\"note_gap\":0.125,\"approach\":1}"
        "]}", folder);
    CHECK(play_song(api, inst, json, 3000), "run 1 published");
    int nk = 0;
    for (int i = 0; i < n_ev && nk < 256; i++)
        if (g_captured[i].channel == 0 && g_captured[i].status == 0x90 && g_captured[i].note == 36 && g_captured[i].vel > 0) {
            kv[nk++] = g_captured[i].vel;
        }
    int na = note_ons(1, an, av, at, 256);
    printf("info: %d kicks, %d inst 1 notes\n", nk, na);
    CHECK(nk >= 4 && na == nk, "inst 1 plays once per kick");
    int pat_ok = 1, vel_ok = 1, vel_varies = 0;
    int step = 0, last_g = 0;
    for (int i = 0; i < na && i < nk; i++) {
        int g = at[i] >= 1920;   /* bar 3 on: G */
        if (g != last_g) { step = 0; last_g = g; }
        int expect = g ? ((step % 2) ? 62 : 55) : ((step % 2) ? 57 : 50);
        if (an[i] != expect) { pat_ok = 0; printf("info: note %d @%d = %d, expected %d\n", i, at[i], an[i], expect); }
        if (av[i] != kv[i]) vel_ok = 0;
        if (av[i] != av[0]) vel_varies = 1;
        step++;
    }
    CHECK(pat_ok, "Root/5th: root, fifth, root... starting again on the root at the change");
    CHECK(vel_ok, "Vel Follow: each note as loud as its kick");
    printf("info: inst 1 velocities %s\n", vel_varies ? "vary with the kicks" : "are all the same (the clip's kicks are)");
    CHECK(all_released(1), "inst 1: every note released");

    int bn = note_ons(2, an, NULL, at, 256);
    printf("info: inst 2 notes:");
    for (int i = 0; i < bn; i++) printf(" %d@%d", an[i], at[i]);
    printf("\n");
    CHECK(bn == 3 && an[0] == 38 && an[1] == 42 && an[2] == 43, "approach: D2, then F#2, then G2");
    CHECK(bn == 3 && at[1] >= 1800 && at[1] < 1806, "the approach note half a beat before bar 3 (tick 1800)");
    CHECK(bn == 3 && at[2] >= 1920 && at[2] < 1926, "G2 on bar 3");
    CHECK(all_released(2), "inst 2: every note released");

    /* ---- Run 2: Arp up on the kick; strummed chord ----
     * Inst 1: arp of D (50 54 57) on each kick, upward. Inst 2: D chord at
     * octave 3, strummed 50 ms apart lowest first (0.1 beat = 24 ticks at 120). */
    snprintf(json, sizeof(json),
        "{\"source_folder\":\"%s\",\"name\":\"T\",\"tempo_bpm\":120,"
        "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
        "{\"name\":\"A\",\"clips\":[" CLIP "],"
        "\"chords\":[{\"root\":\"D\",\"quality\":\"maj\",\"bass\":\"\"},"
        "{\"root\":\"D\",\"quality\":\"maj\",\"bass\":\"\"}]}"
        "],\"instruments\":["
        "{\"enabled\":true,\"output\":\"schwung\",\"channel\":2,\"octave\":3,\"follow_note\":36,"
        "\"voicing\":\"arp\",\"inversion\":0,\"note_gap\":0.125,\"pattern\":0},"
        "{\"enabled\":true,\"output\":\"schwung\",\"channel\":3,\"octave\":3,\"follow_note\":0,"
        "\"voicing\":\"chord\",\"inversion\":0,\"note_gap\":0.125,\"strum\":50,\"strum_dir\":2}"
        "]}", folder);
    CHECK(play_song(api, inst, json, 3000), "run 2 published");
    na = note_ons(1, an, NULL, NULL, 256);
    int arp_ok = na >= 4;
    const int up[3] = { 50, 54, 57 };
    for (int i = 0; i < na; i++) if (an[i] != up[i % 3]) arp_ok = 0;
    CHECK(arp_ok, "Arp Up: D F# A D ... one tone per kick");
    CHECK(all_released(1), "arp: every note released");
    bn = note_ons(2, an, NULL, at, 256);
    printf("info: strum notes:");
    for (int i = 0; i < bn; i++) printf(" %d@%d", an[i], at[i]);
    printf("\n");
    CHECK(bn == 6, "two strummed chords (bars 1 and 2), three notes each");
    if (bn == 6) {
        CHECK(an[0] == 50 && an[1] == 54 && an[2] == 57, "first strum lowest first");
        CHECK(an[3] == 57 && an[4] == 54 && an[5] == 50, "Alternate: the second highest first");
        int d1 = at[1] - at[0], d2 = at[2] - at[1];
        CHECK(d1 >= 22 && d1 <= 27 && d2 >= 22 && d2 <= 27, "notes 50 ms (24 ticks) apart");
        CHECK(at[0] < 4 && at[3] >= 960 && at[3] < 964, "each strum starts on its bar");
    }
    CHECK(all_released(2), "strum: every note released");

    /* ---- Run 3: Chance ----
     * Inst 1 on every kick at 50%: some play, some do not, and the ones
     * that do are released. Inst 2, the same at the default: all play. */
    snprintf(json, sizeof(json),
        "{\"source_folder\":\"%s\",\"name\":\"T\",\"tempo_bpm\":120,"
        "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
        "{\"name\":\"A\",\"clips\":[" CLIP "," CLIP "," CLIP "],"
        "\"chords\":[{\"root\":\"D\",\"quality\":\"maj\",\"bass\":\"\"}]}"
        "],\"instruments\":["
        "{\"enabled\":true,\"output\":\"schwung\",\"channel\":2,\"octave\":3,\"follow_note\":36,"
        "\"voicing\":\"bass\",\"note_gap\":0.125,\"chance\":50},"
        "{\"enabled\":true,\"output\":\"schwung\",\"channel\":3,\"octave\":2,\"follow_note\":36,"
        "\"voicing\":\"bass\",\"note_gap\":0.125}"
        "]}", folder);
    CHECK(play_song(api, inst, json, 9000), "run 3 published");
    na = note_ons(1, NULL, NULL, NULL, 256);
    bn = note_ons(2, NULL, NULL, NULL, 256);
    printf("info: chance 50%%: %d of %d hits played\n", na, bn);
    CHECK(bn >= 8, "enough kicks to judge");
    CHECK(na > 0 && na < bn, "Chance 50%: some hits play and some do not");
    CHECK(na * 100 >= bn * 20 && na * 100 <= bn * 80, "about half (20-80%)");
    CHECK(all_released(1), "chance: every note released");

    /* ---- Run 4: approach on a kick-following bass; a pattern from an item ----
     * Inst 1 follows the kick (D bars 1-2, G bars 3-4) with Approach above.
     * The clip has no kick on bar 3's downbeat, so the approach leads into
     * the first kick on G (G3 55) instead: G#3 56 half a beat before it, and
     * nothing between. Inst 2 follows the kick plainly until an item at bar 3
     * turns on Root/Oct: G2 43, G3 55, G2 ... */
    snprintf(json, sizeof(json),
        "{\"source_folder\":\"%s\",\"name\":\"T\",\"tempo_bpm\":120,"
        "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
        "{\"name\":\"A\",\"clips\":[" CLIP "],"
        "\"chords\":[{\"root\":\"D\",\"quality\":\"maj\",\"bass\":\"\"},null,"
        "{\"root\":\"G\",\"quality\":\"maj\",\"bass\":\"\"}]}"
        "],\"instruments\":["
        "{\"enabled\":true,\"output\":\"schwung\",\"channel\":2,\"octave\":3,\"follow_note\":36,"
        "\"voicing\":\"bass\",\"note_gap\":0.125,\"approach\":2},"
        "{\"enabled\":true,\"output\":\"schwung\",\"channel\":3,\"octave\":2,\"follow_note\":36,"
        "\"voicing\":\"bass\",\"note_gap\":0.125,\"items\":[{\"section\":0,\"bar\":2,\"pattern\":2}]}"
        "]}", folder);
    CHECK(play_song(api, inst, json, 3000), "run 4 published");
    na = note_ons(1, an, NULL, at, 256);
    printf("info: kick bass with approach:");
    for (int i = 0; i < na; i++) printf(" %d@%d", an[i], at[i]);
    printf("\n");
    int ap = -1;
    for (int i = 0; i < na; i++) if (an[i] == 56) ap = i;
    int g1 = ap >= 0 && ap + 1 < na ? at[ap + 1] : -1;
    CHECK(ap >= 0 && ap + 1 < na && an[ap + 1] == 55 && g1 >= 1920, "the approach, then straight to G3 on the first kick of bar 3");
    CHECK(ap >= 0 && g1 - at[ap] >= 118 && g1 - at[ap] <= 124, "half a beat (120 ticks) before that kick");
    int d_after_change = 0;
    for (int i = 0; i < na; i++) if (an[i] == 50 && at[i] >= 1920) d_after_change = 1;
    CHECK(!d_after_change, "no D after the change");
    CHECK(all_released(1), "kick approach: every note released");
    bn = note_ons(2, an, NULL, at, 256);
    int oct_ok = 1, after = 0, k = 0;
    for (int i = 0; i < bn; i++) {
        if (at[i] < 1920) { if (an[i] != 38) oct_ok = 0; continue; }
        after++;
        if (an[i] != ((k++ % 2) ? 55 : 43)) oct_ok = 0;
    }
    CHECK(after >= 2 && oct_ok, "item at bar 3: Root/Oct from there (D2 plain before)");

    /* ---- Run 5: Arp on the chord grid (Follow Note Off) at its Rate ----
     * D for bar 1, G for bar 2 (then held). Inst 1: Arp Up at 1/8 (120
     * ticks), octave 3: D3 F#3 A3 D3 ... from the bar, then G3 B3 D4 ...
     * starting again on G. Inst 2: Arp Down at 1/16 (60 ticks) on the same. */
    snprintf(json, sizeof(json),
        "{\"source_folder\":\"%s\",\"name\":\"T\",\"tempo_bpm\":120,"
        "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
        "{\"name\":\"A\",\"clips\":[" CLIP "],"
        "\"chords\":[{\"root\":\"D\",\"quality\":\"maj\",\"bass\":\"\"},"
        "{\"root\":\"G\",\"quality\":\"maj\",\"bass\":\"\"}]}"
        "],\"instruments\":["
        "{\"enabled\":true,\"output\":\"schwung\",\"channel\":2,\"octave\":3,\"follow_note\":0,"
        "\"voicing\":\"arp\",\"inversion\":0,\"note_gap\":0.5,\"pattern\":0,\"arp_rate\":2},"
        "{\"enabled\":true,\"output\":\"schwung\",\"channel\":3,\"octave\":3,\"follow_note\":0,"
        "\"voicing\":\"arp\",\"inversion\":0,\"note_gap\":0.125,\"pattern\":1,\"arp_rate\":4}"
        "]}", folder);
    CHECK(play_song(api, inst, json, 3000), "run 5 published");
    na = note_ons(1, an, NULL, at, 256);
    printf("info: arp 1/8:");
    for (int i = 0; i < na && i < 20; i++) printf(" %d@%d", an[i], at[i]);
    printf("\n");
    int up8 = na >= 24, even8 = 1;
    const int dup[3] = { 50, 54, 57 }, gup[3] = { 55, 59, 62 };
    for (int i = 0; i < na && i < 24; i++) {
        int expect = i < 8 ? dup[i % 3] : gup[(i - 8) % 3];
        if (an[i] != expect) up8 = 0;
        if (at[i] < i * 120 || at[i] > i * 120 + 4) even8 = 0;
    }
    CHECK(up8, "Arp Up at 1/8: D F# A D... for bar 1, then G B D G... from bar 2 (held into bar 3)");
    CHECK(even8, "a note every 120 ticks (an eighth), on the grid");
    CHECK(all_released(1), "arp 1/8: every note released");
    bn = note_ons(2, an, NULL, at, 256);
    int down16 = bn >= 16, even16 = 1;
    for (int i = 0; i < 16 && i < bn; i++) {
        if (an[i] != dup[2 - i % 3]) down16 = 0;
        if (at[i] < i * 60 || at[i] > i * 60 + 4) even16 = 0;
    }
    CHECK(down16 && even16, "Arp Down at 1/16: A F# D A... every 60 ticks");
    CHECK(all_released(2), "arp 1/16: every note released");

    /* ---- Run 6: Random arp around its base; Pedal over two octaves ----
     * D held 4 bars, both arps at 1/16 (60 ticks) on the chord grid.
     * Inst 1: Random, Chance 50%, Vel Range 40%, velocity 100: it starts on
     * the base D3 50, every D3 plays at 100 and is never skipped, and the
     * others are skipped about half the time and play at 60-90. Inst 2:
     * Pedal, Range 2: D3 under each of F#3 A3 D4 F#4 A4 in turn. */
    snprintf(json, sizeof(json),
        "{\"source_folder\":\"%s\",\"name\":\"T\",\"tempo_bpm\":120,"
        "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
        "{\"name\":\"A\",\"clips\":[" CLIP "],"
        "\"chords\":[{\"root\":\"D\",\"quality\":\"maj\",\"bass\":\"\"}]}"
        "],\"instruments\":["
        "{\"enabled\":true,\"output\":\"schwung\",\"channel\":2,\"octave\":3,\"follow_note\":0,"
        "\"voicing\":\"arp\",\"inversion\":0,\"note_gap\":0.125,\"pattern\":3,\"arp_rate\":4,"
        "\"chance\":50,\"arp_vel\":40,\"velocity\":100},"
        "{\"enabled\":true,\"output\":\"schwung\",\"channel\":3,\"octave\":3,\"follow_note\":0,"
        "\"voicing\":\"arp\",\"inversion\":0,\"note_gap\":0.125,\"pattern\":7,\"arp_rate\":4,\"arp_range\":2}"
        "]}", folder);
    CHECK(play_song(api, inst, json, 3000), "run 6 published");
    na = note_ons(1, an, av, at, 256);
    int bases = 0, base_vel_ok = 1, other = 0, other_vel_ok = 1;
    for (int i = 0; i < na; i++) {
        if (an[i] == 50) { bases++; if (av[i] != 100) base_vel_ok = 0; }
        else { other++; if (av[i] < 60 || av[i] > 90) other_vel_ok = 0; }
    }
    printf("info: random arp: %d notes (%d base, %d other) of 64 steps\n", na, bases, other);
    CHECK(na > 0 && an[0] == 50 && at[0] < 4 && av[0] == 100, "Random starts on the base, D3, at full velocity");
    CHECK(base_vel_ok, "the base always at full velocity");
    CHECK(other > 0 && other_vel_ok, "the other notes quieter: 60-90 with Vel Range 40%");
    CHECK(na < 64, "Chance skips some of the other notes");
    bn = note_ons(2, an, NULL, NULL, 256);
    const int pedal[10] = { 50, 54, 50, 57, 50, 62, 50, 66, 50, 69 };
    int ped_ok = bn >= 20;
    for (int i = 0; i < bn && i < 20; i++) if (an[i] != pedal[i % 10]) ped_ok = 0;
    CHECK(ped_ok, "Pedal over two octaves: D3 F#3 D3 A3 D3 D4 D3 F#4 D3 A4 ...");
    CHECK(all_released(1) && all_released(2), "run 6: every note released");

    /* ---- Run 7: Alberti and Converge; Shuffle rounds ---- */
    snprintf(json, sizeof(json),
        "{\"source_folder\":\"%s\",\"name\":\"T\",\"tempo_bpm\":120,"
        "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
        "{\"name\":\"A\",\"clips\":[" CLIP "],"
        "\"chords\":[{\"root\":\"D\",\"quality\":\"maj\",\"bass\":\"\"}]}"
        "],\"instruments\":["
        "{\"enabled\":true,\"output\":\"schwung\",\"channel\":2,\"octave\":3,\"follow_note\":0,"
        "\"voicing\":\"arp\",\"inversion\":0,\"note_gap\":0.125,\"pattern\":6,\"arp_rate\":4},"
        "{\"enabled\":true,\"output\":\"schwung\",\"channel\":3,\"octave\":3,\"follow_note\":0,"
        "\"voicing\":\"arp\",\"inversion\":0,\"note_gap\":0.125,\"pattern\":8,\"arp_rate\":4,\"arp_range\":2}"
        "]}", folder);
    CHECK(play_song(api, inst, json, 3000), "run 7 published");
    na = note_ons(1, an, NULL, NULL, 256);
    const int alb[4] = { 50, 57, 54, 57 };
    int alb_ok = na >= 16;
    for (int i = 0; i < na && i < 16; i++) if (an[i] != alb[i % 4]) alb_ok = 0;
    CHECK(alb_ok, "Alberti: D A F# A ...");
    bn = note_ons(2, an, NULL, NULL, 256);
    const int conv[6] = { 50, 69, 54, 66, 57, 62 };
    int conv_ok = bn >= 12;
    for (int i = 0; i < bn && i < 12; i++) if (an[i] != conv[i % 6]) conv_ok = 0;
    CHECK(conv_ok, "Converge over two octaves: D3 A4 F#3 F#4 A3 D4 ...");

    snprintf(json, sizeof(json),
        "{\"source_folder\":\"%s\",\"name\":\"T\",\"tempo_bpm\":120,"
        "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
        "{\"name\":\"A\",\"clips\":[" CLIP "],"
        "\"chords\":[{\"root\":\"D\",\"quality\":\"maj\",\"bass\":\"\"}]}"
        "],\"instruments\":["
        "{\"enabled\":true,\"output\":\"schwung\",\"channel\":2,\"octave\":3,\"follow_note\":0,"
        "\"voicing\":\"arp\",\"inversion\":0,\"note_gap\":0.125,\"pattern\":5,\"arp_rate\":4,\"arp_range\":2},"
        "{\"enabled\":true,\"output\":\"schwung\",\"channel\":3,\"octave\":2,\"follow_note\":36,"
        "\"voicing\":\"bass\",\"note_gap\":0.125,\"pattern\":7}"
        "]}", folder);
    CHECK(play_song(api, inst, json, 3000), "run 8 published");
    na = note_ons(1, an, NULL, NULL, 256);
    int shuf_ok = na >= 24 && an[0] == 50, varied = 0;
    for (int r = 0; r + 6 <= na && r < 24; r += 6) {
        int seen = 0;
        for (int i = r; i < r + 6; i++) {
            int bit = an[i] == 50 ? 0 : an[i] == 54 ? 1 : an[i] == 57 ? 2 : an[i] == 62 ? 3 : an[i] == 66 ? 4 : an[i] == 69 ? 5 : 6;
            seen |= 1 << bit;
            if (r > 0 && an[i] != an[i - 6]) varied = 1;
        }
        if (seen != 0x3F) shuf_ok = 0;
    }
    CHECK(shuf_ok, "Shuffle: each round of six plays every tone once, the first starting on the base");
    CHECK(varied, "...in a different order from round to round");
    bn = note_ons(2, an, NULL, NULL, 256);
    const int boogie[8] = { 38, 42, 45, 47, 48, 47, 45, 42 };   /* D2 F#2 A2 B2 C3 B2 A2 F#2 */
    int boo_ok = bn >= 8;
    for (int i = 0; i < bn; i++) if (an[i] != boogie[i % 8]) boo_ok = 0;
    CHECK(boo_ok, "Boogie bass on the kicks: 1 3 5 6 b7 6 5 3");
    CHECK(all_released(1) && all_released(2), "runs 7-8: every note released");

    /* ---- Run 9: the bass counts its octave from the key's root ----
     * Key Bb (as the UI sends it, each chord carrying "key"), Octave 3:
     * Bb Bb F Eb bars -> Bb2 (46), F3 (53), Eb3 (51) -- the tonic lowest, not
     * Bb3 at the top of a C-based octave. Inst 2: key D, a C chord's bass
     * goes ABOVE the tonic, to C4 (60), and D is D3 (50). */
    snprintf(json, sizeof(json),
        "{\"source_folder\":\"%s\",\"name\":\"T\",\"tempo_bpm\":120,"
        "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
        "{\"name\":\"A\",\"clips\":[" CLIP "],"
        "\"chords\":[{\"root\":\"Bb\",\"quality\":\"maj\",\"key\":\"A#\",\"degree\":0},null,"
        "{\"root\":\"F\",\"quality\":\"maj\",\"key\":\"A#\",\"degree\":4},"
        "{\"root\":\"D#\",\"quality\":\"maj\",\"key\":\"A#\",\"degree\":3}]}"
        "],\"instruments\":["
        "{\"enabled\":true,\"output\":\"schwung\",\"channel\":2,\"octave\":3,\"follow_note\":0,"
        "\"voicing\":\"bass\",\"note_gap\":0.125}]}", folder);
    CHECK(play_song(api, inst, json, 3000), "run 9 published");
    na = note_ons(1, an, NULL, NULL, 256);
    printf("info: Bb key bass:");
    for (int i = 0; i < na; i++) printf(" %d", an[i]);
    printf("\n");
    CHECK(na == 3 && an[0] == 46 && an[1] == 53 && an[2] == 51, "key Bb, Octave 3: Bb2 F3 Eb3 -- the tonic lowest");
    snprintf(json, sizeof(json),
        "{\"source_folder\":\"%s\",\"name\":\"T\",\"tempo_bpm\":120,"
        "\"time_sig_num\":4,\"time_sig_den\":4,\"sections\":["
        "{\"name\":\"A\",\"clips\":[" CLIP "],"
        "\"chords\":[{\"root\":\"D\",\"quality\":\"maj\",\"key\":\"D\",\"degree\":0},"
        "{\"root\":\"C\",\"quality\":\"maj\",\"key\":\"D\",\"degree\":-1}]}"
        "],\"instruments\":["
        "{\"enabled\":true,\"output\":\"schwung\",\"channel\":2,\"octave\":3,\"follow_note\":0,"
        "\"voicing\":\"bass\",\"note_gap\":0.125}]}", folder);
    CHECK(play_song(api, inst, json, 3000), "run 9b published");
    na = note_ons(1, an, NULL, NULL, 256);
    CHECK(na == 2 && an[0] == 50 && an[1] == 60, "key D, Octave 3: D3, and the C chord above it at C4");

    api->destroy_instance(inst);
    if (g_failures == 0) printf("\nALL TESTS PASSED\n");
    else printf("\n%d TEST(S) FAILED\n", g_failures);
    return g_failures == 0 ? 0 : 1;
}
