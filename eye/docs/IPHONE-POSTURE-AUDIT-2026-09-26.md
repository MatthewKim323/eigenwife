# Calibration-to-validation posture audit

Capture: `iphone-20260926-163714-e95726b96bbf`. This is a retrospective diagnostic of one run, not evidence of general accuracy or a fresh evaluation set.

The complete 27-target calibration selected fused linear mapping (nested target-grouped CV 255.65 pt; training 155.17 pt). Independent validation measured 923.71 pt mean, 1240.33 pt p90, and mean bias (+647.90, +616.51) pt. Numeric replay reproduced the live result. Display geometry remained 1512 × 982 points, and the phone session stayed unchanged.

Camera rotation stayed approximately fixed. Head posture did not: head rotation column 1's z component ranged from -0.087 to -0.028 during calibration, versus -0.149 to -0.098 during validation. Validation mean shifted by -6.58 calibration standard deviations. Eye midpoint depth changed from 45.4–46.9 cm to 46.4–48.0 cm. This is head-posture extrapolation, not evidence that horizontal phone orientation caused a coordinate flip.

The fitted head pitch feature alone contributed about +1028 pt to the change in predicted vertical position. Other features have large compensating coefficients. The normalized training design's largest/smallest singular value ratio was approximately 375. The existing target-grouped split holds out locations but exposes all three posture/time blocks to both train and test; it does not establish generalization to a new posture.

## Retrospective ablations

All fitting and alpha selection used calibration only. The table's held-out values must now be treated as development evidence when designing the next model; a new independent check is required before claiming improved accuracy.

| Features | Nested target CV, pt | Validation mean, pt |
| --- | ---: | ---: |
| Original fused linear | 255.65 | 923.71 |
| Direction xyz | 389.23 | 495.06 |
| Direction xy | 362.42 | 500.08 |
| Direction and origin | 334.21 | 901.83 |
| Omit head matrix diagonal terms | 276.05 | 990.01 |
| Head features with training SD > 0.01 | 263.80 | 936.41 |

Dropping near-constant terms alone does not solve the failure. A separate fixed-alpha diagnostic over 0.01, 0.1, 1, 10, and 100 selected alpha 1 by held-out posture-block error (362.45 pt); its independent mean was 590.89 pt. Alpha 10 happened to give 295.71 pt validation mean, but choosing it on that basis would reuse validation for model selection.

## Focused regression guard

`PostureSupport` fits an envelope from calibration only: observed eye-midpoint ranges plus 25 mm per axis and wrapped head pitch/yaw/roll ranges plus 2 degrees per axis. These fixed margins tolerate small tracking fluctuations while limiting unconstrained extrapolation. An axis-aligned envelope is deliberately simple; it cannot detect every unsupported combination or guarantee accuracy inside its bounds.

Unsupported runtime predictions abstain, reset smoothing, and emit `head_pose_outside_calibration` with guidance. Unsupported validation/recenter frames count as attempted and rejected, rather than silently disappearing. Fresh calibration can expand support, including for legacy clients with an unflagged `calib_begin`, while the cursor abstains until the model supports the pose. Updated clients declare validation/recenter intent at `calib_begin`.

Retrospectively, this guard accepts 88 of 226 otherwise-valid validation frames (38.9%) and rejects all frames for the first five validation targets. It therefore makes this run fail validation coverage; it does not transform this run into an accurate tracker. Original captured/live and baseline replay measurements remain the baseline and must not be overwritten with guarded measurements.

Verification: 27 focused Python model/stream tests and 25 browser client tests passed, including normal-pose tolerance, out-of-support pitch/translation, honest rejected coverage, and fresh-calibration support expansion.
