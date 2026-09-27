"""Explicit checkerboard capture and offline calibration; never activates a model."""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import cv2
import numpy as np


class IntrinsicsError(ValueError):
    pass


def board_points(columns: int, rows: int, square_mm: float) -> np.ndarray:
    if (isinstance(columns, bool) or isinstance(rows, bool) or
            not isinstance(columns, int) or not isinstance(rows, int) or
            columns < 3 or rows < 3 or columns > 30 or rows > 30):
        raise IntrinsicsError("inner corner counts must be integers from 3 to 30")
    if not math.isfinite(square_mm) or not 0 < square_mm <= 1000:
        raise IntrinsicsError("square_mm must be finite and in (0, 1000]")
    points = np.zeros((columns * rows, 3), np.float32)
    points[:, :2] = np.mgrid[:columns, :rows].T.reshape(-1, 2) * square_mm
    return points


def _diversity(views: list[np.ndarray], size: tuple[int, int], columns: int, rows: int) -> dict:
    normalized = [np.asarray(v).reshape(rows, columns, 2) / size for v in views]
    centers = np.array([v.mean(axis=(0, 1)) for v in normalized])
    perspective = []
    unique = []
    for grid in normalized:
        flat = grid.reshape(-1, 2)
        if not any(np.sqrt(np.mean((flat - other) ** 2)) < .015 for other in unique):
            unique.append(flat)
        top = np.linalg.norm(grid[0, -1] - grid[0, 0])
        bottom = np.linalg.norm(grid[-1, -1] - grid[-1, 0])
        left = np.linalg.norm(grid[-1, 0] - grid[0, 0])
        right = np.linalg.norm(grid[-1, -1] - grid[0, -1])
        if min(top, bottom, left, right) <= 1e-6:
            raise IntrinsicsError("degenerate checkerboard geometry")
        perspective.append([math.log(top / bottom), math.log(left / right)])
    center_span = np.ptp(centers, axis=0)
    tilt_span = np.ptp(perspective, axis=0)
    if len(unique) < 6 or max(center_span) < .15 or max(tilt_span) < .06:
        raise IntrinsicsError("insufficient view diversity: move the board across the image and tilt it around both axes; repeated/front-facing frames are insufficient")
    return {"distinct_views": len(unique), "center_span_normalized": center_span.tolist(),
            "perspective_span": tilt_span.tolist()}


def fit_corners(views, image_size, *, columns, rows, square_mm, camera_id,
                names=None, max_rms_px=2.0, max_holdout_rms_px=3.0) -> dict:
    """Fit K on training views only; reserve every fifth view for pose/reprojection checks."""
    obj = board_points(columns, rows, square_mm)
    if not isinstance(camera_id, str) or not camera_id.strip():
        raise IntrinsicsError("a nonempty physical camera_id is required")
    if (len(image_size) != 2 or any(isinstance(v, bool) or not isinstance(v, (int, np.integer)) or v < 64 for v in image_size)):
        raise IntrinsicsError("image_size must contain two integer dimensions of at least 64 pixels")
    if any(not math.isfinite(v) or v <= 0 for v in (max_rms_px, max_holdout_rms_px)):
        raise IntrinsicsError("reprojection thresholds must be positive finite pixels")
    if len(views) < 10:
        raise IntrinsicsError("at least 10 detected checkerboard views are required; capture 15–25")
    size = tuple(int(v) for v in image_size)
    checked = []
    for view in views:
        array = np.asarray(view, dtype=np.float32)
        if array.shape not in ((len(obj), 2), (len(obj), 1, 2)) or not np.isfinite(array).all():
            raise IntrinsicsError("invalid checkerboard corner shape or nonfinite coordinates")
        array = array.reshape(-1, 1, 2)
        if np.any(array < 0) or np.any(array.reshape(-1, 2) >= size):
            raise IntrinsicsError("checkerboard corners must be inside the image")
        checked.append(array)
    names = list(names) if names is not None else [str(i) for i in range(len(views))]
    if len(names) != len(views):
        raise IntrinsicsError("one source name is required per view")
    holdout = [i for i in range(len(views)) if i % 5 == 4]
    train = [i for i in range(len(views)) if i not in holdout]
    diversity = _diversity([checked[i] for i in train], size, columns, rows)
    try:
        rms, matrix, distortion, _, _ = cv2.calibrateCamera(
            [obj] * len(train), [checked[i] for i in train], size, None, None)
        errors = []
        for i in holdout:
            ok, rotation, translation = cv2.solvePnP(obj, checked[i], matrix, distortion)
            if not ok:
                raise IntrinsicsError("held-out checkerboard pose could not be estimated")
            projected, _ = cv2.projectPoints(obj, rotation, translation, matrix, distortion)
            errors.append(float(np.sqrt(np.mean(np.sum((projected - checked[i]) ** 2, axis=2)))))
    except cv2.error as exc:
        raise IntrinsicsError(f"OpenCV calibration failed: {exc}") from exc
    if not np.isfinite(matrix).all() or not np.isfinite(distortion).all() or not math.isfinite(rms):
        raise IntrinsicsError("camera fit returned nonfinite parameters")
    if (not .1 * size[0] < matrix[0, 0] < 10 * size[0] or
            not .1 * size[1] < matrix[1, 1] < 10 * size[1] or
            not -.1 * size[0] < matrix[0, 2] < 1.1 * size[0] or
            not -.1 * size[1] < matrix[1, 2] < 1.1 * size[1]):
        raise IntrinsicsError("implausible intrinsics; improve checkerboard pose diversity and inspect captures")
    if rms > max_rms_px or any(not math.isfinite(e) or e > max_holdout_rms_px for e in errors):
        raise IntrinsicsError(f"reprojection check failed: training RMS {rms:.2f}px, held-out RMS {errors}")
    return {"schema_version": 1, "camera_id": camera_id.strip(), "image_size": list(size),
            "camera_matrix": matrix.tolist(), "distortion_coefficients": distortion.ravel().tolist(),
            "rms_px": float(rms), "validation": {"view_rms_px": errors,
                "mean_view_rms_px": float(np.mean(errors)), "max_view_rms_px": max(errors),
                "source_views": [names[i] for i in holdout],
                "interpretation": "K and distortion frozen; pose fitted to held-out corners. Reprojection consistency, not independent intrinsic ground truth."},
            "protocol": {"name": "checkerboard-holdout-v1", "columns": columns, "rows": rows,
                "square_mm": square_mm, "train_views": [names[i] for i in train],
                "split": "every fifth detected view held out; no final refit",
                "max_rms_px": max_rms_px, "max_holdout_rms_px": max_holdout_rms_px,
                "distortion_model": "OpenCV pinhole k1,k2,p1,p2,k3", "diversity": diversity}}


