# iPhone TrueDepth sensor app

`eye/iphone/EyePhone.xcodeproj` is a native iOS 16+ SwiftUI app with no third-party packages. The iPhone 14 Pro's front TrueDepth camera supplies ARKit eye/head tracking; actual ARFrame depth availability is reported separately. This app does not expose raw infrared video, and does not claim eye-tracker-grade accuracy.

## Deploy to the phone

1. Install full Xcode from Apple, launch it once, and install its iOS platform support. Command Line Tools alone cannot build or sign this app.
2. Open `eye/iphone/EyePhone.xcodeproj`. In the **EyePhone** target's **Signing & Capabilities**, select your own development team. If needed, change `local.eigenwife.EyePhone` to a unique bundle identifier. No team or credentials are stored in this repository.
3. Connect the iPhone by cable, unlock it, accept **Trust This Computer**, and enable **Developer Mode** when Xcode/iOS prompts you. Select the physical iPhone as the run destination; the simulator cannot provide TrueDepth tracking.
4. Build and run. On the phone, enter the receiver's `ws://MAC_LAN_IP:8766/iphone` URL and pairing token displayed by the Mac receiver. A `127.0.0.1` URL points at the phone itself and will not reach the Mac.
5. Keep both devices on the same trusted local network. Tap **connect and start** and allow camera/local-network access. Mount the phone securely beside the laptop with the **front** camera looking at you; look at the laptop screen.
6. Keep the phone fixed throughout laptop calibration and testing. Moving the phone changes its relationship to the screen and requires recalibration.

A USB developer launch can prefill `EYE_RECEIVER_URL` and `EYE_PAIRING_TOKEN` through the app process environment. This never starts capture automatically: the user still taps connect and grants permissions. The app saves only the endpoint URL in preferences. The token remains in memory. Tracking stops when backgrounded, interrupted, disconnected or explicitly stopped; it never reconnects automatically. Returning to the app requires tapping connect again. The app UI is portrait-locked, but the phone can be mounted horizontally. Calibration must use the same physical orientation as tracking; the offline image model additionally needs the rotation that makes the recorded face upright. Screen sleep is disabled only during an active connection.

The local `ws://` stream is unencrypted. Pairing limits access but does not provide transport encryption. Use a trusted network or a properly configured `wss://` receiver. The app's transport exception permits development on local IP addresses; it is not an App Store networking/privacy review.

## Recorded model comparison

Enable **include camera images for model research** in EyePhone to send synchronized RGB JPEGs with numeric tracking. This is off by default. Images are limited to 5 Hz, 1280 pixels on the longest edge and 300 KiB per JPEG. They retain sensor orientation and carry scaled camera intrinsics.

Start the receiver with `--capture-root` to enable local recording. On the Mac console, calibrate and record, run **check accuracy**, then **finish recording**. The calibration button starts recording automatically when recording is available; older open console tabs still require **record experiment locally** first. Calibration uses 27 randomized targets in three posture blocks; validation uses separate targets and does not train the mapping.

The Mac saves JPEGs and numeric records only while recording is active, with a complete checksummed manifest when stopped. Default limits are 512 MiB or 20 minutes. Camera images are not forwarded to the browser extension or uploaded to a cloud service. See [the rebuild plan](IPHONE-REBUILD-PLAN.md) for offline model extraction and comparison commands.

## Protocol

An ephemeral URLSession WebSocket sends `Authorization: Bearer TOKEN` in the upgrade request. Tokens are not added to URLs or frame payloads. JSON messages use `type=iphone_frame`, `schema=1`.

| Field | Meaning |
| --- | --- |
| `sessionId`, `seq` | New UUID per connection; monotonically increasing integer per transmitted frame |
| `timestamp` | ARFrame monotonic timestamp in seconds, not wall-clock UTC |
| `tracked` | Whether ARFaceAnchor is tracked and both blink observations exist; false for missing face/eye data or stalled camera |
| `cameraTransform`, `faceTransform` | 16 floats, column-major 4×4 world poses; metric translation |
| `leftEyeTransform`, `rightEyeTransform` | 16 floats, column-major 4×4 eye poses relative to the face |
| `lookAtPoint` | Three floats in face coordinates; an estimated focus point, not a unit vector or screen coordinate |
| `intrinsics`, `imageSize` | 9 floats, column-major 3×3 pixel intrinsics, and `[width,height]` for the corresponding camera image |
| `blinkLeft`, `blinkRight` | ARKit blend-shape coefficients, required for a tracked packet |
| `depthAvailable` | Whether this AR frame contains actual `capturedDepthData` |
| `depthTimestamp` | Separate source depth timestamp, present only when depth exists |
| `depthCentralM` | Optional median of valid center 5×5 depth pixels, meters; a diagnostic, **not face-segmented distance** |
| `reason` | Optional loss reason, including `face_not_tracked`, `eye_data_unavailable` and `camera_stalled` |

No eye/face transforms are sent when the face is untracked. The camera-stall heartbeat omits all camera/face samples instead of replaying stale values. A loss heartbeat starts after 0.5 seconds without AR frames. The receiver must additionally expire stale/disconnected streams: network loss cannot reliably deliver a final loss packet.

