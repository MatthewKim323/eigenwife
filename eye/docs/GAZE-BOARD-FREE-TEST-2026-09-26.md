# Board-Free Gaze Test — 2026-09-26

The user completed a fresh MGazeNet calibration and held-out target validation without a physical checkerboard. UniGaze was not evaluated: camera intrinsics are still unmeasured. The test candidate was saved separately; the incumbent calibration remains active, and its server was restored on port 8765 with the existing extension ID.

## Results

On each model's accepted validation frames:

| Model | Mean error (screen points) | Median | p90 | Coverage |
|---|---:|---:|---:|---:|
| Previous saved calibration | 224.08 | 215.50 | 345.18 | 81.17% |
| Fresh candidate | 72.29 | 59.53 | 127.12 | 90.51% |

On the identical 547 validation frames accepted by both models (79.85% paired coverage):

| Model | Mean error | Median | p90 | Worst |
|---|---:|---:|---:|---:|
| Previous saved calibration | 224.49 | 215.84 | 346.16 | 681.36 |
| Fresh candidate | 68.92 | 57.14 | 119.45 | 722.10 |

The fresh candidate completed all 14 validation targets after two coverage retries. Its mean error was about 78 points when sitting naturally and 68 under instructed head motion. The large worst-frame error remains a concern.

This compares a previous-session model against a model personalized in the current session. It demonstrates the importance of recalibration under changed session conditions; it does not establish that the new candidate generalizes across sessions. The candidate's validation targets were excluded from training, but a fresh later-session evaluation remains required. No UniGaze or depth-map accuracy claim follows from these results.

## Artifacts

- Session: `~/.eye/sessions/calib-20260926-153217-1790461937624370000.npz`
- Candidate: `~/.eye/sessions/calib-20260926-153217-1790461937624370000-candidate.npz`
- Local lossless capture: `~/.eye/research-captures/capture-20260926-152924-bb16df57`
- Frozen benchmark report: `/tmp/eigenwife-board-free-test.json`
- Capture integrity report: `/tmp/eigenwife-board-free-capture-check.json`

Capture manifest reports 3,418 saved images and 256 explicitly logged drops out of 3,674 processed frames, using 4,373,323,715 bytes. Image-save drops are separate from gaze-quality rejection and remain visible for future image-model comparisons.

Next: evaluate this frozen candidate after reseating in another session, then decide whether to promote it. Investigate session drift and rare large jumps rather than treating same-session averages as reliable browser cursor precision.

## Frozen Candidate Reseating Check

On user authorization, the candidate was loaded into a temporary live server on port 8765 with `fresh=True` (no saved drift correction). The saved incumbent calibration file was not replaced. Chrome opened the local playground, enabled fullscreen mapping, and ran **measure accuracy**, which leaves model coefficients unchanged.

The live check failed at target 1 of 9 after three attempts, with zero usable samples and 0% coverage for that target. The page reported head-position support violations; prior to validation it also reported pitch 11.3 against calibrated bounds -14.2 to 0.9. The failure message named horizontal_position, displayed rounded as 0.1 against -0.1 to 0.0. Those rounded values are diagnostics, not physical distance measurements.

No gaze accuracy score can be inferred from this failed run. It demonstrates a live availability/pose-support failure after reseating, not a measured angular error. No thresholds, correction, or coefficients were changed to pass the test. The temporary candidate server remains running for inspection; restarting the normal `eye serve` command loads the saved incumbent again.

Next engineering work: distinguish overly restrictive support detection from actual extrapolation error using labelled multi-posture captures; expand calibration across head translation, pitch and distance; test head-normalized representations. Do not simply disable the pose gate and call the result robust.
