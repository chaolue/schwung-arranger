# Arranger Module — Control Reference

This file lists every hardware control used in each screen of the Arranger module.
Controls are shown as they appear on Ableton Move.

Button LED legend:
- **White buttons** (Back, Menu, Capture, Loop, Mute, Delete, Copy, Undo, Shift, arrows): lit bright when they do something on the current screen; dim when they only work with Shift held; off when inactive.
- **Play**: white when stopped, green while playing. **Record** (Perform): red while recording, white otherwise.
- Hold **Shift** to see the alternate action LEDs brighten.

**Footer:** the bottom line of the display shows up to three of the current screen's most important buttons and what they do (e.g. `JOG SEL  CLK OPEN  BACK EXIT`). Hold **Shift** to see the Shift actions instead.

**Anywhere in the module:**

| Control | Action |
|---------|--------|
| Back (tap) | Screen-specific — see each section below |
| Back (hold ≥0.5s) | Suspend the module: it parks in the background with playback still running. Return to it from the Schwung Tools menu to pick up where you left off |
| Track 1–4 (hold ≥0.5s) | Open Schwung's editor for Chain 1–4 **alongside** the Arranger, which keeps playing — see **Schwung Chains** below |
| Menu (hold ≥0.5s) | Open Schwung's Master FX alongside the Arranger |

A quick tap of a Track button or Menu still does what that screen says it does, but it acts when you **let go** rather than when you press, so that a hold can be told apart from a tap. With Shift held they act on press, as before. While a chain is open, a Track tap switches chain instead (see **Schwung Chains**).

---

## Global / Root Menu

Screen reached when first loading the module.

| Control | Action |
|---------|--------|
| Jog wheel | Scroll between Song Builder, Setlists, Perform, Jam, Options |
| Jog click | Open the selected entry |
| Back (tap twice) | Exit the module (return to Schwung menu). The first tap shows a popup asking for a second tap within 3 seconds |

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

Build and arrange a song from Groove/Fill clips. A song has five tracks — Drum,
Chord, two Instrument tracks and the Click track — selected with the **Track**
buttons above the pads:

| Track button | Track | LED colour |
|---------------|-------|------------|
| Track 1 | Drum, or Chord — press again to switch between them | White (Drum) / Azure Blue (Chord) |
| Track 2 | Instrument 1 | Bright Yellow |
| Track 3 | Instrument 2 | Purple |
| Track 4 | Click track — press again to turn the click on/off | Bright Orange (dim while the click is off) |

The lit Track button shows which track is showing. Every track is edited the
same way: the display lists the current section's items — clips on the Drum
track; chords, instrument changes or click volumes on the others — and the jog
wheel, jog click, Shift + jog, Delete and Copy act on the selected one. This
section covers the Drum track; see **Chord Track**, **Instrument Track** and
**Click Track** below for the others. Section navigation (Left/Right), merging
and splitting sections (Mute), Song Settings/Instrument Settings (Menu), and
playback (Play, Back) work the same on every track.

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
| Mute | Merge the current section with the next one (lit when there is a next section) |
| Shift + Mute | Split the current section at the clip under the cursor — that clip and the ones after it become a new section (from the 2nd clip; Drum track) |
| Up / Down | Change the clip page |
| Left / Right | Move to the previous / next section |
| Shift + Left / Right | Move the current section backward / forward in the song order |
| Back | Save the song and return to Song Bank |
| Hold a pad | Preview the clip (release to insert a short tap) |
| Tap a pad | Insert the clip at the current cursor position |

**Merging and splitting** need the song stopped. A merge keeps the second
section's chords, instrument items and click volumes, moved after the first
section's; where the second section started fresh (no chord carried in,
instrument defaults, the default click volume) the join gets a No Chord /
defaults item / default volume, so the result sounds the same. A split starts
the new section with whatever was in effect at the split point. The new section
is named like a duplicate (Verse → Verse 2).

Playback keeps running while you browse: moving the cursor with the jog wheel, changing the palette page (Up/Down), or moving sections (Left/Right) does not stop playback. While playing, the display and step LEDs follow the section you navigate to, then resume following the playhead on the next section change.

