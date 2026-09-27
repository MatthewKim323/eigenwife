# Webcam eye cursor: what the research says, and what we built

> Historical design notes. See [the September 26 research update](../docs/GAZE-RESEARCH-2026-09-26.md) for fresh-session evidence, benchmark caveats, and the current recommendation. Several implementation details below have since changed.

Research done 2026-09-21 across four parallel passes (gaze estimation, blink/click UX,
macOS + MediaPipe platform, prior art). Everything below was checked against current
sources, and the platform numbers were measured on this machine (M2 MacBook Air,
macOS 26.5, FaceTime HD camera at 1280x720). Where a claim is unverified it says so.

## 1. Three different problems get called "eye tracking"

1. **Eye/iris landmarks**: where are the pupils in the image. Solved.
2. **Gaze direction**: which way the eyes point, in degrees. Mostly solved.
3. **Screen gaze coordinates**: which pixel you're looking at. This is the hard one,
   and it's what a cursor needs.

Going from 2 to 3 needs per-user calibration, because it depends on your face, your
seating distance, and where the camera sits relative to the screen.

## 2. How accurate can this actually be

At 55 cm from a 13.6" screen, 1 degree of visual angle is about 49 points.

| System | Accuracy | ≈ points |
|---|---|---|
| Tobii Pro hardware (spec) | 0.45° | 22 |
| Labvanced webcam, strict head box | 1.4° | 68 |
| GazeRecorder / Beam (vendor claims) | 1.4-1.5° | 69-73 |
| Landmark regression, 9-point, still head | 3.8-4.5° | 185-220 |
| **Same, once the head moves** | **7-31°** | **340-1500** |
| WebGazer.js | ~4° | ~195 |

Two consequences drove the whole design:

