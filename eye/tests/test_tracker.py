"""Tracker lifecycle regressions without opening a camera or native models."""

import threading

import pytest

import eye.tracker as module
from eye.appearance import AppearanceError


class FakeCamera:
    def __init__(self, *args, **kwargs):
        self.started = False
        self.stopped = False
        self.closed = threading.Event()

    def start(self):
        self.started = True

    def read(self, **kwargs):
        self.closed.wait(0.005)
        return None

    def stop(self):
        self.stopped = True
        self.closed.set()


class Factory:
    metadata = {"name": "fake", "feature_count": 258, "fingerprint": "test"}

    def __init__(self, initialize):
        self.initialize = initialize

    def __call__(self):
        return self.initialize()


def test_optional_backend_failure_releases_camera_before_face_model(monkeypatch):
    monkeypatch.setattr(module, "Camera", FakeCamera)
    created_faces = []
    monkeypatch.setattr(module, "FaceTracker", lambda: created_faces.append(True))

    def fail():
        raise AppearanceError("optional model unavailable")

    tracker = module.Tracker(appearance=Factory(fail))
    with pytest.raises(AppearanceError, match="optional model unavailable"):
        tracker.start()
    assert tracker.camera.started and tracker.camera.stopped
    assert created_faces == []
    assert tracker._running is False
    assert not tracker._thread.is_alive()


def test_optional_runtime_is_constructed_on_tracking_thread(monkeypatch):
    monkeypatch.setattr(module, "Camera", FakeCamera)
    owner_threads, face_closed = [], []

    class Face:
        def __init__(self):
            owner_threads.append(threading.get_ident())

        def close(self):
            face_closed.append(True)

    monkeypatch.setattr(module, "FaceTracker", Face)

    def initialize():
        owner_threads.append(threading.get_ident())
        return object()

    tracker = module.Tracker(appearance=Factory(initialize))
    tracker.start()
    tracker.stop()
    assert len(owner_threads) == 2
    assert owner_threads[0] == owner_threads[1] == tracker._thread.ident
    assert owner_threads[0] != threading.get_ident()
    assert face_closed == [True]
    assert tracker.camera.stopped


def test_model_startup_timeout_releases_camera(monkeypatch):
    monkeypatch.setattr(module, "Camera", FakeCamera)
    tracker = module.Tracker()
    # Simulate a worker that exits without reporting ready; no actual delay.
    monkeypatch.setattr(tracker, "_loop", lambda: None)
    monkeypatch.setattr(tracker._ready, "wait", lambda timeout: False)
    with pytest.raises(RuntimeError, match="startup timed out"):
        tracker.start()
    assert tracker.camera.stopped
    assert tracker._running is False
    assert not tracker._thread.is_alive()
