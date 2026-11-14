# Arranger on Linux

Play and edit Arranger song files on a Linux PC, without a Move. The notes go
to a MIDI output of the PC (a USB MIDI interface, a synth's USB port, or a
virtual port for a soft synth).

It runs the Move's own code — the engine, and the song model from `src/ui.js`
— so a song plays here as it does on the Move, and files saved here open
there.

Needs Node 18+ and a C compiler. No packages to install.

## Set up

The tool works in a folder laid out like the Move's
`/data/UserData/UserLibrary/Arranger`: `MidiLibrary/` (the drum clips) and
`Songs/`. By default that is `~/Arranger`; `--home <dir>` or `$ARRANGER_HOME`
names another.

To work on what is on your Move, copy it over (and back, when done):

```bash
scp -r ableton@move.local:/data/UserData/UserLibrary/Arranger ~/Arranger
```

Songs find their clips by library folder, so the PC's `MidiLibrary/` should
hold the same folders as the Move's.

## The editor

```bash
linux/arranger ui
```

then open <http://127.0.0.1:7700/> (`--open` does it for you, `--http <port>`
picks another port). It only answers on this PC.

- **Songs**: open, New, Save, Save as, Delete. Each save keeps the version it
  replaces in `Songs/.backups` (the last 10), as on the Move.
- **Song**: name, tempo, time signature, key (changing it moves the chords).
- **Sections**: add, rename, reorder, duplicate, delete; ▶ plays from there.
- **Drums**: add clips from the MIDI library on the right (**+** adds to the
  section you last touched, **▶** auditions a clip); set each clip's bars,
  velocity and speed.
- **Chords**: one box per bar. `Am7`, `C/E`, `N.C.`; several in a bar with
  their beats: `G7 C@3`; empty holds the previous chord.
- **Instruments**: Inst 1, Inst 2 and Pads, with their voicing, octave,
  pattern and the rest. Changes inside a section (a mute, another octave, a
  click volume) go under *Instrument and click changes*.
- **Play / Stop / Loop / Click**, and Space. Play uses the song as it is on
  screen, saved or not.
- **MIDI…**: the output, and the channels for drums (10), Inst 1/2/Pads
  (2/3/4) and the click; MIDI clock out.

## The command line

```bash
linux/arranger songs                 # what is in Songs/
linux/arranger show "My Song"        # sections, clips, chords
linux/arranger play "My Song"        # play it
linux/arranger play "My Song" --loop --section 3 --tempo 96 --click
linux/arranger ports                 # MIDI outputs
linux/arranger config                # settings
linux/arranger config port /dev/snd/midiC1D0
linux/arranger config inst1_channel 5
```

While `play` runs in a terminal: Space stops and starts, `n`/`p` jump to the
next/previous section, `l` loop, `c` click, `+`/`-` tempo, `q` quits.

## MIDI output

- **A MIDI interface or a synth on USB**: it shows up as
  `/dev/snd/midiC<card>D<device>` (see `linux/arranger ports`); the first one
  found is used unless `--port` or `config port` names another. Your user
  needs access to it (usually the `audio` group).
- **A soft synth** (FluidSynth, a DAW...): build with ALSA's headers
  installed (`libasound2-dev` on Debian/Ubuntu, `alsa-lib-devel` on Fedora),
  then use the port `virtual` and connect it with `aconnect` or your patchbay.
  Without them, `sudo modprobe snd-virmidi` gives raw devices that soft
  synths can read too.

On the Move, each track goes to External, a Move track or a Schwung chain.
Here everything goes to the one MIDI output, each track on its own channel.

## What it does not do

Setlists and Perform, Jam mode, Schwung chains and performance knobs — those
are the Move's. Advanced per-clip trims a song already has (beat-level
start/end, guard, snare and kick filters) are kept and played, but only bars,
velocity and speed can be edited here.

## How it is put together

- `arranger_host.c` — links `src/dsp/arranger_engine.c` unchanged, calls its
  render every 128 frames of real time, and writes its MIDI to the output.
  Built to `linux/build/` on first run (`linux/build.sh`).
- `arranger.mjs` — the commands and the editor's local server. Loads
  `src/ui.js` with Schwung's screen modules stood in for.
- `ui.html` — the editor page.
- `tests/linux/run.mjs` — plays a generated song to a file and checks the MIDI.
