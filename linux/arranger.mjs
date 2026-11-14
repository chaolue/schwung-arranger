#!/usr/bin/env node
/* Arranger on a Linux PC, without a Move: play and edit Arranger song files,
 * with the notes going to a MIDI output of the PC.
 *
 *   arranger ui                 a small editor in the browser
 *   arranger play <song>        play a song in the terminal
 *   arranger songs | ports | show <song> | config [key value]
 *
 * It runs the Move's own code: the engine (src/dsp/arranger_engine.c) inside
 * linux/arranger_host.c, and src/ui.js's song model (toUiSong,
 * toEngineSongJson, the backups) loaded with Schwung's screen modules
 * stubbed out. So a song plays and saves here as it does on the Move, and
 * nothing about the song format is written twice.
 *
 * Node 18+, a C compiler, no packages. See linux/README.md. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const BUILD = path.join(HERE, 'build');
/* The Move's Arranger folder; ui.js names its files under it. */
const MOVE_ROOT = '/data/UserData/UserLibrary/Arranger';

/* ---- arguments ---- */

const argv = process.argv.slice(2);
const flags = {};
const words = [];
const VALUE_FLAGS = new Set(['home', 'port', 'http', 'section', 'tempo']);
for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
        const eq = a.indexOf('=');
        const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
        if (eq > 0) flags[name] = a.slice(eq + 1);
        else if (VALUE_FLAGS.has(name)) flags[name] = argv[++i];
        else flags[name] = true;
    } else words.push(a);
}
const command = words.shift() || 'help';

const HOME = path.resolve(flags.home || process.env.ARRANGER_HOME || path.join(os.homedir(), 'Arranger'));
const SONGS = path.join(HOME, 'Songs');
const LIBRARY = path.join(HOME, 'MidiLibrary');
const SETTINGS_FILE = path.join(HOME, 'linux.json');

function die(msg) { console.error('arranger: ' + msg); process.exit(1); }

/* ---- settings ---- */

