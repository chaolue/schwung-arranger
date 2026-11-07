# Changelog

## Unreleased

### Song Builder
- A shortened clip can be lengthened again: Trim Clip's End reaches the
  clip's whole length, found in its own folder. A clip from a folder other
  than the one on the pads used its shortened end as its length (or a
  same-named clip's from the pads' folder).
- **Click Settings** (Menu on the Click track), saved with the song as an
  instrument's are: Enabled (opening the song, or switching to it in
  Perform, turns the click on or off to match), the Volume each section
  starts at, and the Accent and Normal notes. What a song doesn't set is
  Options > Click's. Song Settings' Click row is the same saved Enabled.
  Perform's count-ins always play at Options' volume.
- **Similar clips**: Shift+Record on the Drum track, or **Find Similar** at
  the bottom of a clip's Trim Clip screen, lists clips from other folders
  with a rhythm like the selected clip's -- same meter, and grooves for a
  groove, fills for a fill -- best first, with how alike each is. Play hears
  one; the click loads its folder onto the pads, the clip lit white. The
  engine takes each clip's rhythm while it scans the library, so the search
  reads no files of its own.
- **Record** first lists the folders the song's clips come from, then
  **Browse...** for the library, when there are two or more. A clip from the
  song's old folder keeps playing from it when the folder changes.
- Holding a pad plays the clip from the pads' folder, not by name from
  wherever in the library it is found.
- **Chord and Inst pads**: on the Chord, Inst 1/2 and Pads tracks a pad
  plays a bar of a chord or item and picks it; a step then adds it to that
  bar (halfway when beat 1 is taken), or takes it out if it's already there.
  The left pads are roots (the key's own first), the right ones chord types
  -- or, on Inst and Pads, variations of what the instrument plays: Bass
  patterns with an Approach, Arp patterns with a Range, or a chord's
  inversion x strum (the Pads, or an Inst set to Chord).
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
  - Bass patterns are named by the notes they walk: 1, 1-5, 1-8,
    1-5-8-5, 1-5 Low, 1-3-5-3, 1-3-5-8, 1-3-5-6-b7 (were Root, Root/5th,
    Root/Oct, R-5-O-5, Country, ..., Boogie).
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
- The display has a **Perform** header with the song's key (the setlist's,
  if it sets one) beside the battery. Now: the song moves to the line below,
  and Sec and NSc are one line: the section playing > the next one.
- A renamed song shows its new name in Perform and Setlist Edit: renaming
  it in Song Settings, or in the Song Bank to a name with the same file
  name, now renames it in the setlists that play it, and Perform takes each
  song's name from its file.
- **Big view** (jog click in Perform, and again to go back): the chord
  playing large with its section; the next chord, as large, with blocks
  counting the beats to it, the next section with blocks
  counting the bars to it; the key and capo, the battery and the time; and
  Now: the song and Next: the next one, in turn. Minor's m and a flat
  are drawn small, so Am doesn't read AM.
- **Capo** (Setlist Edit > a song): the fret a guitarist's capo is on.
  Perform's big view shows the chords as the shapes played there; the key
  stays the one the song sounds in.
- In 6/8 the step LEDs flash the first bar's six beats, not twelve.
- A knob on a module's own presets (its preset browser's parameter -- an
  SF2's programs, say) shows the preset's name in the popup and the Knobs
  list, not its number. Preset comes first in the knob's parameter list
  (then My Presets); a module that leaves it out of its parameter list
  still offers it.
- A knob on a list -- a module's Preset, My Presets, or any option list --
  takes four detents per item (two before; one for Preset), so it no longer
  skids past the one you want. Turning back answers at once.
- Knobs follow their parameters changed elsewhere — Schwung's Remote UI or
  its editor: the new value is saved for the current song, the knob light
  follows, and the knob feedback shows it. With Schwung's parameter change
  feed (`shadow_param_changes`) it is immediate and costs no reads; without
  it, Perform reads the mapped parameters back.

### Jam
- Record records the Schwung mix to a WAV, as in Perform.

### Pads and Keys
- Keys: a held note lights green on every pad that plays it, not just the
  one pressed (the 4ths and 3rds layouts repeat a note a row up).
