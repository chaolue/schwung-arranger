/* MIDI clock to Schwung (send_clock in arranger_engine.c), against the real
 * dsp.so: what goes out through midi_send_internal on Play, while playing,
 * on a tempo change, on a restart, on Stop, and with the setting off.
 * Build and run: tests/dsp/run.sh */
#include <dlfcn.h>
#include <stdio.h>
#include <string.h>
#include <stdint.h>
#include "plugin_api_v1.h"

static int n_start, n_stop, n_tick, n_other;
static int log_order[16], log_n;

static int send_internal(const uint8_t *msg, int len) {
    if (len != 4 || msg[0] != 0x0F) { n_other++; return len; }
    if (log_n < 16) log_order[log_n++] = msg[1];
    if (msg[1] == 0xFA) n_start++;
    else if (msg[1] == 0xFC) n_stop++;
    else if (msg[1] == 0xF8) n_tick++;
    else n_other++;
    return len;
}
static int send_external(const uint8_t *m, int l) { (void)m; return l; }
static void hlog(const char *m) { (void)m; }
static void reset(void) { n_start = n_stop = n_tick = n_other = 0; log_n = 0; }

static int failures, passes;
#define CHECK(c, ...) do { if (c) passes++; else { failures++; printf("FAIL: " __VA_ARGS__); printf("\n"); } } while (0)

int main(int argc, char **argv) {
    const char *so = argc > 1 ? argv[1] : "build/dsp.so";
    void *h = dlopen(so, RTLD_NOW);
    if (!h) { printf("dlopen: %s\n", dlerror()); return 2; }
    plugin_api_v2_t *(*init)(const host_api_v1_t *) = dlsym(h, "move_plugin_init_v2");
    static host_api_v1_t host;
    memset(&host, 0, sizeof(host));
    host.api_version = 1;
    host.sample_rate = 44100;
    host.frames_per_block = 128;
    host.log = hlog;
    host.midi_send_internal = send_internal;
    host.midi_send_external = send_external;
    plugin_api_v2_t *api = init(&host);
    void *e = api->create_instance("/tmp", NULL);
    int16_t buf[256];
    const int blocks_per_sec = 44100 / 128;   /* 344 */

    /* Stopped: nothing. */
    reset();
    for (int i = 0; i < 100; i++) api->render_block(e, buf, 128);
    CHECK(n_start + n_stop + n_tick == 0, "stopped sends nothing (start %d stop %d tick %d)", n_start, n_stop, n_tick);

    /* Play at 120: Start then tick 0 in the first block, ~48 ticks/s. */
    api->set_param(e, "tempo", "120");
    api->set_param(e, "play", "1");
    reset();
    api->render_block(e, buf, 128);
    CHECK(log_n == 2 && log_order[0] == 0xFA && log_order[1] == 0xF8, "Play sends Start then the anchoring tick");
    for (int i = 1; i < blocks_per_sec * 10; i++) api->render_block(e, buf, 128);
    /* 10 s at 120 BPM = 20 beats * 24 = 480 ticks, plus the anchor. */
    CHECK(n_start == 1 && n_tick >= 479 && n_tick <= 481, "120 BPM: %d ticks in 10 s (want ~481)", n_tick);

    /* Tempo change while playing takes effect at once. */
    api->set_param(e, "tempo", "90");
    reset();
    for (int i = 0; i < blocks_per_sec * 10; i++) api->render_block(e, buf, 128);
    CHECK(n_tick >= 358 && n_tick <= 362 && n_start == 0, "90 BPM: %d ticks in 10 s (want ~360)", n_tick);

    /* Play again while playing (a restart): a fresh Start re-anchors beat 0. */
    reset();
    api->set_param(e, "play", "1");
    api->render_block(e, buf, 128);
    CHECK(n_start == 1 && n_stop == 0 && log_order[0] == 0xFA, "restart sends a new Start");

    /* Stop: one Stop, then silence. */
    reset();
    api->set_param(e, "stop", "1");
    for (int i = 0; i < 50; i++) api->render_block(e, buf, 128);
    CHECK(n_stop == 1 && n_tick == 0, "Stop sends one Stop (stop %d tick %d)", n_stop, n_tick);

    /* Setting off: playing sends nothing; turning it off mid-play stops. */
    api->set_param(e, "send_clock", "0");
    api->set_param(e, "play", "1");
    reset();
    for (int i = 0; i < 100; i++) api->render_block(e, buf, 128);
    CHECK(n_start + n_tick + n_stop == 0, "send_clock 0: nothing while playing");
    api->set_param(e, "send_clock", "1");
    api->render_block(e, buf, 128);
    CHECK(n_start == 1, "turning it on while playing starts the clock");
    reset();
    api->set_param(e, "send_clock", "0");
    api->render_block(e, buf, 128);
    CHECK(n_stop == 1, "turning it off while playing sends Stop");

    /* Move's own Start/Stop (on_midi) drive the clock like Play/Stop. */
    api->set_param(e, "send_clock", "1");
    api->set_param(e, "stop", "1");
    api->render_block(e, buf, 128);
    reset();
    const uint8_t start[1] = { 0xFA }, stop[1] = { 0xFC };
    api->on_midi(e, start, 1, 0);
    api->render_block(e, buf, 128);
    api->on_midi(e, stop, 1, 0);
    api->render_block(e, buf, 128);
    CHECK(n_start == 1 && n_stop == 1, "Move Start/Stop: start %d stop %d", n_start, n_stop);
    CHECK(n_other == 0, "nothing but realtime packets sent (%d other)", n_other);

    api->destroy_instance(e);
    printf("%d passed, %d failed\n", passes, failures);
    return failures ? 1 : 0;
}
