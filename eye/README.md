# eye

A webcam eye cursor for macOS. Your gaze moves the pointer, a held blink clicks.

No hardware beyond the built-in camera. Everything runs locally: frames never leave the
machine and nothing is written except your calibration.

```bash
uv run eye doctor      # permissions, cameras, displays
uv run eye debug       # camera preview: check lighting and your blink signals
uv run eye calibrate   # ~90 s, once per setup
uv run eye run         # go
```

## How it works

Webcam gaze lands within about 2-4 degrees, which is 100-200 points on a 13.6" screen:
bigger than most Mac buttons. So gaze isn't asked to do the whole job.

- **Gaze jumps the cursor** to wherever you look (a saccade lands it, not a slow glide).
- **Small head turns fine-tune it.** Rotating your head a few degrees moves the cursor
  the last stretch, which is what makes clicking real targets possible.
- **Clicks snap** to the nearest button, link or field via the macOS accessibility tree.
- **Every click teaches it.** In hybrid mode, wherever you steered before clicking
  becomes a fresh calibration sample, so it follows you as you shift in your seat.

`RESEARCH.md` has the evidence behind each of those choices.

## Gestures

You can't see the screen with your eyes shut, so **the hold tiers announce themselves
with a sound**. Hold, wait for the tone you want, then open.

| Gesture | Action |
|---|---|
| Hold both eyes shut, open after the **first tone** (~0.3 s) | left click |
| Same again within 1.5 s on the same spot | double click |
| Hold past the **second tone** (1.2 s), then open | right click |
| Hold past the **third tone** (2.5 s) | pause / resume everything |
| Raise your eyebrows (~0.5 s) | grab a drag; raise again to drop |
| Open your mouth (~0.6 s) | scroll mode: tilt your head up/down; blink to stop |
| Wink left / right | left / right click, **only if calibration found a clean wink** |
| Touch the trackpad | eye backs off for 1.5 s |

Normal blinks do nothing: a spontaneous blink is only fully shut for about 50 ms, which
is why the threshold is a *held* closure, personalized from your own blinks during
calibration.

## Modes

| Mode | What moves the cursor |
|---|---|
| `hybrid` (default) | gaze jumps + head fine-tunes |
| `gaze` | gaze only, sitting on your current fixation |
| `head` | head only, no calibration needed |

Switch from the menu bar icon or with `eye run --mode head`.

## Setup