Samples are throttled to at most 30 Hz with one WebSocket send in flight. New frames are dropped during a pending send, not queued. A send stalled for two seconds closes the connection. A connection without a handshake times out after ten seconds. Depth can be absent on some RGB frames because the sensors have different capture rates; absence is not evidence of unsupported hardware.

Matrices retain ARKit coordinates. For example, eye world pose is `faceTransform × eyeTransform`; camera-space eye pose is `inverse(cameraTransform) × faceTransform × eyeTransform`. Laptop-screen coordinates still require calibration. Do not treat ARKit eye axes, `lookAtPoint`, or the center-depth summary as validated gaze labels.

## Verification and limits

Xcode 27.0 and the iOS 27 SDK are installed. Unsigned and Personal Team-signed arm64 device builds both succeeded; `codesign --verify --deep --strict` passed for the signed app. Developer Mode is enabled and installation on the iPhone succeeded. The user trusted their Developer App profile and the app launched successfully via devicectl. Live ARKit input reached the Mac: 906 packets with zero malformed packets, with about 21 frames/sec during a short observation. Face/eye features were accepted and requested calibration. Later runs confirmed depth delivery on some frames. An earlier independent accuracy check measured mean 120.99 screen points and p90 202.66 after recentering; this is a historical session result, not a guarantee for a new setup. A later disconnect correctly disabled browser calibration. Earlier checks also passed:

- Swift syntax parsing for the app sources with `swiftc -frontend -parse eye/iphone/EyePhone/*.swift`.
- `plutil -lint` for Info.plist and the Xcode project.
- Compiled and executed Foundation-only protocol checks with `eye/iphone/test-protocol.sh`. These verify optional fields, explicit loss, dimensions, optional image payloads and rejection of nonfinite values. An optional argument writes the tracked fixture JSON for receiver interoperability tests.

The compiled Swift tracked fixture and loss-heartbeat shape also decoded successfully through the Python `decode_iphone_frame` receiver, including all 12 geometry features and the independent depth timestamp.

The SDK builds verify iOS type checking and signing, but do **not** prove installation, camera permission, real ARKit callbacks, or eye-tracking accuracy. Physical-device tests remain required. The app contains no bundled gaze model and saves no images on the phone. Optional RGB frames can be sent to the paired Mac for an explicitly recorded experiment.

## Primary API references

- [ARFaceTrackingConfiguration](https://developer.apple.com/documentation/arkit/arfacetrackingconfiguration): face tracking support alone does not guarantee a depth camera on recent iOS. The app also checks `builtInTrueDepthCamera`.
- [ARFaceAnchor.leftEyeTransform](https://developer.apple.com/documentation/arkit/arfaceanchor/lefteyetransform): eye pose is relative to the face.
- [ARFaceAnchor.lookAtPoint](https://developer.apple.com/documentation/arkit/arfaceanchor/lookatpoint): estimated focus in face coordinates.
- [ARFrame.capturedDepthData](https://developer.apple.com/documentation/arkit/arframe/captureddepthdata): front TrueDepth depth in face-tracking experiences; may be absent on individual frames.
- [ARFrame.capturedDepthDataTimestamp](https://developer.apple.com/documentation/arkit/arframe/captureddepthdatatimestamp): depth source timing.
- [Apple TrueDepth streaming sample](https://developer.apple.com/documentation/avfoundation/streaming-depth-data-from-the-truedepth-camera): supported depth access, distinct from raw infrared imagery.

## Explicit live image-model challenger

A saved appearance-only profile can run on the Mac alongside ARKit. It does not replace the normal `/ws` stream or connect to the browser extension. Open `http://127.0.0.1:8767/?source=appearance` to select its isolated `/appearance/ws` stream and run a fresh, approximately 35-second accuracy check. Calibration/reset/recenter commands are rejected on this frozen-profile endpoint. Keep the phone in the physical position and orientation used for the saved calibration; restarting a connection does not verify that mounting stayed fixed.

The receiver accepts these optional arguments:

```sh
python -m eye.iphone_server \
  --appearance-profile /absolute/path/to/appearance-profile.json \
  --appearance-upstream /absolute/path/to/UniGaze \
  --appearance-weights /absolute/path/to/unigaze_b16_joint.safetensors \
  --appearance-landmark-cache /absolute/path/to/landmarks \
  --appearance-device mps --appearance-landmark-device mps \
  --appearance-assume-rectified
```

Use a Python environment with the existing verified UniGaze dependencies plus the receiver dependencies. `EYE_PAIRING_TOKEN` can preserve an existing token across a receiver restart; never put the token in URLs or logs. The app must reconnect after the receiver restarts. No native app rebuild is needed.

One worker processes images and retains at most one newer pending image. Results older than 500 ms since receiver receipt, invalid camera geometry, blink/lost-face samples, and results from a replaced session are rejected. Validation counts rejected/replaced images and never updates profile coefficients. Processing and receipt latency exclude phone capture/network delay. Profile export/load verifies provenance and checksums and uses calibration labels only; the observed 73.42-point offline mean remains a single-session result until a fresh live check succeeds.
