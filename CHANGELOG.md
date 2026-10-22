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
  to other sections, picked from a list: the same-named ones (Chorus,
  Chorus 2, ...) start ticked, and any other can be ticked too.
- More variety for Inst 1/2 (Instrument Settings, and per item):
  - **Arp** voicing: the chord's notes one at a time, by **Pattern** Up,
    Down, Up-Down or Random -- on each Follow Note hit, or with Follow Note
    Off at its **Rate** (1/4, 1/8, 1/8T, 1/16, 1/16T).
  - Bass **Pattern**: Root/5th, Root/Oct, root-fifth-octave-fifth,
    Country (the fifth below), 1-3-5-3, 1-3-5-8 or Boogie on successive
    attacks, starting again on each new chord.
  - More Arp patterns: Rnd Walk, Shuffle, Alberti, Pedal, Converge and
    1-5-8-10; **Range** (1-3 octaves); **Vel Range** plays the notes other
    than the base quieter by a random amount. The base note always plays
    (Chance only thins the others), and the random patterns start each
    chord on it.
  - **Approach** (Bass): a passing note half a beat before each new bass
    note -- a semitone below or above, or the scale step below.
  - **Strum** (Chord): the chord's notes 5-100 ms apart, up, down or
    alternating.
  - **Vel Follow**: a drum-following note is as loud as its drum hit.
  - **Chance**: the share of attacks that play.
  Only the settings that apply to the voicing are shown.
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

### Pads and Keys
- **Pads**: a third instrument that plays the chords as a full chord on the
  chord grid -- piano pads under the song. Track 1 now steps Drum -> Chord
  -> Pads; Shift + Track 1 on the Pads track turns it on or off, and in
  Perform too (live). Its settings (Octave, Inversion, Strum, Note Gap,
  Velocity, Chance) and items work as Inst 1/2's; its output is Options >
  Pads. Off in new songs.
- **Keys**: Capture in Perform or Jam turns the pads into a keyboard (and
  back); Up/Down change octave. Played straight from the engine, so with no
  added latency. Options > Keys sets its output, channel, layout (In Key or
  Chromatic; rows in 4ths, 3rds or in sequence), scale and starting octave;
  the root is the song's key (Jam's in Jam).
- Options lists Drums, Inst 1, Inst 2, Pads, Click, Keys, Chains, ...; the
  web settings page has Pads and Keys too.

### Instrument settings while playing
- Play now works from Instrument Settings and the item pages of Inst 1/2 and
  Pads (it sent the song but never started it: the build confirmation that
  starts playback wasn't read from those pages).
- While playing, a change to an instrument's settings or items -- on those
  pages, or Delete/Copy/nudge in its list -- is heard at once: the engine
  takes the instrument live and re-strikes, without rebuilding the song.
- A setting changed while playing from a section or the cursor is no longer
  lost on Stop (it went to the temporary copy being played).

### Schwung chains
- While a chain, Send or Master FX editor is open over the Arranger, only
  playing controls still work: Play, the Track buttons, Menu, Shift, and in
  Perform and Jam the pads, steps, arrows and Record. Delete, Copy, Loop,
  Undo and the rest -- and Song Builder's pads -- do nothing and go dark,
  so nothing changes on a screen you can't see (Delete on the Song Bank
  started deleting a song).

### Battery
- A battery icon, filled to the charge, shows at the right of the header on
  the main menu, Perform and Jam (Move's own battery display is hidden while
  the Arranger is up). At 10% it blinks and a "Low battery" popup warns once.
  Needs a Schwung with `host_battery()`; on an older one nothing is shown.

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
