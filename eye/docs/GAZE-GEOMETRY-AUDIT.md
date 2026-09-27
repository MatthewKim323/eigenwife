# Webcam Gaze: Geometry and Measurement Audit

Date: 2026-09-26. Scope: source inspection of `eye/src/eye/{camera,face,features,appearance,gaze_model,calibration,gaze_quality,stream,screen}.py`, with primary-source research. This is an architectural audit, not a new accuracy measurement. No active calibration was changed.

## Conclusion

The present system is a personal screen-coordinate regressor over image embeddings and approximate facial geometry. It is not a calibrated 3D eye-to-screen measurement system. That is a legitimate baseline, and replacing it with geometric equations alone will not guarantee improvement: inaccurate eye origin, camera calibration, visual-axis offset, or model preprocessing can make the geometric pipeline worse.

Keep the current working baseline while building a reproducible challenger pipeline. The decisive improvement is to measure all stages and compare models on genuinely independent sessions with matched coverage. More capacity without better capture, geometry, and evaluation could merely fit the calibration better.

## Observed mechanisms

| Component | What the code does | Consequence and concrete repair |
|---|---|---|
| Camera | Requests 1280×720 at 30 fps; records actual frame size but not calibrated intrinsics, distortion, exposure, or sensor timestamps. | A camera/resolution/crop change can change the relationship between image and gaze. Persist actual capture configuration and camera ID; invalidate incompatible calibrations. Record exposure timestamps if the native API provides them. |
| Timing | `Frame.t` is `time.monotonic()` after `cap.read()`; tracker latency measures arrival to feature extraction. | Reported latency excludes exposure, buffering, and display presentation. Keep capture, arrival, inference, emission, receipt, and paint timestamps separate. Use a camera/display loopback experiment to estimate end-to-end delay; do not describe compute time as cursor latency. |
| Facial frame | `face_frame()` rotates/scales MediaPipe x/y/relative-z landmarks around eye corners and forehead. | This reduces pose variation but is not a calibrated perspective reconstruction. Do not treat its iris coordinates as a measured eyeball rotation. Test it as a feature family against appearance-only and geometry-aware alternatives. |
| Head matrix | `head_pose()` labels translation centimeters; no physical camera parameters are supplied to Face Landmarker. | Those values have canonical-model/virtual-camera assumptions. They can be useful relative features, but do not establish actual viewing distance or eye origin. Use calibrated intrinsics plus an explicit face/eye-origin model for the geometric branch. |
| Appearance | MGazeNet receives upstream-style axis-aligned crops, one eye flip, and rectangle metadata. | Preserve this pretrained input contract. Applying a new perspective warp to this same model without retraining may introduce domain shift. A normalized-model challenger needs its own adapter and fingerprint. |
| Personalization | Screen-normalized x/y regression from 16 landmark features plus 258 appearance outputs. | High-dimensional personal fitting can learn session-specific camera/head correlations. Compare low-capacity residual correction, embedding regression, and pretrained angular output with the same training sessions. |
| Calibration | Repeated head motions cover several targets, but motions are instructions rather than verified multidimensional coverage. | A user may sweep yaw without sufficient depth/pitch variation. Quantify achieved joint pose/target coverage, and request only the missing conditions. Do not equate time spent calibrating with information gained. |
| Cross-validation | Normalization is correctly fit within folds. Repeated HEAD targets share a group, but a FIXATE target at the same location has a different group; pursuit uses adjacent one-second groups. | The CV objective is not strictly unseen spatial target or independent time block. Make the intended split explicit; use target groups across fixation/head conditions and buffered temporal blocks for pursuit, plus a separate session holdout. |
| Quality | A frozen geometry-aware open-eye baseline and temporal recovery reject closures. | Good separation from predicted gaze, but still a heuristic without blink annotations. Evaluate false rejection of downward gaze and false acceptance of closures independently. Lower gaze error from rejecting hard frames is not a free gain. |
| Pose gate | Independent min/max bounds plus margins over six head terms. | A box accepts combinations never observed together. Add a regularized joint novelty/support score; validate its risk-versus-coverage curve before making it a rejection rule. Do not call this score a calibrated probability. |
| Uncertainty | Uses historical/global error statistics, including p90 where available. | Global p90 is not per-frame confidence, and a mean-only legacy statistic cannot promise p90 coverage. Separate empirical evaluation radius from current input novelty and tracking state. Learn/calibrate local error only using held-out data. |
| Degrees | `Display.degrees()` converts screen displacement using an assumed 55 cm distance by default. | Report screen-point error as primary until distance is measured. Approximate degrees must carry that assumption. A proper angular metric compares rays from the measured eye origin to predicted and target screen points. |