**Button LED hints:** Back, Main, Copy, arrows, Delete, Play and Record are lit. Shift is dim; hold it to see Main, Copy, Loop, Delete, Left/Right and Play brighten for their alternate functions. Track 1 is lit white for the Drum track.

---

### Chord Track

Set the harmony for each section. Press **Track 1** on the Drum track to show
it. Chords use the song's key (set in Song Settings) and drive the Instrument
tracks. Each chord starts at a bar and beat and holds until the next one; a
section starts with no chord (nothing carries over from the section before).

The display lists the section, then its chords in order with where each starts
(`b3` = bar 3, `b3.2` = bar 3 beat 2, `b3.2&` = halfway through beat 2), then
**+ Add**.

| Control | Action |
|---------|--------|
| Jog wheel | Select the section row, a chord, or **+ Add** |
| Jog click (on a chord) | Open Chord Settings for it |
| Jog click (on + Add) | Add a chord after the last one — on the next bar, or, when no bar is left, halfway through what remains of the last chord's bar (beat 1 → 3 → 4 in 4/4) — and open it |
| Jog click (on the section row) | Rename the section |
| Shift + Jog wheel | Move the selected chord a beat (half a beat in Advanced) — past other chords, across bars, stopping at the section's ends |
| Delete | Delete the selected chord |
| Copy | Duplicate the selected chord after the section's last chord |
| Step buttons | Select that bar's first chord (the selected chord's bar is white) |
| Left / Right | Move to the previous / next section |
| Mute / Shift + Mute | Merge / split sections (see Edit Song) |
| Menu | Open Song Settings |
| Play / Back | Same as the Drum track |

**Button LED hints:** Track 1 is lit azure blue. Copy and Delete are lit when a
chord is selected.

---

### Chord Settings

Edit one chord, opened with the jog click on it in the Chord Track.

| Control | Action |
|---------|--------|
| Jog wheel (browse mode) | Move between the fields |
| Jog wheel (edit mode) | Adjust the selected field |
| Jog click | Toggle edit / browse mode; on Advanced it toggles On/Off; on Delete Chord it deletes the chord |
| Back (edit mode) | Exit edit mode |
| Back (browse mode) | Save the chord and return to the Chord Track |

| Field | Meaning |
|-------|---------|
| Root | Scale degree within the song's key (I, ii, iii, IV, V, vi, vii°), or **No Chord** — a silent bar: the chord before stops there, and empty bars after it stay silent until the next chord |
| Type | Chord quality (major, minor, 7th, etc.) |
| Bass | Optional slash-chord bass note, or **—** for none. The choices start at the song key's tonic |
| Bar | The bar the chord starts in (only bars with a free beat) |
| Beat | The beat it starts on, from the bar's free beats |
| Advanced | **On** also offers half-beat starts (the "and" of each beat); turning it off moves the chord to the nearest free whole beat |
| Delete Chord | Remove the chord |

**Play** works here (and on every Song Builder settings page — Item Settings,
Instrument Settings, Trim Clip, Song Settings) as it does in Song Builder:
Play / Shift + Play start playback after saving what the page is editing, and
stop it while playing; the page stays open.

A bar can hold several chords, each on its own beat. A chord you open but don't
change is kept exactly as it was, even one whose root is outside the key.

**Button LED hints:** Back and Main are lit.

---

### Instrument Track

Play a synth/bass part alongside the drums, following the Chord Track's harmony.
There are two independent instrument tracks — press **Track 2** for Instrument 1
and **Track 3** for Instrument 2. Each plays with its track settings (Menu) by
default; an **item** changes them from a bar and beat until the section's next
item — mute it, change its octave, follow note, voicing, inversion or note gap.
Each section starts on the track settings.

The display lists the section, then its items in order with where each starts,
then **+ Add**. Controls are the same as the Chord Track's (jog, jog click,
Shift + jog, Delete, Copy, step buttons, Mute, Left/Right), plus:

| Control | Action |
|---------|--------|
| Jog click (on an item) | Open Item Settings for it |
| Jog click (on + Add) | Add an item after the last one and open it |
| Menu | Open Instrument Settings for this track |

