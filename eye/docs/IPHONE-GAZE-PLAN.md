# iPhone TrueDepth eye-tracking experiment

## Objective

Run the native iPhone 14 Pro front-camera tracker, calibrate its camera-relative ARKit gaze to the Mac display, measure independent accuracy and coverage, then use validated gaze to highlight browser DOM targets. Hardware support or a calibration fit is not proof of usable accuracy.

## Current verified state — 2026-09-26

- Native project: `eye/iphone/EyePhone.xcodeproj`. Swift syntax, project/plist validity, compiled numeric-only protocol fixture, and fixture-to-Python decoding verified. Unsigned and Personal Team-signed arm64 iOS SDK builds now pass; signed app verification passes. Build outputs are `/tmp/eigenwife-iphone-build` and `/tmp/eigenwife-iphone-signed`.
- Receiver: `eye/src/eye/iphone_server.py`. Private-interface authenticated phone input, loopback browser console, single-phone enforcement, replay rejection, explicit stale/disconnected status. No images are transmitted or persisted.
- Mapping: camera-relative metric eye origin/direction plus head rotation, personalized ridge fit, grouped cross-validation, separate frozen-model validation. Reconnection invalidates the mapping.
- Verification: 24 Python mapping/real-network tests and 48 browser tests passed. Browser console rendered in Chrome and correctly disabled calibration while no phone is connected.
- Running console: `http://127.0.0.1:8767/`. Start manually with `cd eye && uv run --extra appearance python -m eye.iphone_server`. Pairing details are shown only in the local console and rotate on receiver restart.
- User completed Apple Developer sign-in. Official stable Xcode 27 archive downloaded from Apple, expanded, passed `codesign --verify --deep --strict`, and installed to `/Applications/Xcode.app`. `xcodebuild -version` reports Xcode 27.0 (27A266a), compatible with this Mac's macOS 26.6.2.
- User completed first-launch setup. iOS 27 SDK and compatible iOS developer disk image are available. Personal Team signing is configured. Device inspection confirms a wired, paired iPhone 14 Pro on iOS 26.6.2; Developer Mode is now enabled and DDI services are available. EyePhone installed successfully via devicectl. First launch was denied by iOS Security; local signature verification passes, the provisioning profile includes this device, and it expires 2026-10-03. User was asked to trust their Developer App profile under Settings → General → VPN & Device Management. User subsequently trusted the profile; devicectl launch succeeded. Added and rebuilt USB-launch pairing prefill, reinstalled and launched with the current receiver address/token without printing the token. User was asked to tap connect and allow camera/local-network prompts. Live tracking was subsequently verified: 906 accepted packets, zero malformed packets, and about 21 frames/sec during a short observation. Real face/eye features reached the mapping; it correctly requested screen calibration. Depth was not reported in the observed status, so depth delivery is not yet verified. The phone later disconnected; the console correctly disabled calibration.
- The iPhone was detected over USB; EyePhone is installed and has streamed real ARKit features, but screen accuracy has not been measured yet.

## First independent device accuracy result

The Chrome console retained a completed independent accuracy check: mean **236.52 screen points**, p90 **317.13 screen points**, coverage **100%**. Approximate angular errors were 4.91° and 6.58° under the assumed 55 cm distance. The display is 1512 × 982 screen points; mean error is about 15.6% of display width. This is insufficient for ordinary browser target selection. Coverage indicates usable sample collection, not accurate gaze.

The same retained browser state reported 22 frames/sec and depth available, providing evidence that depth was delivered during the run. At inspection afterward, direct HTTP and a fresh WebSocket both reported the phone disconnected (4,849 accepted packets, zero malformed packets), with calibration invalidated. The browser accessibility state still displayed the earlier connected/tracking labels; treat those as retained state rather than current liveness. Preserve the visible accuracy result before refreshing or recalibrating. Next diagnosis should capture per-target residuals and separate systematic offset/scale error from head-pose drift before selecting a model change.

