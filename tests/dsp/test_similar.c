/*
 * Song Builder's Similar search (set_param "similar_find", get_param
 * "similar_json"), against a small library this test writes itself -- so,
 * unlike the Song 13 tests, it needs no library:
 *   Alpha/   Verse.mid  -- kick 1 & 3, snare 2 & 4, 8th hats (the clip searched for)
 *            Fill 1.mid -- toms
 *   Bravo/   Groove A/B/C.mid -- Verse's beat, played a little early and late
 *   Charlie/ Busy.mid   -- kick on every 8th, 16th hats, no snare
 *   Delta/   Waltz.mid  -- Verse's beat in 3/4
 *   Echo/    Fill 2.mid -- a fill with Verse's beat
 *   Foxtrot/ Loose.mid  -- Verse's beat, every hit most of a step off
 *
 * Usage: test_similar
 */

#include "test_common.h"
#include <sys/stat.h>

#define TPQ 96

typedef struct { uint32_t tick; uint8_t note, vel; } ev_t;

static void put32(FILE *f, uint32_t v) { fputc(v >> 24, f); fputc(v >> 16, f); fputc(v >> 8, f); fputc(v, f); }
static void put16(FILE *f, uint16_t v) { fputc(v >> 8, f); fputc(v, f); }
static int vlq(uint8_t *out, uint32_t v) {
    uint8_t tmp[5]; int n = 0;
    do { tmp[n++] = v & 0x7F; v >>= 7; } while (v);
    for (int i = 0; i < n; i++) out[i] = tmp[n - 1 - i] | (i < n - 1 ? 0x80 : 0);
    return n;
}

static int ev_cmp(const void *a, const void *b) {
    const ev_t *x = a, *y = b;
    return (int)x->tick - (int)y->tick;
}

/* A one-track MIDI file of `n` hits (each 10 ticks long), `bars` bars of `num`/4. */
static void write_mid(const char *path, ev_t *hits, int n, int num, int bars) {
    static ev_t all[2048];
    int m = 0;
    for (int i = 0; i < n; i++) {
        all[m++] = hits[i];
        all[m++] = (ev_t){ hits[i].tick + 10, hits[i].note, 0 };
    }
    qsort(all, m, sizeof(ev_t), ev_cmp);
    static uint8_t trk[16384];
    int len = 0;
    trk[len++] = 0; trk[len++] = 0xFF; trk[len++] = 0x58; trk[len++] = 4;
    trk[len++] = (uint8_t)num; trk[len++] = 2; trk[len++] = 24; trk[len++] = 8;
    uint32_t last = 0;
    for (int i = 0; i < m; i++) {
        len += vlq(trk + len, all[i].tick - last);
        last = all[i].tick;
        trk[len++] = all[i].vel ? 0x99 : 0x89;
        trk[len++] = all[i].note;
        trk[len++] = all[i].vel ? all[i].vel : 0;
    }
    uint32_t end = (uint32_t)bars * num * TPQ;
    len += vlq(trk + len, end > last ? end - last : 0);
    trk[len++] = 0xFF; trk[len++] = 0x2F; trk[len++] = 0;
    FILE *f = fopen(path, "wb");
    if (!f) { perror(path); exit(1); }
    fwrite("MThd", 1, 4, f); put32(f, 6); put16(f, 0); put16(f, 1); put16(f, TPQ);
    fwrite("MTrk", 1, 4, f); put32(f, (uint32_t)len); fwrite(trk, 1, len, f);
    fclose(f);
}

/* Verse's beat, `bars` bars of `num` beats, every hit moved by `jitter`
 * ticks (alternately early and late). */
