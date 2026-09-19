# Arranger Module — Control Reference

This file lists every hardware control used in each screen of the Arranger module.
Controls are shown as they appear on Ableton Move.

Button LED legend:
- **White buttons** (Back, Menu, Capture, Loop, Mute, Delete, Copy, Undo, Shift, arrows): lit bright when they do something on the current screen; dim when they only work with Shift held; off when inactive.
- **RGB buttons** (Play, Record/Sample): green means the action will start/add something; red means Play will stop playback.
- Hold **Shift** to see the alternate action LEDs brighten.

**Anywhere in the module:**

| Control | Action |
|---------|--------|
| Back (tap) | Screen-specific — see each section below |
| Back (hold ≥0.5s) | Suspend the module: it parks in the background with playback still running. Return to it from the Schwung Tools menu to pick up where you left off |

---

## Global / Root Menu

Screen reached when first loading the module.

| Control | Action |
|---------|--------|
| Jog wheel | Scroll between Song Builder, Setlists, Perform, Jam, Options |
| Jog click | Open the selected entry |
| Back (tap) | Exit the module (return to Schwung menu) |

---

## Song Builder


### Song Bank

Browse, rename, delete, and load songs.

| Control | Action |
|---------|--------|
| Jog wheel | Scroll the list (first item is "+ New Song") |
| Jog click | Load the selected song into the Song Builder |
| Shift + Jog click (on existing song) | Rename the selected song |
| Delete (on existing song) | Delete the selected song |
| Back | Return to Root Menu |

**Button LED hints:** Back, Main and Delete are lit; Shift is dim and brightens when held for renaming.

---

### Source Folder Picker

Choose the MIDI folder a new song is built from, or change the current song's source folder (via **Record** in Edit Song). Folders are grouped by category (e.g. `GM Ballads`, `Vintage Drummer/03 Swing`); drill into a category to reach its song folders.

| Control | Action |
|---------|--------|
| Jog wheel | Scroll the current category's sub-categories and folders |
| Jog click (on a category) | Drill into that sub-category |
| Jog click (on a folder) | Select it (new song: name it; change-folder: apply it) |
| Back | Return to the parent category, then to the previous screen |

**Button LED hints:** Back and Main are lit.

---

### Edit Song

Build and arrange a song from Groove/Fill clips. A song has four tracks — Drum,
Chord, and two Instrument tracks — selected with the four **Track** buttons
above the pads:

| Track button | Track | LED colour |
|---------------|-------|------------|
| Track 1 | Drum | White |
| Track 2 | Chord | Azure Blue |
| Track 3 | Instrument 1 | Bright Yellow |
| Track 4 | Instrument 2 | Purple |

The lit Track button shows which track is showing. See **Chord Track** and
**Instrument Track** below for the other three — this section covers the Drum
track, which is the only one with clip editing (pads, Delete, Copy, Record,
Loop). Section navigation (Left/Right), Song Settings/Instrument Settings
(Menu), and playback (Play, Back) work the same on every track.

| Control | Action |
|---------|--------|
| Jog wheel | Move the clip cursor up/down in the current section |
| Shift + Jog wheel | Move the clip at the cursor up/down within the section (when cursor is on a clip) |
| Jog click (on clip) | Open Trim Clip for that clip |
| Jog click (on section header) | Rename the current section |
| Menu | Open Song Settings |
| Shift + Jog click | Open Song Settings (song name, BPM, time signature, key) |
| Play (during playback) | Stop playback (LED turns red) |
| Play (stopped) | Preview the clip at the cursor (LED green) |
| Shift + Play | Save and play from the start of the song |
| Record (blue)| Change the MIDI song's source folder (reloads the clip palette from the selected folder) |
| Delete | Delete the clip at the cursor |
| Shift + Delete | Delete the current section (must keep at least one) |
| Copy | Duplicate the clip at the cursor |
| Shift + Copy | Duplicate the current section |
| Shift + Loop | Add a new empty section after the current one |
| Up / Down | Change the clip page |
| Left / Right | Move to the previous / next section |
| Shift + Left / Right | Move the current section backward / forward in the song order |
| Back | Save the song and return to Song Bank |
| Hold a pad | Preview the clip (release to insert a short tap) |
| Tap a pad | Insert the clip at the current cursor position |

