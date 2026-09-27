# Gaze reliability work

Goal: make webcam attention measurable and honest, with no mouse masquerading as gaze and no stale or fabricated targets.

## Implemented

- Browser client: known fullscreen geometry, invalidation on viewport changes, conservative target resolution, sample-based semantic transitions, loss cleanup.
- Shell: explicit eye/mouse state, no implicit mouse fallback, event timestamps, visible setup errors and calibration results.
- Stream: independent display smoothing, conservative pose bounds, correction evaluated against the active mapping, correction provenance, loopback integration.
- Calibration: train-only preprocessing, whole-target cross-validation, static versus pursuit timing, broader pose coverage, honest frame errors and replay audit.

## Baseline

Saved session: `~/.eye/sessions/calib-20260926-140551.npz` (private, not committed).
Original model: five target median errors average 151.9 screen points; frame mean 150.3; frame p90 240.3. Whole head-target holdouts averaged 73.8, 557.4, 1047.6, 949.2 points. These are offline diagnostics from one session, not population accuracy estimates.

## Acceptance

- Regression tests for cross-origin loading, target transitions, dropout, geometry changes, correction rejection, and validation leakage.
- Python tests, browser-client tests, shell tests and type checks/build where dependencies permit.
- Replay preserved session without replacing the active calibration.
- Fresh user calibration and live target validation still required to establish real-world improvement.

## Verified result

The original recording remains untouched. Replaying with train-only preprocessing and untrimmed validation gives 160 pt mean, 261 pt p90, and 405 pt worst frame error. One target has only 60% usable coverage; whole head-target holdouts still reach 1,039 pt worst. These changes make evaluation honest; they do not establish improved live accuracy.

The upgraded server is running with the original model. A live loopback-origin HTTP request returned the required CORS header, and a WebSocket client received the new quality/uncertainty fields. Current out-of-calibration poses are explicitly rejected. Browser setup shows the fullscreen requirement instead of mouse simulation.

The user requested leaving calibration ready, so no new calibration or live accuracy check was started. Full calibration is ~117 seconds without expressions. Restart the gaze server after saving a new model, then run the independent nine-point measurement in fullscreen.

## Reusable lessons

- Receiving camera events proves transport, not gaze accuracy or semantic correctness.
- Test whole targets and poses; temporal neighbors make held-out chunks too easy.
- Report frame error and dropout coverage separately. Never trim difficult validation samples to improve a headline score.
- Keep physical calibration separate from browser geometry. A drift correction must not compensate for a hidden panel or zoom mismatch.
- On macOS, a fullscreen page may occupy the OS usable area rather than the full CoreGraphics display even at 100% browser zoom. Check display size and device scale separately, then map through the browser's reported usable-area origin.
- Distinguish measured error, estimated uncertainty, training fit, and correction acceptance in both protocol and UI.