MediaPipe documents relative landmark depth under weak perspective and a virtual camera/canonical model for metric geometry; matching physical camera parameters matters. These statements support caution about our interpretation, not a claim that its landmarks are unusable. [MediaPipe source documentation](https://github.com/google-ai-edge/mediapipe/blob/master/docs/solutions/face_mesh.md)

## A geometry-aware challenger

Define each coordinate frame and transform explicitly. One possible convention uses an OpenCV camera frame with x right, y down, z forward; screen coordinates use physical millimeters and a separate rigid transform into that camera frame. Never mix it implicitly with MediaPipe's negative-z convention.

For an estimated eye origin `o`, normalized gaze direction `d`, a point `p0` on the screen plane, and plane normal `n`, intersection is:

```text
t = dot(n, p0 - o) / dot(n, d)
p = o + t * d
```

Reject nearly parallel rays, negative intersections under the chosen convention, invalid geometry, and unsuitable model confidence. Project `p - p0` onto the screen's two physical basis vectors, then convert once to display points and once more to browser viewport coordinates. Calibrate the individual's visual-axis offset or a small residual map; avoid letting an unrestricted personal model compensate arbitrarily for incorrect camera geometry.

Intrinsic calibration estimates focal parameters, optical center, and distortion from multiple known-pattern views. Pose estimation then requires corresponding image and model points with those intrinsics. A guessed focal length is an experimental fallback, not a calibrated camera. [OpenCV calibration and pose documentation](https://docs.opencv.org/4.13.0/d9/d0c/group__calib3d.html)

The referenced normalization implementation computes image warping using the camera intrinsics, eye location, head orientation, and a virtual camera. Crucially, the updated method rotates the gaze vector without applying the image's depth scaling to it. Reversing the wrong transform changes gaze angles. Use a checkpoint's exact training convention; normalized crop size, distance, focal length, and eye ordering are part of the model contract. The reference implementation is CC BY-NC-SA 4.0; independent implementation of equations and use of separately licensed models require their own provenance review. [Authors' normalization implementation](https://github.com/xucong-zhang/data-preprocessing-gaze/blob/master/normalize_data.py)

ETH-XGaze uses calibrated capture and head-pose-dependent normalization across extensive pose variation. It supports evaluating normalization and pose robustness, but its controlled multi-camera data and benchmark errors do not establish accuracy for this user's laptop. [Authors' paper](https://files.ait.ethz.ch/projects/xgaze/xucongzhang2020eccv.pdf)

## What existing recordings can establish

Existing `.npz` sessions retain landmarks, facial matrices, blendshapes, timestamps, calibration script/clock, and versioned appearance features where present. They do not retain original camera images, calibrated intrinsics, camera exposure timestamps, or independently observed fixation truth.

**Possible now:** compare landmark/appearance/hybrid personal maps, regularization, robust losses, alternative head features, joint support diagnostics, frozen quality thresholds, target grouping, temporal filtering, pursuit-label lag, and conditional error by pose/target. Replay can report accepted-frame error, rejected-frame count, and response lag relative to the scripted target. It cannot certify that the user actually fixated each target.

**Requires new capture:** another image backbone, different eye crops, image augmentation, perspective normalization, crop sharpness/exposure diagnostics, and any investigation requiring visual verification of a blink. Collect timestamped local images or lossless task-specific crops with an explicit user-controlled recording mode, finite retention, and a manifest. Full frames are needed if future recropping/geometry changes matter; crops alone discard that option. Preserve model inputs plus geometry metadata to reproduce current inference exactly.

**Requires independent ground truth or stronger protocol:** subdegree claims, true gaze latency, blink detection sensitivity/specificity, and real eye-origin accuracy. A dot is an intended fixation target, not proof of the eye's actual direction. Held-out target tasks are useful application tests; research-grade claims need a reference tracker or a defensible validated measurement setup.

Image-space brightness/noise/compression/crop-jitter augmentations belong in a new raw-capture experiment. Augment only training data and keep all variants of each source frame in one fold. Camera rotations and flips require consistently transformed labels and eye conventions. Noise in stored embeddings is not equivalent to realistic image augmentation.

## Prioritized implementation and acceptance

1. **Instrument and freeze a baseline.** Persist camera configuration, backend fingerprint, stage timestamps, session IDs, and complete rejection reasons. Keep the existing model active until a challenger passes a fresh session. Offline improvements on already-inspected recordings are exploratory.
2. **Make evaluation independent and coverage-aware.** Split train, model selection, uncertainty calibration, and final evaluation by sessions/blocks. Report frame mean/median/p90/p95, valid-time fraction, longest dropout, fixation acquisition time, and per-target/pose results. Compare methods on both common accepted frames and their own coverage. Bootstrap sessions or target episodes rather than pretending neighboring video frames are independent observations.
3. **Ship uncertainty that supports the browser task.** Return raw estimate, filtered estimate, freshness, empirically evaluated radius, input-support status, and explicit unavailable states. Use DOM geometry only downstream. Highlight candidates; confirm before activation; abstain when several controls are plausible. DOM snapping success is a separate application metric and must not inflate raw gaze accuracy.
4. **Build model challengers on captured data.** Maintain exact adapter preprocessing and model hashes. Benchmark old MGazeNet, a suitably licensed newer model, and the calibrated geometric branch on identical held-out captures. Measure latency on the actual laptop. Promote based on a predeclared accuracy/coverage/latency tradeoff, not checkpoint size or a benchmark leaderboard alone.
5. **Personalize efficiently.** Use active target/pose sampling guided by missing support. Evaluate session-to-session drift and a small explicit recalibration task. Mouse clicks may provide weak supervision only when the task makes fixation at click time plausible; never train on the model's own chosen DOM target as if it were ground truth.

Frontier-level is an experimental objective, not a verified property of this implementation. Ordinary webcam evidence, resolution, lighting, pose, and personal calibration constrain what can be claimed. The useful browser objective is reliable intentional target selection with known latency and abstention, alongside independently measured gaze accuracy.

## Implemented CV grouping repair

The grouping issue described in the inspection table above was repaired after this audit. New fits record `cv_grouping = spatial-target-and-pursuit-step-v2`. All neutral fixation and head-motion observations of the same static `(x, y)` target share one training fold, regardless of motion condition or repetition. Each continuous pursuit step stays in one temporal block. Validation steps keep their separate episode identities and remain excluded from model fitting.

This changes model-selection inputs, not the recorded outcomes of old experiments. Previously reported errors cannot be retroactively relabeled as results of this CV protocol. Refit archived sessions to measure its effect, label that work exploratory, and use fresh sessions for confirmation. It also does not make the entire pipeline fully nested: open-eye profile fitting and pursuit-lag estimation happen before model CV, and the pursuit trajectory can overlap static targets. Thus the CV score remains a training model-selection diagnostic, not a generalization guarantee or a perfectly disjoint spatial benchmark. The final independent-session evaluation remains necessary.
