/*
 * A placeholder clip -- what a deleted drum clip leaves in a section with
 * chords, so the clips after it keep their bars -- is sent to the engine as a
 * silent MIDI file: one note-off on its last tick (to set its length), and
 * an end of track. This writes the same bytes as ui.js's placeholderMidiPath
 * and checks the engine plays it as silence of its length: the clip after a
 * 2-bar placeholder starts on bar 3, and nothing sounds in bars 1-2.
 *
 * Usage: test_placeholder <library_root>
 */

#include "test_common.h"

#define PH_PATH "/tmp/test_placeholder_silence.mid"

/* placeholderMidiPath(bars, 4, 4): division 240, a note-off at bars * 960. */
static int write_silence(int bars) {
    uint32_t ticks = (uint32_t)bars * 240 * 4;
    uint8_t vlq[5]; int vn = 0;
    uint8_t tmp[5]; int tn = 0;
    uint32_t v = ticks;
    tmp[tn++] = v & 0x7F; v >>= 7;
    while (v) { tmp[tn++] = (uint8_t)((v & 0x7F) | 0x80); v >>= 7; }
    while (tn) vlq[vn++] = tmp[--tn];
    uint8_t trk[16]; int n = 0;
    for (int i = 0; i < vn; i++) trk[n++] = vlq[i];
    trk[n++] = 0x80; trk[n++] = 0; trk[n++] = 0;
    trk[n++] = 0; trk[n++] = 0xFF; trk[n++] = 0x2F; trk[n++] = 0;
    FILE *f = fopen(PH_PATH, "wb");
    if (!f) return 0;
    const uint8_t hdr[14] = { 'M','T','h','d', 0,0,0,6, 0,0, 0,1, 0,240 };
    fwrite(hdr, 1, sizeof hdr, f);
    const uint8_t mtrk[8] = { 'M','T','r','k', 0,0,0,(uint8_t)n };
    fwrite(mtrk, 1, sizeof mtrk, f);
    fwrite(trk, 1, (size_t)n, f);
    fclose(f);
    return 1;
}

int main(int argc, char **argv) {
    if (argc < 2) { fprintf(stderr, "usage: %s <library_root>\n", argv[0]); return 1; }
    host_api_v1_t host = make_test_host();
    plugin_api_v2_t *api = move_plugin_init_v2(&host);
    void *inst = api->create_instance("/tmp/test_placeholder", NULL);
    char folder[128], json[2048];
    if (!inst || !find_song13_folder(api, inst, argv[1], folder, sizeof folder)) return 1;
    if (!write_silence(3)) { fprintf(stderr, "cannot write %s\n", PH_PATH); return 1; }
    api->set_param(inst, "emit_directly", "1");
    api->set_param(inst, "output_target", "schwung");
    snprintf(json, sizeof json,
        "{\"source_folder\":\"%s\",\"name\":\"P\",\"tempo_bpm\":120,\"time_sig_num\":4,\"time_sig_den\":4,"
        "\"sections\":[{\"name\":\"A\",\"clips\":["
        "{\"source\":\"Grooves/120 Verse Half-Time.mid\",\"start_bar\":0,\"end_bar\":1},"
        "{\"source\":\"" PH_PATH "\",\"start_bar\":0,\"end_bar\":2},"
        "{\"source\":\"Grooves/120 Verse Half-Time.mid\",\"start_bar\":0,\"end_bar\":1}],"
        "\"chords\":[]}]}", folder);
    uint32_t base = state_u32(api, inst, "primary_published_gen");
    api->set_param(inst, "loop", "0");
    api->set_param(inst, "song_json", json);
    CHECK(wait_field_change(api, inst, "primary_published_gen", base, 3000), "the song with a placeholder builds");
    g_captured_count = 0;
    api->set_param(inst, "play", "1");
    int16_t audio[MOVE_FRAMES_PER_BLOCK * 2];
    /* 4 bars at 120 bpm = 8 s = ~2756 blocks; a bar is ~689. */
    for (int b = 0; b < 3000; b++) { g_block = b; api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK); }
    int in_bar1 = 0, in_gap = 0, in_bar4 = 0;
    for (int i = 0; i < g_captured_count; i++) {
        if (g_captured[i].status != 0x90) continue;
        int b = g_captured[i].block;
        if (b < 680) in_bar1++;
        else if (b > 700 && b < 2050) in_gap++;
        else if (b >= 2060 && b < 2760) in_bar4++;
    }
    printf("info: drum note-ons: bar 1 %d, bars 2-3 (placeholder) %d, bar 4 %d\n", in_bar1, in_gap, in_bar4);
    CHECK(in_bar1 > 0, "the first clip plays in bar 1");
    CHECK(in_gap == 0, "nothing sounds over the 2-bar placeholder");
    CHECK(in_bar4 > 0, "the clip after it starts on bar 4, where it was");
    CHECK(count_note(0x80, 0) == 0, "its length-setting note-off is never sent");
    remove(PH_PATH);
    api->destroy_instance(inst);
    if (g_failures == 0) printf("\nALL TESTS PASSED\n");
    else printf("\n%d TEST(S) FAILED\n", g_failures);
    return g_failures == 0 ? 0 : 1;
}