static int beat(ev_t *h, int num, int bars, int jitter) {
    int n = 0, sign = 1;
    for (int b = 0; b < bars; b++) {
        uint32_t bar = (uint32_t)(b * num * TPQ);
        for (int q = 0; q < num; q++) {
            uint32_t t = bar + q * TPQ;
            int j = jitter * sign; sign = -sign;
            uint32_t tj = (int)t + j < 0 ? 0 : (uint32_t)((int)t + j);
            if (q % 2 == 0) h[n++] = (ev_t){ tj, 36, 110 };
            else h[n++] = (ev_t){ tj, 38, 115 };
            h[n++] = (ev_t){ tj, 42, 100 };
            h[n++] = (ev_t){ t + TPQ / 2, 42, 70 };
        }
    }
    return n;
}

static char g_root[256];

static void mk(const char *rel) {
    char p[512];
    snprintf(p, sizeof(p), "%s/%s", g_root, rel);
    mkdir(p, 0755);
}
static void mid(const char *rel, ev_t *h, int n, int num, int bars) {
    char p[512];
    snprintf(p, sizeof(p), "%s/%s", g_root, rel);
    write_mid(p, h, n, num, bars);
}

static int folder_index(plugin_api_v2_t *api, void *inst, int count, const char *name) {
    char key[64], buf[256];
    for (int i = 0; i < count; i++) {
        snprintf(key, sizeof(key), "folder_name_%d", i);
        if (api->get_param(inst, key, buf, sizeof(buf)) > 0 && strcmp(buf, name) == 0) return i;
    }
    return -1;
}

/* Ask for clips like `path` in folder `f`; the answer, once it's this one's. */
static int find_similar(plugin_api_v2_t *api, void *inst, int id, int f, const char *path, char *out, int len) {
    char req[512];
    snprintf(req, sizeof(req), "%d\t%d\t%s", id, f, path);
    api->set_param(inst, "similar_find", req);
    char want[32];
    snprintf(want, sizeof(want), "{\"id\":%d,", id);
    for (int waited = 0; waited < 3000; waited++) {
        if (api->get_param(inst, "similar_json", out, len) > 0 && strncmp(out, want, strlen(want)) == 0) return 1;
        usleep(1000);
    }
    return 0;
}

/* How many items name folder `f`, and the score of the first that does (-1 if none). */
static int items_in(const char *json, int f, int *first_score) {
    char pat[32];
    snprintf(pat, sizeof(pat), "{\"f\":%d,", f);
    int n = 0;
    *first_score = -1;
    for (const char *p = strstr(json, pat); p; p = strstr(p + 1, pat)) {
        if (n == 0) {
            const char *s = strstr(p, "\"s\":");
            if (s) *first_score = atoi(s + 4);
        }
        n++;
    }
    return n;
}

