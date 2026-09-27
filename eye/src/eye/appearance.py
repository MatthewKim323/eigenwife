"""Optional MGazeNet appearance features for personal screen calibration.

Research/noncommercial adapter. Preprocessing is adapted from Gancheng Zhu's
GazeFollower (CC BY-NC-SA 4.0); the downloaded model has the same license:
https://github.com/GanchengZhu/GazeFollower/tree/13806edabefe76fc6b964c4c5bdcd62846c1ac1d
https://creativecommons.org/licenses/by-nc-sa/4.0/
This module's adapted preprocessing is provided under CC BY-NC-SA 4.0.

Changes: reuse this project's FaceObs, explicit BGR->RGB conversion, no temporal
box filtering, checksum-pinned external weights, and explicit failure handling.
The upstream camera sends RGB to MGazeNet; its FaceAlignment docstring saying
BGR must not be used to infer the gaze network's color order. Inputs are RGB
0..1 NHWC, with the image-right eye flipped. Output contains two uncalibrated
coordinates and a 256-value embedding. None are screen coordinates until fitted.

Install: uv sync --extra appearance. Call prepare_model(download=True) once;
construct MGazeNetFeatures on the inference thread and call extract(bgr, obs).
No camera or network is accessed by extract. Do not share an instance across
threads. Calibration must record FINGERPRINT to prevent feature-schema mixing.
"""

from __future__ import annotations

import hashlib
import ssl
import tempfile
import urllib.request
from pathlib import Path
from typing import TYPE_CHECKING

import cv2
import numpy as np

from . import paths

if TYPE_CHECKING:
    from .face import FaceObs

UPSTREAM_COMMIT = "13806edabefe76fc6b964c4c5bdcd62846c1ac1d"
MODEL_SHA256 = "2f96b95275fe6d7b79e98df3237ebb96e15ef5522c96968f08167da7e1954a96"
MODEL_URL = f"https://raw.githubusercontent.com/GanchengZhu/GazeFollower/{UPSTREAM_COMMIT}/gazefollower/res/model_weights/base.mnn"
FEATURE_COUNT = 258
FINGERPRINT = f"mgazenet-rgb-unsmoothed-v1:{MODEL_SHA256}"


class AppearanceError(RuntimeError):
    """The optional model cannot load or a frame cannot be safely processed."""


def prepare_model(model_path: str | Path | None = None, *, download: bool = False) -> Path:
    """Return verified pinned weights. Download only when explicitly requested."""
    path = Path(model_path) if model_path is not None else paths.home() / "models" / "mgazenet-base.mnn"
    if path.exists():
        if hashlib.sha256(path.read_bytes()).hexdigest() != MODEL_SHA256:
            raise AppearanceError(f"MGazeNet checksum mismatch: {path}; expected pinned research model")
        return path
    if not download:
        raise AppearanceError("MGazeNet model missing; prepare the appearance backend before calibration")
    path.parent.mkdir(parents=True, exist_ok=True)
    temp: Path | None = None
    try:
        try:
            import certifi
            context = ssl.create_default_context(cafile=certifi.where())
        except ImportError:
            context = ssl.create_default_context()
        with urllib.request.urlopen(MODEL_URL, timeout=60, context=context) as response:
            data = response.read(20 * 1024 * 1024 + 1)
        if hashlib.sha256(data).hexdigest() != MODEL_SHA256:
            raise AppearanceError("downloaded MGazeNet weights failed checksum verification")
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix="mgazenet-", suffix=".part", delete=False) as out:
            temp = Path(out.name)
            out.write(data)
        temp.replace(path)
    except AppearanceError:
        raise
    except Exception as exc:
        raise AppearanceError(f"could not prepare MGazeNet weights: {exc}") from exc
    finally:
        if temp is not None:
            temp.unlink(missing_ok=True)
    return path


