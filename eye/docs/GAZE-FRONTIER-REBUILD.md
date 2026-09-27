# Webcam Gaze Rebuild: Measurement Before Promotion

Date: 2026-09-26. The active MGazeNet calibration remains the incumbent. This work builds a reproducible challenger and evaluation path; it does not establish frontier-level user accuracy.

## System contract

```text
unmirrored camera pixels + arrival timestamp + measured camera calibration
  -> face landmarks and exact checkpoint-specific perspective normalization
  -> pretrained gaze direction + estimated origin + input quality
  -> personal screen-coordinate mapping trained on calibration targets
  -> frozen independent validation, including rejected/missing frames
  -> temporal tracking + explicit uncertainty
  -> browser DOM candidate ranking and deliberate confirmation
```

The current MGazeNet path remains useful: image embeddings and facial features feed a personal screen regressor. UniGaze is a separate normalized gaze-ray challenger. A ray model still needs personal screen mapping; camera intrinsics alone do not measure the screen plane or the person's visual-axis offset. Face-model origins remain approximate, even with measured camera intrinsics.

## Implemented

- Calibration CV groups every repeat of a static target together across neutral/head-motion conditions. Each pursuit step is one temporal group. Historical CV numbers do not retroactively inherit this protocol. Profile and pursuit-lag selection are not fully nested; truly independent sessions remain decisive.
- Frozen-model replay reports coverage, per-target/condition error, paired common-frame comparisons, jitter and dropouts. Training-session content hashes expose renamed training data. The tool never fits or activates a model.
- Explicit lossless image capture records the same pixels seen by the incumbent, stage timing, camera identity and actual dimensions. A bounded queue and byte cap protect tracking; every dropped processed frame stays in the ledger. This is not a record of every sensor exposure.
- Capture replay checks image/session hashes, dimensions and exact timestamps. Missing faces and declared image drops remain in the evaluation denominator.
- Candidate-only calibration saves a separate model and preserves the active calibration. Interrupted, restarted and cancelled image captures remain local for diagnosis but are rejected by the completed-capture benchmark.
- Offline camera intrinsic calibration and an optional pinned UniGaze-B adapter provide a geometry-aware research path. See the linked guides for dependencies, licenses, model hashes and exact commands.

## Capture a new comparison session

Stop the existing camera-serving process before starting another camera user. From the repository root:

```sh
uv run --project eye --extra appearance eye calibrate \
  --backend appearance --no-expressions --candidate-only \
  --record-images "$HOME/.eye/research-captures" --capture-max-mb 2000
```

This opens the calibration introduction; Space begins. The introduction explicitly states that local images are recorded and retained even when cancelled. No images are saved by default, no upload occurs, and the path is printed. Each attempt has a separate directory. The default 2 GB cap may be reached before the script ends; the ledger records all resulting missing images. Raise it explicitly if storage permits. Keep camera dimensions/settings constant across training and final evaluation.

Do not activate the candidate based on the blue preview ring. Run a second session after reseating, freeze the first candidate, and evaluate it on the second recording. Include head movement, lower-screen targets and normal lighting. Do not refit or select hyperparameters on that final session.

## Depth-map proposal

A dense depth map could supply an additional estimate of head/eye distance, especially during leaning. It cannot replace gaze direction or camera-to-screen geometry. Standard Depth Anything V2 predicts relative depth; separate metric variants and Depth Pro estimate physical depth. Their general scene results do not establish close-up eye-origin precision. Video temporal consistency can reduce flicker but must be evaluated for lag.

First compare calibrated face-pose distance against a metric depth model on identical captures. Keep estimated depth as a named optional feature with provenance, not a claimed measurement. Test neutral and depth-motion conditions separately; retain it only if it improves fresh-session error at matched coverage and acceptable latency. No depth model has been installed into the live tracker by this change.

A gaze probability heatmap over the screen is a different component. It could help rank DOM candidates, but must be calibrated against held-out residuals rather than turning an arbitrary Gaussian blur into confidence. DOM snapping accuracy must be reported separately from raw gaze accuracy.

Sources: [Depth Anything V2](https://github.com/DepthAnything/Depth-Anything-V2), [Depth Pro](https://github.com/apple-aiml-research/ml-depth-pro), [Video Depth Anything, CVPR 2025](https://openaccess.thecvf.com/content/CVPR2025/papers/Chen_Video_Depth_Anything_Consistent_Depth_Estimation_for_Super-Long_Videos_CVPR_2025_paper.pdf).

## Promotion criteria

Freeze criteria before reviewing fresh-session results. Proposed initial gate: at least 20% lower target-macro p90 error than the incumbent on paired frames, at least 90% usable-frame coverage with no large loss relative to incumbent, improvement under head movement, and no material regression in worst-target performance. Report median/p90/p95 error in screen points, not only assumed-distance degrees. Any changed thresholds need a new final evaluation session.

Measure end-to-end camera-to-highlight delay separately from model inference. The initial engineering target is p95 below 100 ms, but this is not yet measured. Report intended-element top-1/top-3, abstention and selection time in the browser. Maintain explicit confirmation; gaze alone must not activate arbitrary page actions.

## Guides

- [Geometry audit](GAZE-GEOMETRY-AUDIT.md)
- [Camera calibration](GAZE-INTRINSICS.md)
- [UniGaze model, setup and replay](GAZE-UNIGAZE.md)
- [Current DOM interface](GAZE-DOM-UPGRADE.md)

Remaining evidence: measured camera intrinsics for this laptop, completed raw-frame sessions, independent user accuracy, live end-to-end latency, and browser selection performance. Synthetic tests and model loading cannot substitute for those measurements.

## Evidence from this implementation

The stricter grouping protocol on the already-inspected 14:51 recording selected
CV error 125.95 screen points and produced held-out frame mean 122.38 / p90
209.37 points at 91.93% coverage. The incumbent was 121.97 / 208.44 at the same
coverage. This is effectively unchanged and is not a reason to promote the refit.
The comparison remains retrospective and validation coverage is incomplete.

Real pinned UniGaze weights and the exact iBUG-68 frontend ran on MPS. On an
external 569×750 face fixture, full frontend+geometry+model latency was median
63.69 ms / p95 67.15 ms (10 warmup, 20 measured frames). Synthetic camera
intrinsics were explicitly used only for this execution/latency smoke test.
The model/geometry-only test was 13.09 / 14.61 ms. Neither number measures
webcam-to-browser latency, and neither establishes gaze accuracy.

Final verification: 188 Python tests passed, 2 optional UniGaze real-weight
checks skipped in the ordinary environment; the separate prepared UniGaze
MPS environment passed all 18 adapter tests including real weights. All 46
browser/extension tests passed. `git diff --check` passed. The existing tracker
server remained running on port 8765 with its incumbent calibration.

A ready-to-print [checkerboard](gaze-checkerboard.svg) is included. Print in
landscape at actual size and measure a square (20 mm); do not use fit-to-page.
Follow the camera-calibration guide before recording the new comparison.