Needs Python 3.12+, [uv](https://docs.astral.sh/uv/), and macOS.

```bash
cd eye  # in the eigenwife repo
uv sync
uv run eye doctor
```

Two permissions, both granted to **the terminal app you launch from** (not to Python):

- **Camera**: you'll get a prompt the first time.
- **Accessibility** (System Settings > Privacy & Security > Accessibility): required to
  move and click. `eye run` will prompt if it's missing.

If you run it from a different terminal later, grant them there too.

## Commands

```
eye doctor                 permissions, cameras, displays, calibration status
eye debug                  live preview: landmarks, magnified eyes, blink signals, head pose
eye calibrate              fullscreen calibration (--quick for a 45 s version)
eye run                    start the cursor (--dry-run to watch without clicking)
eye fit                    refit the gaze model from a saved session, offline
eye config                 print the effective settings
```

Useful flags: `--camera "FaceTime"`, `--display 1`, `--mode gaze|head|hybrid`,
`--debug` (draws the raw gaze estimate and fixation radius on the overlay).

## eye serve (gaze for apps)

`eye serve` tracks without touching the mouse and streams events to apps:

```bash
uv run eye serve          # http://127.0.0.1:8765/ demo page, ws://127.0.0.1:8765/ws events
```

Open the demo page, hit **quick calibrate** (5 dots, ~10 s), look around. The full
`eye calibrate` should happen beforehand; the quick one fits a small drift correction on
top of it (saved to `~/.eye/correction.json`, `--fresh` ignores it) and is only applied
if it beats no correction on held-out dots.

From a page, use the client (no deps):

```js
import { EyeClient } from "http://127.0.0.1:8765/eye-client.js";
const eye = new EyeClient();                  // watches every [data-gaze="key"] element
eye.on("fixation", ({ key, el }) => {});      // a fixation landed on an element (snaps within 2 deg)
eye.on("fixation_end", ({ key, ms }) => {});
eye.on("confirm", ({ key, el }) => {});       // held blink = click
eye.stats();   // { prompt_1: { dwellMs, visits, revisits, fixations, longestMs, firstAt, lastAt } }
await eye.calibrate();                        // the LOOK HERE dots
```

Screen to page coords assume the browser chrome is on top and zoom is 100%. Fullscreen
the page for the demo; the quick calibration absorbs whatever offset is left.

Raw protocol, for non-browser consumers (jabby): JSON messages, coordinates in macOS
screen points (`x`, `y`) and normalized display coords (`nx`, `ny`), times in epoch ms.

| out | fields |
|---|---|
| `hello` | `display {x,y,w,h,ptPerDeg}`, `calibrated`, `accuracyDeg`, `corrected` |
| `face` | `present` |
| `gaze` (~30 Hz) | `x y nx ny`, `blink` (true = frozen at blink onset), `raw`, `fix {id, ms}` |
| `fixation_start` / `fixation_end` | `id x y nx ny t`, end has `ms` |
| `gesture` | `kind`: `confirm` (held blink), `back` (longer hold), `long_close`, `brow`, `mouth`, `tier_confirm`/`tier_back` (still holding) |
| `calib_result` | `beforeDeg afterDeg looDeg applied points perPoint` |

| in | fields |
|---|---|
| `calib_begin`, then per dot `calib_target {x,y}` or `{nx,ny}` ... `calib_target_end`, then `calib_finish` | |
| `calib_reset` | drop the drift correction |

## Calibration

Once per setup (or after you move the laptop a lot). About 90 seconds:

1. 13 dots to look at.
2. A dot that circles the screen edges, slowly. Follow it with your eyes.
3. Four dots where you **keep looking at the dot while slowly moving your head**. Don't
   skip this: a model calibrated with a perfectly still head measures ~4° of error while
   still and ~31° once you move.
4. Five guided expressions: both eyes shut, each wink, brows, mouth. Tones tell you when.
5. Five fresh dots to measure accuracy honestly, then a live preview before saving.

Under about 2.5° is good. `--quick` (~45 s) drops to 9 points and skips the sweep and head motion.

Every run also saves raw landmarks to `~/.eye/sessions/`, so `eye fit` can try a
different model later without recalibrating.

## Tuning

`~/.eye/config.json` overrides any default (see `eye config` for the full list, only the
keys you change are needed):

```json
{
  "pointer": { "mode": "hybrid", "head_gain": 24.0, "warp_radius_deg": 4.0 },
  "gestures": { "right_click_s": 1.2, "pause_s": 2.5 },
  "actions": { "mouth_hold": "none" },
  "snap": true,
  "sounds": true
}
```

Actions: `left_click`, `right_click`, `double_click`, `drag`, `scroll`, `pause`, `none`.

## Troubleshooting

- **Cursor drifts off target over time**: recalibrate, or just keep clicking (hybrid
  mode learns from every click). Big changes in lighting or seating position matter most.
- **Clicks fire while you read**: your blink threshold is too low. Recalibrate (it's
  measured from your own blinks), or raise `gestures.click_s`.
- **Winks don't work**: most people can't wink cleanly enough, and calibration disables
  them when it can't see a clean one. Blinks do everything anyway.
- **Nothing moves**: check Accessibility permission, and that `eye doctor` finds your
  built-in camera.
- **Worse near the bottom of the screen**: normal with a camera above the screen, your
  lids cover the iris. Sit slightly further back.
- Turn off macOS Video Effects (Reactions) for your terminal app, it can interfere.

## Development

```bash
uv run pytest             # no camera needed
uv run eye fit --save     # refit the newest saved session and make it active
```

Layout: `camera.py` capture, `face.py` MediaPipe wrapper, `features.py` eye/head
measurements, `gaze_model.py` ridge regression, `calibration.py` script and fitting,
`profile.py` per-user signal normalization, `gestures.py` blink/wink/expression state
machine, `pointer.py` cursor control, `snap.py` accessibility targets, `app.py` runtime,
`ui/` AppKit screens.

Pinned deliberately: `mediapipe==1.0.0` (1.0.1 aborts on macOS) and
`opencv-contrib-python==4.13` (5.0's arm64 resize segfaults).
