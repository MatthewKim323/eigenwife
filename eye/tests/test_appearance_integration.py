"""Appearance schema plumbing, never an assertion of human gaze accuracy.

Optional real-model smoke: set EYE_APPEARANCE_FIXTURE to a local face image and
run with `uv run --extra appearance pytest tests/test_appearance_integration.py`.
Weights must already be prepared. Tests never access a camera or download files.
"""

from dataclasses import replace
import os
from types import SimpleNamespace

import numpy as np
import pytest

from eye import calibration as cal
from eye.appearance import FEATURE_COUNT, FINGERPRINT
from eye.backend import AppearanceFactory, for_calibration
from eye.features import BlendIdx, extract, gaze_vector
from eye.profile import FaceProfile
from eye.stream import GazeStream
from test_appearance import observation
from test_calibration import DISPLAY, synthetic_recording


def fitted():
    rec = synthetic_recording(cal.build_script(quick=True, expressions=False))
    samples = [f for f in rec.features[:80] if f is not None]
    rng = np.random.default_rng(712)
    for f in samples:
        f.appearance = rng.normal(size=FEATURE_COUNT)
    x = np.array([gaze_vector(f) for f in samples])
    # Arbitrary synthetic targets, not real gaze labels.
    y = 0.5 + x[:, 16:18] * 0.04
    model = cal.new_model(x.shape[1])
    model.alpha = 1.0
    model.fit(x, y)
    result = cal.Result(model, FaceProfile(), {}, [], (x, y, np.ones(len(x))), AppearanceFactory().metadata)
    return samples, result


def test_appearance_calibration_roundtrip_and_missing_frame(tmp_path):
    samples, result = fitted()
    loaded = cal.load(cal.save(result, DISPLAY, "synthetic", tmp_path / "appearance.npz"))
    assert for_calibration(loaded).metadata == AppearanceFactory().metadata
    assert loaded.model.n_features == 16 + FEATURE_COUNT
    assert loaded.meta["feature_backend"]["fingerprint"] == FINGERPRINT
    x = np.array([gaze_vector(f) for f in samples])
    np.testing.assert_array_equal(loaded.model.predict(x), result.model.predict(x))
    events = []
    stream = GazeStream(DISPLAY, loaded, events.append)
    for f in samples:
        stream.on_frame(SimpleNamespace(t=f.t), None, f)
    assert any(e.get("type") == "gaze" and e.get("valid") for e in events)
    missing = replace(samples[-1], t=samples[-1].t + 1/30, appearance=None)
    stream.on_frame(SimpleNamespace(t=missing.t), None, missing)
    assert events[-1]["valid"] is False
    assert events[-1]["reason"] == "appearance_features_unavailable"


@pytest.mark.parametrize("metadata", [
    {"name": "landmarks"},
    {"name": "mgazenet", "fingerprint": "other-weights", "feature_count": FEATURE_COUNT},
    {"name": "mgazenet", "fingerprint": FINGERPRINT, "feature_count": FEATURE_COUNT - 1},
])
def test_backend_mismatch_is_rejected(metadata):
    _, result = fitted()
    saved = cal.Calibration(result.model, result.profile, {"feature_backend": metadata}, result.train)
    with pytest.raises(RuntimeError, match="backend"):
        for_calibration(saved)