int main(void) {
    snprintf(g_root, sizeof(g_root), "/tmp/arr_similar_%d", (int)getpid());
    mkdir(g_root, 0755);
    static ev_t h[1024];
    mk("Alpha"); mk("Bravo"); mk("Charlie"); mk("Delta"); mk("Echo"); mk("Foxtrot");
    mid("Alpha/Verse.mid", h, beat(h, 4, 2, 0), 4, 2);
    {
        int n = 0;
        for (int i = 0; i < 8; i++) h[n++] = (ev_t){ (uint32_t)(3 * 4 * TPQ + i * TPQ / 2), (uint8_t)(i < 4 ? 48 : 45), 110 };
        mid("Alpha/Fill 1.mid", h, n, 4, 4);
    }
    mid("Bravo/Groove A.mid", h, beat(h, 4, 4, 3), 4, 4);
    mid("Bravo/Groove B.mid", h, beat(h, 4, 4, 2), 4, 4);
    mid("Bravo/Groove C.mid", h, beat(h, 4, 4, 4), 4, 4);
    {
        int n = 0;
        for (int b = 0; b < 2; b++)
            for (int s = 0; s < 16; s++) {
                uint32_t t = (uint32_t)(b * 4 * TPQ + s * TPQ / 4);
                if (s % 2 == 0) h[n++] = (ev_t){ t, 36, 110 };
                h[n++] = (ev_t){ t, 42, 90 };
            }
        mid("Charlie/Busy.mid", h, n, 4, 2);
    }
    mid("Delta/Waltz.mid", h, beat(h, 3, 4, 0), 3, 4);
    mid("Echo/Fill 2.mid", h, beat(h, 4, 1, 0), 4, 1);
    mid("Foxtrot/Loose.mid", h, beat(h, 4, 2, 6), 4, 2);   /* a step is 8 ticks */

    host_api_v1_t host = make_test_host();
    plugin_api_v2_t *api = move_plugin_init_v2(&host);
    void *inst = api->create_instance("/tmp/test_similar", NULL);
    if (!inst) { fprintf(stderr, "create_instance failed\n"); return 1; }
    api->set_param(inst, "library_root", g_root);
    static char buf[16384];
    int count = 0;
    for (int waited = 0; waited < 3000 && count < 6; waited++) {
        int rc = api->get_param(inst, "folder_count", buf, sizeof(buf));
        count = rc > 0 ? atoi(buf) : 0;
        usleep(1000);
    }
    CHECK(count == 6, "the test library's six folders are scanned");
    int alpha = folder_index(api, inst, count, "Alpha"), bravo = folder_index(api, inst, count, "Bravo");
    int charlie = folder_index(api, inst, count, "Charlie"), delta = folder_index(api, inst, count, "Delta");
    int echo = folder_index(api, inst, count, "Echo"), foxtrot = folder_index(api, inst, count, "Foxtrot");

    CHECK(find_similar(api, inst, 7, alpha, "Verse.mid", buf, sizeof(buf)), "a search answers, under its own id");
    CHECK(strstr(buf, "\"status\":\"ok\"") != NULL, "...ok");
    printf("  %s\n", buf);
    int s_bravo, s_charlie, s_other;
    int n_bravo = items_in(buf, bravo, &s_bravo);
    int n_charlie = items_in(buf, charlie, &s_charlie);
    char first[32];
    snprintf(first, sizeof(first), "\"items\":[{\"f\":%d,", bravo);
    CHECK(strstr(buf, first) != NULL, "the same beat played loosely comes first");
    CHECK(s_bravo >= 90, "...scoring 90 or more");
    CHECK(n_bravo == 2, "at most two clips from any one folder");
    CHECK(n_charlie == 1 && s_charlie < s_bravo - 20, "a different beat scores well below");
    int s_fox;
    items_in(buf, foxtrot, &s_fox);
    CHECK(s_fox > s_charlie + 20, "hits off by most of a step still score close");
    CHECK(items_in(buf, alpha, &s_other) == 0, "nothing from the clip's own folder");
    CHECK(items_in(buf, delta, &s_other) == 0, "nothing in another meter (3/4)");
    CHECK(items_in(buf, echo, &s_other) == 0, "a groove finds no fills");
    CHECK(strstr(buf, "\"c\":\"Groove B.mid\",\"b\":4,") != NULL, "an item names its clip and its bars");

    CHECK(find_similar(api, inst, 8, alpha, "Fill 1.mid", buf, sizeof(buf)), "a fill's search answers");
    CHECK(items_in(buf, echo, &s_other) == 1 && items_in(buf, bravo, &s_other) == 0, "a fill finds only fills");

    CHECK(find_similar(api, inst, 9, alpha, "Nope.mid", buf, sizeof(buf)), "an unknown clip answers too");
    CHECK(strstr(buf, "\"status\":\"not_found\"") != NULL, "...as not found");

    api->destroy_instance(inst);
    char cmd[300];
    snprintf(cmd, sizeof(cmd), "rm -rf '%s'", g_root);
    if (system(cmd) != 0) fprintf(stderr, "could not remove %s\n", g_root);
    printf("similar: %d failure(s)\n", g_failures);
    return g_failures ? 1 : 0;
}
