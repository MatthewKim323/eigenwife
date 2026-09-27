# Gaze Regression Upgrade — September 26, 2026

The appearance model remains MGazeNet with its original image preprocessing. The personal screen mapping now compares ordinary ridge against Huber-style iteratively reweighted ridge. Four bounded fitting passes downweight large **training** residuals, so a distracted fixation or bad feature frame has less influence without deleting it. See the [scikit-learn robust regression explanation](https://scikit-learn.org/1.8/modules/linear_model.html#huber-regression) for the underlying loss principle; this project implements a two-output, screen-distance IRLS variant, not scikit-learn's scalar estimator.

For appearance calibrations, the fixed candidate set is ordinary ridge and robust residual thresholds of 100/200 screen points. Each candidate selects ridge strength through grouped training cross-validation, with fold-local feature scaling and fold-local residual weights. A robust candidate must improve training CV by at least 3% over ordinary ridge to be selected. Landmark-only calibration retains ordinary ridge. Validation labels never enter this selection. Saved models preserve the robust threshold and screen geometry so later refitting uses the same loss.

No extra head-pose transform or synthetic image augmentation was added. The current input already includes rotation, depth, and translation divided by depth. Applying image warps to a pretrained model without its matching training normalization is not justified. Archives contain embeddings, not camera images, so image augmentation cannot be replayed from them.

## Experiments and Selection

The saved appearance session `calib-20260926-145105.npz` was used. On a fixed training-only extraction, embedding/head feature block weights gave 133.82 points grouped CV versus ordinary ridge's 134.07—too small to justify shipping that added complexity. Removing the embedding block worsened CV to 155.7 points. Those experimental block weights were removed.

Robust fitting gave 122.76 points on the same extraction. With the separately improved observable eye-quality gate integrated and pursuit lag refit, ordinary ridge's training CV was 135.12 points and the selected robust candidate was 121.57 points (100-point threshold, alpha 316.23). The two-output regression remains linear; prediction latency is unchanged. Full session refitting took about seven seconds on the development machine.

## Frozen Validation Comparison

These are retrospective measurements on one session, not proof of fresh-session or live browser accuracy. No candidate was tuned after these validation results were inspected. Previously accepted frames use the old calibration report's target-dependent gate; the new gate depends only on observable eye/head features.

| Accepted frame set | Frames | Old mean / p90 | New mean / p90 |
|---|---:|---:|---:|
| Accepted by both gates | 713 | 124.60 / 182.75 | 114.10 / 164.81 |
| Newly accepted by observable gate | 609 | 167.53 / 273.50 | 131.19 / 227.01 |
| All frames accepted by new gate | 1,322 | 144.38 / 247.51 | 121.97 / 208.44 |

All errors are screen points. Coverage increased from 49.6% to 91.9%, which changes the population being scored. The common-frame comparison is therefore more informative than comparing unqualified old/new averages. Large outliers remain; the new model's worst accepted frame is about 737 points. Fresh validation and blink-specific checks are still required.

## Reproduction

From `eye/`, run `uv run --extra appearance python scripts/replay_model_upgrade.py SESSION --baseline ORIGINAL_MODEL --candidate SEPARATE_OUTPUT`. Omit `--candidate` for a read-only report. The script rejects candidate paths that would overwrite the active model, baseline, or recording. It includes median, p90, worst, neutral/motion summaries, and full retry-aware validation diagnostics.

The session loader now decompresses each NPZ array once and closes the archive before rebuilding frames. A regression test verifies that appearance features are not repeatedly decompressed inside the frame loop. Targeted tests cover robust CV against independent fold fits, contaminated synthetic fixations, backward-compatible model loading, save/load/refit consistency, and appearance session roundtrip.
