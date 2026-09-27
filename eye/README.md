# eye

Local eye tracking for macOS, with webcam and iPhone TrueDepth-assisted modes.

The iPhone image-model challenger runs UniGaze on the Mac, with a personal calibration, independent accuracy checks, and a continuously animated browser gaze cursor. Start with the [iPhone setup guide](docs/IPHONE-APP.md) and [implementation and measured results](docs/IPHONE-REBUILD-PLAN.md). Model weights and personal profiles are not bundled.

The webcam commands below use the built-in camera. Phone frames travel over the paired local connection; optional research recording saves images only on the Mac. Nothing is uploaded to a cloud inference service.

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

`eye serve` is what Eigenwife uses. Gaze is context only (what you're looking at, for the
agent), no clicking, no blink gestures. It tracks without touching the mouse and streams:

```bash
uv run eye serve          # http://127.0.0.1:8765/ demo page, ws://127.0.0.1:8765/ws events
```

For serve, `eye calibrate --no-expressions` skips the blink/wink/brow steps (not used).
Open the demo page in fullscreen at 100% zoom, run **quick calibrate**, then **measure accuracy**. The full
`eye calibrate` should happen beforehand; the quick one fits a small drift correction on
top of it (saved to `~/.eye/correction.json`, `--fresh` ignores it) and is only applied
if it beats no correction on held-out dots.

From a page, use the client (no deps):

```js
import { EyeClient } from "http://127.0.0.1:8765/eye-client.js";
const eye = new EyeClient();                  // watches every [data-gaze="key"] element
eye.on("fixation", ({ key, el }) => {});      // a fixation landed on an element (snaps within 2 deg)
eye.on("fixation_end", ({ key, ms }) => {});
eye.stats();   // { prompt_1: { dwellMs, visits, revisits, fixations, longestMs, firstAt, lastAt } }
await eye.calibrate();                        // the LOOK HERE dots
```

Screen-to-page mapping requires document fullscreen on the calibrated display at 100% zoom.
Unknown geometry disables mapped gaze; drift calibration must not absorb browser chrome offsets.

Raw protocol, for non-browser consumers (jabby): JSON messages, coordinates in macOS
screen points (`x`, `y`) and normalized display coords (`nx`, `ny`), times in epoch ms.

| out | fields |
|---|---|
| `hello` | `display {x,y,w,h,ptPerDeg}`, `calibrated`, `accuracyDeg`, `corrected` |
| `face` | `present` |
| `gaze` (~30 Hz) | `x y nx ny`, `blink` (true = frozen at blink onset), `raw`, `fix {id, ms}` |
| `fixation_start` / `fixation_end` | `id x y nx ny t`, end has `ms` |
| `calib_result` | `beforeDeg afterDeg looDeg applied points perPoint` |

| in | fields |
|---|---|
| `calib_begin`, then per dot `calib_target {x,y}` or `{nx,ny}` ... `calib_target_end`, then `calib_finish` | |
| `calib_reset` | drop the drift correction |

## Calibration

Once per setup (or after you move the laptop a lot). About two minutes without expression gestures:

1. 13 dots to look at.
2. A dot that circles the screen edges, slowly.
3. Five head-motion targets repeated for yaw and nod/lean movements, with neutral recenter cues.
4. Optional guided expressions for cursor mode; skip with `--no-expressions` for gaze streaming.
5. Nine neutral and five moving-head validation targets, then a live preview before saving.

Under about 2.5° is good. `--quick` (~45 s) drops to 9 points and skips the sweep and head motion.

Every run also saves raw landmarks to `~/.eye/sessions/`, so `eye fit` can try a
different model later without recalibrating.

### Optional image-based research backend

MGazeNet supplies local image features alongside the landmark features. Its weights
and adapted preprocessing use **CC BY-NC-SA 4.0**; this optional path is for
noncommercial research. See `src/eye/appearance.py` for pinned provenance.

From the `eye` directory:

```bash
uv run --extra appearance eye prepare-appearance
uv run --extra appearance eye calibrate --backend appearance --no-expressions --serve-after
```

Stop any running tracker first so it releases the camera. Press Space at the intro
to begin. Validation retries targets with insufficient usable samples up to twice;
all attempts remain in reported aggregate errors and coverage. The model stays
frozen during validation. Results include a separately fitted landmark baseline
measured on the same validation session. Better accuracy must be measured, not assumed.

Press Space on results to save explicitly, or Escape to discard. `--serve-after`
starts the gaze server with the saved model, or the previous model after cancellation.
Existing calibration is backed up before replacement. For later starts use
`uv run --extra appearance eye serve`; model metadata enforces matching features
and verified weights without silently falling back to landmarks.

Replay recordings include the image feature vectors, not camera images. Old
landmark-only recordings cannot train the image-based backend. Browser validation
also retries low-coverage targets and reports live rejection reasons; it does not
alter the fitted mapping to improve its own score.

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

## Reliable attention tracking

Use `eye serve` for Eigenwife; `eye run` is the separate cursor-control tool.