- **Head movement is the failure mode, not eye tracking.** EyeTrax's author measured
  raw-landmark ridge regression at 3.78° with a still head and **31.07°** when the head
  moved ([arXiv 2603.12388](https://arxiv.org/abs/2603.12388)). The fix is calibration
  data that includes head motion. Labvanced calibrates across 7 head poses and gets 1.4°.
- **Gaze alone cannot click Mac UI.** Default macOS controls are 28 pt; even with a
  Tobii, one study needed ~5.9 x 6.2 cm targets for 90% hits (Feit et al., CHI 2017).
  Something has to close the gap: head refinement, snapping, or zoom.

## 3. Stack

**MediaPipe Face Landmarker (Tasks API), pinned to `mediapipe==1.0.0`.** 478 landmarks
including iris, 52 blendshapes, and a rigid head transform, at **6.5 ms/frame on the M2
CPU**. Measured here: 30 fps end to end, 10 ms from frame arrival to features ready,
97% face detection.

Gotchas found the hard way:

- **1.0.1 (latest on PyPI) aborts on macOS** at graph creation: `graph_service.h:139
  Check failed: service_` from `DrishtiMetalHelper`, even with the CPU delegate. Fixed
  upstream by commit 32d0e5b but unreleased
  ([#6356](https://github.com/google-ai-edge/mediapipe/issues/6356)). We pin 1.0.0.
- The legacy `mp.solutions` API (FaceMesh) was **removed in 0.10.30**. Tutorials using
  it no longer run.
- MediaPipe depends on `opencv-contrib-python`. Never install `opencv-python` too, they
  share the `cv2` namespace. We pin `opencv-contrib-python==4.13`, because **5.0's arm64
  `resize` segfaults** ([#29794](https://github.com/opencv/opencv/issues/29794)).
- The GPU delegate aborts on macOS in Python. CPU is fast enough.
- MediaPipe Tasks send usage metrics to Google (frames stay on device). Block
  `play.googleapis.com` if that matters.

**Alternatives we read and didn't build on:**

- [EyeTrax](https://github.com/ck-zhang/EyeTrax) (MIT): the closest prior work. Its
  head-aligned feature frame is worth copying and we did. Its default model is the one
  that degrades to 31° with head motion, and it can't detect winks.
- [EyeGestures](https://github.com/NativeSensors/EyeGestures): GPL-3, per-frame OLS,
  25-point calibration, no published accuracy.
- WebGazer.js: 120-dim eye patches plus ridge, self-calibrates from clicks, ~4°.
  Maintenance ended 2026-02.
- Appearance models (L2CS-Net, UniGaze, MobileGaze ONNX): 3.9-6° cross-person
  uncalibrated, so no better than calibrated landmarks with a still head, but they
  degrade far more gracefully across head poses. MobileOne-S0 runs at 1.1 ms via CoreML.
  Worth A/B testing later as extra features; several are non-commercial licensed.

## 4. Features and model

Eye-in-head measurements in a face-aligned frame (origin between the outer eye corners,
x toward one corner, y toward the forehead, scaled by eye-corner distance), so head
rotation is mostly divided out before regression:

```
per eye: iris offset u, v (in eye widths), upper lid height
head:    yaw, pitch, roll, x/z, y/z, distance
```

Model: standardize, **quadratic terms on the eye block, linear on the head block**,
ridge regression, alpha chosen by cross validation **grouped by calibration target** so
the score reflects generalizing to unseen screen positions. Head terms get the least
capacity on purpose: they're what breaks when calibration missed a pose. Each feature
has a floor on its normalization scale, so a feature that barely moved during
calibration can't explode at runtime.

## 5. Calibration protocol (~90 s)

| Phase | What | Why |
|---|---|---|
| 13 fixation points | 3x3 grid at 5% margins plus 4 inner, glide in, settle 0.5 s, sample 0.85 s | Under-covered corners measured 19° error in one study. Saccade plus settling through a webcam pipeline takes 450-750 ms. |
| 15 s moving target | Rounded rectangle near the edges at a constant **5.7°/s** | Dense coverage between grid points. Smooth pursuit breaks down much above ~6°/s, and the naive squircle parametrization spikes in speed at the edge midpoints (fixed by walking the path by arc length). |
| 4 head-motion targets | "Keep your eyes on the dot, move your head", 4.5 s each | The 31° problem. Gives the regression head-pose variation at known gaze points. |
| 5 expression steps | Both eyes shut, left wink, right wink, brows, mouth, guided by tones | Per-eye blink baselines, wink feasibility, expression thresholds. |
| 5 fresh validation points | Not used in training | Honest accuracy number. |

Pursuit lag (camera latency plus eye lag) is estimated after the fact by fitting a
fixation-only model and picking the time shift that best explains the pursuit samples.

Every calibration also saves the **raw landmarks of every frame**, so models can be
refit offline (`eye fit`) without asking you to sit through it again.

## 6. Filtering

- **Saccade-gated averaging, not a low-pass filter.** While samples stay within ~2.5° of
  the current fixation, the cursor shows the mean of the recent ones, which gets steadier
  the longer you look. Two agreeing samples outside that radius start a new fixation.
  A One Euro filter in front of this only added lag: the cursor crept toward a new target
  instead of landing on it (caught by a test). Feit et al. (CHI 2017) found
  saccade-aware averaging beat plain smoothing for gaze cursors.
- One Euro **is** used for head rotation, where the signal is clean and continuous.
- Gaze noise inflates a One Euro speed estimate, so gaze-scale beta values are ~0.001,
  not the ~0.05 typical for a mouse.

## 7. Blinks and winks

The physiology is unforgiving:

- Spontaneous blinks last 150-400 ms but are only **fully shut for ~50 ms**, which is
  2-4 frames at 30 fps. A quick *deliberate* blink is only ~18% longer. So a short blink
  cannot be a click: only a **held** closure carries intent.
- People blink 300-1200 times an hour, so a 1% false-positive rate is 3-12 phantom
  clicks an hour.
- Published long-blink thresholds: >200 ms (Królak & Strumiłło), 392-400 ms
  (Molina-Cantero, who measured 176 ms short vs 776 ms "long"), 500 ms (AceCentre
  EyeCommander's shipping default).
- **Winks are unreliable.** Only 5 of 15 subjects could wink each eye (Missimer & Betke);
  wink clicking scored 81.8% vs 91.9% for blinks, and an ETRA 2026 study measured 20.4%
  errors for winks vs 9.9% for blinks, rating winks "most tiring". Google's Project
  GameFace ships **no** blink or wink gesture at all.
- MediaPipe blendshapes read winks as partly symmetric (both eyes' scores rise), and
  looking down raises the open-eye blink score because the lid actually drops ~1.5 mm.

What we built from that:

- Click = **both eyes held shut past a threshold personalized from your own spontaneous
  blinks** during calibration (longest observed + 50 ms, clamped to 250-500 ms).
- **Tones while your eyes are shut**, because you can't see the screen: first tone means
  "open now for a left click", second (1.2 s) means "right click", longest (2.5 s)
  toggles pause. BlinkWrite used exactly this trick.
- Winks stay **off** unless calibration proves you produce a clean one, and are
  suppressed past 20° of head yaw.
- Closure is normalized per eye against a baseline that **tracks where you're looking**
  vertically, from whichever signal separated better for you (eye aspect ratio,
  blendshapes, or the average).
- The cursor **freezes at its pre-blink position** the moment the lids start moving:
  eyes roll down and inward 1-5° during a blink, so gaze after onset is garbage.
- Guards: hysteresis plus a refractory period (single-threshold triggers cause
  "Geiger counter" repeat-fire, GameFace #39), cancel on head speed >60°/s, require
  0.3 s of solid tracking before a closure counts, and raise thresholds while smiling.

## 8. Making 100-200 pt error clickable

- **MAGIC pointing** (Zhai et al. 1999): gaze warps the cursor when you look far away,
  manual input does the last bit. Measured faster than a plain mouse.
- **Head refinement is the best manual bit.** Kytö et al. (CHI 2018) took eye-only
  pointing from 2.42° to 0.49° by adding head refinement. Talon and Precision Gaze Mouse
  both work this way.
- **Snap to accessibility targets.** A bubble gaze cursor beats a raw gaze point on
  speed and workload. On macOS, `AXUIElementCopyElementAtPosition` hit-tests any point:
  measured 11 ms here for a full 16-point sweep around the cursor.
- Dwell (600 ms) had the lowest error rate of any trigger in the ETRA study and is worth
  adding as a mode later.

Our hybrid mode: gaze jumps the cursor when you look more than ~4° from the last jump
(suppressed while the head is steering), the head does the last few degrees, and clicks
snap to the nearest pressable element within 150 pt.

## 9. macOS plumbing

- Post `kCGEventMouseMoved` at `kCGHIDEventTap`. Never `CGWarpMouseCursorPosition` per
  frame: it posts no events (hover breaks) and freezes the physical mouse for 250 ms.
- Double click means setting `kCGMouseEventClickState` to 2 on the second down/up pair.
  pyautogui never sets it and sleeps 100 ms per call, so we use Quartz directly.
- Three separate permissions exist: Accessibility (posting), Input Monitoring
  (listening), Camera. We need Accessibility and Camera. Prompts attach to the terminal
  app you launch from.
- **OpenCV numbers cameras by sorting AVCaptureDevice by uniqueID**, so an attached
  iPhone can take index 0 (it does on this Mac). We enumerate with PyObjC and pick the
  built-in camera by name, since only that one is fixed relative to the screen.
- Click-through overlay: borderless `NSWindow`, clear background, `ignoresMouseEvents`,
  screen-saver level, `canJoinAllSpaces | stationary | fullScreenAuxiliary`.
- `AppHelper.stopEventLoop()` does **not** stop `NSApp.run()`; it falls through to
  `terminate_()` and kills the process mid-cleanup. Use `NSApp.stop_()` plus a posted
  dummy event (found by a smoke test: Quit would have skipped releasing a held drag).
- Apple ships Eye Tracking on iPhone and iPad only. macOS has Head Pointer plus facial
  expression clicks, through macOS 27. Its drag is a toggle, which we copied.

## 10. What we took from prior art

| Source | Idea |
|---|---|
| Talon, Precision Gaze Mouse | Gaze for coarse jumps, head for precision; pause when the physical mouse moves |
| Project GameFace | Rigid head pose instead of a single landmark, so gestures don't drag the cursor; per-gesture thresholds with live meters (its lack of hysteresis is the anti-pattern) |
| tracky-mouse | Vertical head gain higher than horizontal; settle time after mouse-down; compare the OS cursor against positions we set to detect the real mouse |
| EyeTrax | Head-aligned feature frame; grouped calibration routines |
| WebGazer | Recalibrate from clicks during normal use |
| OptiKey, Apple Head Pointer | Drag as a toggle, not a held gesture |
| BlinkWrite | Audio tiers while the eyes are shut |

## 11. Open questions

- Does fusing an appearance model's gaze angles (MobileOne-S0 via CoreML, 1.1 ms) with
  landmark features beat landmarks alone after calibration? No head-to-head evidence found.
- Do the 8 `eyeLook*` blendshapes add anything over raw iris offsets?
- Does our own click-through overlay interfere with AX hit-testing? The code detects
  that case (checks the returned element's pid) but it hasn't been observed live.
- Whether synthetic `clickState=2` is honored as a double click by every app.
- All thresholds here are starting points from literature plus one live session. The
  saved session recordings exist so they can be tuned against real data.
