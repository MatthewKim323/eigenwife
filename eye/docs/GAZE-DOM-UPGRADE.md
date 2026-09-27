# Gaze robustness and DOM interaction upgrade

## Outcome

Improve usable tracking coverage without fabricating gaze, then map gaze uncertainty to a visible DOM candidate. Explicit confirmation emits a selector and focuses the element; gaze alone never clicks. Initial browser support uses known fullscreen geometry and an opt-in Chrome extension.

## Work

- [x] Train observable eye-openness baselines from training data; remove target-label feedback from gaze validity.
- [x] Evaluate robust regression using training-only grouped cross-validation; preserve independent validation and record coverage changes.
- [x] Compare replay results on the same recorded session, retain the current calibration backup, activate only verified artifacts.
- [x] DOM adapter: visible/eligible element discovery, conservative uncertainty-aware ranking, stable highlight, explicit selection descriptor, lifecycle cleanup.
- [x] Chrome extension: activeTab injection, isolated content world, local WebSocket via background, explicit extension-origin allowlist.
- [x] Automated tests, browser demo checks, documentation, running handoff.

## Evidence before changes

September 26 14:51 appearance calibration: accepted-frame mean124.60pt / p90182.75pt, coverage49.58%. Same-session landmark baseline mean177.55pt. Lower-screen validation frames rejected75.5%, upper5.6%, all by eyes_closed. Calibration incomplete. This dataset is development evidence now; any final accuracy claim needs a fresh human validation session.

## Decisions

- No VLM in the per-frame tracker. DOM already provides structured target identity.
- No blind image warping or arbitrary augmentation against a fixed pretrained model. We do not retain source images to replay alternate preprocessing.
- Do not relax browser geometry using guesses about toolbar offsets. Fullscreen is required in this iteration.
- Dense neighboring targets cause abstention; explicit focus confirmation is not click authorization.
- No automatic extension installation or upload of page content/webcam images.

## Completed verification

- 104 Python tests passed with the real MGazeNet fixture, 34 Node browser/extension tests passed, 299 application tests passed. Typecheck, shell production build, extension build, JavaScript syntax checks, and diff checks passed.
- Activated the separately evaluated candidate after checks. Previous active calibration backed up to `~/.eye/calibration-backup-1790460297592669000.npz`.
- Same new-gate validation mask: old mean144.38/p90247.51 points; new mean121.97/p90208.44. Coverage91.93%; worst error worsened712.13→736.56 points. Validation remains incomplete.
- Local server restarted with new model. Real localhost handshake confirmed MGazeNet backend. Of92 gaze events in a100-event sample,79 were usable and13 marked blink. This confirms live transport, not gaze accuracy.
- Extension built at `eye/browser-extension/dist`; installation and live extension testing are still pending. Chrome demo restored to localhost:8765, fullscreen mapping enabled, and a real camera-driven DOM highlight visually confirmed. Fresh human validation remains required.

## Reusable lessons

- Comparing accepted-frame error without coverage can reward a broken rejection gate. Always report both, plus common-mask old/new comparisons.
- A blink classifier for gaze validity must use observable features at training, validation, and runtime; target labels or previous predicted gaze can introduce mismatches and feedback lockout.
- DOM highlights must clear on scroll, mutation, loss, and stale samples, and confirmation must recheck current geometry. DOM descriptors are not authorization to activate a control.
