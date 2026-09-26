"""MediaPipe Face Landmarker (Tasks API) wrapper.

Pinned to mediapipe 1.0.0: 1.0.1 aborts on macOS at graph creation
("graph_service.h Check failed: service_ Service is unavailable" from
DrishtiMetalHelper), even on the CPU delegate. The GPU delegate aborts the same
way, so we run on CPU, which is ~7ms per frame on an M2 anyway.
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import mediapipe as mp
import numpy as np
from mediapipe.tasks.python import vision
from mediapipe.tasks.python.core.base_options import BaseOptions

from . import paths


@dataclass
class FaceObs:
    t: float
    size: tuple[int, int]  # (w, h) of the source image
    lm: np.ndarray  # (478, 3) float32; x, y in pixels, z in the same scale as x
    blend: np.ndarray  # (52,) float32 blendshape scores, see FaceTracker.blend_names
    matrix: np.ndarray  # (4, 4) canonical face model -> camera space (cm)


class FaceTracker:
    def __init__(self, model_path=None, min_confidence: float = 0.5):
        options = vision.FaceLandmarkerOptions(
            base_options=BaseOptions(
                model_asset_path=str(model_path or paths.model_file()),
                delegate=BaseOptions.Delegate.CPU,
            ),
            running_mode=vision.RunningMode.VIDEO,
            num_faces=1,
            min_face_detection_confidence=min_confidence,
            min_face_presence_confidence=min_confidence,
            min_tracking_confidence=min_confidence,
            output_face_blendshapes=True,
            output_facial_transformation_matrixes=True,
        )
        self._landmarker = vision.FaceLandmarker.create_from_options(options)
        self._last_ms = -1
        self.blend_names: list[str] = []

    def blend_index(self, name: str) -> int:
        return self.blend_names.index(name)

    def process(self, bgr: np.ndarray, t: float) -> FaceObs | None:
        # VIDEO mode wants strictly increasing integer timestamps.
        ms = max(int(t * 1000), self._last_ms + 1)
        self._last_ms = ms
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        result = self._landmarker.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb), ms)
        if not result.face_landmarks:
            return None
        h, w = bgr.shape[:2]
        lm = np.array([(p.x * w, p.y * h, p.z * w) for p in result.face_landmarks[0]], dtype=np.float32)
        cats = result.face_blendshapes[0]
        if not self.blend_names:
            self.blend_names = [c.category_name for c in cats]
        blend = np.array([c.score for c in cats], dtype=np.float32)
        matrix = np.asarray(result.facial_transformation_matrixes[0], dtype=np.float32)
        return FaceObs(t=t, size=(w, h), lm=lm, blend=blend, matrix=matrix)

    def close(self) -> None:
        self._landmarker.close()