| Item field | Meaning |
|------------|---------|
| Bar / Beat / Advanced | Where the item starts, as for chords |
| Sound | **Play**, or **Mute** from here (a mute mid-bar cuts the note there) |
| Octave, Follow Note, Voicing, Inversion, Note Gap | **Default (x)** uses the track setting (shown); or a value of its own — see Instrument Settings |
| Delete | Remove the item |

Songs made before items existed are converted when opened: their per-bar mutes
and per-bar settings become items that play the same way.

**Button LED hints:** Track 2 (Instrument 1) is lit bright yellow; Track 3
(Instrument 2) is lit purple. A bar the instrument plays is in the track colour,
a muted bar dimmed, and the selected item's bar white.

---

### Click Track

Set how loud the click is through the song. Press **Track 4** to show it, and
again to turn the click on or off. Each section starts at the click volume set
in **Options: Click**; a **click item** changes it from a bar and beat until the
section's next item — louder in a chorus, **0%** for silence. Controls are the
same as the Chord Track's; an item's fields are Bar, Beat, Advanced, **Volume**
(0–100%) and Delete.

**Button LED hints:** Track 4 is bright orange while it shows (dim while the
click is off). Bars where an item starts are in orange.

---

### Instrument Settings

Configure how an instrument track plays. Opened with **Menu** from that
Instrument track.

| Control | Action |
|---------|--------|
| Jog wheel (browse mode) | Move between Enabled, Octave, Follow Note, Voicing, Inversion, Note Gap |
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
| Inversion | Which chord note is at the bottom (Chord voicing only): **Root**, **1st**, **2nd**, **3rd**, or **Auto** (see below) |
| Note Gap | How far before the next note-on this instrument's current note is cut short (0 to 1 beat), so notes don't run into each other |

**Auto** inversion (the default for new instruments) voice-leads by the chord's place in the song key, so chords move smoothly instead of jumping up and down the keyboard: I, ii and vii° in root position; iii and IV in 2nd inversion; V and vi in 1st inversion. Each chord is also placed so its lowest note is the one nearest the key's root. In C that gives I `C E G`, ii `D F A`, iii `B E G`, IV `C F A`, V `B D G`, vi `C E A`, vii° `B D F`. Chords whose root isn't in the key play in root position. It follows the song key, including after a key change. Songs made before Auto existed keep their saved inversion; pick Auto to switch.

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

Open with **Menu** in Song Builder. Edit song name, tempo, time signature,
key and the song lock, or restore an earlier version of the song.

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
| Restore Backup | Opens the list of saved versions of this song (the value is how many there are) |

#### Restore Backup

Select **Restore Backup** and press the jog wheel. Every save keeps the
version it replaces, and the last 10 are listed here, newest first, with
the date and time they were replaced and their section count. Select one and
confirm **Yes** to make it the song: the version you had until then —
including any change not yet saved — is kept as a backup of its own, so a
restore can be undone from the same list. Not available while the song is
locked.

| Control | Action |
|---------|--------|
| Jog wheel | Scroll backups |
| Jog click | Restore the selected backup (asks to confirm) |
| Back | Return to Song Settings |

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
| Jog wheel | Scroll the songs in the setlist (then "(add song)" and "(knobs)") |
| Shift + Jog wheel | Move the selected song up / down in the set |
| Jog click (on a song) | Open Click Settings for that song |
| Jog click (on "(add song)") | Open the Song Bank to add a song |
| Jog click (on "(knobs)") | Map the setlist's Performance knobs — see **Performance Knobs** below |
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
| Jog wheel (browse mode) | Move between Bars, Sound, Stop On End, Knobs |
| Jog wheel (edit mode) | Adjust the selected value |
| Jog click | Toggle edit / browse mode; on Sound and Stop On End it toggles them; on Knobs it opens this song's knobs |
| Back (edit mode) | Exit edit mode |
| Back (browse mode) | Save and return to Setlist Edit |

