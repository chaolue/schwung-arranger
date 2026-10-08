# Arranger

A Song Builder, Setlist/Performance, and Jam module for
[Schwung](https://github.com/charlesvestal/schwung) on Ableton Move. It turns a
library of GM drum MIDI clips into arranged songs you can compose, rehearse,
and perform live — all from Move's pads, step buttons and jog wheel.

## Features

- **Song Builder** — assemble a song from a MIDI drum-clip library into
  sections, then trim each clip (start/end, guard, velocity, snare filter,
  kick thinning). The trim view shows each clip's source folder.
- **Chord & Instrument tracks** — chords in the song's key (with automatic
  transposition if the key changes), several per bar on any beat, and No
  Chord for silence; they drive up to two instrument tracks — chord or bass
  voicing, octave shift, a follow-note mode that fires alongside a drum hit
  (e.g. bass following the kick), and independent output routing per track.
  Instrument items change those settings (or mute) from any bar and beat.
- **One way to edit every track** — the Drum, Chord, Instrument and Click
  tracks all list a section's items on the display: jog to select, click to
  edit, Shift + jog to move, Delete and Copy, **+ Add**. Sections can be
  merged (Mute) and split at a clip (Shift + Mute).
- **Click track** — a metronome (and Perform's count-in) on its own output
  and channel, with its volume set per song section.
- **Setlists & Performance** — build a setlist of songs, set a count-in click
  and stop-after-finish per song, then play through it live with queued
  section/song jumps.
- **Jam Mode** — layer grooves and fills on the fly, queueing clips at bar
  boundaries and adjusting the BPM in realtime.
- **Categorised library** — folders are grouped by category (e.g. `GM Ballads`,
  `Vintage Drummer/03 Swing`) with drill-in navigation in both the Builder and
  Jam folder pickers. Song folders laid out with part subfolders (`Grooves/`,
  `Fills/`, `Clap/`, `Snare/`, `Stick/`) are recognised automatically.
- **Output routing** — send MIDI to External, Move tracks, or the Schwung
  synth chain, independently for drums and each instrument track, each on a
  configurable channel.
- **Schwung chains alongside** — hold Track 1–4 to edit Schwung's Chain 1–4
  (or hold Menu for Master FX) while the song keeps playing: the editor takes
  the screen, jog, knobs and Back, and the Arranger keeps the pads, steps and
  transport. On a Schwung with 8 chain slots, tap a Track to toggle to its
  second chain (Chain 5–8). Options > Chains sets which MIDI channel each
  chain listens on.
- **Performance knobs** — map Move's 8 knobs to parameters of any Schwung
  chain (synth, MIDI FX or audio FX, or a module's user presets) or of Master
  FX, per setlist with per-song overrides;
  each song restores its own knob values, and the Arranger warns when the
  loaded Move Set is not the one the setlist was used with.
- **Schwung clock** — while playing, the Arranger sends MIDI clock to
  Schwung at the song's tempo, so clock-synced modules and effects stay in
  time with it (Options > Schwung Clock).
- **Automatic backups** — the last 10 saved versions of each song are kept
  automatically, and any of them can be restored from Song Settings >
  Restore Backup.
- **Overtake module** — runs on Move's hardware surface (pads, steps, jog
  wheel, buttons), and can be suspended in the background (hold Back) so
  playback keeps running while you use the rest of Move.

## Prerequisites

- [Schwung](https://github.com/charlesvestal/schwung) installed on your
  Ableton Move. Editing chains alongside the Arranger uses Schwung's co-run,
  which needs Schwung 1.6.2 or newer. Chains 5–8 need a Schwung with the four
  aux chain slots; with 4 slots the Arranger offers Chain 1–4 only.
- A library of GM-style MIDI drum clips organised into folders
  (e.g. `Grooves/`, `Fills/`). Song folders may be laid out with part
  subfolders (`Grooves/`, `Fills/`, `Clap/`, `Snare/`, `Stick/`). The default
  library path is `/data/UserData/UserLibrary/Arranger/MidiLibrary`.
  I use MIDI packs from Groove Monkee, see free packs here (https://groovemonkee.com/pages/beat-farm-free-midi-beats)

## Building

```bash
./scripts/build.sh        # cross-compile via Docker, produces dist/arranger-module.tar.gz
```

## Testing

```bash
SCHWUNG_DIR=../schwung ./scripts/test.sh
```

runs the UI suites (Node 18+, against a Schwung checkout's shared modules) and
the engine tests. The engine regression tests in `tests/dsp` play real MIDI
clips from the "Song 13 4-4 120 BPM" folder of Groove Monkee's GM Rock 2 pack,
which is not in the repo — point `ARRANGER_TEST_LIBRARY` at a library holding
it, or they are reported as skipped.

## Upgrading from 0.5

Songs open as before. Their per-bar instrument mutes and settings are turned
into instrument items that play the same way, and saved that way. Songs saved
by 0.6 store chord lists, items and click volumes that **0.5 does not
understand** — if you go back to 0.5, restore a backup made before upgrading
(Song Settings > Restore Backup). See [CHANGELOG.md](./CHANGELOG.md).

## Installation

Install via the Schwung module store, or manually copy the built module:

```bash
./scripts/install.sh
```

The module is loaded as an **overtake** module and takes over Move's surface
when launched from the Schwung tools menu.

## Usage

See **[HELP.md](./HELP.md)** for the full control reference covering every
screen, button and pad.

## License

MIT.
