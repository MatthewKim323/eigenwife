# Measured Camera Intrinsics

This workflow measures your camera's focal parameters, optical center, and lens distortion using a physical checkerboard. It produces the JSON consumed by `eye.unigaze_backend.CameraCalibration.load`. It does not activate a gaze model or alter the saved gaze calibration.

Only the explicit `capture` command opens your camera. `board` and `fit` are offline. Capture stores unmirrored camera images locally, including anything visible behind the board; choose the directory deliberately and remove it when no longer needed.

## Practical workflow

Run these commands from the repository's `eye` directory. Use a fresh output directory and filename; the tool refuses to overwrite existing outputs.

1. Generate a printable board:

   ```sh
   uv run --extra appearance python -m eye.intrinsics board --columns 8 --rows 5 --square-mm 20 --output /tmp/eye-checkerboard.svg
   ```

   Print at actual size, with no fit-to-page scaling. The SVG is 220 × 160 mm including its white border; the checkerboard has **9 × 6 squares and 8 × 5 inner corners**. Measure a printed square with a ruler, and use its actual size consistently in subsequent commands. Mount the sheet flat on rigid cardboard. A curved sheet invalidates the planar-board model. A tablet displaying the pattern is an alternative only if the physical square size is measured, the surface is flat, and glare/moiré do not obscure corners.

2. Stop the gaze server or another app using this camera. Open explicit board capture:

   ```sh
   uv run --extra appearance python -m eye.intrinsics capture --columns 8 --rows 5 --square-mm 20 --output /tmp/eye-camera-views --width 1280 --height 720
   ```

   The built-in camera is selected by default; `--camera` can select another by name substring or index. The preview is unmirrored. Hold the whole board in view, wait until the overlay says it is detected, and press **Space** to save a lossless PNG. Save 15–25 clearly different views: board toward left/right/top/bottom of the image, at several distances, tilted left/right and up/down. Include substantial oblique angles while keeping every corner visible and sharp. Keep the same camera mode and disable automatic framing/cropping features for capture and future gaze use. Repeated nearly identical consecutive views are not saved. Press **q** or **Escape** to finish.

   Capture writes `capture.json` containing the actual physical camera ID, actual image dimensions, board parameters, and mirroring convention. It never infers camera geometry from a nominal device name.

3. Fit offline:

   ```sh
   uv run --extra appearance python -m eye.intrinsics fit --columns 8 --rows 5 --square-mm 20 --images /tmp/eye-camera-views --output /tmp/eye-camera-intrinsics.json
   ```

   The camera ID is read from capture metadata. An explicit `--camera-id` must match that metadata. External image directories without metadata require an explicit physical camera ID; all images must share one original, unmirrored resolution and camera mode. The fit checks board parameters and image dimensions against capture metadata when available.

4. Use the resulting JSON with the geometry-aware challenger documented in [GAZE-UNIGAZE.md](GAZE-UNIGAZE.md). It is specific to the camera and capture mode. Changing camera, digital crop, stabilization, or resolution requires a matching calibration or an explicitly correct intrinsic transform. Do not merely resize the numbers until the loader accepts them.

## What the fit verifies

The tool detects checkerboard corners, refines them to subpixel locations, and fits the OpenCV five-coefficient pinhole distortion model. It requires at least ten detected views, with at least six distinguishable training views and variation in board position and projective tilt. It rejects inconsistent image sizes, nonfinite data, degenerate boards, implausible focal parameters, and failed reprojection checks. Diversity thresholds are explicit heuristic screening; passing them does not prove sufficient calibration conditioning.

Every fifth detected view, in filename order, is held out from intrinsic fitting. The fit never silently retrains on those held-out views. Default limits are 2 pixels training RMS and 3 pixels for each held-out view. Camera pose for a held-out board is estimated from that view's corners while intrinsics remain frozen, then its corner reprojection RMS is reported. This tests consistency on new views; because pose uses those same corners, it is **not independent ground truth for the intrinsic matrix**, a gaze accuracy test, or a guarantee of subdegree tracking. Capture independent additional board views and gaze validation sessions for stronger checks.

The fitting functions accept explicit thresholds for controlled experiments, but raising them to make a bad dataset pass is not a repair. If fitting fails, inspect blur, printing geometry, reflections, and insufficient board tilt/position coverage, then collect better images.

This procedure follows the calibrated pinhole/distortion and pose-estimation formulation documented by [OpenCV](https://docs.opencv.org/4.13.0/d9/d0c/group__calib3d.html). Camera intrinsics are only one part of a full gaze system: face/eye origin, model normalization, personal visual-axis offset, and camera-to-screen geometry still require correct treatment.

## JSON contract

```json
{
  "schema_version": 1,
  "camera_id": "physical-camera-identifier",
  "image_size": [1280, 720],
  "camera_matrix": [[1000, 0, 640], [0, 990, 360], [0, 0, 1]],
  "distortion_coefficients": [0, 0, 0, 0, 0],
  "rms_px": 0.2,
  "validation": {"view_rms_px": [0.25, 0.3]},
  "protocol": {"name": "checkerboard-holdout-v1"}
}
```

These numeric values are illustrative, not device defaults. Real output includes source-view lists, board dimensions, split definition, diversity diagnostics, acceptance thresholds, and a precise interpretation of validation.

## Verification

Automated tests recover known synthetic intrinsics, verify that held-out views never enter `calibrateCamera`, reject corrupted held-out views and nondiverse captures, exercise real image corner detection, load generated JSON through the UniGaze camera loader, and test explicit save/exit/camera cleanup with a fake camera. No real camera calibration or physical printing measurement has been performed by these tests.