## Remaining sequence

1. Reopen EyePhone and tap connect, keeping it foregrounded. The console is open in fullscreen. Installation, signing, launch, real frame delivery, face features, and disconnected-state gating are verified.
2. Observe depth diagnostics across a sustained connection; depth delivery remains unverified.
3. Confirm a stable phone mount before starting calibration.
4. Fix the phone securely relative to the laptop display. Complete 14-target calibration and 9 independent validation targets. Report screen-point error and coverage; angular error assumes 55 cm viewing distance and is only approximate.
5. Repeat validation after ordinary seated head motion. Use large DOM targets first; keep explicit activation. Do not claim frontier-level accuracy without measured evidence.
6. Once validated, connect the existing browser extension to the iPhone-backed service. The separate prototype port currently avoids changing the webcam service or its saved calibration.

## Constraints

No printed calibration board. ARKit uses supported TrueDepth-assisted face/eye tracking; this is not raw infrared eye-camera access. The phone-to-Mac development stream uses unencrypted local WebSocket with an ephemeral bearer token; use a trusted local network. The prototype does not save video. Phone movement requires recalibration.

## Adaptive smoothing update

Added the existing One Euro filter to iPhone screen-space predictions (1.5 Hz minimum cutoff, beta 0.02 in screen-point units). Capture timestamps drive filtering; stale/disconnected sessions, calibration changes, and valid-sample gaps over 250 ms reset state. Raw predictions remain the basis for calibration and independent accuracy. Validation now exposes per-target x/y bias, RMS jitter, and mean/p90 error; the browser renders these diagnostics.

Verification: 26 Python mapping/network tests and 48 browser tests pass. Synthetic 22 Hz regression checks cover fixation jitter reduction, a large step settling within 10% in three frames, raw validation isolation, and reset after loss. These do not establish real-user latency or improved accuracy. Updated receiver is running and Chrome loaded the new page; the phone must reconnect and recalibrate after the receiver restart. Pairing was retained in memory for this development restart.

## Live smoothed-session check and center correction

The next real calibration completed with grouped-CV mean 147.54 points and training mean 66.70. Independent raw validation measured mean 283.68 points, p90 410.30, and 100% coverage. Every one of nine targets had positive horizontal bias (64.86–373.30 points) and negative vertical bias (−102.20 to −234.03 points). Within-target RMS jitter ranged 17.01–69.59 points. This points to a substantial systematic offset in addition to noise; it does not prove a particular cause (pose drift, mounting, or model error).

Added an explicit center-dot recenter operation using new samples, never validation labels. Requires an existing model, at least 15 usable samples, 80% coverage, bounded offset and RMS jitter ≤60 points. Updates only an additive offset, resets the display filter, and invalidates prior accuracy. Failed corrections preserve the prior mapping. A fresh independent accuracy check remains mandatory to establish benefit.

## First live recenter result

The user completed the updated calibration (CV mean 163.28 points, training mean 99.76), followed by a successful independent center correction of −188.49 x / +69.24 y screen points. Center RMS jitter was 31.11 points. A separate nine-target accuracy check then measured mean **120.99 points**, p90 **202.66 points**, coverage **100%**. Approximate angles are 2.51° mean / 4.21° p90 under the 55 cm assumption. This is better than the previous session's 283.68-point mean, but recalibration also changed, so the comparison does not isolate the causal benefit of recentering.

Residual per-target means range 73.18–239.04 points, with the largest error at the lower-right target. Within-target RMS jitter is 8.93–25.32 points. Remaining error is mainly position-dependent bias rather than moment-to-moment noise. Do not tighten uncertainty based on jitter or claim small-target accuracy. The receiver remains running with this calibration; do not restart while the user tests the four large DOM targets. User was asked to confirm intended selection using Option+Enter, or numbered disambiguation via Option+Space. Actual browser task success and robustness after seated movement remain unverified.
