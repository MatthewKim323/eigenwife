# iPhone gaze rebuild execution plan

## Outcome

A usable iPhone-assisted browser gaze system, with measured held-out accuracy and task success. Hardware connectivity or passing synthetic tests is not completion.

## Work in progress

- Geometry: retain separate-eye directions and origins; compare incumbent linear mapping with projective/binocular challengers using grouped calibration-only validation.
- Measurement: explicit local recording, complete checksummed captures, reproducible numeric replay, retained reports.
- Calibration: randomized repeated targets across separate posture blocks; fresh independent target locations.
- Appearance: opt-in synchronized, bounded RGB frames with native scaled intrinsics; offline UniGaze challenger using the existing verified adapter.
- Integration: updated native build, receiver and browser console; preserve incumbent runtime until changes pass relevant checks, then deploy together.

## Gates

1. Numeric protocol backward compatibility, model selection without held-out leakage, filter/reset semantics.
2. Recording privacy/isolation, corruption detection, incomplete recordings rejected, bounded image transport/storage.
3. Actual signed SDK build and on-device install; camera permissions/capture remain user-controlled.
4. One recorded calibration and independent validation; replay candidates on identical observations.
5. Fresh session/posture validation and browser task success. Do not claim accuracy gains before these are measured.

## Baseline

Latest true independent validation: mean120.99 points, p90202.66, coverage100%. Per-target jitter9–25 points. Preserve this as the comparison baseline; improvements from different sessions are not controlled causal comparisons.

## Implementation verified

- Geometry candidates: fused linear baseline, fused projective, binocular projective; head-only diagnostic. Nested grouped development scoring, conservative challenger promotion; raw independent validation stays frozen.
- Recorder/replay: explicit local controls, bounded JPEG and numeric records, private files, complete checksum manifest, seed state, rejection coverage fidelity. Default receiver does not enable recording unless `--capture-root` is configured.
- Native RGB: default-off toggle, same-frame sensor images and numeric telemetry, scaled native intrinsics, max5Hz/1280px/300KiB, no phone disk storage. Signed build installed and launched.
- Appearance challenger: `eye.iphone_appearance extract` and `benchmark` reuse pinned UniGaze-B assets. Explicit sensor rotation and rectification assumption. Common-image comparisons; no automatic live promotion.
- Browser: randomized three-posture protocol; separate fresh validation positions; extension0.3 supports explicit iPhone vs webcam and correct one-dot iPhone recenter behavior. Built, not yet reloaded in Chrome.
- Verification so far: 65 Python tests and 60 browser tests pass. Signed SDK build and signature verification pass. Actual updated phone frames reached the receiver, including validated JPEGs and TrueDepth availability. User is beginning the first recorded experiment.

## Replay commands

```sh
cd eye
uv run --extra appearance python -m eye.iphone_replay CAPTURE --numeric
PYTHONPATH=src /tmp/eigenwife-unigaze-env/bin/python -m eye.iphone_appearance extract CAPTURE \
  --rotation 0 --assume-rectified \
  --upstream /tmp/eigenwife-unigaze \
  --weights /tmp/eigenwife-unigaze-models/unigaze_b16_joint.safetensors \
  --landmark-cache /tmp/eigenwife-unigaze-models/landmarks \
  --device mps --landmark-device mps --output /absolute/path/to/new-rays.json
uv run --extra appearance python -m eye.iphone_appearance benchmark CAPTURE \
  --rays /absolute/path/to/new-rays.json --output /absolute/path/to/new-comparison.json
```

Rotation0 matches the inspected image from the current horizontal-phone capture: the face is upright and image landmarks agree with projected ARKit eye positions. Inspect a recorded sensor image again if phone orientation changes. Keep phone position and angle fixed after calibration; moving it relative to the screen requires recalibration. The assumed-rectified flag is an explicit experiment limitation, not a camera calibration claim. No printed board is required to use recorded native intrinsics. Do not overwrite existing result bundles.

## Recorded horizontal-phone experiment (2026-09-26)

Capture: `~/.eye/iphone-captures/iphone-20260926-163714-e95726b96bbf` (private local data, not repository contents). Complete manifest: 17,346 records, 1,099 images, 229,694,976 bytes. Initial partial calibration/recenter cannot replay; the subsequent complete 27-target calibration and independent nine-target check do replay.

The numeric replay reproduces the live result exactly: calibration grouped CV 255.65 screen points, independent mean 923.71 points and p90 1240.33, coverage 98.26%. This run is unusable. Camera orientation stayed essentially fixed; validation head pitch fell outside the calibration support. Post-hoc diagnostic ablations trained only on calibration reduce error to approximately 495 points for gaze direction alone, still unusable. These ablations are exploratory; this validation set is now development evidence, not a fresh test for future choices.

The console now starts recording before calibration when recording is available, avoiding the earlier partial recording. Inline JavaScript syntax and 27 client/protocol tests passed after this UI change. Do not refresh during a running calibration.

### Actual UniGaze comparison

