# UniGaze-B Research Challenger

This is an executable, optional offline challenger. It does not replace the active MGazeNet model, open the webcam, guess camera intrinsics, or establish improved accuracy. Fresh image recordings and independent validation are still required.

## Why this model

[UniGaze (WACV 2026)](https://github.com/ut-vision/UniGaze) provides released gaze-trained ViT checkpoints and normalization code. Its normalized face representation is relevant to webcam gaze; scene gaze-following models are a different task. We use the smaller joint-dataset B checkpoint first. [The paper](https://arxiv.org/html/2502.02307v2) motivates pose-balanced, geometrically normalized pretraining rather than assuming semantic VLM features improve precision.

Upstream is pinned to `9c240fbe33f3d6146970a77b7c8fa06a7e60019e`. The 346,291,616-byte weights are pinned to Hugging Face revision `d3f8335cd4b7d249adbc32389986ce49b52f6f72` and SHA256 `2580d707b1395840ecabe7906e2cb35705f38c4ddb0be9c3c38ebb2d5546ffb8`. Inference checks the source revision, clean tracked source, and model digest. Downloads are explicit commands.

License: UniGaze model terms are ModelGo Attribution–NonCommercial–ResponsibleAI 2.0; normalization source additionally carries CC BY-NC-SA 4.0 attribution to Zhang, Sugano, Bulling (ETRA 2018). Dependencies retain their licenses. This research integration makes no commercial-use clearance claim. Source is loaded from a separate checkout rather than copied into this project.

## Isolated setup

From the repository root, run these commands. They leave the live tracker's environment alone. The upstream package's distribution omits model subpackages, so the adapter imports its verified source checkout directly.

```sh
uv venv --python 3.12 /tmp/eigenwife-unigaze-env
uv pip install --python /tmp/eigenwife-unigaze-env/bin/python torch==2.8.0 torchvision==0.23.0 timm==0.3.2 numpy==2.2.6 opencv-contrib-python==4.12.0.88 safetensors==0.6.2 huggingface-hub==0.34.4 scipy==1.18.1 scikit-image==0.26.0 numba==0.67.0 tqdm==4.70.1 pytest==8.4.2
uv pip install --python /tmp/eigenwife-unigaze-env/bin/python --no-deps face-alignment==1.4.1

git clone https://github.com/ut-vision/UniGaze.git /tmp/eigenwife-unigaze
git -C /tmp/eigenwife-unigaze checkout 9c240fbe33f3d6146970a77b7c8fa06a7e60019e

PYTHONPATH=eye/src /tmp/eigenwife-unigaze-env/bin/python -m eye.unigaze_backend fetch /tmp/eigenwife-unigaze-models/unigaze_b16_joint.safetensors
PYTHONPATH=eye/src /tmp/eigenwife-unigaze-env/bin/python -m eye.unigaze_backend fetch-landmarks /tmp/eigenwife-unigaze-models/landmarks
```

`face-alignment` is installed without dependency resolution because its `opencv-python` requirement duplicates the `cv2` namespace supplied by `opencv-contrib-python`; its other runtime dependencies are explicitly installed above. Do not install both OpenCV distributions into this environment.

The landmark frontend downloads another approximately 178 MB: pinned SFD and 2D-FAN models from the face-alignment author's host. Its version is checked, each asset SHA256 is verified before loading, and inference has no download path with missing assets. On this machine the checkout, environment, weights, and landmark cache above have been prepared. `/tmp` is disposable; use persistent paths for long-term experiments.

## Camera and landmark contract

Use a measured checkerboard calibration JSON from the intrinsics tool, with `schema_version: 1`, `camera_id`, `image_size: [width,height]`, `camera_matrix`, and explicit `distortion_coefficients`. The image must have exactly those full-frame dimensions, be unmirrored, and use the same physical camera/lens settings. Scaling/cropping images requires explicitly transforming the calibration; this adapter rejects dimension mismatches. Never substitute the official demo's guessed focal length.

The frontend detects standard iBUG-68 landmarks using face-alignment 1.4.1, half-resolution RGB input, and `flip_input=False`, matching the upstream video pipeline. Multiple faces are rejected. It does not substitute MediaPipe indices for iBUG topology. Precomputed `.npy` iBUG-68 landmarks are also supported, in full-frame distorted pixel coordinates.

The adapter undistorts image and landmarks together, runs upstream six-point PnP, uses its eye/nose mean origin, and calls the actual upstream normalization implementation (224×224, focal length 960, distance 600). RGB/ImageNet normalization matches upstream. A configurable reprojection-error gate and upstream 80-degree head-pose gate reject unusable geometry.

The returned `direction_camera` points **from face toward the gaze target**, using OpenCV camera axes. This explicitly negates the upstream positive-z pitch/yaw vector before inverse rotation, matching its demo's negative drawing direction. `origin_camera_mm` is a generic-face-model estimate, not a metric depth sensor. No screen projection or physical certainty is implied.

## Image inference

```sh
PYTHONPATH=eye/src /tmp/eigenwife-unigaze-env/bin/python -m eye.unigaze_backend infer \
  --upstream /tmp/eigenwife-unigaze \
  --weights /tmp/eigenwife-unigaze-models/unigaze_b16_joint.safetensors \
  --camera /absolute/path/to/intrinsics.json \
  --image /absolute/path/to/frame.png \
  --landmark-cache /tmp/eigenwife-unigaze-models/landmarks \
  --device mps --landmark-device mps
```

Alternatively pass `--landmarks /absolute/path/to/ibug68.npy` instead of the landmark cache. CPU and MPS are explicit options; unavailable MPS fails instead of silently switching devices.

## Capture replay

Replay additionally imports existing recording types, which require the project's pinned MediaPipe package:

```sh
uv pip install --python /tmp/eigenwife-unigaze-env/bin/python mediapipe==1.0.0 opencv-contrib-python==4.12.0.88
PYTHONPATH=eye/src /tmp/eigenwife-unigaze-env/bin/python -m eye.unigaze_backend replay \
  --capture /absolute/path/to/completed-capture \
  --upstream /tmp/eigenwife-unigaze \
  --weights /tmp/eigenwife-unigaze-models/unigaze_b16_joint.safetensors \
  --camera /absolute/path/to/intrinsics.json \
  --landmark-cache /tmp/eigenwife-unigaze-models/landmarks \
  --device mps --landmark-device mps \
  --output /absolute/path/to/new-unigaze-rays.jsonl
```

The input capture/session/images are integrity-checked by `CaptureReplay`. Before opening output, recorded `metadata.camera.device.unique_id` must equal the intrinsics `camera_id` and recorded dimensions must match. Unknown camera identity is rejected; use the actual camera unique ID when fitting intrinsics. Output is exclusively created, never overwritten. Every recorded frame yields a row, including missing images and landmark/geometry rejection. Rows include `index`, `seq`, `t`, `valid`, backend and camera fingerprints. Valid rows add `origin_camera_mm`, `direction_camera`, raw `pitch_yaw_normalized`, both normalization transforms, and `reprojection_error_px`. Invalid rows include `reason`. Fatal runtime failures abort rather than fabricating predictions; an interrupted output is partial and must not be treated as a completed run.

These rays need a personal screen mapping trained only on training targets, followed by the same frozen validation protocol as the incumbent. A camera calibration does not by itself locate the screen plane. Compare coverage and error on all attempts, later-session drift, and DOM-selection outcomes before promotion.

## Verification and limits

On Apple M3 Max, real pinned UniGaze-B weights loaded on MPS and passed synthetic calibrated-geometry inference. Adapter latency over 100 synthetic frames after 10 warmup frames: median **13.09 ms**, p95 **14.61 ms**, batch size 1. This includes undistortion, PnP, normalization and model inference; it excludes face/landmark detection, camera capture, websocket transport and browser work. It is not a webcam throughput or accuracy claim.

```sh
EYE_UNIGAZE_UPSTREAM=/tmp/eigenwife-unigaze \
EYE_UNIGAZE_WEIGHTS=/tmp/eigenwife-unigaze-models/unigaze_b16_joint.safetensors \
EYE_UNIGAZE_DEVICE=mps PYTHONPATH=eye/src \
/tmp/eigenwife-unigaze-env/bin/python -m pytest eye/tests/test_unigaze_backend.py -q
```

Without those environment variables, real-weight tests skip explicitly; dependency-free geometry/contract tests still run. The exact SFD/FAN frontend also returned 68 landmarks on the upstream GazeFollower face fixture using MPS; its first call took 6.24 seconds including initialization/JIT overhead. A subsequent full-pipeline measurement on that external 569×750 fixture used explicitly **synthetic intrinsics for latency only**: 10 warmup iterations followed by 20 measured iterations, batch size 1, MPS for both models. Landmark detection median/p95 was **49.63/52.10 ms**; detection plus normalization plus UniGaze inference was **63.69/67.15 ms**, with no geometry rejections. This is roughly 16 predictions/second before camera/browser overhead, not a 30 Hz production frontend. The model-only figure hides substantial landmark cost. No gaze accuracy can be derived from this fixture or synthetic camera matrix.

Synthetic intrinsics in tests are deliberately labeled synthetic and must never be used for actual webcam predictions.