const DEFAULT_SETTINGS = {
    port: '',                  /* MIDI output; '' = the first found */
    drums_channel: 10,
    inst_channels: [2, 3, 4],  /* Inst 1, Inst 2, Pads */
    click: false,
    click_channel: 10,
    click_volume: 100,
    click_accent_note: 76,
    click_normal_note: 77,
    clock: false,              /* send MIDI clock while playing */
};
const chan = (v, d) => (Number.isInteger(v) && v >= 1 && v <= 16) ? v : d;
function cleanSettings(s) {
    const d = DEFAULT_SETTINGS, o = Object.assign({}, d, s || {});
    const int = (v, lo, hi, dflt) => Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : dflt;
    return {
        port: typeof o.port === 'string' ? o.port : '',
        drums_channel: chan(o.drums_channel, d.drums_channel),
        inst_channels: d.inst_channels.map((c, i) => chan(Array.isArray(o.inst_channels) ? o.inst_channels[i] : null, c)),
        click: !!o.click,
        click_channel: chan(o.click_channel, d.click_channel),
        click_volume: int(o.click_volume, 0, 100, d.click_volume),
        click_accent_note: int(o.click_accent_note, 0, 127, d.click_accent_note),
        click_normal_note: int(o.click_normal_note, 0, 127, d.click_normal_note),
        clock: !!o.clock,
    };
}
function loadSettings() {
    let s = null;
    try { s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch (e) { /* defaults */ }
    s = cleanSettings(s);
    if (flags.port) s.port = String(flags.port);
    return s;
}
function saveSettings(s) {
    fs.mkdirSync(HOME, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(cleanSettings(s), null, 2) + '\n');
}

/* ---- MIDI outputs ---- */

function hostBinary() {
    const bin = path.join(BUILD, 'arranger-host');
    const sources = [path.join(HERE, 'arranger_host.c'), path.join(REPO, 'src/dsp/arranger_engine.c')];
    let stale = !fs.existsSync(bin);
    if (!stale) {
        const built = fs.statSync(bin).mtimeMs;
        stale = sources.some(s => fs.statSync(s).mtimeMs > built);
    }
    if (stale) {
        const r = spawnSync(path.join(HERE, 'build.sh'), [], { stdio: ['ignore', 'inherit', 'inherit'] });
        if (r.status !== 0) die('could not build the engine host (linux/build.sh needs a C compiler)');
    }
    return bin;
}

let alsaBuild = null;
function hostHasAlsa() {
    if (alsaBuild === null) {
        const r = spawnSync(hostBinary(), ['--has-alsa'], { encoding: 'utf8' });
        alsaBuild = (r.stdout || '').trim() === '1';
    }
    return alsaBuild;
}

/* The PC's MIDI outputs: its raw MIDI devices, and -- in a build with ALSA --
 * a port of our own for soft synths. */
function listPorts() {
    const out = [];
    let names = [];
    try { names = fs.readdirSync('/dev/snd'); } catch (e) { /* no sound devices */ }
    for (const n of names.sort()) {
        const m = /^midiC(\d+)D(\d+)$/.exec(n);
        if (!m) continue;
        let label = 'card ' + m[1];
        try { label = fs.readFileSync('/proc/asound/card' + m[1] + '/id', 'utf8').trim(); } catch (e) { /* keep */ }
        try {
            const first = fs.readFileSync('/proc/asound/card' + m[1] + '/midi' + m[2], 'utf8').split('\n')[0].trim();
            if (first) label = first;
        } catch (e) { /* keep */ }
        out.push({ id: '/dev/snd/' + n, label: label + ' (' + n + ')' });
    }
    if (hostHasAlsa()) out.push({ id: 'virtual', label: 'Arranger virtual port (connect it with aconnect)' });
    return out;
}

function resolvePort(settings) {
    if (settings.port) return settings.port;
    const ports = listPorts();
    return ports.length ? ports[0].id : '';
}

/* ---- the Move's song code ---- */

/* Where a path ui.js uses on the Move lives here. */
function localPath(p) {
    p = String(p);
    if (p === MOVE_ROOT || p.startsWith(MOVE_ROOT + '/')) return HOME + p.slice(MOVE_ROOT.length);
    if (p.startsWith('/data/UserData/')) return path.join(HOME, '.move', p.slice('/data/UserData/'.length));
    return p;
}

/* QuickJS's `os`, as far as ui.js uses it for files. */
const quickOs = {
    O_WRONLY: fs.constants.O_WRONLY, O_CREAT: fs.constants.O_CREAT, O_TRUNC: fs.constants.O_TRUNC,
    O_RDONLY: fs.constants.O_RDONLY, O_APPEND: fs.constants.O_APPEND,
    open(p, fl) { try { return fs.openSync(localPath(p), fl, 0o644); } catch (e) { return -1; } },
    write(fd, buf, off, len) { try { return fs.writeSync(fd, new Uint8Array(buf, off, len)); } catch (e) { return -1; } },
    close(fd) { try { fs.closeSync(fd); return 0; } catch (e) { return -1; } },
    readdir(p) { try { return [fs.readdirSync(localPath(p)), 0]; } catch (e) { return [[], 1]; } },
    remove(p) { try { fs.rmSync(localPath(p)); return 0; } catch (e) { return -1; } },
    stat(p) { try { const s = fs.statSync(localPath(p)); return [{ mode: s.mode, size: s.size, mtime: s.mtimeMs }, 0]; } catch (e) { return [null, 1]; } },
    mkdir(p) { try { fs.mkdirSync(localPath(p), { recursive: true }); return 0; } catch (e) { return -1; } },
};

/* Names from ui.js this tool uses that the module does not export. */
const EXTRA = ['CHORD_QUALITIES', 'CHORD_QUALITY_LABEL', 'KEYS', 'PITCH_CLASS', 'INST_ITEM_FIELDS',
    'BASS_PATTERN_LABELS', 'ARP_PATTERN_LABELS', 'ARP_RATES', 'INVERSION_AUTO',
    'normalizeSongForSave', 'newSection', 'writeSongBackup', 'safeFileName',
    'inferTempoFromFolder', 'inferTimeSigFromFolder'];

let uiModule = null;
async function loadUi() {
    if (uiModule) return uiModule;
    const srcPath = path.join(REPO, 'src/ui.js');
    const src = fs.readFileSync(srcPath, 'utf8');
    /* Schwung's shared modules draw Move's screen and lights. None of that
     * exists here, so each imported name becomes a stand-in: 0 for a
     * constant, an empty list for the pad/step tables, a do-nothing function
     * for the rest. The song model does not touch them. */
    let imports = 0;
    let out = src.replace(/import\s*\{([^}]*)\}\s*from\s*'\/data\/UserData\/schwung\/shared\/[^']+';/g, (m, names) => {
        imports++;
        const decl = names.split(',').map(s => s.trim()).filter(Boolean).map(n => {
            const [a, b] = n.split(/\s+as\s+/);
            return (b || a) + ' = __arrangerStub(' + JSON.stringify(a) + ')';
        });
        return 'const ' + decl.join(', ') + ';';
    });
    if (!imports) die('src/ui.js no longer imports Schwung\'s shared modules the way linux/arranger.mjs expects');
    out = out.replace("import * as os from 'os';", 'const os = globalThis.__arrangerOs;');
    if (/^import\s/m.test(out)) die('src/ui.js has an import linux/arranger.mjs does not know how to stand in for');
    out += '\nexport const __linux = { ' + EXTRA.join(', ') + ' };\n';
    fs.mkdirSync(BUILD, { recursive: true });
    const gen = path.join(BUILD, 'ui_linux.mjs');
    fs.writeFileSync(gen, out);

    const g = globalThis;
    g.__arrangerStub = (name) => {
        if (name === 'MovePads' || name === 'MoveSteps') return [];
        if (/^[A-Z]/.test(name)) return 0;
        const f = () => f;
        return f;
    };
    g.__arrangerOs = quickOs;
    for (const f of ['print', 'clear_screen', 'fill_rect', 'draw_rect', 'draw_line', 'set_pixel',
        'host_flush_display', 'host_log', 'shadow_log', 'console_log']) g[f] = () => true;
    g.host_read_file = (p) => { try { return fs.readFileSync(localPath(p), 'utf8'); } catch (e) { return null; } };
    g.host_write_file = (p, text) => {
        const lp = localPath(p);
        fs.mkdirSync(path.dirname(lp), { recursive: true });
        fs.writeFileSync(lp, String(text));
        return true;
    };
    g.host_file_exists = (p) => fs.existsSync(localPath(p));
    g.host_ensure_dir = (p) => { fs.mkdirSync(localPath(p), { recursive: true }); return true; };
    uiModule = await import(pathToFileURL(gen).href + '?t=' + fs.statSync(srcPath).mtimeMs);
    return uiModule;
}

