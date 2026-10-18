# Changelog

## Unreleased

### Song Builder
- The footer names only what works on the selected row: **NAME** on a
  section row, **ADD** on "+ Add", and **MENU** where the click does nothing.
  A locked song shows no click, pad or move actions; its chords and items
  no longer open for editing.
- With no chords in the song, the Inst and Click tracks show
  "(add chords first)" in place of "+ Add".
- Track 2 / 3 on the Inst 1 / 2 track turn that instrument on or off, as
  Track 4 does the click.
- A chord set on a bar that repeats the previous bar's chord is heard again:
  the held chord is released note-gap before it, as for a chord change.
- Follow Note: with Bass voicing, turning up from Off jumps to 36 (kick).
- Inst 1/2 Velocity (Instrument Settings, default 100), and items can change
  it from any bar and beat -- an item changing only Velocity re-strikes a held
  chord, so per-beat accents are heard.
- On a locked song, "+ Add" and any other click or pad that would edit show
  "Song locked" instead of doing nothing.
- Renaming a section offers the section names (as for a new section), or
  Custom... for the keyboard.
- Loop on the Chord, Inst or Click track copies the section's chords/items
  to every other section with the same name (Chorus, Chorus 2, ...).
- Deleting a drum clip in a section with chords or items leaves an (empty)
  placeholder of the same length, so the chords and items after it stay on
  their drums. A pad fills it; Delete again removes it.

### Playback
- Stop sends every instrument note-off at once, so each synth plays its own
  release; All Notes Off still follows 2 s later. (Notes no longer hold for
  10 s after Stop.) Leaving the Arranger sends All Notes Off at once, so
  nothing is left sounding in Schwung's chains.

### Setlists
- A setlist can play a song in another key, at another tempo, and with its
  sections in another order -- repeated, left out or rearranged (Setlist
  Edit > a song > Key / Tempo / Sections). The song itself is unchanged;
  Perform, its pads and the setlist's total time follow the setlist's
  version.
- Copy duplicates a setlist.
- Setlist Edit: Left/Right no longer move songs (Shift + jog does).

### Perform
- Knobs follow their parameters changed elsewhere — Schwung's Remote UI or
  its editor: the new value is saved for the current song, the knob light
  follows, and the knob feedback shows it. With Schwung's parameter change
  feed (`shadow_param_changes`) it is immediate and costs no reads; without
  it, Perform reads the mapped parameters back.

### Jam
- Record records the Schwung mix to a WAV, as in Perform.

### Options
- The web UI shows one Drums MIDI Channel (the selected output's) instead
  of one per output type.

## 0.6.0

### Song Builder
- Every track is edited the same way: the display lists the section's items
  (clips, chords, instrument changes, click volumes); jog selects, the click
  edits, Shift + jog moves, Delete removes, Copy duplicates, **+ Add** adds.
- Chords: several per bar, each on a chosen beat (half beats with Advanced);
  **No Chord** for a silent bar; the slash-bass list starts at the key's tonic.
  Chords follow sections that end mid-bar.
- Instrument items change an instrument's settings — mute, octave, follow
  note, voicing, inversion, note gap — from any bar and beat; each section
  starts on the track settings.
- Click track (Track 4): the click's volume per section; Options > Click >
  Volume sets where each section starts.
- Merge a section with the next (Mute) or split it at a clip (Shift + Mute).
- Play and Shift + Play work on every Song Builder settings page (chord, item,
  instrument, trim, song settings), saving the page's edit first.
- Headers fit the song name by measured width; list names keep a gap before
  their value.

### Perform and Jam
- Track 1/2/3 mute Drums/Inst 1/Inst 2; Track 4 turns the click (and count-in
  click) on or off. Record records the Schwung mix to a WAV.
- Instrument notes ring on for 10 s after Stop, then are released; All Notes
  Off follows on every channel that played. Notes no longer stick after a
  section jump.
- The first chord plays right after a count-in; a song staged for a stopped
  count-in no longer plays after another song.
- Knobs can step through a module's user presets (My Presets), and Shift + jog
  moves a knob's mapping on the Knobs screen.
- Knob banks: Sample switches between 4 banks of 8 knob mappings in Perform
  (and on the Knobs screen), lit in the bank's colour; the knob lights show
  each knob's value along the bank's colour sweep.
- Knobs can also map Send A/B's effects and return level, and a chain's
  Settings: volume, pan, mute, solo and send levels.
- Under Master FX, a Track tap goes to that Track's chain.

### Schwung
- MIDI clock to Schwung at the song's tempo while playing.
- On a Schwung with 8 chain slots, a Track tap under a chain view toggles to
  Chain 5–8.

### Upgrading
- Songs from 0.5 open as before; their per-bar instrument data becomes
  instrument items that play the same. Songs saved by 0.6 are not fully
  readable by 0.5 — restore a pre-upgrade backup if you go back.