def preprocess(bgr: np.ndarray, obs: FaceObs) -> tuple[np.ndarray, ...]:
    """Match upstream unsmoothed face/eye crops and normalized rectangle order."""
    if bgr.ndim != 3 or bgr.shape[2] != 3 or bgr.dtype != np.uint8:
        raise AppearanceError("MGazeNet requires a uint8 BGR camera image")
    h, w = bgr.shape[:2]
    if obs.size != (w, h):
        raise AppearanceError("face landmarks and image dimensions differ")
    if obs.lm.ndim != 2 or obs.lm.shape[0] < 468 or obs.lm.shape[1] < 2 or not np.isfinite(obs.lm).all():
        raise AppearanceError("invalid face landmarks")
    lm = np.round(obs.lm[:, :2])
    if np.mean(lm[[61, 91, 14, 178, 402, 324, 95], 1]) >= h:
        raise AppearanceError("face extends beyond camera image")
    lo = np.maximum(lm.min(axis=0), 0)
    hi = np.minimum(lm.max(axis=0), [w, h])
    delta = ((hi[0] - lo[0]) - (hi[1] - lo[1])) / 4
    face = [int(max(0, lo[0] + delta)), int(max(0, lo[1] - delta)),
            int(min(w - 1, hi[0] - delta)), int(min(h - 1, hi[1] + delta))]
    padding = abs(lm[362, 0] - lm[133, 0]) * 0.2
    boxes = [face]
    for a, b in ((33, 133), (362, 263)):
        x0, x1 = lm[a, 0] - padding, lm[b, 0] + padding
        eh = abs(x1 - x0) * 0.75
        cy = (lm[a, 1] + lm[b, 1]) / 2
        box = [int(x0), int(cy - 0.6 * eh), int(x1), int(cy + 0.4 * eh)]
        if box[0] <= 0 or box[1] <= 0 or box[2] >= w or box[3] >= h:
            raise AppearanceError("eye crop extends beyond camera image; center your face")
        boxes.append(box)
    patches, rect = [], []
    for i, (x0, y0, x1, y1) in enumerate(boxes):
        if x1 - x0 < 5 or y1 - y0 < 5:
            raise AppearanceError("face or eye crop is too small")
        size = (224, 224) if i == 0 else (112, 112)
        patch = cv2.resize(bgr[y0:y1, x0:x1], size)
        patch = cv2.cvtColor(patch, cv2.COLOR_BGR2RGB)
        if i == 2:
            patch = cv2.flip(patch, 1)
        patches.append(np.ascontiguousarray(patch[None], dtype=np.float32) / 255.0)
        rect.extend(((x1 - x0) / w, (y1 - y0) / h, x0 / w, y0 / h))
    return (*patches, np.array([rect], dtype=np.float32))


class MGazeNetFeatures:
    """CPU inference with pinned optional MNN; output is a 258-float vector."""

    fingerprint = FINGERPRINT
    feature_count = FEATURE_COUNT

    def __init__(self, model_path: str | Path | None = None):
        try:
            import MNN
        except ImportError as exc:
            raise AppearanceError("appearance backend requires: uv sync --extra appearance") from exc
        path = prepare_model(model_path)
        try:
            self._runtime = MNN.nn.create_runtime_manager(({"precision": "normal", "backend": 0, "numThread": 2},))
            self._module = MNN.nn.load_module_from_file(
                str(path), ["face", "left", "right", "rect"], ["output_0"], runtime_manager=self._runtime,
            )
            self._inputs = [MNN.expr.placeholder(shape, MNN.expr.NHWC) for shape in
                            ((1, 224, 224, 3), (1, 112, 112, 3), (1, 112, 112, 3))]
            self._inputs.append(MNN.expr.placeholder((1, 12)))
        except Exception as exc:
            raise AppearanceError(f"could not load MGazeNet: {exc}") from exc

    def extract(self, bgr: np.ndarray, obs: FaceObs) -> np.ndarray:
        inputs = preprocess(bgr, obs)
        try:
            for tensor, array in zip(self._inputs, inputs, strict=True):
                tensor.write(array)
            outputs = self._module.onForward(self._inputs)
            if len(outputs) != 1:
                raise AppearanceError("MGazeNet returned an unexpected output count")
            vector = np.array(outputs[0].read(), dtype=np.float64, copy=True).reshape(-1)
        except AppearanceError:
            raise
        except Exception as exc:
            raise AppearanceError(f"MGazeNet inference failed: {exc}") from exc
        if vector.shape != (FEATURE_COUNT,) or not np.isfinite(vector).all():
            raise AppearanceError("MGazeNet returned invalid appearance features")
        return vector