| Field | Meaning |
|-------|---------|
| Bars | Count-in click bars before this song starts (0 = no click) |
| Sound | **On**: the click track plays the count-in, on its output, channel and notes (see **Options: Click**). **Off**: a silent count-in (pad flashes only) |
| Stop On End | If Yes, playback stops when this song finishes and the next song is selected |
| Knobs | This song's own knob mappings: **Setlist** while it uses the setlist's, or how many it overrides |

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
| Track 1 / 2 / 3 | Turn Drums / Inst 1 / Inst 2 on or off (kept until you leave Perform) |
| Track 4 | Turn the click on or off (lit orange while on) |
| Record | Start or stop recording the Schwung mix to a WAV file (see below) |
| Knobs 1–8 | Change the Schwung parameter mapped to that knob — see **Performance Knobs** |
| Touch a knob | Show what it controls (chain or Master FX, component, module) and its value |
| Play | Start playback from the current / selected song or section |
| Back | Stop and return to Root Menu |

### While playing

| Control | Action |
|---------|--------|
| Pad press (current song section) | Queue a jump to that section at the end of the current section |
| Pad press again (same section) | Escalate the jump to the end of the current bar |
| Pad press (other song / click pad) | Queue a jump to that song at the next section boundary |
| Up / Down | Scroll the pad window up / down one row |
| Track 1 / 2 / 3 | Turn Drums / Inst 1 / Inst 2 on or off immediately |
| Track 4 | Turn the click on or off (lit orange while on) |
| Record | Start or stop recording the Schwung mix to a WAV file (see below) |
| Knobs 1–8 | Change the Schwung parameter mapped to that knob |
| Play | Stop playback |
| Back | Stop playback and return to Root Menu |

The pad window shows 4 rows of sections at a time. When playback reaches the third visible row, the window auto-scrolls up one row so the next row of sections becomes visible at the top. The currently playing pad/section is shown in bright green; queued jumps flash white. Step LEDs show bar progress within the current section, or the selected section's clip layout while stopped. The active bar flashes white-to-black on the beat for a prominent cue, then returns to its clip colour on the next bar.

The Track buttons are live mutes, not saved to the song. Each song starts with its own instrument settings (drums always on) when you switch to it; a mute set while stopped stays in place when you press Play.

**Recording:** Record starts recording Schwung's audio output (the same "Resample" source Schwung's own sampler uses) to `UserLibrary/Recordings/Arranger/<setlist>_<date-time>.wav`; press it again to stop and save. It runs independently of Play/Stop, so a whole set can go into one file, and stops when you leave Perform. Record is red while recording and white otherwise.

**Button LED hints:** Back, Up, Down and Play are lit; Play is white when stopped and green while playing. Track 1, 2 and 3 are lit in their track colour while that part is on, and off while it is muted.

---

### Performance Knobs

Each of Move's 8 knobs can control one parameter of a Schwung chain while you
perform — the synth, a MIDI FX or an audio FX of any chain, or an effect in
Schwung's Master FX — using the parameters (and ranges) the module itself
publishes. A chain component whose module has **user presets** (Schwung's My
Presets) also offers **My Presets**: the knob steps through them by name and
loads each one.

- **Per setlist, with song overrides.** Map the knobs in Setlist Edit >
  (knobs). A song can replace any knob with its own parameter, or turn it
  **Off**, in its Settings > Knobs; the rest follow the setlist. A song's
  screen shows the setlist's mappings in (parentheses).
- **Values are restored.** When a song is selected or starts playing, every
  knob's parameter is set back to the value saved for that song. Turning a
  knob in Perform saves the new value for the **current song** only. The
  setlist's own value is the starting point for songs that have none yet —
  set it by turning the knob on the setlist's Knobs screen.
- **Rows and the knob display say where a knob points:** C1–C8 for a chain,
  MFX for Master FX. Turning or touching a knob in Perform shows the chain or
  Master FX, the component and its module on one line, and the parameter and
  value on the next.
- **On a Knobs screen**, turning a knob sets the value restored at that
  level, and you hear it as you turn.
- **Another module in the chain?** A mapping remembers the module it was made
  for. If that chain position now holds a different module (another Move Set,
  or a swapped module), the knob shows **not loaded** and changes nothing.
- Under a chain view (hold Track 1–4) the knobs belong to Schwung's editor.
  Coming back, a mapped knob continues from wherever the editor left that
  parameter.