/* ---- songs on disk ---- */

function songFiles() {
    let names = [];
    try { names = fs.readdirSync(SONGS); } catch (e) { return []; }
    const out = [];
    for (const n of names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))) {
        if (!n.endsWith('.json')) continue;
        const file = path.join(SONGS, n);
        let name = n.replace(/\.json$/, '');
        try { const o = JSON.parse(fs.readFileSync(file, 'utf8')); if (o && typeof o.name === 'string' && o.name) name = o.name; } catch (e) { continue; }
        out.push({ file, name });
    }
    return out;
}

/* A song by path, file name or song name. */
function findSong(ref) {
    if (!ref) die('which song? (see: arranger songs)');
    if (fs.existsSync(ref) && fs.statSync(ref).isFile()) return path.resolve(ref);
    for (const c of [path.join(SONGS, ref), path.join(SONGS, ref + '.json')]) if (fs.existsSync(c)) return c;
    const all = songFiles();
    const low = ref.toLowerCase();
    const hit = all.find(s => s.name.toLowerCase() === low) || all.filter(s => s.name.toLowerCase().includes(low));
    if (Array.isArray(hit)) {
        if (hit.length === 1) return hit[0].file;
        die(hit.length ? '"' + ref + '" matches several songs: ' + hit.map(s => s.name).join(', ')
            : 'no song "' + ref + '" in ' + SONGS);
    }
    return hit.file;
}

