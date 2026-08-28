# Arranger

A Song Builder, Setlist/Performance, and Jam module for
[Schwung](https://github.com/charlesvestal/schwung) on Ableton Move. It turns a
library of GM drum MIDI clips into arranged songs you can compose, rehearse,
and perform live — all from Move's pads, step buttons and jog wheel.

## Features

- **Song Builder** — assemble a song from a MIDI drum-clip library into
  sections, then trim each clip (start/end, guard, velocity, snare filter,
  kick thinning).
- **Setlists & Performance** — build a setlist of songs, set a count-in click
  and stop-after-finish per song, then play through it live with queued
  section/song jumps.
- **Jam Mode** — layer grooves and fills on the fly, queueing clips at bar
  boundaries and adjusting the BPM in realtime.
- **Output routing** — send MIDI to External, Move tracks, or the Schwung
  synth chain, on a configurable channel.
- **Overtake module** — runs on Move's hardware surface (pads, steps, jog
  wheel, buttons).

## Prerequisites

- [Schwung](https://github.com/charlesvestal/schwung) installed on your
  Ableton Move.
- A library of GM-style MIDI drum clips organised into folders
  (e.g. `Grooves/`, `Fills/`). The default library path is
  `/data/UserData/UserLibrary/Arranger/MidiLibrary`.
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