| Control (Knobs screen) | Action |
|------------------------|--------|
| Jog wheel / touch a knob | Select a knob row |
| Jog click | Choose what the knob controls: a chain or Master FX, then component, then parameter (or None / Use Setlist / Off) |
| Shift + Jog wheel | Move the selected knob's mapping to the next / previous knob (swapping with what is there) |
| Turn a knob | Set the value it restores, live |
| Delete | Clear the mapping (on a song: back to the setlist's) |
| Back | Return |

**Move Set check.** Schwung's chains belong to the Move Set, so a setlist
remembers the Move Set it was used with. Opening it in Perform with a different
Set loaded (or coming back to Arranger with one) shows **Use Move Set:** and
the Set it expects, with the one that is loaded. **Back** returns to the
setlist list, so you can leave the Arranger, load that Set on Move and come
back; **Continue** plays with the loaded Set and remembers it from now on.

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

Press Track 2 or Track 3 to turn on Inst 1 or Inst 2 and play chords over the groove. While either instrument is on, the two left columns become chord pads and the grooves and fills shrink to 3 columns each. See **Jam Chord Pads** below.

#### While stopped

| Control | Action |
|---------|--------|
| Tap a groove pad | Start that groove looping |
| Tap an intro fill pad | Start playback with that intro fill, then return to the first intro groove |
| Hold a pad (past the delay) | Preview the clip as a one-shot until you release it (no overlay; the clip name shows in "Now:") |
| Tap a chord pad | Queue that chord to start when playback starts (pad turns green) |
| Tap the green chord pad again | Clear the queued chord |
| Hold a chord pad | Show the chord's name and degree in the overlay (doesn't select it) |
| Jog wheel | Adjust the BPM in realtime |
| Shift + Jog wheel | Change the key of the chord pads |
| Track 1 / 2 / 3 | Turn Drums / Inst 1 / Inst 2 on or off |
| Track 4 | Turn the click on or off (lit orange while on) |
| Shift + Track 2 / 3 | Open the settings for Inst 1 / Inst 2 |
| Play | Stop (if a preview is playing) |
| Back | Return to the Jam Folder picker |

#### While playing

| Control | Action |
|---------|--------|
| Tap a groove pad | Queue that groove to play after the current groove finishes |
| Tap the same groove pad again | Escalate to a bar-end restart of that groove |
| Tap a fill pad | Queue that fill to play at the next bar-end, then return to the groove |
| Press the return groove's pad during a fill | Restart that groove from its beginning when the fill ends (pad turns red) |
| Tap a chord pad | Queue that chord for the start of the next bar (pad turns red, then white once playing) |
| Hold a chord pad | Show the chord's name and degree in the overlay (doesn't select it) |
| Up / Down | Scroll the groove pads up / down |
| Left / Right | Scroll the fill pads up / down |
| Jog wheel | Change the BPM in realtime |
| Shift + Jog wheel | Change the key of the chord pads |
| Track 1 / 2 / 3 | Turn Drums / Inst 1 / Inst 2 on or off immediately |
| Track 4 | Turn the click on or off (lit orange while on) |
| Shift + Track 2 / 3 | Open the settings for Inst 1 / Inst 2 |
| Play | Stop playback |
| Back | Stop and return to the Jam Folder picker |