def calibrate_directory(directory, *, columns, rows, square_mm, camera_id, **kwargs):
    board_points(columns, rows, square_mm)
    directory = Path(directory)
    if not directory.is_dir():
        raise IntrinsicsError("image directory does not exist")
    metadata_path = directory / "capture.json"
    metadata = json.loads(metadata_path.read_text()) if metadata_path.exists() else None
    if metadata:
        if camera_id is not None and camera_id != metadata.get("camera_id"):
            raise IntrinsicsError("camera_id does not match the captured physical camera")
        camera_id = metadata.get("camera_id")
        if metadata.get("board") != {"columns": columns, "rows": rows, "square_mm": square_mm}:
            raise IntrinsicsError("checkerboard parameters do not match capture metadata")
    paths = sorted(p for p in directory.iterdir() if p.suffix.lower() in {".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff"})
    views, names, rejected = [], [], []
    size = None
    for path in paths:
        gray = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
        if gray is None:
            raise IntrinsicsError(f"cannot decode image: {path.name}")
        this_size = (gray.shape[1], gray.shape[0])
        if metadata and list(this_size) != metadata.get("image_size"):
            raise IntrinsicsError("image resolution does not match capture metadata")
        if size is not None and this_size != size:
            raise IntrinsicsError("all calibration images must have exactly the same resolution")
        size = this_size
        found, corners = cv2.findChessboardCorners(gray, (columns, rows), cv2.CALIB_CB_ADAPTIVE_THRESH | cv2.CALIB_CB_NORMALIZE_IMAGE)
        if not found:
            rejected.append(path.name)
            continue
        corners = cv2.cornerSubPix(gray, corners, (5, 5), (-1, -1),
                                  (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_MAX_ITER, 40, .001))
        views.append(corners)
        names.append(path.name)
    if size is None:
        raise IntrinsicsError("no supported images found")
    result = fit_corners(views, size, columns=columns, rows=rows, square_mm=square_mm,
                         camera_id=camera_id, names=names, **kwargs)
    result["protocol"]["undetected_views"] = rejected
    return result


