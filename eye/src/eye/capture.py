"""Explicit, bounded, local image capture for reproducible model comparisons.

No capture occurs unless constructed by --record-images. Lossless BGR PNGs
retain precisely the pixels passed to the incumbent model. The JSONL ledger
includes dropped frames; capture must never silently improve evaluation coverage.
"""
from __future__ import annotations

from dataclasses import asdict
import hashlib
import json
from pathlib import Path
import queue
import threading
import time
import uuid

import cv2


class ImageCapture:
    def __init__(self, root: Path, metadata: dict, *, max_bytes: int = 2_000_000_000,
                 queue_size: int = 8):
        if max_bytes <= 0 or queue_size <= 0:
            raise ValueError("capture limits must be positive")
        self.path = Path(root) / (time.strftime("capture-%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:8])
        self.path.mkdir(parents=True, mode=0o700)
        self.metadata = dict(metadata)
        self.max_bytes = max_bytes
        self.bytes_written = 0
        self.written = 0
        self.dropped = 0
        self.error = None
        self._closed = False
        self._lock = threading.Lock()
        self._queue = queue.Queue(maxsize=queue_size)
        self._ledger = (self.path / "frames.jsonl").open("x")
        self._manifest(status="recording")
        self._worker = threading.Thread(target=self._write_loop, name="eye-image-capture", daemon=True)
        self._worker.start()

    def _manifest(self, **extra):
        data = {"schema": "eye-image-capture-v1", "encoding": "lossless-png-bgr",
                "timestamps": "host-monotonic-arrival-not-exposure", "metadata": self.metadata,
                "max_bytes": self.max_bytes, "bytes_written": self.bytes_written,
                "written": self.written, "dropped": self.dropped, "error": self.error, **extra}
        temporary = self.path / "manifest.tmp"
        temporary.write_text(json.dumps(data, indent=2, allow_nan=False))
        temporary.replace(self.path / "manifest.json")

    def _record(self, row):
        # caller holds the lock; a failure is visible in the final manifest.
        self._ledger.write(json.dumps(row, allow_nan=False) + "\n")
        self._ledger.flush()

    def submit(self, frame, *, timing=None):
        with self._lock:
            if self._closed:
                raise RuntimeError("capture already closed")
            row = {"seq": frame.seq, "t": frame.t,
                   "size": [frame.image.shape[1], frame.image.shape[0]],
                   "timing": timing or {}}
            if self.error or self.bytes_written >= self.max_bytes:
                row["dropped"] = "writer_error" if self.error else "byte_limit"
            else:
                try:
                    self._queue.put_nowait((frame.image.copy(), row))
                    return True
                except queue.Full:
                    row["dropped"] = "queue_full"
            self.dropped += 1
            self._record(row)
            return False

    def _write_loop(self):
        while True:
            item = self._queue.get()
            if item is None:
                return
            image, row = item
            try:
                ok, png = cv2.imencode(".png", image, [cv2.IMWRITE_PNG_COMPRESSION, 1])
                if not ok:
                    raise RuntimeError("PNG encoding failed")
                with self._lock:
                    if self.bytes_written + png.nbytes > self.max_bytes:
                        row["dropped"] = "byte_limit"
                        self.dropped += 1
                    else:
                        filename = f"{row['seq']:09d}.png"
                        data = png.tobytes()
                        with (self.path / filename).open("xb") as file:
                            file.write(data)
                        self.bytes_written += len(data)
                        self.written += 1
                        row.update(file=filename, sha256=hashlib.sha256(data).hexdigest())
                    self._record(row)
            except Exception as exc:
                with self._lock:
                    self.error = f"{type(exc).__name__}: {exc}"
                    self.dropped += 1
                    try:
                        self._record({**row, "dropped": "writer_error", "error": self.error})
                    except OSError:
                        pass

    def close(self, *, status="complete", session_path=None, script=None, clock=None):
        with self._lock:
            if self._closed:
                return
            self._closed = True
        self._queue.put(None)
        self._worker.join()
        self._ledger.close()
        session = None
        if session_path is not None:
            session_path = Path(session_path).resolve()
            session = {"path": str(session_path),
                       "sha256": hashlib.sha256(session_path.read_bytes()).hexdigest()}
        self._manifest(status=status, session=session, script=script, clock=clock,
                       finished_utc=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))


def camera_metadata(camera):
    """Measured dimensions, requested settings, and explicitly unknown geometry."""
    return {"device": asdict(camera.info) if camera.info is not None else None,
            "requested": {"width": camera.width, "height": camera.height, "fps": camera.fps},
            "actual_size": list(camera.frame_size),
            "intrinsics": None, "distortion": None, "screen_extrinsics": None,
            "exposure_timestamp_available": False}
