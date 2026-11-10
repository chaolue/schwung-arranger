/*
 * An instrument's Lowest Note ("low_note"): a note below it plays whole
 * octaves up until it isn't -- for a bass synth that can't go lower -- its
 * note-off alike, so nothing hangs. A bass an octave too low (octave 0,
 * notes around C0-G1), 1-5 pattern on every kick, against a Lowest Note of
 * E (28): every note lands in 28-39. Writes its own one-clip library.
 *
 * Usage: test_low_note
 */

#include "test_common.h"
#include <sys/stat.h>

#define TPQ 240

static void put32(FILE *f, uint32_t v) { fputc(v >> 24, f); fputc(v >> 16, f); fputc(v >> 8, f); fputc(v, f); }
static void put16(FILE *f, uint16_t v) { fputc(v >> 8, f); fputc(v, f); }

/* A 4-bar 4/4 clip: a kick on every beat (channel 10). */
static void write_clip(const char *path) {
    static uint8_t trk[4096];
    int len = 0;
    trk[len++] = 0; trk[len++] = 0xFF; trk[len++] = 0x58; trk[len++] = 4;
    trk[len++] = 4; trk[len++] = 2; trk[len++] = 24; trk[len++] = 8;
    for (int b = 0; b < 16; b++) {
        trk[len++] = 0; trk[len++] = 0x99; trk[len++] = 36; trk[len++] = 100;
        trk[len++] = 10; trk[len++] = 0x89; trk[len++] = 36; trk[len++] = 0;
        trk[len++] = 0x81; trk[len++] = 0x66; trk[len++] = 0xFF; trk[len++] = 0x01; trk[len++] = 0;
    }
    trk[len++] = 0; trk[len++] = 0xFF; trk[len++] = 0x2F; trk[len++] = 0;
    FILE *f = fopen(path, "wb");
    if (!f) { perror(path); exit(1); }
    fwrite("MThd", 1, 4, f); put32(f, 6); put16(f, 0); put16(f, 1); put16(f, TPQ);
    fwrite("MTrk", 1, 4, f); put32(f, (uint32_t)len); fwrite(trk, 1, len, f);
    fclose(f);
}

static char g_root[256];

/* Play 2 bars of C then G, the bass at octave 0 with `low` as its Lowest
 * Note (or none); the lowest and highest note-ons it sent, and whether every
 * note-on had its note-off by the end. */
static int run(plugin_api_v2_t *api, int low, int *lo, int *hi, int *balanced) {
    void *inst = api->create_instance("/tmp/test_low_note", NULL);
    if (!inst) return 0;
    api->set_param(inst, "library_root", g_root);
    char buf[256];
    for (int i = 0; i < 3000; i++) {
        if (api->get_param(inst, "folder_count", buf, sizeof buf) > 0 && atoi(buf) > 0) break;
        usleep(1000);
    }
    char lowf[32] = "";
    if (low > 0) snprintf(lowf, sizeof lowf, ",\"low_note\":%d", low);
    char json[1024];
    snprintf(json, sizeof json,
        "{\"source_folder\":\"F\",\"name\":\"T\",\"tempo_bpm\":120,\"time_sig_num\":4,\"time_sig_den\":4,\"key\":\"C\","
        "\"sections\":[{\"name\":\"A\",\"clips\":[{\"source\":\"Beat.mid\",\"start_bar\":0,\"end_bar\":2,\"guard_fraction\":0}],"
        "\"chords\":[{\"root\":\"C\",\"quality\":\"maj\",\"bass\":\"\"},{\"root\":\"G\",\"quality\":\"maj\",\"bass\":\"\"}]}],"
        "\"instruments\":[{\"enabled\":true,\"output\":\"schwung\",\"channel\":2,\"octave\":0,\"follow_note\":36,"
        "\"voicing\":\"bass\",\"note_gap\":0.125,\"velocity\":100,\"pattern\":1%s}]}", lowf);
    uint32_t base = state_u32(api, inst, "primary_published_gen");
    api->set_param(inst, "loop", "0");
    api->set_param(inst, "song_json", json);
    if (!wait_field_change(api, inst, "primary_published_gen", base, 3000)) { api->destroy_instance(inst); return 0; }
    static int16_t audio[MOVE_FRAMES_PER_BLOCK * 2];
    g_captured_count = 0;
    api->set_param(inst, "play", "1");
    for (int b = 0; b < 1500; b++) api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);   /* ~2 bars */
    api->set_param(inst, "stop", "1");
    for (int b = 0; b < 10; b++) api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
    int on[128] = { 0 };
    *lo = 128; *hi = -1;
    int count = 0;
    for (int i = 0; i < g_captured_count; i++) {
        const captured_event_t *c = &g_captured[i];
        if (c->status == 0x90 && c->vel > 0) {
            on[c->note]++; count++;
            if (c->note < *lo) *lo = c->note;
            if (c->note > *hi) *hi = c->note;
        } else if (c->status == 0x80 || (c->status == 0x90 && c->vel == 0)) {
            if (on[c->note] > 0) on[c->note]--;
        }
    }
    *balanced = 1;
    for (int n = 0; n < 128; n++) if (on[n]) *balanced = 0;
    api->destroy_instance(inst);
    return count;
}

int main(void) {
    snprintf(g_root, sizeof g_root, "/tmp/arr_lownote_%d", (int)getpid());
    mkdir(g_root, 0755);
    char p[512];
    snprintf(p, sizeof p, "%s/F", g_root); mkdir(p, 0755);
    snprintf(p, sizeof p, "%s/F/Beat.mid", g_root); write_clip(p);

    host_api_v1_t host = make_test_host();
    plugin_api_v2_t *api = move_plugin_init_v2(&host);
    int lo, hi, bal, n;

    n = run(api, 0, &lo, &hi, &bal);
    printf("  no Lowest Note: %d notes, %d-%d\n", n, lo, hi);
    CHECK(n > 4 && lo < 28, "without a Lowest Note, the bass plays below 28");

    n = run(api, 28, &lo, &hi, &bal);
    printf("  Lowest Note 28: %d notes, %d-%d\n", n, lo, hi);
    CHECK(n > 4 && lo >= 28 && hi < 40, "Lowest Note 28: every note lifted into 28-39");
    CHECK(bal, "...and every note-on has its note-off (nothing hangs)");

    char cmd[300];
    snprintf(cmd, sizeof cmd, "rm -rf '%s'", g_root);
    if (system(cmd) != 0) fprintf(stderr, "could not remove %s\n", g_root);
    printf("low note: %d failure(s)\n", g_failures);
    return g_failures ? 1 : 0;
}