- **Pads**: a third instrument that plays the chords as a full chord on the
  chord grid -- piano pads under the song. Track 1 now steps Drum -> Chord
  -> Pads; Shift + Track 1 on the Pads track turns it on or off.
  (Since moved to Track 4: see Track buttons.) Its settings (Octave, Inversion, Strum, Note Gap,
  Velocity, Chance) and items work as Inst 1/2's; its output is Options >
  Pads. Off in new songs.
- **Keys**: Capture in Perform or Jam turns the pads into a keyboard (and
  back); Up/Down change octave. Played straight from the engine, so with no
  added latency. Options > Keys sets its output, channel, layout (In Key or
  Chromatic; rows in 4ths, 3rds or in sequence), scale and starting octave;
  the root is the song's key (Jam's in Jam).
- Options lists Drums, Inst 1, Inst 2, Pads, Click, Keys, Chains, ...; the
  web settings page has Pads and Keys too.

### Bass register
- The bass's Octave counts from the song key's root, so the tonic is the
  lowest, home note. It counted from C, which put a Bb song's tonic at the
  top of the octave (Bb3, with F3 and Eb3 below): a section on the tonic --
  Yes He Lives' Intro -- played an octave above the rest. Songs in C are
  unchanged; in other keys, roots on the far side of the tonic move an
  octave. Jam's bass follows its key the same way.

### Track buttons
- Song Builder: Track 4 shows the **Pads** (press again for the Click
  track); Track 1 is Drum <-> Chord again. The track buttons only choose
  the track: Inst 1/2 and the Pads are turned on or off with Enabled in
  their settings (Menu), the click with the new **Click** row in Song
  Settings.
- Jam: Track 4 is the **Pads** instead of the click -- the chord pads'
  chord as a full chord on Options > Pads, held from bar to bar until
  another is picked; Shift + Track 4 opens their settings (Octave,
  Inversion, Note Gap).
- Perform: Track 4 turns the **Pads** on or off (lit teal), as in Jam; the
  click moved to Shift + Track 4 (lit orange while Shift is held).
- Back is lit on every screen it works on: Song Builder's item pages (Inst,
  Pads and Click), Instrument Settings and the Chord Picker, Jam's instrument
  settings, and Options > Drums, Inst, Keys and Click were dark.
- A confirm box (delete, overwrite...) has a footer: **JOG SEL**,
  **CLK PICK**, **BACK OUT**.
- Chord Settings has a footer: the chord line (`= Cm7 b1`) moved up to
  the list's last row to make room, so four fields show at a time.
- Jam's instrument settings (Shift + Track 2/3/4) have everything Song
  Builder's do: Arp and its Pattern, Rate, Range and Vel Range; bass
  patterns and Approach (into a chord queued on the pads); Strum; Velocity;
  Vel Follow; Chance.

### Chords outside the key
- The chord page's Root takes any root: a semitone at a time from the key
  (I, bII, ii, bIII, iii, IV, #IV, V, bVI, vi, bVII, vii°), then No Chord.
  Out-of-key roots default to major and are named with flats where usual
  (bVII in C is Bb). A chord outside the key now opens showing its own
  root; it showed as I.

- More chord types: 6, m6, m7b5, m(maj7), 7sus4, add9, m(add9), add4 (4),
  m(4), 7(4), m7(4), 6/9, 9, maj9, m9, 7b9, 7#9, maj7#11, 11, m11, 13 --
  up to six notes, all played.
- Notes are spelt as the key writes them: flats in F, Bb, Eb, Ab and Db
  (and their chords, bass list and the key itself -- "A#" shows as Bb),
  sharps in the others; a chord saved with the other spelling shows the
  key's.

### Instrument settings while playing
- Play now works from Instrument Settings and the item pages of Inst 1/2 and
  Pads (it sent the song but never started it: the build confirmation that
  starts playback wasn't read from those pages).
- While playing, a change to an instrument's settings or items -- on those
  pages, or Delete/Copy/nudge in its list -- is heard at once: the engine
  takes the instrument live and re-strikes, without rebuilding the song.
- A setting changed while playing from a section or the cursor is no longer
  lost on Stop (it went to the temporary copy being played).
- Editing an item playback hasn't reached (later in the section, or in
  another one) no longer re-strikes the note sounding now: the change is
  heard when playback gets there.

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
  On the charger (charging or full) a lightning bolt shows beside it.
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
