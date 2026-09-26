"""Webcam capture.

OpenCV does the capturing; PyObjC handles the parts OpenCV is bad at on macOS:
asking for camera permission and telling us which index is which camera.
OpenCV numbers devices by sorting AVCaptureDevice.devicesWithMediaType (video,
then muxed) by uniqueID, so listing them the same way maps names to indices.
That matters when an iPhone Continuity Camera is around: on matt's Mac the
iPhone sorts first and is index 0. Only the built-in camera is fixed relative
to the screen, which is what calibration depends on.
"""

from __future__ import annotations

import os
import threading
import time
from dataclasses import dataclass

# We request camera access ourselves (OpenCV's own request can't work off the main thread).
os.environ.setdefault("OPENCV_AVFOUNDATION_SKIP_AUTH", "1")

import cv2  # noqa: E402
import numpy as np  # noqa: E402


class CameraError(RuntimeError):
    pass


@dataclass(frozen=True)
class CameraInfo:
    index: int
    name: str
    unique_id: str
    builtin: bool


@dataclass
class Frame:
    image: np.ndarray  # BGR
    t: float  # time.monotonic() when the frame arrived
    seq: int


def list_cameras() -> list[CameraInfo]:
    import AVFoundation as AV

    devices = list(AV.AVCaptureDevice.devicesWithMediaType_(AV.AVMediaTypeVideo))
    devices += list(AV.AVCaptureDevice.devicesWithMediaType_(AV.AVMediaTypeMuxed))
    devices.sort(key=lambda d: str(d.uniqueID()))  # same order as cap_avfoundation_mac.mm
    builtin = str(AV.AVCaptureDeviceTypeBuiltInWideAngleCamera)
    return [
        CameraInfo(i, str(d.localizedName()), str(d.uniqueID()), str(d.deviceType()) == builtin)
        for i, d in enumerate(devices)
    ]


def camera_access(request: bool = True, timeout: float = 120.0) -> bool:
    """True if we may use the camera; triggers the macOS prompt the first time."""
    import AVFoundation as AV

    status = AV.AVCaptureDevice.authorizationStatusForMediaType_(AV.AVMediaTypeVideo)
    if status == AV.AVAuthorizationStatusAuthorized:
        return True
    if status != AV.AVAuthorizationStatusNotDetermined or not request:
        return False
    done = threading.Event()
    granted = []

    def handler(ok):
        granted.append(bool(ok))
        done.set()

    AV.AVCaptureDevice.requestAccessForMediaType_completionHandler_(AV.AVMediaTypeVideo, handler)
    done.wait(timeout)
    return bool(granted and granted[0])


def resolve_camera(which: str | int | None) -> CameraInfo:
    cams = list_cameras()
    if not cams:
        raise CameraError("no cameras found")
    if which is None:
        return next((c for c in cams if c.builtin), cams[0])
    if isinstance(which, int) or str(which).isdigit():
        idx = int(which)
        if idx >= len(cams):
            raise CameraError(f"camera index {idx} out of range: {[c.name for c in cams]}")
        return cams[idx]
    needle = str(which).lower()
    for c in cams:
        if needle in c.name.lower():
            return c
    raise CameraError(f"no camera matching {which!r}: {[c.name for c in cams]}")


class Camera:
    """Background reader that always hands out the newest frame (stale frames are dropped)."""

    def __init__(self, which: str | int | None = None, width: int = 1280, height: int = 720, fps: int = 30):
        self.which = which
        self.width, self.height, self.fps = width, height, fps
        self.info: CameraInfo | None = None
        self._cap = None
        self._thread: threading.Thread | None = None
        self._cond = threading.Condition()
        self._latest: Frame | None = None
        self._running = False
        self.frame_size: tuple[int, int] = (0, 0)

    def start(self) -> "Camera":
        if not camera_access():
            raise CameraError(
                "camera access denied. System Settings > Privacy & Security > Camera, "
                "enable the terminal app you ran this from, then restart it."
            )
        self.info = resolve_camera(self.which)
        cap = cv2.VideoCapture(self.info.index, cv2.CAP_AVFOUNDATION)
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, self.width)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self.height)
        cap.set(cv2.CAP_PROP_FPS, self.fps)
        if not cap.isOpened():
            raise CameraError(f"could not open camera {self.info.name!r}")
        image = None
        for _ in range(50):  # the first reads can fail while the device spins up
            ok, image = cap.read()
            if ok and image is not None:
                break
            time.sleep(0.05)
        if image is None:
            cap.release()
            raise CameraError(f"camera {self.info.name!r} opened but produced no frames")
        self.frame_size = (image.shape[1], image.shape[0])
        self._cap = cap
        self._running = True
        self._thread = threading.Thread(target=self._loop, name="eye-camera", daemon=True)
        self._thread.start()
        return self

    def _loop(self) -> None:
        seq = 0
        while self._running:
            ok, image = self._cap.read()
            if not ok or image is None:
                time.sleep(0.005)
                continue
            seq += 1
            with self._cond:
                self._latest = Frame(image, time.monotonic(), seq)
                self._cond.notify_all()

    def read(self, after: int = 0, timeout: float = 1.0) -> Frame | None:
        """Newest frame with seq > after, waiting up to timeout seconds."""
        deadline = time.monotonic() + timeout
        with self._cond:
            while self._latest is None or self._latest.seq <= after:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not self._running:
                    return None
                self._cond.wait(remaining)
            return self._latest

    def stop(self) -> None:
        self._running = False
        if self._thread:
            self._thread.join(timeout=1.0)
        if self._cap is not None:
            self._cap.release()
            self._cap = None

    def __enter__(self) -> "Camera":
        return self.start()

    def __exit__(self, *exc) -> None:
        self.stop()
