/*
 * Regression tests for library/folder scanning (library_root set_param,
 * folder_count/folder_name_N get_param). Every other test file in this
 * suite already relies on this scan implicitly (via find_song13_folder in
 * test_common.h) as a precondition; this file makes the scan itself the
 * thing under test.
 *
 * Build (plain):
 *   gcc -Wall -Wextra -g -pthread tests/dsp/test_library_scan.c \
 *       src/dsp/arranger_engine.c -Isrc/dsp -ldl -lm -o /tmp/test_library_scan
 *
 * Usage: test_library_scan <library_root>
 * Expects the "Song 13" fixture (see test_async_channels.c).
 */

#include "test_common.h"

int main(int argc, char **argv) {
    if (argc < 2) { fprintf(stderr, "usage: %s <library_root>\n", argv[0]); return 1; }
    const char *library_root = argv[1];

    host_api_v1_t host = make_test_host();
    plugin_api_v2_t *api = move_plugin_init_v2(&host);
    void *inst = api->create_instance("/tmp/test_library_scan", NULL);
    if (!inst) { fprintf(stderr, "create_instance failed\n"); return 1; }

    api->set_param(inst, "library_root", library_root);
    char buf[8192];
    int folder_count = 0;
    for (int waited = 0; waited < 3000; waited++) {
        int rc = api->get_param(inst, "folder_count", buf, sizeof(buf));
        folder_count = rc > 0 ? atoi(buf) : 0;
        if (folder_count > 0) break;
        usleep(1000);
    }
    CHECK(folder_count > 0, "library scan: folder_count becomes positive after scanning a real library_root");

    /* --- Test: the "Song 13" fixture folder is actually found among the
     * scanned entries, with its full expected name. --- */
    int song13_idx = -1;
    char song13_name[128] = "";
    for (int i = 0; i < folder_count; i++) {
        char key[64];
        snprintf(key, sizeof(key), "folder_name_%d", i);
        if (api->get_param(inst, key, buf, sizeof(buf)) > 0 && strstr(buf, "Song 13")) {
            song13_idx = i;
            snprintf(song13_name, sizeof(song13_name), "%.127s", buf);
            break;
        }
    }
    CHECK(song13_idx >= 0, "library scan: the 'Song 13' fixture folder is found among scanned folders");
    CHECK(strstr(song13_name, "Song 13 4-4 120 BPM") != NULL,
          "library scan: the fixture folder's full expected name is reported");

    /* --- Test: folder_name_N is stable across repeated reads for the same
     * index -- not regenerated/reordered on every call. --- */
    if (song13_idx >= 0) {
        char key[64], first[256], second[256];
        snprintf(key, sizeof(key), "folder_name_%d", song13_idx);
        api->get_param(inst, key, first, sizeof(first));
        api->get_param(inst, key, second, sizeof(second));
        CHECK(strcmp(first, second) == 0, "library scan: folder_name_N is stable across repeated reads");

        /* And stable across an unrelated intervening get_param call too. */
        api->get_param(inst, "folder_count", buf, sizeof(buf));
        char third[256];
        api->get_param(inst, key, third, sizeof(third));
        CHECK(strcmp(first, third) == 0, "library scan: folder_name_N unaffected by an intervening unrelated get_param");
    }

    /* --- Test: an out-of-range folder index returns nothing usable rather
     * than reading adjacent memory (bounds safety; run under ASan). --- */
    {
        char key[64];
        snprintf(key, sizeof(key), "folder_name_%d", folder_count + 1000);
        int rc = api->get_param(inst, key, buf, sizeof(buf));
        CHECK(rc <= 0 || buf[0] == '\0', "library scan: a wildly out-of-range folder index returns nothing, not garbage");
    }

    if (g_failures == 0) {
        printf("\nALL TESTS PASSED\n");
    } else {
        printf("\n%d TEST(S) FAILED\n", g_failures);
    }
    api->destroy_instance(inst);
    return g_failures == 0 ? 0 : 1;
}
