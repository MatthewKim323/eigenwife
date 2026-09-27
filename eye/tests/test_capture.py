import json
import threading
from types import SimpleNamespace
import cv2
import numpy as np
import pytest
from eye.camera import Frame
from eye.capture import ImageCapture, camera_metadata


def rows(capture):
    return [json.loads(line) for line in (capture.path / "frames.jsonl").read_text().splitlines()]


def test_lossless_capture_and_session_identity(tmp_path):
    image = np.random.default_rng(12).integers(0, 256, (24, 32, 3), dtype=np.uint8)
    expected = image.copy()
    capture = ImageCapture(tmp_path, {"camera": "test"})
    assert capture.submit(Frame(image, 1.5, 1), timing={"face_ms": 3})
    image[:] = 0
    session = tmp_path / "session.npz"
    session.write_bytes(b"saved session")
    capture.close(session_path=session, script="[]", clock=[[1.5, 0]])
    row, = rows(capture)
    assert np.array_equal(cv2.imread(str(capture.path / row["file"])), expected)
    manifest = json.loads((capture.path / "manifest.json").read_text())
    assert manifest["written"] == 1 and manifest["dropped"] == 0
    assert manifest["session"]["path"] == str(session.resolve())
    assert len(manifest["session"]["sha256"]) == 64
    assert row["timing"]["face_ms"] == 3
    capture.close()
    with pytest.raises(RuntimeError, match="closed"):
        capture.submit(Frame(image, 2, 2))


def test_limit_records_drops_without_writing_images(tmp_path):
    capture = ImageCapture(tmp_path, {}, max_bytes=1)
    capture.submit(Frame(np.zeros((10, 10, 3), np.uint8), 1, 1))
    capture.close(status="cancelled")
    row, = rows(capture)
    assert row["dropped"] == "byte_limit"
    assert not list(capture.path.glob("*.png"))
    manifest = json.loads((capture.path / "manifest.json").read_text())
    assert manifest["status"] == "cancelled" and manifest["dropped"] == 1


def test_queue_overload_is_explicit_and_does_not_block_tracker(tmp_path, monkeypatch):
    entered, release = threading.Event(), threading.Event()
    original = cv2.imencode
    def blocked(*args):
        entered.set()
        assert release.wait(2)
        return original(*args)
    monkeypatch.setattr(cv2, "imencode", blocked)
    capture = ImageCapture(tmp_path, {}, queue_size=1)
    image = np.zeros((10, 10, 3), np.uint8)
    capture.submit(Frame(image, 1, 1))
    assert entered.wait(2)
    assert capture.submit(Frame(image, 2, 2))
    assert not capture.submit(Frame(image, 3, 3))
    release.set()
    capture.close()
    result = sorted(rows(capture), key=lambda row: row["seq"])
    assert len(result) == 3 and result[-1]["dropped"] == "queue_full"
    assert capture.written == 2 and capture.dropped == 1


def test_encoder_failure_survives_and_is_reported(tmp_path, monkeypatch):
    monkeypatch.setattr(cv2, "imencode", lambda *args: (False, None))
    capture = ImageCapture(tmp_path, {})
    capture.submit(Frame(np.zeros((2, 2, 3), np.uint8), 1, 1))
    capture.close()
    assert "encoding failed" in capture.error
    assert rows(capture)[0]["dropped"] == "writer_error"


def test_camera_metadata_does_not_invent_intrinsics():
    camera = SimpleNamespace(info=None, width=1920, height=1080, fps=30, frame_size=(1280, 720))
    metadata = camera_metadata(camera)
    assert metadata["requested"]["width"] == 1920
    assert metadata["actual_size"] == [1280, 720]
    assert metadata["intrinsics"] is None
    assert not metadata["exposure_timestamp_available"]
