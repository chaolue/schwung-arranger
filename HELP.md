# Arranger Module — Control Reference

This file lists every hardware control used in each screen of the Arranger module.
Controls are shown as they appear on Ableton Move.

Button LED legend:
- **White buttons** (Back, Menu, Capture, Loop, Mute, Delete, Copy, Undo, Shift, arrows): lit bright when they do something on the current screen; dim when they only work with Shift held; off when inactive.
- **RGB buttons** (Play, Record/Sample): green means the action will start/add something; red means Play will stop playback.
- Hold **Shift** to see the alternate action LEDs brighten.

---

## Global / Root Menu

Screen reached when first loading the module.

| Control | Action |
|---------|--------|
| Jog wheel | Scroll between Song Builder, Setlists, Perform, Jam, Options |
| Jog click | Open the selected entry |
| Back | Exit the module (return to Schwung menu) |

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

### Edit Song

Build and arrange a song from Groove/Fill clips.

| Control | Action |
|---------|--------|
| Jog wheel | Move the clip cursor up/down in the current section |
| Shift + Jog wheel | Move the clip at the cursor up/down within the section (when cursor is on a clip) |
| Jog click (on clip) | Open Trim Clip for that clip |
| Jog click (on section header) | Rename the current section |
| Shift + Jog click | Open Song Settings (song name, BPM, time signature) |
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

**Button LED hints:** Back, Main, Copy, arrows, Delete, Play and Record are lit. Shift is dim; hold it to see Main, Copy, Loop, Delete, Left/Right and Play brighten for their alternate functions.

---

### Trim Clip

Adjust clip start/end, guard window, speed, velocity, single note velocity and thinning. Enable **Advanced Trim** to also edit sub-bar (beat) positions.

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
| MIDI Channel | Per-clip MIDI out channel override: **Default** follows the Options output channel, or set 1–16 to route this clip to a specific channel |


**Button LED hints:** Back and Main are lit.

---

### Song Settings

Edit song name, tempo, and time signature.

| Control | Action |
|---------|--------|
| Jog wheel | Scroll fields / adjust value when editing |
| Jog click | Toggle edit mode; on the Name field, open text entry |
| Back | Save changes and return to Song Builder |

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

Choose which folder of clips to jam with. The folder's name (BPM / time signature) sets the playback tempo.

| Control | Action |
|---------|--------|
| Jog wheel | Scroll the folder list |
| Jog click | Enter Jam mode with the selected folder |
| Back | Return to Root Menu |

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
| Press the return groove's pad during a fill | Restart that groove from its beginning when the fill ends (pad turns blue) |
| Up / Down | Scroll the groove pads up / down |
| Left / Right | Scroll the fill pads up / down |
| Jog wheel | Change the BPM in realtime |
| Play | Stop playback |
| Back | Stop and return to the Jam Folder picker |

Step LEDs show the current clip's bar layout, flashing white-to-black on the current bar as it plays. Fills overlay the groove's bars where they fall.

**Button LED hints:** Back, Up, Down, Left and Right are lit; Play is red while playing.

---

## Options

Choose where the Arranger sends MIDI, on which channel, and other playback options.

| Control | Action |
|---------|--------|
| Jog wheel (browse mode) | Move between Output, MIDI Channel, Click Channel, Swap Guard, DSP Debug |
| Jog wheel (edit mode) | Cycle the routing option / adjust the value |
| Jog click | Toggle edit / browse mode |
| Back (edit mode) | Exit edit mode |
| Back (browse mode) | Return to Root Menu |

| Field | Meaning |
|-------|---------|
| Output | Where the Arranger sends MIDI: External (MIDI_OUT), Move (Move tracks), or Schwung (the synth chain) |
| MIDI Channel | MIDI channel (1–16) used by the selected output |
| Click Channel | MIDI channel (1–16) used for the count-in click. **Default** follows the primary output channel |
| Swap Guard | Mid-clip swap guard window (0–100%) removed at clip boundaries to avoid overlaps |
| DSP Debug | Toggles the DSP debug log (`.dsp_log`) on/off |

Settings are saved to file and restored when the module restarts.

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
