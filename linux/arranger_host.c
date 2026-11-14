/*
 * arranger-host: runs the Arranger engine on a Linux PC, without a Move.
 *
 * The engine (src/dsp/arranger_engine.c) is linked in unchanged. This host
 * gives it what Schwung gives it on the Move: a render call every 128 frames
 * of 44.1 kHz time, and somewhere for its MIDI to go -- here a MIDI output of
 * the PC instead of Move's USB port:
 *
 *   /dev/snd/midiC1D0   a raw MIDI device (a USB MIDI interface, a synth's
 *                       own USB port): bytes are written straight to it
 *   virtual             an ALSA sequencer port named "Arranger", for
 *                       aconnect / a soft synth (needs a build with ALSA)
 *   any other path      the MIDI bytes appended to that file (tests)
 *
 * It is driven over stdin, one command a line, one answer line each, by
 * linux/arranger.mjs:
 *
 *   set <key> <value>   the engine's set_param            -> ok
 *   get <key>           the engine's get_param            -> = <value> | err
 *   port <name>         open that MIDI output             -> ok | err <why>
 *   clock <0|1>         pass the engine's MIDI clock on   -> ok
 *   panic               All Notes Off on every channel    -> ok
 *   quit                release notes and exit            -> ok
 *
 * Everything the engine sends is treated as external: "schwung" and "move"
 * routes do not exist here, and arranger.mjs asks for "external" throughout.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <sched.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#ifdef HAVE_ALSA
#include <alsa/asoundlib.h>
#endif

#include "plugin_api_v1.h"

extern plugin_api_v2_t *move_plugin_init_v2(const host_api_v1_t *host);

#define LINE_CAP (512 * 1024)   /* a song_json payload fits several times */
#define VALUE_CAP (1024 * 1024)

static plugin_api_v2_t *g_api;
static void *g_inst;
/* The engine expects set_param/get_param and render_block from one thread at
 * a time (on the Move they share the audio thread). */
static pthread_mutex_t g_engine_lock = PTHREAD_MUTEX_INITIALIZER;
static volatile sig_atomic_t g_quit = 0;

/* ---- MIDI out ---- */

static int g_fd = -1;
#ifdef HAVE_ALSA
static snd_rawmidi_t *g_alsa;
#endif
static int g_pass_clock = 0;
static int g_verbose = 0;

static void midi_write(const uint8_t *bytes, int n) {
    if (g_verbose) {
        fprintf(stderr, "midi:");
        for (int i = 0; i < n; i++) fprintf(stderr, " %02x", bytes[i]);
        fprintf(stderr, "\n");
    }
#ifdef HAVE_ALSA
    if (g_alsa) { snd_rawmidi_write(g_alsa, bytes, (size_t)n); return; }
#endif
    if (g_fd >= 0) {
        ssize_t w = write(g_fd, bytes, (size_t)n);
        (void)w;
    }
}

/* The engine sends 4-byte USB-MIDI packets: [cable|cin, status, d1, d2]. */
static int packet_out(const uint8_t *m, int len) {
    if (len < 4) return 0;
    uint8_t status = m[1];
    int n;
    if (status >= 0xF8) n = 1;
    else if (status < 0x80 || status >= 0xF0) return len;
    else n = ((status & 0xF0) == 0xC0 || (status & 0xF0) == 0xD0) ? 2 : 3;
    midi_write(m + 1, n);
    return len;
}

static int host_midi_send_external(const uint8_t *m, int len) { return packet_out(m, len); }
static int host_midi_inject_to_move(const uint8_t *m, int len) { return packet_out(m, len); }
/* The internal route carries the notes of "schwung" outputs (none here, but
 * sent on all the same if a song asks) and the engine's MIDI clock, which is
 * passed on only when asked for. */
static int host_midi_send_internal(const uint8_t *m, int len) {
    if (len >= 4 && m[1] >= 0xF8 && !g_pass_clock) return len;
    return packet_out(m, len);
}