async function readSong(file) {
    const ui = await loadUi();
    let obj;
    try { obj = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { die(file + ': ' + e.message); }
    return ui.toUiSong(obj);
}

/* Save as the Move does: rounded, stamped, the version it replaces kept as a
 * backup (Songs/.backups, the last 10 -- Song Settings > Restore Backup on
 * the Move lists them too). */
async function writeSong(file, song) {
    const ui = await loadUi();
    song = ui.toUiSong(song);
    ui.__linux.normalizeSongForSave(song);
    song.modified = new Date().toISOString();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let previous = null;
    try { previous = fs.readFileSync(file, 'utf8'); } catch (e) { /* a first save */ }
    if (previous && path.dirname(file) === SONGS) {
        let oldName = song.name;
        try { oldName = JSON.parse(previous).name || oldName; } catch (e) { /* keep */ }
        ui.__linux.writeSongBackup(oldName, previous);
    }
    fs.writeFileSync(file, JSON.stringify(song, null, 2));
    return song;
}

/* A section's length in bars, as ui.js's clipEffBars counts it. */
function sectionBars(song, sec) {
    const bpb = song.time_sig_num > 0 ? song.time_sig_num : 4;
    let bars = 0;
    for (const c of sec.clips || []) {
        const speed = (typeof c.speed === 'number' && c.speed > 0) ? c.speed : 1;
        const startBeat = c.start_beat > 0 ? c.start_beat : 1;
        const endBeat = c.end_beat > 0 ? c.end_beat : bpb;
        bars += Math.max(0.25, ((c.end_bar - c.start_bar) - (startBeat - 1) / bpb - (bpb - endBeat) / bpb) / speed);
    }
    return bars;
}

/* ---- the engine ---- */

class Engine {
    constructor(settings) {
        this.settings = settings;
        this.queue = [];
        this.buffer = '';
        this.port = '';
        this.portError = '';
    }

    async start() {
        const bin = hostBinary();
        fs.mkdirSync(path.join(HOME, '.linux'), { recursive: true });
        this.child = spawn(bin, ['--state-dir', path.join(HOME, '.linux')].concat(flags.verbose ? ['--verbose'] : []),
            { stdio: ['pipe', 'pipe', 'inherit'] });
        this.child.on('exit', () => {
            this.dead = true;
            for (const w of this.queue.splice(0)) w.reject(new Error('the engine host exited'));
        });
        this.child.stdin.on('error', () => { /* the exit handler reports it */ });
        this.child.stdout.setEncoding('utf8');
        this.child.stdout.on('data', (chunk) => {
            this.buffer += chunk;
            let nl;
            while ((nl = this.buffer.indexOf('\n')) >= 0) {
                const line = this.buffer.slice(0, nl);
                this.buffer = this.buffer.slice(nl + 1);
                const w = this.queue.shift();
                if (w) w.resolve(line);
            }
        });
        await new Promise((resolve, reject) => this.queue.push({ resolve, reject }));   /* "ready" */
        await this.set('library_root', LIBRARY);
        await this.applySettings(this.settings);
    }

    send(line) {
        if (this.dead) return Promise.reject(new Error('the engine host exited'));
        return new Promise((resolve, reject) => {
            this.queue.push({ resolve, reject });
            this.child.stdin.write(line + '\n');
        });
    }
    set(key, value) { return this.send('set ' + key + ' ' + String(value).replace(/[\r\n]+/g, ' ')); }
    async get(key) {
        const a = await this.send('get ' + key);
        return a.startsWith('= ') ? a.slice(2) : null;
    }
    async getJson(key) {
        const t = await this.get(key);
        try { return t ? JSON.parse(t) : null; } catch (e) { return null; }
    }

    async applySettings(s) {
        this.settings = s;
        const port = resolvePort(s);
        if (port !== this.port || this.portError) {
            const a = await this.send('port ' + (port || 'none'));
            this.port = port;
            this.portError = a.startsWith('err') ? a.slice(4) : '';
        }
        await this.send('clock ' + (s.clock ? 1 : 0));
        await this.set('output_target', 'external');
        await this.set('output_channel', s.drums_channel - 1);
        await this.set('emit_directly', 1);
        await this.set('send_clock', s.clock ? 1 : 0);
        await this.set('click_output', 'external');
        await this.set('click_channel', s.click_channel - 1);
        await this.set('click_volume', s.click_volume);
        await this.applyClick(null);
    }

    /* The click as `song` has it, where it sets its own. */
    async applyClick(song) {
        const s = this.settings, own = (song && song.click_settings) || {};
        const num = (k) => typeof own[k] === 'number' ? own[k] : s['click_' + k];
        await this.set('click_accent_note', num('accent_note'));
        await this.set('click_normal_note', num('normal_note'));
        this.clickOn = typeof own.enabled === 'boolean' && !this.clickForced ? own.enabled : s.click;
        await this.set('click_enabled', this.clickOn ? 1 : 0);
    }
    async setClick(on) {
        this.clickForced = true;
        this.settings.click = !!on;
        this.clickOn = !!on;
        await this.set('click_enabled', on ? 1 : 0);
    }

    async waitScan() {
        for (let i = 0; i < 1200; i++) {
            if ((await this.get('scan_pending')) !== '1') return;
            await sleep(50);
        }
    }

    /* The song as the engine takes it: ui.js's conversion, with every track
     * sent to the MIDI output, on this PC's channels. */
    async engineSong(song) {
        const ui = await loadUi();
        const eng = JSON.parse(ui.toEngineSongJson(song));
        (eng.instruments || []).forEach((inst, i) => {
            inst.output = 'external';
            inst.channel = this.settings.inst_channels[i] || this.settings.inst_channels[0];
        });
        for (const sec of eng.sections || []) {
            for (const c of sec.clips || []) {
                if (typeof c.source === 'string' && c.source.startsWith(MOVE_ROOT + '/')) c.source = localPath(c.source);
            }
        }
        return eng;
    }

    /* Build `song` and play it from section `from` (0-based). */
    async play(song, { from = 0, loop = false } = {}) {
        const ui = await loadUi();
        let playing = song;
        from = Math.max(0, Math.min((song.sections || []).length - 1, from | 0));
        if (from > 0) {
            playing = JSON.parse(JSON.stringify(song));
            playing.sections = playing.sections.slice(from);
            ui.reindexInstrumentsForSectionSlice(playing, from);
        }
        const eng = await this.engineSong(playing);
        const before = (await this.getJson('state')) || {};
        await this.set('stop', 1);
        await this.set('song_json', JSON.stringify(eng));
        let built = false;
        for (let i = 0; i < 400 && !built; i++) {
            const st = await this.getJson('state');
            built = !!st && st.primary_published_gen !== before.primary_published_gen;
            if (!built) await sleep(25);
        }
        const err = await this.get('error');
        if (err) throw new Error(err);
        if (!built) throw new Error('the engine did not build the song (is the MIDI library in ' + LIBRARY + '?)');
        await this.applyClick(song);
        await this.set('loop', loop ? 1 : 0);
        await this.set('play_from_bar', 0);
        /* Section starts, in bars of the whole song, for the position. */
        const starts = [];
        let at = 0;
        for (const sec of playing.sections) { starts.push(at); at += sectionBars(song, sec); }
        this.playing = { song, from, starts, total: at, names: playing.sections.map(s => s.name || 'Section') };
    }

    async stop() { await this.set('stop', 1); }

    /* Where playback is: { running, section, section_name, bar (in the
     * section, 1-based), beat, bpm, ended }. */
    async position() {
        const t = await this.getJson('transport');
        const st = await this.getJson('state');
        const p = this.playing;
        const out = { running: !!(t && t.running), ended: !!(st && st.stopped_at_end), bpm: t ? t.bpm : 0,
            section: -1, section_name: '', bar: t ? t.bar : 1, beat: t ? t.beat : 1 };
        if (p && t) {
            let i = 0;
            while (i + 1 < p.starts.length && t.bar_frac >= p.starts[i + 1] - 1e-6) i++;
            out.section = p.from + i;
            out.section_name = p.names[i];
            out.bar = Math.floor(t.bar_frac - p.starts[i] + 1e-6) + 1;
        }
        return out;
    }

    /* Jump to a section of the playing song (by its index in the song). */
    async jump(section) {
        const p = this.playing;
        if (!p) return;
        const i = Math.max(0, Math.min(p.starts.length - 1, section - p.from));
        await this.set('play_from_bar', p.starts[i]);
    }

    async folders() {
        await this.waitScan();
        const out = [];
        for (;;) {
            const page = await this.getJson(out.length ? 'folders_json_' + out.length : 'folders_json');
            if (!page || !Array.isArray(page.items) || !page.items.length) break;
            for (const f of page.items) {
                out.push({ index: out.length, name: f.name, category: f.category || '',
                    path: f.category ? f.category + '/' + f.name : f.name });
            }
            if (out.length >= page.count) break;
        }
        return out;
    }
    async clips(index) { return (await this.getJson('folder_clips_json_' + (index | 0))) || []; }

    async quit() {
        if (this.dead) return;
        try { await this.send('quit'); } catch (e) { /* already gone */ }
        await new Promise(r => { if (this.dead) r(); else this.child.on('exit', r); });
    }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function startEngine() {
    const settings = loadSettings();
    const engine = new Engine(settings);
    await engine.start();
    return engine;
}

/* ---- commands ---- */

function ensureHome() {
    for (const d of [SONGS, LIBRARY]) fs.mkdirSync(d, { recursive: true });
}

function usage() {
    console.log(`Arranger on Linux -- play and edit Arranger songs, MIDI out, no Move.

  arranger ui [--http 7700]        the editor, in a browser
  arranger play <song> [--loop] [--section N] [--tempo BPM] [--click]
  arranger songs                   the songs in the Songs folder
  arranger show <song>             a song's sections, clips and chords
  arranger ports                   the MIDI outputs
  arranger config [key value]      show or change a setting (port, channels...)

  --home <dir>   the Arranger folder (default ~/Arranger, or $ARRANGER_HOME):
                 MidiLibrary/ and Songs/, as on the Move
  --port <out>   MIDI output for this run: /dev/snd/midiC1D0, virtual

Now: ${HOME}`);
}

async function cmdSongs() {
    const all = songFiles();
    if (!all.length) { console.log('No songs in ' + SONGS); return; }
    for (const s of all) console.log(s.name + (path.basename(s.file, '.json') !== s.name ? '   (' + path.basename(s.file) + ')' : ''));
}

function cmdPorts() {
    const ports = listPorts();
    const cur = resolvePort(loadSettings());
    if (!ports.length) {
        console.log('No MIDI output found. Plug in a USB MIDI interface, or name a device with --port.');
        return;
    }
    for (const p of ports) console.log((p.id === cur ? '* ' : '  ') + p.id.padEnd(22) + p.label);
}

function cmdConfig() {
    const s = loadSettings();
    if (!words.length) { console.log(JSON.stringify(s, null, 2)); console.log('(' + SETTINGS_FILE + ')'); return; }
    const [key, ...rest] = words;
    const val = rest.join(' ');
    const m = /^inst([123])_channel$/.exec(key);
    if (m) s.inst_channels[m[1] - 1] = parseInt(val, 10);
    else if (!(key in DEFAULT_SETTINGS) || key === 'inst_channels') {
        die('unknown setting "' + key + '" (port, drums_channel, inst1_channel, inst2_channel, inst3_channel, ' +
            'click, click_channel, click_volume, click_accent_note, click_normal_note, clock)');
    }
    else if (typeof DEFAULT_SETTINGS[key] === 'boolean') s[key] = /^(1|on|true|yes)$/i.test(val);
    else if (typeof DEFAULT_SETTINGS[key] === 'number') s[key] = parseInt(val, 10);
    else s[key] = val;
    saveSettings(s);
    console.log(JSON.stringify(cleanSettings(s), null, 2));
}

async function cmdShow() {
    const ui = await loadUi();
    const song = await readSong(findSong(words[0]));
    console.log(`${song.name}   ${song.tempo_bpm} BPM   ${song.time_sig_num}/${song.time_sig_den}   key ${song.key}`);
    console.log('folder: ' + (song.source_folder || '(none)'));
    (song.instruments || []).forEach((inst, i) => {
        if (inst.enabled) console.log(`${['Inst 1', 'Inst 2', 'Pads'][i] || 'Inst'}: ${inst.voicing}, octave ${inst.octave}` +
            (inst.follow_note ? ', follows note ' + inst.follow_note : ''));
    });
    song.sections.forEach((sec, si) => {
        const bars = sectionBars(song, sec);
        console.log(`\n${si + 1}. ${sec.name}   (${+bars.toFixed(2)} bars)`);
        for (const c of sec.clips) {
            console.log('   ' + (c.placeholder ? '(empty)' : c.source) + `   bars ${c.start_bar + 1}-${c.end_bar}` +
                (c.source_folder ? '   [' + c.source_folder + ']' : ''));
        }
        const line = [];
        for (let b = 0; b < Math.ceil(bars); b++) {
            const list = ui.barChords(sec, b);
            line.push(list.length ? list.map(ch => ui.chordLabel(ch, song.key) + (ui.chordBeat(ch) !== 1 ? '@' + ui.chordBeat(ch) : '')).join(' ') : '-');
        }
        if (line.some(x => x !== '-')) console.log('   chords: ' + line.join(' | '));
    });
}

function checkOutput(engine) {
    if (engine.portError) console.error('arranger: MIDI output: ' + engine.portError);
    else if (!engine.port) console.error('arranger: no MIDI output found -- nothing will sound (see: arranger ports)');
}

async function cmdPlay() {
    const file = findSong(words[0]);
    const song = await readSong(file);
    const engine = await startEngine();
    checkOutput(engine);
    if (flags.click) await engine.setClick(true);
    await engine.waitScan();
    let loop = !!flags.loop;
    const from = flags.section ? Math.max(0, parseInt(flags.section, 10) - 1) : 0;
    const start = async (sec) => {
        await engine.play(song, { from: sec, loop });
        if (flags.tempo) await engine.set('tempo', parseFloat(flags.tempo));
    };
    let finished = false;
    const finish = async () => {
        if (finished) return;
        finished = true;
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        process.stdout.write('\n');
        await engine.quit();
        process.exit(0);
    };
    process.on('SIGINT', finish);
    process.on('SIGTERM', finish);
    try { await start(from); } catch (e) { await engine.quit(); die(e.message); }
    const tty = process.stdin.isTTY && process.stdout.isTTY;
    console.log(`${song.name}  ->  ${engine.portError || !engine.port ? '(no MIDI output)' : engine.port}`);
    if (tty) {
        console.log('space stop/play   n/p next/previous section   l loop   c click   +/- tempo   q quit');
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.on('data', async (d) => {
            for (const k of d.toString()) try {
                const pos = await engine.position();
                if (k === 'q' || k === '\u0003') await finish();
                else if (k === ' ') { if (pos.running) await engine.stop(); else await start(pos.section > 0 && !pos.ended ? pos.section : from); }
                else if (k === 'n') await engine.jump(pos.section + 1);
                else if (k === 'p') await engine.jump(pos.section - 1);
                else if (k === 'l') { loop = !loop; await engine.set('loop', loop ? 1 : 0); }
                else if (k === 'c') await engine.setClick(!engine.clickOn);
                else if (k === '+' || k === '=') await engine.set('tempo', Math.min(300, Math.round(pos.bpm) + 1));
                else if (k === '-') await engine.set('tempo', Math.max(20, Math.round(pos.bpm) - 1));
            } catch (e) { /* the engine went away: the loop below ends */ }
        });
    }
    for (;;) {
        let pos;
        try { pos = await engine.position(); } catch (e) { break; }
        if (tty) {
            const line = `${pos.running ? '>' : '#'} ${pos.section + 1}. ${pos.section_name}   bar ${pos.bar}.${pos.beat}   ` +
                `${Math.round(pos.bpm)} BPM${loop ? '   loop' : ''}${engine.clickOn ? '   click' : ''}`;
            process.stdout.write('\r\x1b[K' + line);
        }
        /* Without a terminal to restart it from, the song's end is the end. */
        if (!pos.running && pos.ended && !tty) break;
        await sleep(100);
    }
    await finish();
}

/* ---- the editor ---- */

async function cmdUi() {
    const ui = await loadUi();
    const engine = await startEngine();
    const httpPort = parseInt(flags.http || '7700', 10);
    const page = () => fs.readFileSync(path.join(HERE, 'ui.html'));
    const L = ui.__linux;
    const constants = {
        keys: L.KEYS, notes: Object.keys(L.PITCH_CLASS),
        qualities: L.CHORD_QUALITIES.map(q => ({ id: q, label: L.CHORD_QUALITY_LABEL[q] || '' })),
        voicings: ui.VOICINGS, bass_patterns: L.BASS_PATTERN_LABELS, arp_patterns: L.ARP_PATTERN_LABELS,
        arp_rates: L.ARP_RATES, item_fields: L.INST_ITEM_FIELDS, inversion_auto: L.INVERSION_AUTO,
        default_instruments: [0, 1, 2].map(i => ui.defaultInstrument(i)),
    };
    /* Only files in the Songs folder are read or written through the page. */
    const songFile = (name) => {
        const base = path.basename(String(name || ''));
        if (!base.endsWith('.json') || base.startsWith('.')) throw new Error('not a song file: ' + name);
        return path.join(SONGS, base);
    };
    const describe = (song) => ({
        song, bars: song.sections.map(sec => sectionBars(song, sec)),
    });
    const status = async () => ({
        home: HOME, settings: engine.settings, port: engine.port, port_error: engine.portError,
        ports: listPorts(), click: !!engine.clickOn, songs: songFiles().map(s => ({ file: path.basename(s.file), name: s.name })),
    });

    const api = {
        'GET /api/init': async () => Object.assign({ constants }, await status()),
        'GET /api/status': status,
        'GET /api/song': async (q) => Object.assign({ file: path.basename(songFile(q.file)) }, describe(await readSong(songFile(q.file)))),
        /* The song as ui.js normalizes it, and its sections' lengths. */
        'POST /api/describe': async (q, body) => describe(ui.toUiSong(body.song)),
        'POST /api/new': async (q, body) => {
            const folder = String(body.source_folder || '');
            const leaf = folder.split('/').pop();
            const [num, den] = folder ? L.inferTimeSigFromFolder(leaf) : [4, 4];
            const name = String(body.name || leaf || 'New Song');
            return describe(ui.toUiSong({
                id: 'song-' + Date.now(), name, source_folder: folder,
                tempo_bpm: folder ? L.inferTempoFromFolder(leaf) : 120, time_sig_num: num, time_sig_den: den,
                ppq: 240, sync_mode: 'internal', key: 'C', sections: [L.newSection('Intro')],
            }));
        },
        'POST /api/save': async (q, body) => {
            let file = body.file ? songFile(body.file) : null;
            if (!file) {
                file = path.join(SONGS, L.safeFileName(body.song.name || 'untitled') + '.json');
                if (fs.existsSync(file)) throw new Error('a song file named ' + path.basename(file) + ' already exists');
            }
            const song = await writeSong(file, body.song);
            return Object.assign({ file: path.basename(file) }, describe(song));
        },
        'POST /api/delete': async (q, body) => {
            const file = songFile(body.file);
            const text = fs.readFileSync(file, 'utf8');
            let name = path.basename(file, '.json');
            try { name = JSON.parse(text).name || name; } catch (e) { /* keep */ }
            L.writeSongBackup(name, text);   /* still restorable */
            fs.rmSync(file);
            return {};
        },
        /* A key change moves the chords with it, as on the Move. */
        'POST /api/transpose': async (q, body) => describe(ui.toUiSong(ui.applySetlistEdits(ui.toUiSong(body.song), { key: body.key }))),
        'POST /api/play': async (q, body) => {
            await engine.waitScan();
            await engine.play(ui.toUiSong(body.song), { from: body.section | 0, loop: !!body.loop });
            return {};
        },
        /* Hear one library clip, looped. */
        'POST /api/audition': async (q, body) => {
            await engine.waitScan();
            const song = ui.toUiSong({
                name: 'Audition', source_folder: String(body.source_folder || ''), tempo_bpm: body.tempo_bpm || 120,
                time_sig_num: body.time_sig_num || 4, time_sig_den: body.time_sig_den || 4,
                sections: [{ name: 'Audition', clips: [{ source: String(body.source), start_bar: 0, end_bar: Math.max(1, body.bars | 0) }] }],
            });
            await engine.play(song, { loop: true });
            engine.playing = null;
            return {};
        },
        'POST /api/stop': async () => { await engine.stop(); return {}; },
        'POST /api/jump': async (q, body) => { await engine.jump(body.section | 0); return {}; },
        'POST /api/tempo': async (q, body) => { await engine.set('tempo', Number(body.bpm) || 120); return {}; },
        'POST /api/loop': async (q, body) => { await engine.set('loop', body.loop ? 1 : 0); return {}; },
        'POST /api/click': async (q, body) => { await engine.setClick(!!body.on); return {}; },
        'POST /api/panic': async () => { await engine.stop(); await engine.send('panic'); return {}; },
        'GET /api/position': () => engine.position(),
        'GET /api/folders': async () => ({ folders: await engine.folders(), library: LIBRARY }),
        'GET /api/clips': async (q) => ({ clips: await engine.clips(parseInt(q.index, 10)) }),
        'POST /api/rescan': async () => { await engine.set('scan_library', 1); return { folders: await engine.folders(), library: LIBRARY }; },
        'POST /api/settings': async (q, body) => {
            const s = cleanSettings(Object.assign({}, engine.settings, body));
            saveSettings(s);
            engine.clickForced = false;
            await engine.applySettings(s);
            return status();
        },
    };

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); };
        /* The page talks to this PC's files and MIDI: answer only requests
         * made to this address, from this page. */
        const hostName = String(req.headers.host || '').replace(/:\d+$/, '');
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostName)) return send(403, 'text/plain', 'forbidden');
        if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return send(403, 'text/plain', 'forbidden');
        if (req.method === 'GET' && url.pathname === '/') return send(200, 'text/html; charset=utf-8', page());
        const handler = api[req.method + ' ' + url.pathname];
        if (!handler) return send(404, 'text/plain', 'not found');
        try {
            let body = {};
            if (req.method === 'POST') {
                if (!/^application\/json/.test(req.headers['content-type'] || '')) return send(415, 'text/plain', 'json only');
                const chunks = [];
                for await (const c of req) chunks.push(c);
                body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
            }
            const out = await handler(Object.fromEntries(url.searchParams), body);
            send(200, 'application/json', JSON.stringify(out));
        } catch (e) {
            send(400, 'application/json', JSON.stringify({ error: e.message }));
        }
    });
    server.on('error', (e) => { engine.quit().then(() => die('http: ' + e.message)); });
    server.listen(httpPort, '127.0.0.1', () => {
        const address = 'http://127.0.0.1:' + httpPort + '/';
        console.log('Arranger: ' + address + '   (Ctrl+C to quit)');
        console.log('Songs and MIDI library: ' + HOME);
        checkOutput(engine);
        if (engine.port && !engine.portError) console.log('MIDI output: ' + engine.port);
        if (flags.open) spawn('xdg-open', [address], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
    });
    const finish = async () => { server.close(); await engine.quit(); process.exit(0); };
    process.on('SIGINT', finish);
    process.on('SIGTERM', finish);
}

const commands = { songs: cmdSongs, ports: cmdPorts, config: cmdConfig, show: cmdShow, play: cmdPlay, ui: cmdUi };
if (!commands[command]) { usage(); process.exit(command === 'help' ? 0 : 2); }
ensureHome();
await commands[command]();