Pinned UniGaze-B processed 1,099 recorded images; 1,058 yielded valid appearance rays. Training used 172 common image samples; independent validation used 45 samples across nine targets (45/46 image frames accepted, 19.57% of all numeric packets because images are sent at 5 Hz).

| Mapping trained and tested on the same image subset | Mean error (screen points) | P90 (screen points) |
| --- | ---: | ---: |
| ARKit geometry | 1040.90 | 1443.21 |
| UniGaze appearance only | 73.42 | 155.09 |
| Geometry + appearance | 553.11 | 706.30 |

These are raw mappings before the new live posture guard; geometry support covers 40% of these validation frames. No validation labels trained the models. Inference median137.89ms, p95329.83ms excludes capture/network/browser and model loading. This single-session result motivates an appearance-only live challenger, not a general accuracy claim or automatic promotion. The validation set is now development evidence; use new targets/session to evaluate subsequent changes. Assumptions: native scaled intrinsics, images treated as rectified, generic-face-model origin.

Private outputs: `~/.eye/iphone-captures/iphone-20260926-163714-rays.json` and `iphone-20260926-163714-comparison.json`. All 68 Python receiver/model/capture/appearance tests and 60 browser tests passed after posture guarding and explicit raw-comparison coverage reporting.

### Live challenger prepared

Appearance-only profile exported to `~/.eye/iphone-captures/iphone-20260926-163714-appearance-profile.json` with private permissions. Reloaded predictions exactly reproduce the offline comparison. New `iphone_live_appearance.py` runs a bounded latest-image worker with isolated `/appearance/ws`, frozen validation, session/freshness rejection and camera-geometry checks. The default ARKit stream now has calibration-only posture support guarding.

Verification: 80 focused Python tests and 60 browser tests passed; final live-protocol diagnostic edits passed 19 targeted tests. Actual recorded JPEG inference through the live adapter plus saved profile succeeded. Receiver restarted with existing pairing token preserved; native app unchanged. Chrome is open to `http://127.0.0.1:8767/?source=appearance` in fullscreen. User must reconnect EyePhone and run the fresh ~35-second image-model check. The profile has not yet passed live validation or demonstrated browser task success. Recording is off.

### Fresh live image-model validation

User reconnected EyePhone without a native reinstall and completed nine fresh targets on the isolated challenger. Frozen appearance-only mapping: mean139.86 screen points, p90213.26, 97/99 usable image frames (97.98% coverage). Per-target jitter RMS33.46–67.98 points. All targets had positive y bias (+41.87 to +172.80 points), suggesting a substantial systematic downward offset in this new run. Do not use these validation labels to silently recenter and then quote the same check as independent evidence.

This result is worse than the73.42-point offline result and does not beat the earlier121-point ARKit session; those are different conditions. It avoids the current recording's catastrophic ARKit posture extrapolation but is not proof of generalized superiority or small-control accuracy. After warm-up, five observed live outputs took approximately99–102ms receiver-to-result; this excludes capture/network latency. The initial model load dropped/replaced queued images as intended. Browser task success remains unmeasured. Private validation artifact: `~/.eye/iphone-captures/iphone-20260926-appearance-live-validation-1.json`.

Current live receiver uses the saved appearance profile on `/appearance/ws`; default `/ws` remains the ARKit tracker. Chrome challenger page is open and the phone is connected. Recording remains off. Next useful experiments: independently measured center correction followed by new validation, smoothing measured against latency, and larger DOM target selection—not a claim that the tracker is finished.

### Appearance cursor smoothing

User found the live model useful and requested stronger smoothing. Added optional client-side GazeSmoother only on the image-model page: causal three-sample median plus adaptive exponential smoothing, steady/responsive/off controls, 90ms visual cursor transitions. Cursor and DOM hit testing share filtered coordinates; raw WebSocket messages and backend validation remain unchanged. Reset on loss, viewport/session clear, or >=500ms gap; no history reset for normal irregular 5Hz delivery. Defaults for other clients remain unchanged.

Synthetic 5Hz fixation test RMS48.76 ->20.12 points (59% reduction). A500-point sustained move confirms after one extra image interval (~200ms), residual28.72 points on confirmation and1.65 points after400ms. This is synthetic filter behavior, not a new human accuracy result. 69 browser tests passed; inline syntax and diff checks passed. Chrome refreshed and returned to fullscreen with steady mode selected and live tracking confirmed. Receiver/phone connection and saved calibration were preserved.

### Continuous cursor rendering

Replaced 90ms CSS transitions with requestAnimationFrame-driven critically damped motion (omega20), preserving velocity across sparse image updates and using transform-only positioning. DOM target changes no longer reset the visual cursor; tracking loss/staleness/backgrounding still cancel and clear it. The existing filter and raw accuracy measurement are unchanged. 72 browser tests passed, including refresh-rate independence, continuous retargeting, settling and loss reset; inline syntax and diff checks passed. Browser refresh was interrupted twice by concurrent user interaction with the smoothing dropdown; code is served from disk but the open page still needs a refresh and steady mode.