def capture_directory(directory, *, columns, rows, square_mm, camera=None, width=1280, height=720):
    """Open a camera only on explicit invocation; Space saves, Escape/q exits."""
    from .camera import Camera

    board_points(columns, rows, square_mm)
    if width < 64 or height < 64:
        raise IntrinsicsError("capture dimensions must be at least 64 pixels")
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=False)
    window = "Camera calibration: Space saves; q/Escape exits"
    count, seq = 0, 0
    last_saved = None
    status = "Move and tilt the board; save 15-25 distinct views"
    tracker = Camera(camera, width=width, height=height)
    try:
        tracker.start()
        metadata = {"schema_version": 1, "camera_id": tracker.info.unique_id,
                    "camera_name": tracker.info.name, "image_size": list(tracker.frame_size),
                    "board": {"columns": columns, "rows": rows, "square_mm": square_mm},
                    "mirrored": False}
        (directory / "capture.json").write_text(json.dumps(metadata, indent=2) + "\n")
        while True:
            frame = tracker.read(after=seq, timeout=.1)
            found, corners = False, None
            if frame is not None:
                seq = frame.seq
                gray = cv2.cvtColor(frame.image, cv2.COLOR_BGR2GRAY)
                found, corners = cv2.findChessboardCorners(gray, (columns, rows),
                    cv2.CALIB_CB_ADAPTIVE_THRESH | cv2.CALIB_CB_NORMALIZE_IMAGE | cv2.CALIB_CB_FAST_CHECK)
                preview = frame.image.copy()
                if found:
                    cv2.drawChessboardCorners(preview, (columns, rows), corners, True)
                for line, text in enumerate((f"Board {'detected' if found else 'not detected'} | saved {count}",
                                             "Space: save | q/Esc: finish | vary tilt, position, distance", status)):
                    cv2.putText(preview, text, (15, 30 + 28 * line), cv2.FONT_HERSHEY_SIMPLEX,
                                .65, (0, 255, 0) if found else (0, 160, 255), 2)
                cv2.imshow(window, preview)
            key = cv2.waitKey(1) & 0xff
            if key in (27, ord("q")):
                break
            if key == 32:
                if not found:
                    status = "Not saved: show every inner corner clearly"
                elif last_saved is not None and np.sqrt(np.mean(((corners - last_saved) / tracker.frame_size) ** 2)) < .015:
                    status = "Not saved: change board position or tilt first"
                else:
                    path = directory / f"view-{count:03d}.png"
                    if not cv2.imwrite(str(path), frame.image):
                        raise IntrinsicsError("could not save checkerboard image")
                    last_saved = corners.copy()
                    count += 1
                    status = f"Saved {path.name}; try another tilt/position/distance"
    finally:
        tracker.stop()
        cv2.destroyAllWindows()
    return count


def board_svg(columns, rows, square_mm):
    board_points(columns, rows, square_mm)
    width, height = (columns + 3) * square_mm, (rows + 3) * square_mm
    pieces = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}mm" height="{height}mm" viewBox="0 0 {width} {height}">',
              f'<rect width="{width}" height="{height}" fill="white"/>']
    for y in range(rows + 1):
        for x in range(columns + 1):
            if (x + y) % 2 == 0:
                pieces.append(f'<rect x="{(x + 1) * square_mm}" y="{(y + 1) * square_mm}" width="{square_mm}" height="{square_mm}" fill="black"/>')
    return "\n".join([*pieces, "</svg>"])


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("board", "capture", "fit"))
    parser.add_argument("--columns", type=int, required=True, help="inner corner columns, not squares")
    parser.add_argument("--rows", type=int, required=True, help="inner corner rows, not squares")
    parser.add_argument("--square-mm", type=float, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--images", type=Path)
    parser.add_argument("--camera-id")
    parser.add_argument("--camera", help="capture camera name substring or index")
    parser.add_argument("--width", type=int, default=1280)
    parser.add_argument("--height", type=int, default=720)
    args = parser.parse_args(argv)
    try:
        if args.operation == "capture":
            count = capture_directory(args.output, columns=args.columns, rows=args.rows,
                                      square_mm=args.square_mm, camera=args.camera, width=args.width, height=args.height)
            print(f"saved {count} views in {args.output}; fit reads the recorded camera ID")
            return
        elif args.operation == "board":
            content = board_svg(args.columns, args.rows, args.square_mm)
        else:
            if args.images is None:
                parser.error("fit requires --images")
            content = json.dumps(calibrate_directory(args.images, columns=args.columns, rows=args.rows,
                                 square_mm=args.square_mm, camera_id=args.camera_id), indent=2, allow_nan=False)
        # Explicit output only, and preserve any existing calibration file.
        with args.output.open("x") as output:
            output.write(content + "\n")
    except (IntrinsicsError, OSError, RuntimeError) as exc:
        parser.error(str(exc))
    print(f"saved {args.output}")


if __name__ == "__main__":
    main()
