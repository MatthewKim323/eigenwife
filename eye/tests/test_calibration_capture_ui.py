"""Exercise native-controller recording lifecycle without opening any window."""
from types import SimpleNamespace
import json
import numpy as np

from eye.camera import Frame
from eye.ui.calibrate import EyeCalibrator
from eye import calibration as cal
from eye.capture_replay import CaptureReplay


def controller(tmp_path, monkeypatch):
    monkeypatch.setattr(cal.paths, "sessions_dir", lambda: tmp_path)
    tracker = SimpleNamespace(feature_backend={"name": "landmarks"}, blend_names=[],
                              stage_timing={}, camera=SimpleNamespace(info=None, width=32,
                              height=24, fps=30, frame_size=(32, 24)))
    display = SimpleNamespace(name="test", w=100, h=100, mm=(100, 100))
    return EyeCalibrator.alloc().init().setup(display, tracker, cal.Script([]), "test",
                                             capture_root=tmp_path, candidate_only=True)


def test_capture_only_begins_on_user_start_and_preserves_missing_faces(tmp_path, monkeypatch):
    owner = controller(tmp_path, monkeypatch)
    assert not list(tmp_path.iterdir())
    owner.begin()
    owner.rec.clock.append((1., 0.))
    owner.on_frame(Frame(np.zeros((24, 32, 3), np.uint8), 1., 1), None, None)
    owner.state = "results"
    owner._finish_capture("complete")
    replay = CaptureReplay(owner.capture_paths[0])
    frame, = replay.frames()
    assert frame.image is not None
    assert frame.observation is None
    assert owner.saved_path is None  # capture never activates a calibration


def test_redo_finalizes_previous_capture_and_starts_separate_directory(tmp_path, monkeypatch):
    owner = controller(tmp_path, monkeypatch)
    owner.begin()
    owner.begin()
    assert len(owner.capture_paths) == 2
    first = json.loads((owner.capture_paths[0] / "manifest.json").read_text())
    assert first["status"] == "restarted"
    assert owner.image_capture.path == owner.capture_paths[1]
    owner._finish_capture("cancelled")


def test_candidate_accept_never_uses_active_save_path(tmp_path, monkeypatch):
    calls = []
    session = tmp_path / "calib-test.npz"
    monkeypatch.setattr(cal, "save_session", lambda *args: session)
    monkeypatch.setattr(cal, "save", lambda *args, **kwargs: calls.append(kwargs["path"]) or kwargs["path"])
    owner = SimpleNamespace(result=object(), error=None, rec=None, script=None, display=None,
                            camera_name="test", tracker=SimpleNamespace(blend_names=[]),
                            candidate_only=True, close=lambda: None)
    EyeCalibrator.accept(owner)
    assert calls == [tmp_path / "calib-test-candidate.npz"]
    assert owner.saved_path == calls[0]
