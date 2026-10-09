# Changelog

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
