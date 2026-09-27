# Gaze upgrade — September 26, 2026

## Scope

User authorized implementing the research recommendations. Preserve the saved user calibration until an upgraded model has fresh measurements. A functioning inference pipeline is not an accuracy claim.

## Work

- [x] Native calibration: bounded per-target validation retries, frozen fitted model, honest attempt coverage, explicit start.
- [x] Browser correction/validation: bounded retries with sample acknowledgements and useful status.
- [x] Stream: precise pose diagnostics and recovery guidance; preserve rejected frames in validation.
- [x] Appearance backend: pinned local pretrained image features, optional runtime, real inference smoke/latency check.
- [x] Integrate versioned appearance features into capture, calibration, save/replay, and serving, with landmark compatibility.
- [x] Select regression regularization in screen-distance units and compare saved-session results without replacing the active model.
- [x] Regression tests, application checks, review, restart services and leave calibration ready.

## Acceptance

All automated checks must pass. Confirm actual appearance inference and model/schema persistence. Fresh human calibration/validation is required before claiming improved gaze accuracy. No image upload or silent fallback between model types.

## Verification and handoff

- 90 Python tests passed, including real MGazeNet fixture inference and camera failure cleanup.
- 18 browser client tests and 299 application tests passed. Type checking and shell production build passed.
- Real local inference produced finite 258-dimensional features; synthetic latency median 13.85 ms, p95 14.52 ms (not an accuracy measurement).
- Existing session refit retained mean 154.79 pt / p90 284.17 pt; the active saved calibration was not replaced.
- Upgraded native appearance calibration launched and its explicit Space-to-start intro was visually verified. Saving starts the gaze server automatically.
- Pending human action: fresh calibration and independent validation. Improved accuracy remains unverified.
