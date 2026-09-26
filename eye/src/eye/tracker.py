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
    def __init__(self, camera: str | int | None = None, on_frame: FrameCallback | None = None, width: int = 1280, height: int = 720):
        self.camera = Camera(camera, width=width, height=height)
        self.on_frame = on_frame
        self.blend_names: list[str] = []
        self.fps = 0.0
        self.latency_ms = 0.0  # frame arrival -> features ready
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
        self._ready.wait(30)
        if self.error:
            raise self.error
        return self

    def _loop(self) -> None:
        try:
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
                seq = frame.seq
                obs = face.process(frame.image, frame.t)
                feats = None
                if obs is not None:
                    if idx is None:
                        self.blend_names = list(face.blend_names)
                        idx = BlendIdx.from_names(self.blend_names)
                    feats = extract(obs, idx)
                    self.last_face_t = frame.t
                self.face_visible = obs is not None
                now = time.monotonic()
                self.latency_ms = 0.9 * self.latency_ms + 0.1 * (now - frame.t) * 1000
                if last is not None and frame.t > last:
                    self.fps = 0.9 * self.fps + 0.1 / (frame.t - last)
                last = frame.t
                if self.on_frame:
                    self.on_frame(frame, obs, feats)
        finally:
            face.close()

    def stop(self) -> None:
        self._running = False
        if self._thread:
            self._thread.join(timeout=2.0)
        self.camera.stop()
