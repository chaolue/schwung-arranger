# Arranger

A Song Builder, Setlist/Performance, and Jam module for
[Schwung](https://github.com/charlesvestal/schwung) on Ableton Move. It turns a
library of GM drum MIDI clips into arranged songs you can compose, rehearse,
and perform live — all from Move's pads, step buttons and jog wheel.

## Features

- **Song Builder** — assemble a song from a MIDI drum-clip library into
  sections, then trim each clip (start/end, guard, velocity, snare filter,
  kick thinning). The trim view shows each clip's source folder.
- **Chord & Instrument tracks** — set a chord per bar (in the song's key,
  with automatic transposition if the key changes) and drive up to two
  instrument tracks from it — chord or bass voicing, octave shift, a
  follow-note mode that fires alongside a drum hit (e.g. bass following the
  kick), and independent output routing per track.
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
- **Automatic backups** — the last few saved versions of each song are kept
  automatically, so a change can be undone by hand if needed.
- **Overtake module** — runs on Move's hardware surface (pads, steps, jog
  wheel, buttons), and can be suspended in the background (hold Back) so
  playback keeps running while you use the rest of Move.

## Prerequisites

- [Schwung](https://github.com/charlesvestal/schwung) installed on your
  Ableton Move.
- A library of GM-style MIDI drum clips organised into folders
  (e.g. `Grooves/`, `Fills/`). Song folders may be laid out with part
  subfolders (`Grooves/`, `Fills/`, `Clap/`, `Snare/`, `Stick/`). The default
  library path is `/data/UserData/UserLibrary/Arranger/MidiLibrary`.
  I use MIDI packs from Groove Monkee, see free packs here (https://groovemonkee.com/pages/beat-farm-free-midi-beats)

## Building

```bash
./scripts/build.sh        # cross-compile via Docker, produces dist/arranger-module.tar.gz
```

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