static void host_log(const char *msg) { if (g_verbose && msg) fprintf(stderr, "engine: %s\n", msg); }
static int host_clock_status(void) { return 0; }
static float host_bpm(void) { return 120.0f; }

static void all_notes_off(void) {
    for (int ch = 0; ch < 16; ch++) {
        uint8_t msg[3] = { (uint8_t)(0xB0 | ch), 123, 0 };
        midi_write(msg, 3);
    }
}

static void port_close(void) {
#ifdef HAVE_ALSA
    if (g_alsa) { snd_rawmidi_drain(g_alsa); snd_rawmidi_close(g_alsa); g_alsa = NULL; }
#endif
    if (g_fd >= 0) { close(g_fd); g_fd = -1; }
}

/* Open a MIDI output; 0, or -1 with `why` filled in. */
static int port_open(const char *name, char *why, size_t why_len) {
    port_close();
    if (!name[0] || strcmp(name, "none") == 0) return 0;
    if (name[0] == '/') {
        g_fd = open(name, O_WRONLY | O_CREAT | O_APPEND | O_NOCTTY, 0644);
        if (g_fd < 0) { snprintf(why, why_len, "%s: %s", name, strerror(errno)); return -1; }
        return 0;
    }
#ifdef HAVE_ALSA
    int rc = strcmp(name, "virtual") == 0
        ? snd_rawmidi_open(NULL, &g_alsa, "virtual", SND_RAWMIDI_NONBLOCK)
        : snd_rawmidi_open(NULL, &g_alsa, name, SND_RAWMIDI_NONBLOCK);
    if (rc < 0) { g_alsa = NULL; snprintf(why, why_len, "%s: %s", name, snd_strerror(rc)); return -1; }
    return 0;
#else
    snprintf(why, why_len, "%s: this build has no ALSA support (use a /dev/snd/midiC*D* path)", name);
    return -1;
#endif
}

/* ---- the render clock ---- */

static void *render_thread(void *arg) {
    (void)arg;
    struct sched_param sp = { .sched_priority = 20 };
    pthread_setschedparam(pthread_self(), SCHED_FIFO, &sp); /* best effort */
    const long block_ns = (long)(1e9 * MOVE_FRAMES_PER_BLOCK / MOVE_SAMPLE_RATE);
    int16_t audio[MOVE_FRAMES_PER_BLOCK * 2];
    struct timespec next;
    clock_gettime(CLOCK_MONOTONIC, &next);
    while (!g_quit) {
        pthread_mutex_lock(&g_engine_lock);
        g_api->render_block(g_inst, audio, MOVE_FRAMES_PER_BLOCK);
        pthread_mutex_unlock(&g_engine_lock);
        next.tv_nsec += block_ns;
        if (next.tv_nsec >= 1000000000L) { next.tv_nsec -= 1000000000L; next.tv_sec++; }
        struct timespec now;
        clock_gettime(CLOCK_MONOTONIC, &now);
        long late_ms = (now.tv_sec - next.tv_sec) * 1000L + (now.tv_nsec - next.tv_nsec) / 1000000L;
        /* Far behind (the machine slept): start again from now instead of
         * racing through the blocks that were missed. */
        if (late_ms > 100) next = now;
        else clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &next, NULL);
    }
    return NULL;
}

static void on_signal(int sig) { (void)sig; g_quit = 1; }

static void answer(const char *s) { fputs(s, stdout); fputc('\n', stdout); fflush(stdout); }