Playback keeps running while you browse: moving the cursor with the jog wheel, changing the palette page (Up/Down), or moving sections (Left/Right) does not stop playback. While playing, the display and step LEDs follow the section you navigate to, then resume following the playhead on the next section change.

**Button LED hints:** Back, Main, Copy, arrows, Delete, Play and Record are lit. Shift is dim; hold it to see Main, Copy, Loop, Delete, Left/Right and Play brighten for their alternate functions. Track 1 is lit white for the Drum track.

---

### Chord Track

Set the harmony for the song, bar by bar. Chords apply across every section using
the song's key (set in Song Settings) and drive any Instrument track set to
**Chord** voicing.

| Control | Action |
|---------|--------|
| Step buttons | Open the Chord Picker for that bar (scrolled the same way as the Drum track's steps) |
| Left / Right | Move to the previous / next section |
| Menu | Open Song Settings |
| Play / Back | Same as the Drum track |

The display shows the section, the chord currently sounding, the next chord
change and its bar, and the current bar position.

**Button LED hints:** Track 2 is lit azure blue.

---

### Chord Picker

Set the chord for the bar opened from the Chord Track. New bars default to the
diatonic chord for their position in the key.

| Control | Action |
|---------|--------|
| Jog wheel (browse mode) | Move between Root, Type, Bass (or the single Add Chord row if this bar has no chord yet) |
| Jog wheel (edit mode) | Adjust the selected field |
| Jog click | Toggle edit / browse mode for the selected field |
| Jog click (on Add/Delete Chord) | Add a chord to this bar, or delete the existing one |
| Step buttons | Commit this bar and open the picker for the newly pressed bar |
| Back (edit mode) | Exit edit mode |
| Back (browse mode) | Commit the chord (if one was actually added) and return to the Chord Track |

| Field | Meaning |
|-------|---------|
| Root | Scale degree within the song's key (I, ii, iii, IV, V, vi, vii°) |
| Type | Chord quality (major, minor, 7th, etc.) |
| Bass | Optional slash-chord bass note, or **—** for none |

**Button LED hints:** Back and Main are lit.

---

### Instrument Track

Play a synth/bass part alongside the drums, following the Chord Track's harmony.
There are two independent instrument tracks (Instrument 1 and 2).

| Control | Action |
|---------|--------|
| Step buttons | Toggle this instrument on/off for that bar |
| Left / Right | Move to the previous / next section |
| Menu | Open Instrument Settings for this track |
| Play / Back | Same as the Drum track |

The display shows the section, the chord currently sounding, whether this bar
sends or mutes the instrument, the song key, and the instrument's MIDI output
channel (set in Options).

**Button LED hints:** Track 3 (Instrument 1) is lit bright yellow; Track 4
(Instrument 2) is lit purple.

---

### Instrument Settings

Configure how an instrument track plays. Opened with **Menu** from that
Instrument track.

| Control | Action |
|---------|--------|
| Jog wheel (browse mode) | Move between Enabled, Octave, Follow Note, Voicing, Note Gap |
| Jog wheel (edit mode) | Adjust the selected value |
| Jog click | Toggle edit / browse mode; on Enabled it toggles On/Off directly |
| Back (edit mode) | Exit edit mode |
| Back (browse mode) | Return to the Instrument Track |

| Field | Meaning |
|-------|---------|
| Enabled | On/Off for this instrument track |
| Octave | Octave shift applied to the chord/note (-1 to 8) |
| Follow Note | When set (1–127), the instrument fires alongside that drum note instead of on the chord/bar grid (e.g. a bass that follows the kick). 0 = off, follows the bar grid instead |
| Voicing | **Chord** plays the full chord; **Bass** plays only the chord's root/bass note |
| Note Gap | How far before the next note-on this instrument's current note is cut short (0 to 1 beat), so notes don't run into each other |

Output routing and MIDI channel for each instrument are set globally in
**Options**, not here — see Options below.

**Button LED hints:** Back and Main are lit.

---

### Trim Clip

Adjust clip start/end, guard window, speed, velocity, single note velocity and thinning. Enable **Advanced Trim** to also edit sub-bar (beat) positions.

The top line shows the clip's **source folder** (read-only), so you can see which MIDI folder the clip comes from.

| Control | Action |
|---------|--------|
| Jog wheel (edit mode) | Adjust the selected field |
| Jog wheel (browse mode) | Move between fields |
| Jog click | Toggle edit / browse mode for the selected field |
| Jog click (on Advanced Trim) | Toggle Advanced Trim on/off |
| Back (browse mode) | Commit changes and return to Song Builder |
| Back (edit mode) | Cancel the current field and return to browse mode |

| Field | Meaning |
|-------|---------|
| Advanced Trim | Toggle sub-bar editing. When On, Start/End show both Bar and Beat fields |
| Start / End | Bars to play from the source clip (effective song-bar units) |
| Start Bar / End Bar | Bar positions, in effective song-bar units (source ÷ speed) |
| Start Beat / End Beat | Beat within the start/end bar (1 to beats-per-bar) |
| Speed | Playback speed of the clip: 0.5×, 1×, 2× (compresses/stretches the clip length) |
| Guard | Small tail window removed at the clip boundary (0–50%). When a clip is shortened from its full length a 13% guard is applied automatically, and it is cleared again when the end is widened back to full length |
| Velocity | Global note-on velocity scale (0–200%) |
| Single Note | MIDI note to adjust velocity of, for example the snare (default 38; set to 0 to disable) |
| Single Note Vel | Single note velocity scale (0% = remove, 100% = unchanged, up to 200%) |
| Limit Note | Note to thin (set to a note number, e.g. 36; 0 = off) |
| Limit Notes/Bar | Max note hits to keep per bar (0 = off). For example, for kicks, on strong beats (1, plus 3 in 4/4 / 4 in 6/8) are always kept; extra kicks nearest to other kicks are dropped first. |
| MIDI Channel | Per-clip MIDI out channel override: **Default** follows the Drums output channel (set in Options), or set 1–16 to route this clip to a specific channel |


**Button LED hints:** Back and Main are lit.

---

### Song Settings

Edit song name, tempo, time signature, key, and the song lock.

| Control | Action |
|---------|--------|
| Jog wheel | Scroll fields / adjust value when editing |
| Jog click | Toggle edit mode; on the Name field, open text entry |
| Back | Save changes and return to Song Builder |

| Field | Meaning |
|-------|---------|
| Name | The song's display name |
| Tempo | Song tempo in BPM |
| Time Signature | Beats per bar / beat unit |
| Key | The song's key — changing it transposes every existing chord to the same relative harmony in the new key |
| Lock Song | When On, the song cannot be renamed, deleted, or edited |

**Button LED hints:** Back and Main are lit.

---

## Setlists


### Setlist Bank

Browse, create, rename, and delete setlists.

| Control | Action |
|---------|--------|
| Jog wheel | Scroll the list (first item is "+ New Setlist") |
| Jog click | Open the selected setlist for editing |
| Shift + Jog click (on existing setlist) | Rename the selected setlist |
| Delete (on existing setlist) | Delete the selected setlist |
| Back | Return to Root Menu |

**Button LED hints:** Back, Main and Delete are lit; Shift is dim and brightens when held for renaming.

---

### Setlist Edit

Add, reorder, remove songs, and configure per-song options.

| Control | Action |
|---------|--------|
| Jog wheel | Scroll the songs in the setlist (last entry is "(add song)") |
| Shift + Jog wheel | Move the selected song up / down in the set |
| Jog click (on a song) | Open Click Settings for that song |
| Jog click (on "(add song)") | Open the Song Bank to add a song |
| Delete | Remove the selected song from the setlist |
| Left / Right | Move the selected song earlier / later in the setlist |
| Back | Return to Setlist Bank |

**Button LED hints:** Back, Main, Delete and Left/Right are lit; Shift is dim and brightens when held for moving songs.

---

### Setlist Pick (Add Song)

Choose a song from the Song Bank to insert into the setlist.

| Control | Action |
|---------|--------|
| Jog wheel | Scroll songs |
| Jog click | Add the selected song to the setlist and return to Setlist Edit |
| Back | Return to Setlist Edit without adding |

**Button LED hints:** Back and Main are lit.

---

### Setlist Song Settings

Per-song count-in click and stop-after-finish options.

| Control | Action |
|---------|--------|
| Jog wheel (browse mode) | Move between Bars, Note, Stop On End |
| Jog wheel (edit mode) | Adjust the selected value |
| Jog click | Toggle edit / browse mode; on Stop On End it toggles Yes/No |
| Back (edit mode) | Exit edit mode |
| Back (browse mode) | Save and return to Setlist Edit |

| Field | Meaning |
|-------|---------|
| Bars | Count-in click bars before this song starts (0 = no click) |
| Note | MIDI note number used for the click (0 = silent / pad flash only) |
| Stop On End | If Yes, playback stops when this song finishes and the next song is selected |

---

## Perform

Play through a setlist.

### While stopped

| Control | Action |
|---------|--------|
| Pad press (section of current song) | Select that section; Play will start from there |
| Pad press (other song / click pad) | Select that song; Play will start from there |
| Up / Down | Scroll the pad window up / down one row |
| Jog wheel | Scroll the info display |
| Play | Start playback from the current / selected song or section |
| Back | Stop and return to Root Menu |

### While playing

| Control | Action |
|---------|--------|
| Pad press (current song section) | Queue a jump to that section at the end of the current section |
| Pad press again (same section) | Escalate the jump to the end of the current bar |
| Pad press (other song / click pad) | Queue a jump to that song at the next section boundary |
| Up / Down | Scroll the pad window up / down one row |
| Play | Stop playback |
| Back | Stop playback and return to Root Menu |

The pad window shows 4 rows of sections at a time. When playback reaches the third visible row, the window auto-scrolls up one row so the next row of sections becomes visible at the top. The currently playing pad/section is shown in bright green; queued jumps flash white. Step LEDs show bar progress within the current section, or the selected section's clip layout while stopped. The active bar flashes white-to-black on the beat for a prominent cue, then returns to its clip colour on the next bar.

**Button LED hints:** Back, Up, Down and Play are lit; Play is green when stopped and red while playing.

---

### Performance Setlist Picker

Choose a setlist to perform.

| Control | Action |
|---------|--------|
| Jog wheel | Scroll setlists |
| Jog click | Load the setlist and enter Performance Mode |
| Back | Return to Root Menu |

**Button LED hints:** Back and Main (green) are lit.

---

## Jam


### Jam Folder Picker

Choose which folder of clips to jam with. The folder's name (BPM / time signature) sets the playback tempo. Folders are grouped by category; drill into a category to reach its song folders.

| Control | Action |
|---------|--------|
| Jog wheel | Scroll the current category's sub-categories and folders |
| Jog click (on a category) | Drill into that sub-category |
| Jog click (on a folder) | Enter Jam mode with the selected folder |
| Back | Return to the parent category, then to the Root Menu |

**Button LED hints:** Back and Main are lit.

---

### Jam Mode

Layer a groove with fills on the fly. Left 4 columns of pads are grooves; right 4 columns are fills (filtered by the current groove's part type).

#### While stopped

| Control | Action |
|---------|--------|
| Tap a groove pad | Start that groove looping |
| Tap an intro fill pad | Start playback with that intro fill, then return to the first intro groove |
| Hold a pad (past the delay) | Preview the clip as a one-shot until you release it (no overlay; the clip name shows in "Now:") |
| Jog wheel | Adjust the BPM in realtime |
| Play | Stop (if a preview is playing) |
| Back | Return to the Jam Folder picker |

#### While playing

| Control | Action |
|---------|--------|
| Tap a groove pad | Queue that groove to play after the current groove finishes |
| Tap the same groove pad again | Escalate to a bar-end restart of that groove |
| Tap a fill pad | Queue that fill to play at the next bar-end, then return to the groove |
| Press the return groove's pad during a fill | Restart that groove from its beginning when the fill ends (pad turns red) |
| Up / Down | Scroll the groove pads up / down |
| Left / Right | Scroll the fill pads up / down |
| Jog wheel | Change the BPM in realtime |
| Play | Stop playback |
| Back | Stop and return to the Jam Folder picker |

While a fill plays, the groove it will return to is shown in green; once the return is imminent (the fill's last bar) it turns **blue** if the groove will resume from where it left off, or **red** if it will resume from the very beginning — either because you pressed its pad to force a restart, or because the fill(s) carried past the end of the groove.

Step LEDs show the current clip's bar layout, flashing white-to-black on the current bar as it plays. Fills overlay the groove's bars where they fall.

**Button LED hints:** Back, Up, Down, Left and Right are lit; Play is red while playing.

---

## Options

Choose where the Arranger sends MIDI, on which channel, and other playback options.
Drums, Instrument 1, and Instrument 2 each have their own output routing —
opened as a sub-screen from here.

| Control | Action |
|---------|--------|
| Jog wheel (browse mode) | Move between Drums, Inst 1, Inst 2, Chains, Click Channel, Swap Guard, DSP Debug |
| Jog click (on Drums / Inst 1 / Inst 2 / Chains) | Open that sub-screen |
| Jog wheel (edit mode, other fields) | Adjust the value |
| Jog click (other fields) | Toggle edit / browse mode |
| Back (edit mode) | Exit edit mode |
| Back (browse mode) | Return to Root Menu |

| Field | Meaning |
|-------|---------|
| Drums | Drum track's output + MIDI channel (opens a sub-screen — see below) |
| Inst 1 | Instrument 1's output + MIDI channel (opens a sub-screen — see below) |
| Inst 2 | Instrument 2's output + MIDI channel (opens a sub-screen — see below) |
| Chains | View/edit one of Schwung's own 4 built-in chain slots' receive channel directly (opens a sub-screen — see below) |
| Click Channel | MIDI channel (1–16) used for the count-in click. **Default** follows the Drums output channel |
| Swap Guard | Mid-clip swap guard window (0–100%). Removed at the outgoing side of a clip boundary to avoid overlaps; on the incoming side (e.g. a fill swapping back into a partially-played groove), any note that fell inside this window is replayed right at the resume point instead of being lost |
| DSP Debug | Toggles the DSP debug log (`.dsp_log`) on/off |

Settings are saved to file and restored when the module restarts.

**Button LED hints:** Back and Main are lit.

---

### Options: Drums / Inst 1 / Inst 2

Output routing for one track, opened from the Options list.

| Control | Action |
|---------|--------|
| Jog wheel (browse mode) | Move between Output, MIDI Channel |
| Jog wheel (edit mode) | Cycle the routing option / adjust the channel |
| Jog click | Toggle edit / browse mode |
| Back (edit mode) | Exit edit mode |
| Back (browse mode) | Return to Options |

| Field | Meaning |
|-------|---------|
| Output | Where this track sends MIDI: External (MIDI_OUT), Move (Move tracks), or Schwung (the synth chain) |
| MIDI Channel | MIDI channel (1–16) used by the selected output |

**Button LED hints:** Back and Main are lit.

---

### Options: Chains

View and edit one of Schwung's own 4 built-in chain slots' receive channel
directly, without leaving Arranger — the same setting the native Chain
screen and Schwung Manager's web UI edit. Point an instrument track's Output
at Schwung on this same channel (see Options: Inst 1 / Inst 2, above) to
reach that chain. Requires a Schwung build new enough to export this; on an
older build the MIDI Channel field reads "—" and cannot be edited.

| Control | Action |
|---------|--------|
| Jog wheel (browse mode) | Move between Chain, MIDI Channel |
| Jog wheel (edit mode, Chain) | Page through chain slots 1–4 |
| Jog wheel (edit mode, MIDI Channel) | Adjust that chain's receive channel (0 = Any, 1–16 = explicit) |
| Jog click | Toggle edit / browse mode |
| Back (edit mode) | Exit edit mode |
| Back (browse mode) | Return to Options |

**Button LED hints:** Back and Main are lit.

---

## Text Entry

Used when renaming songs, setlists, sections, or creating new files.

| Control | Action |
|---------|--------|
| Pads | Tap letters / characters |
| Jog wheel | Move cursor or scroll character map |
| Jog click | Confirm the name |
| Back | Cancel |