While a fill plays, the groove it will return to is shown in green; once the return is imminent (the fill's last bar) it turns **blue** if the groove will resume from where it left off, or **red** if it will resume from the very beginning — either because you pressed its pad to force a restart, or because the fill(s) carried past the end of the groove.

Step LEDs show the current clip's bar layout, flashing white-to-black on the current bar as it plays. Fills overlay the groove's bars where they fall.

**Button LED hints:** Back, Up, Down, Left and Right are lit; Play is green while playing. Track 1, 2 and 3 are lit in their track colour while that part is on.

#### Jam Chord Pads

Turn on Inst 1 or Inst 2 with Track 2 or Track 3 to show the chord pads. The two left columns hold the 8 chords of the current key, starting at the bottom-left pad and going up each column: I, ii, iii, IV (column 1), then V, vi, vii° and the root chord an octave up (column 2). Shift + Jog wheel changes the key. Changing the key moves the current chord into the new key once you release Shift, taking effect at the start of the next bar (or when you press Play, if stopped); its pad shows red until then.

Both instruments play the same chosen chord.

- **While playing:** a tapped chord pad turns red and takes effect at the start of the next bar, then turns white. If a groove or fill change is queued for the same bar, the chord changes with it.
- **While stopped:** the chord that was playing stays lit green and resumes when you press Play. Tap another pad to choose a different starting chord, or tap the green pad again to clear it.

The chord keeps playing until you pick another one, turn the instrument off, or stop playback. Leaving Jam clears the chord.

With chord pads showing, an extra line at the bottom of the display shows the key and the current chord, plus the queued chord while one is waiting (e.g. `Key: C  Chord: C>G`). The BPM and time signature stay on the line above.

#### Jam Instrument Settings

Hold Shift and press Track 2 or Track 3 to open that instrument's settings. Changes take effect immediately while playing and are not saved.

| Control | Action |
|---------|--------|
| Jog wheel (browse mode) | Move between Octave, Follow Note, Voicing, Inversion, Note Gap |
| Jog wheel (edit mode) | Change the selected setting |
| Jog click | Toggle edit / browse mode |
| Back (edit mode) | Return to browse mode |
| Back (browse mode) | Return to Jam Mode |

| Setting | Effect |
|---------|--------|
| Octave | Octave the chord is played in |
| Follow Note | The drum note that triggers each chord hit. A hit just before the barline plays the next bar's chord. **Off** plays the chord once at the start of every bar |
| Voicing | **Bass** plays the chord's root note; **Chord** plays the full chord |
| Inversion | Which chord note is at the bottom (Chord voicing only). **Auto**, the default, voice-leads by the chord's place in the key, the same as Song Builder's Auto |
| Note Gap | How early each note is cut before the next one |

Inst 1 starts on Follow Note = kick with Bass voicing; Inst 2 starts on Follow Note = Off with Chord voicing. Both use the output and MIDI channel set in **Options**.

---

## Options

Choose where the Arranger sends MIDI, on which channel, and other playback options.
Drums, Instrument 1, Instrument 2 and the Click each have their own output
routing — opened as a sub-screen from here.

| Control | Action |
|---------|--------|
| Jog wheel (browse mode) | Move between Drums, Inst 1, Inst 2, Click, Chains, Swap Guard, Schwung Clock, DSP Debug |
| Jog click (on Drums / Inst 1 / Inst 2 / Click / Chains) | Open that sub-screen |
| Jog wheel (edit mode, other fields) | Adjust the value |
| Jog click (other fields) | Toggle edit / browse mode |
| Back (edit mode) | Exit edit mode |
| Back (browse mode) | Return to Root Menu |

| Field | Meaning |
|-------|---------|
| Drums | Drum track's output + MIDI channel (opens a sub-screen — see below) |
| Inst 1 | Instrument 1's output + MIDI channel (opens a sub-screen — see below) |
| Inst 2 | Instrument 2's output + MIDI channel (opens a sub-screen — see below) |
| Click | The click track's output, MIDI channel and notes (opens a sub-screen — see below) |
| Chains | Schwung's chains (4, or 8 with the aux slots): each one's MIDI channel, and a way into its editor (opens a sub-screen — see below) |
| Swap Guard | Mid-clip swap guard window (0–100%). Removed at the outgoing side of a clip boundary to avoid overlaps; on the incoming side (e.g. a fill swapping back into a partially-played groove), any note that fell inside this window is replayed right at the resume point instead of being lost |
| Schwung Clock | **On** (default): while the Arranger plays, it sends MIDI clock to Schwung at the song's tempo, so clock-synced Schwung modules and effects (synced LFOs, tempo delays, arpeggiators) follow the song and start on its first beat. Move's own clock takes over whenever Move's sequencer is playing. Move's own tempo is not changed |
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

### Options: Click

The click track: a metronome that plays a note on every beat while the
Arranger plays — the accent note on beat 1 of each bar, the normal note on the
others (the time signature's beat, so eighths in 6/8). Turn it on or off with
**Track 4** in Perform and Jam, and with a second press of Track 4 in Song
Builder (where the first shows the Click track). It also plays each Perform song's
count-in, when that song's **Sound** is on (see **Setlist Song Settings**), and
it stays quiet during a count-in so the two don't double up.

| Control | Action |
|---------|--------|
| Jog wheel (browse mode) | Move between Output, MIDI Channel, Accent Note, Normal Note, Volume |
| Jog wheel (edit mode) | Change the selected value |
| Jog click | Toggle edit / browse mode |
| Back (edit mode) | Exit edit mode |
| Back (browse mode) | Return to Options |

| Field | Meaning |
|-------|---------|
| Output | Where the click goes: External (MIDI_OUT), Move (Move tracks), or Schwung (the synth chain). Default **Schwung** |
| MIDI Channel | MIDI channel (1–16) for the click. Default **10** |
| Accent Note | Note for beat 1 of each bar. Default **76** (GM Hi Wood Block) |
| Normal Note | Note for the other beats. Default **77** (GM Low Wood Block) |
| Volume | How loud the click is (0–100%, scaling its velocity), where a song's Click track doesn't say otherwise; every song section starts here. Always used for count-ins. Default **100%** |

**Button LED hints:** Back and Main are lit.

---

### Options: Chains

One of Schwung's chains (4, or 8 on a Schwung with the aux slots), as the
Arranger sees it. A track whose Output is
**Schwung** plays every chain listening on its MIDI channel, so this is where
you match the two up without leaving the module. The channel is the chain's own
setting — the same one as Schwung's Slot Settings and Schwung Manager — so a
change here shows up there too, and is saved with the set.

| Control | Action |
|---------|--------|
| Jog wheel (browse mode) | Move between Chain, MIDI Channel, Edit Chain |
| Jog wheel (edit mode, Chain) | Show another chain |
| Jog wheel (edit mode, MIDI Channel) | Change that chain's MIDI channel (All, 1–16) |
| Jog click (on Edit Chain) | Open that chain's editor alongside the Arranger — the same as holding its Track button |
| Jog click (other fields) | Toggle edit / browse mode |
| Back (edit mode) | Exit edit mode |
| Back (browse mode) | Return to Options |

| Field | Meaning |
|-------|---------|
| Chain | Which chain is shown (the same numbers as Schwung's own) |
| MIDI Channel | The channel the chain listens on. **All** listens on every channel |
| Edit Chain | The synth loaded in the chain, or **Empty** |

A **—** means Schwung did not answer; jog click on MIDI Channel to ask again.

**Button LED hints:** Back and Main are lit.

---

## Schwung Chains

Hold **Track 1–4** for half a second to open Schwung's own editor for Chain
1–4, or hold **Menu** for Schwung's Master FX. The Arranger does not stop or
suspend: the song keeps playing while the screen shows the editor, so you can
shape a synth while it plays the part.

| What stays with the Arranger | What the editor gets |
|------------------------------|----------------------|
| Pads, step buttons, Play, Record, Loop | The screen |
| Track buttons (hold: open / close a chain; tap: switch chain) | Jog wheel and jog click |
| Shift, Menu, arrows, Copy/Delete/Undo | The 8 knobs and their touch |
| Playback | Back |

| Control (while a chain is open) | Action |
|---------------------------------|--------|
| Jog / knobs / jog click | Navigate and edit in Schwung's editor |
| Back | Step back inside the editor; from its top level, return to the Arranger. From Master FX's top level, return to the Arranger |
| Menu (tap) | Return to the Arranger |
| Track 1–4 (tap) | Switch to that Track's chain; tap it again for its second chain (Track 1: Chain 1 ↔ 5 … Track 4: Chain 4 ↔ 8). Only on a Schwung with 8 chain slots |
| Track 1–4 (hold) | Switch to that chain; hold the open chain's Track (either of its pair) again to return to the Arranger |
| Menu (hold) | Switch to Master FX; hold again to return to the Arranger |

Shift + Track and Shift + Menu do nothing while a chain is open, so they cannot
open an Arranger menu out of sight.

Needs a Schwung with co-run (1.6.2 or newer for the knob grid inside the
editor). On an older Schwung the Arranger shows a notice instead.

---

## Text Entry

Used when renaming songs, setlists, sections, or creating new files.

| Control | Action |
|---------|--------|
| Pads | Tap letters / characters |
| Jog wheel | Move cursor or scroll character map |
| Jog click | Confirm the name |
| Back | Cancel |
