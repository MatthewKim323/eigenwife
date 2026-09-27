"""Camera -> face landmarks -> features, on a background thread."""

from __future__ import annotations

import threading
import time
from collections.abc import Callable

from .camera import Camera, Frame
from .face import FaceObs, FaceTracker
from .features import BlendIdx, Features, extract

FrameCallback = Callable[[Frame, FaceObs | None, Features | None], None]


class Tracker:
    def __init__(self, camera: str | int | None = None, on_frame: FrameCallback | None = None, width: int = 1280, height: int = 720, appearance=None):
        self.camera = Camera(camera, width=width, height=height)
        self.on_frame = on_frame
        self.appearance = appearance
        self.feature_backend = appearance.metadata if appearance else {"name": "landmarks"}
        self.feature_error: str | None = None
        self.blend_names: list[str] = []
        self.fps = 0.0
        self.latency_ms = 0.0  # frame arrival -> features ready
        self.stage_timing: dict = {}
        self.face_visible = False
        self.last_face_t = 0.0
        self.error: BaseException | None = None
        self._running = False
        self._ready = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> "Tracker":
        self.camera.start()
        self._running = True
        self._thread = threading.Thread(target=self._loop, name="eye-tracker", daemon=True)
        self._thread.start()
        try:
            if not self._ready.wait(30):
                raise RuntimeError("camera model startup timed out")
            if self.error:
                raise self.error
        except BaseException:
            self.stop()
            raise
        return self

    def _loop(self) -> None:
        try:
            appearance = self.appearance() if self.appearance is not None else None
            face = FaceTracker()  # created on this thread; the landmarker is used only here
        except BaseException as e:  # noqa: BLE001
            self.error = e
            self._ready.set()
            return
        self._ready.set()
        idx = None
        seq = 0
        last = None
        try:
            while self._running:
                frame = self.camera.read(after=seq, timeout=1.0)
                if frame is None:
                    continue
                skipped = max(0, frame.seq - seq - 1) if seq else 0
                seq = frame.seq
                started = time.monotonic()
                obs = face.process(frame.image, frame.t)
                face_done = time.monotonic()
                feats = None
                if obs is not None:
                    if idx is None:
                        self.blend_names = list(face.blend_names)
                        idx = BlendIdx.from_names(self.blend_names)
                    feats = extract(obs, idx)
                    if appearance is not None:
                        from .appearance import AppearanceError
                        try:
                            feats.appearance = appearance.extract(frame.image, obs)
                            self.feature_error = None
                        except AppearanceError as exc:
                            self.feature_error = str(exc)
                            # Do not substitute landmark-only predictions for
                            # a model trained on image features.
                    self.last_face_t = frame.t
                self.face_visible = obs is not None
                now = time.monotonic()
                self.stage_timing = {
                    "arrival_t": frame.t, "inference_start_t": started, "features_ready_t": now,
                    "queue_ms": (started - frame.t) * 1000,
                    "face_ms": (face_done - started) * 1000,
                    "features_ms": (now - face_done) * 1000,
                    "arrival_to_features_ms": (now - frame.t) * 1000,
                    "skipped_capture_frames": skipped,
                }
                self.latency_ms = 0.9 * self.latency_ms + 0.1 * (now - frame.t) * 1000
                if last is not None and frame.t > last:
                    self.fps = 0.9 * self.fps + 0.1 / (frame.t - last)
                last = frame.t
                if self.on_frame:
                    self.on_frame(frame, obs, feats)
        except BaseException as exc:
            self.error = exc
        finally:
            face.close()

    def stop(self) -> None:
        self._running = False
        if self._thread:
            self._thread.join(timeout=2.0)
        self.camera.stop()