def test_session_replays_saved_embeddings_and_missing_samples(tmp_path, monkeypatch):
    monkeypatch.setenv("EYE_HOME", str(tmp_path))
    obs = observation()
    obs.t = 1.0
    obs.blend = np.zeros(52, dtype=np.float32)
    obs.matrix = np.eye(4, dtype=np.float32)
    obs.matrix[2, 3] = -55
    names = ["eyeBlinkLeft", "eyeBlinkRight", "browInnerUp", "jawOpen", "mouthSmileLeft", "mouthSmileRight"]
    names += [f"unused_{i}" for i in range(46)]
    feature = extract(obs, BlendIdx.from_names(names))
    feature.appearance = np.linspace(-2, 2, FEATURE_COUNT)
    rec = cal.Recording(feature_backend=AppearanceFactory().metadata)
    rec.add(1.0, feature, obs)
    rec.add(2.0, replace(feature, t=2.0, appearance=None), obs)
    rec.add(3.0, None, None)
    rec.clock = [(1.0, 0.0), (3.0, 2.0)]
    script = cal.build_script(quick=True, expressions=False)
    path = cal.save_session(rec, script, DISPLAY, "offline", names)
    original_load = np.load
    reads = {}

    class CountedArchive:
        def __init__(self, archive):
            self.archive = archive
            self.files = archive.files
        def __enter__(self):
            return self
        def __exit__(self, *args):
            self.archive.close()
        def __getitem__(self, key):
            reads[key] = reads.get(key, 0) + 1
            return self.archive[key]

    monkeypatch.setattr(cal.np, "load", lambda *args, **kwargs: CountedArchive(original_load(*args, **kwargs)))
    replay, replay_script, _, _ = cal.load_session(path)
    assert reads["appearance"] == 1
    assert reads["t"] == 1
    assert replay.feature_backend == rec.feature_backend
    np.testing.assert_allclose(gaze_vector(replay.features[0]), gaze_vector(feature))
    assert replay.features[1].appearance is None
    assert replay.features[2] is None
    assert replay_script.to_json() == script.to_json()
    baseline = cal.landmark_recording(replay)
    assert baseline.feature_backend == {"name": "landmarks"}
    assert len(gaze_vector(baseline.features[0])) == 16
    assert len(gaze_vector(replay.features[0])) == 274


def test_full_calibration_fits_versioned_appearance_features():
    script = cal.build_script(quick=True, expressions=False)
    rec = synthetic_recording(script)
    rec.feature_backend = AppearanceFactory().metadata
    for f in rec.features:
        if f is not None:
            f.appearance = np.zeros(FEATURE_COUNT)
            f.appearance[:2] = [f.left.u * 5, f.left.v * 5]
    result = cal.fit(rec, script, DISPLAY, latency=0)
    assert result.model.n_features == 274
    assert result.feature_backend == AppearanceFactory().metadata
    assert result.stats["cv_error_units"] == "screen_points"
    assert np.isfinite(result.stats["validation_frame_mean_points"])


@pytest.mark.skipif(not os.environ.get("EYE_APPEARANCE_FIXTURE"), reason="explicit local fixture required for real model smoke")
def test_real_inference_fit_save_reload_stream(tmp_path):
    import cv2
    from eye.appearance import MGazeNetFeatures
    from eye.face import FaceTracker

    image = cv2.imread(os.environ["EYE_APPEARANCE_FIXTURE"])
    assert image is not None
    face = FaceTracker()
    try:
        obs = face.process(image, 1.0)
        assert obs is not None
        idx = BlendIdx.from_names(face.blend_names)
    finally:
        face.close()
    adapter = MGazeNetFeatures()
    features = []
    for i, brightness in enumerate(np.linspace(0.85, 1.15, 12)):
        f = extract(replace(obs, t=1.0 + i / 30), idx)
        # Pixel variations test plumbing, not eye movement or gaze accuracy.
        f.appearance = adapter.extract(np.clip(image * brightness, 0, 255).astype(np.uint8), obs)
        features.append(f)
    x = np.array([gaze_vector(f) for f in features])
    y = np.column_stack((np.linspace(0.4, 0.6, len(x)), np.linspace(0.45, 0.55, len(x))))
    model = cal.new_model(x.shape[1])
    model.alpha = 1.0
    model.fit(x, y)
    profile = FaceProfile()
    result = cal.Result(model, profile, {}, [], (x, y, np.ones(len(x))), AppearanceFactory().metadata)
    loaded = cal.load(cal.save(result, DISPLAY, "fixture-only", tmp_path / "smoke.npz"))
    assert for_calibration(loaded).metadata == AppearanceFactory().metadata
    np.testing.assert_allclose(loaded.model.predict(x), model.predict(x))
    events = []
    stream = GazeStream(DISPLAY, loaded, events.append)
    for f in features:
        stream.on_frame(SimpleNamespace(t=f.t), obs, f)
    gaze = [e for e in events if e.get("type") == "gaze" and e.get("valid")]
    assert gaze
    assert all(np.isfinite([e["x"], e["y"]]).all() for e in gaze)
