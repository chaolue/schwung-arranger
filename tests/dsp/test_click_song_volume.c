/*
 * A song's own click volume (Song Builder's Click Settings: the song JSON's
 * "song_click_volume") -- where its sections' click starts -- against the
 * engine's click_volume (Options > Click's), which a count-in always plays
 * at. Writes its own one-clip library, so it needs none.
 *
 * Usage: test_click_song_volume
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
        /* 10 ticks on: 0x0A; then the rest of the beat (230 = 0x81 0x66) */
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

/* A fresh engine on the test library, the click on channel 10 (9). */
static void *fresh(plugin_api_v2_t *api) {
    void *inst = api->create_instance("/tmp/test_click_song_volume", NULL);
    if (!inst) return NULL;
    api->set_param(inst, "library_root", g_root);
    char buf[256];
    for (int i = 0; i < 3000; i++) {
        if (api->get_param(inst, "folder_count", buf, sizeof buf) > 0 && atoi(buf) > 0) break;
        usleep(1000);
    }
    api->set_param(inst, "emit_directly", "1");
    api->set_param(inst, "output_target", "schwung");
    api->set_param(inst, "schwung_channel", "0");
    api->set_param(inst, "click_output", "schwung");
    api->set_param(inst, "click_channel", "9");
    api->set_param(inst, "click_accent_note", "76");
    api->set_param(inst, "click_normal_note", "77");
    api->set_param(inst, "click_volume", "80");    /* Options > Click's */
    api->set_param(inst, "click_enabled", "1");
    return inst;
}

/* Build `extra` into a one-section song of the clip and play bar 1; the
 * click velocities it gave (up to 8). */
static int play_bar(plugin_api_v2_t *api, void *inst, const char *extra, int *vels, const char *live) {
    char json[1024];
    snprintf(json, sizeof json,
        "{\"source_folder\":\"F\",\"name\":\"T\",\"tempo_bpm\":120,\"time_sig_num\":4,\"time_sig_den\":4,\"ppq\":240,%s"
        "\"sections\":[{\"name\":\"A\",\"clips\":[{\"source\":\"Beat.mid\",\"start_bar\":0,\"end_bar\":4,\"guard_fraction\":0}]}]}",
        extra);
    uint32_t base = state_u32(api, inst, "primary_published_gen");
    api->set_param(inst, "loop", "0");
    api->set_param(inst, "song_json", json);
    if (!wait_field_change(api, inst, "primary_published_gen", base, 3000)) return -1;
    static int16_t audio[MOVE_FRAMES_PER_BLOCK * 2];
    g_captured_count = 0;
    api->set_param(inst, "play", "1");
    /* ~1.39 ticks a block: 600 blocks pass beats 1-4 (ticks 0-720). */
    for (int b = 0; b < 600; b++) {
        if (live && b == 300) api->set_param(inst, "song_click_volume", live);   /* before beat 3 */
        api->render_block(inst, audio, MOVE_FRAMES_PER_BLOCK);
    }
    api->set_param(inst, "stop", "1");
    int n = 0;
    for (int i = 0; i < g_captured_count && n < 8; i++)
        if (g_captured[i].status == 0x90 && g_captured[i].channel == 9) vels[n++] = g_captured[i].vel;
    return n;
}

int main(void) {
    snprintf(g_root, sizeof g_root, "/tmp/arr_clickvol_%d", (int)getpid());
    mkdir(g_root, 0755);
    char p[512];
    snprintf(p, sizeof p, "%s/F", g_root); mkdir(p, 0755);
    snprintf(p, sizeof p, "%s/F/Beat.mid", g_root); write_clip(p);

    host_api_v1_t host = make_test_host();
    plugin_api_v2_t *api = move_plugin_init_v2(&host);
    int v[8], n;

    void *inst = fresh(api);
    if (!inst) { fprintf(stderr, "create_instance failed\n"); return 1; }
    n = play_bar(api, inst, "", v, NULL);
    CHECK(n == 4 && v[0] == 102 && v[1] == 80, "no song volume: the engine's 80% (accent 102, normal 80)");

    n = play_bar(api, inst, "\"song_click_volume\":50,", v, NULL);
    CHECK(n == 4 && v[0] == 64 && v[1] == 50, "the song's own 50%: accent 64, normal 50");

    n = play_bar(api, inst, "\"song_click_volume\":-1,", v, NULL);
    CHECK(n == 4 && v[0] == 102, "-1: none, the engine's again");

    n = play_bar(api, inst, "\"count_in\":1,\"count_in_sound\":1,\"song_click_volume\":50,", v, NULL);
    CHECK(n == 4 && v[0] == 102 && v[1] == 80, "a count-in plays at the engine's 80%, not the song's 50%");

    n = play_bar(api, inst, "\"song_click_volume\":50,", v, "30");
    printf("  live: %d %d %d %d\n", v[0], v[1], v[2], v[3]);
    CHECK(n == 4 && v[1] == 50 && v[2] == 30 && v[3] == 30, "song_click_volume while playing: heard from the next beat");

    api->destroy_instance(inst);
    char cmd[300];
    snprintf(cmd, sizeof cmd, "rm -rf '%s'", g_root);
    if (system(cmd) != 0) fprintf(stderr, "could not remove %s\n", g_root);
    printf("click song volume: %d failure(s)\n", g_failures);
    return g_failures ? 1 : 0;
}