1. Run `uv run eye calibrate --no-expressions` for the full, roughly two-minute calibration. Follow the yaw, nod/lean, and return-to-neutral cues. The quick script does not cover head movement.
2. Stop/restart `eye serve` after saving a new calibration; it loads the model at startup. Existing recordings remain available for replay.
3. Open the tracker or shell in a normal browser on the calibrated display, at 100% zoom, and use **enter fullscreen**. Embedded browser panels and unknown viewport geometry deliberately disable mapped gaze.
4. Run **check drift and recalibrate**, then **measure accuracy**. The latter uses a fresh nine-target sequence and does not fit or change the mapping. It reports valid-frame mean, p90, worst error and coverage. At least 80% of captured frames at every target must be usable; missing targets fail validation.

The native calibration also reports individual-frame errors and target coverage. A validation with insufficient coverage does not auto-save. `Space` still lets you explicitly save it for diagnosis, but that does not make the accuracy reliable.

Eye tracking never silently falls back to the mouse. `?gaze=mouse` explicitly enables simulation and displays that state. Lost faces, blinks, out-of-range head poses, sample gaps, and ambiguous targets clear attention. The cursor is smoothed separately from DOM attention; small shifts can now change the target without waiting for a backend saccade event.

`accuracyDeg` is the saved base estimate, or the mean of the last independent live validation. After a correction it is unknown until validated. `uncertaintyDeg` is separately labelled as either a conservative estimate or a live-validation p90; it is used to abstain when another visible target lies within the estimated error radius. Neither value guarantees future accuracy. Corrections are bound to the model/profile/display fingerprint and ignored after a new calibration.

Replay a recording without touching the active calibration:

```bash
uv run python -m eye.audit ~/.eye/sessions/calib-YYYYMMDD-HHMMSS.npz > /tmp/eye-audit.json
```

This reports whole-head-target holdouts, untrimmed validation errors, neutral/moving-head metrics, and coverage. Calibration profile fitting excludes validation; regression normalization is learned within each cross-validation fold.

From `eye/`, `uv run --extra appearance pytest -q` and `node --test tests/*.test.mjs` run Python and browser-client regressions. Live human accuracy still needs the independent check above.

## DOM selection and browser integration

The demo now includes a DOM target mode: look at a distinct button/link/control,
wait for a green outline, then press **Alt+Enter** to select and focus it. Selection
emits a descriptor (`selector`, `tag`, `role`, `label`, `uncertaintyPx`, `source`)
and never invokes `.click()`. Standard keyboard activation remains explicit.

```js
import { GazeDOMTargets } from './dom-targets.js';
const targets = new GazeDOMTargets(eye);
targets.on('select', ({ element, selector, role, label }) => {
  console.log({ selector, role, label });
});
// On teardown: targets.destroy(); eye.close();
```

Targets clear on blink/loss, stale data, scrolling, resize, or DOM changes.
Nearby competing controls cause automatic abstention. Press Alt+Space to explicitly
open a numbered list of nearby controls, then 1–9 to select/focus one or Escape to
dismiss. Mark app-owned overlay/panel elements
with `data-eye-ui` to exclude them from targeting and mutation invalidation.

For regular websites, see [Chrome extension setup](browser-extension/README.md).
The extension is built locally, enabled per tab, and requires an exact extension
ID on `eye serve --extension-id ID`. Fullscreen geometry remains required.

The upgraded fitting pipeline learns gaze-specific open-eye baselines from
observed iris position and head pitch, separately from cursor expression gestures.
Robust ridge fitting is selected by grouped training cross-validation only when
it improves that score materially. Validation data never fits those weights.
Saved-session replay is development evidence; repeat a fresh live validation
before claiming an accuracy improvement for a new setup.

### Geometry-aware research challenger

The live MGazeNet model remains the baseline. The optional UniGaze-B pipeline
uses measured camera intrinsics, exact checkpoint normalization and an isolated
personal screen mapping. It is not activated automatically and has not yet
passed a fresh-session accuracy comparison on this laptop.

Start with [the rebuild guide](docs/GAZE-FRONTIER-REBUILD.md),
[camera calibration](docs/GAZE-INTRINSICS.md), and
[UniGaze setup/replay](docs/GAZE-UNIGAZE.md).

From this `eye` directory, explicitly record identical camera frames while
saving a separate candidate:

```sh
uv run --extra appearance eye calibrate --backend appearance --no-expressions \
  --candidate-only --record-images "$HOME/.eye/research-captures"
uv run --extra appearance python -m eye.capture_replay /path/to/completed-capture
```

Images stay local, are lossless, and are retained on cancel; default calibration
never records them. Capture has a bounded queue and 2 GB limit per attempt; every
drop is recorded, and the limit can be raised with `--capture-max-mb`. The
introduction waits for Space before recording starts. A separate run after
reseating is required to evaluate the first frozen candidate independently.

After producing a UniGaze ray JSONL using the setup guide:

```sh
uv run --extra appearance python -m eye.challenger \
  --capture /path/to/completed-capture --rays /path/to/rays.jsonl \
  --output /path/to/new-experiment --baseline "$HOME/.eye/calibration.npz"
```

This writes a new `candidate.npz`, aligned `session.npz`, and `report.json`.
Reports compare the frozen incumbent and challenger on identical frames with
separate coverage figures. Existing outputs are protected; validation features are hidden from fitting.
The resulting ray backend is offline only and intentionally cannot be loaded
by the live MGazeNet runtime.