int main(int argc, char **argv) {
    const char *port = "";
    const char *state_dir = "/tmp";
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--port") == 0 && i + 1 < argc) port = argv[++i];
        else if (strcmp(argv[i], "--state-dir") == 0 && i + 1 < argc) state_dir = argv[++i];
        else if (strcmp(argv[i], "--verbose") == 0) g_verbose = 1;
        else if (strcmp(argv[i], "--has-alsa") == 0) {
#ifdef HAVE_ALSA
            puts("1");
#else
            puts("0");
#endif
            return 0;
        } else {
            fprintf(stderr, "usage: %s [--port <midi out>] [--state-dir <dir>] [--verbose]\n", argv[0]);
            return 2;
        }
    }
    signal(SIGPIPE, SIG_IGN);
    struct sigaction sa;
    memset(&sa, 0, sizeof sa);
    sa.sa_handler = on_signal; /* no SA_RESTART: a signal ends the stdin read */
    sigaction(SIGINT, &sa, NULL);
    sigaction(SIGTERM, &sa, NULL);

    char why[512];
    if (port_open(port, why, sizeof why) < 0) { fprintf(stderr, "arranger-host: %s\n", why); return 1; }

    static host_api_v1_t host;
    host.api_version = MOVE_PLUGIN_API_VERSION;
    host.sample_rate = MOVE_SAMPLE_RATE;
    host.frames_per_block = MOVE_FRAMES_PER_BLOCK;
    host.log = host_log;
    host.midi_send_internal = host_midi_send_internal;
    host.midi_send_external = host_midi_send_external;
    host.get_clock_status = host_clock_status;
    host.get_bpm = host_bpm;
    host.midi_inject_to_move = host_midi_inject_to_move;
    g_api = move_plugin_init_v2(&host);
    g_inst = g_api ? g_api->create_instance(state_dir, NULL) : NULL;
    if (!g_inst) { fprintf(stderr, "arranger-host: the engine did not start\n"); return 1; }

    pthread_t th;
    pthread_create(&th, NULL, render_thread, NULL);

    char *line = malloc(LINE_CAP);
    char *value = malloc(VALUE_CAP);
    answer("ready");
    while (!g_quit && fgets(line, LINE_CAP, stdin)) {
        size_t n = strlen(line);
        while (n && (line[n - 1] == '\n' || line[n - 1] == '\r')) line[--n] = '\0';
        char *arg = strchr(line, ' ');
        if (arg) *arg++ = '\0'; else arg = line + n;
        if (strcmp(line, "set") == 0) {
            char *val = strchr(arg, ' ');
            if (val) *val++ = '\0'; else val = arg + strlen(arg);
            pthread_mutex_lock(&g_engine_lock);
            g_api->set_param(g_inst, arg, val);
            pthread_mutex_unlock(&g_engine_lock);
            answer("ok");
        } else if (strcmp(line, "get") == 0) {
            pthread_mutex_lock(&g_engine_lock);
            int rc = g_api->get_param(g_inst, arg, value, VALUE_CAP);
            pthread_mutex_unlock(&g_engine_lock);
            if (rc < 0) answer("err");
            else { fputs("= ", stdout); answer(value); }
        } else if (strcmp(line, "port") == 0) {
            pthread_mutex_lock(&g_engine_lock);
            all_notes_off();
            int rc = port_open(arg, why, sizeof why);
            pthread_mutex_unlock(&g_engine_lock);
            if (rc < 0) { fputs("err ", stdout); answer(why); }
            else answer("ok");
        } else if (strcmp(line, "clock") == 0) {
            g_pass_clock = atoi(arg) != 0;
            answer("ok");
        } else if (strcmp(line, "panic") == 0) {
            pthread_mutex_lock(&g_engine_lock);
            all_notes_off();
            pthread_mutex_unlock(&g_engine_lock);
            answer("ok");
        } else if (strcmp(line, "quit") == 0) {
            answer("ok");
            break;
        } else if (line[0]) {
            answer("err unknown command");
        }
    }

    /* Leave nothing sounding: stop, let the engine release what it holds,
     * then an All Notes Off of our own for good measure. */
    pthread_mutex_lock(&g_engine_lock);
    g_api->set_param(g_inst, "stop", "1");
    g_api->set_param(g_inst, "release_notes", "1");
    pthread_mutex_unlock(&g_engine_lock);
    struct timespec ts = { 0, 30 * 1000000L };
    nanosleep(&ts, NULL);
    g_quit = 1;
    pthread_join(th, NULL);
    all_notes_off();
    port_close();
    return 0;
}
