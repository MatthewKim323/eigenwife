"""The optional image model must not silently alter channels, geometry or schema."""

from types import SimpleNamespace

import cv2
import numpy as np
import pytest

from eye.appearance import AppearanceError, FEATURE_COUNT, FINGERPRINT, MGazeNetFeatures, prepare_model, preprocess


def observation():
    lm = np.tile([320.0, 230.0, 0.0], (478, 1))
    lm[10, :2] = [320, 100]
    lm[152, :2] = [320, 380]
    lm[234, :2] = [200, 230]
    lm[454, :2] = [440, 230]
    lm[[33, 133, 362, 263], :2] = [[235, 210], [285, 210], [355, 210], [405, 210]]
    return SimpleNamespace(size=(640, 480), lm=lm)


def test_preprocessing_channels_eye_mirror_and_rectangles():
    bgr = np.zeros((480, 640, 3), dtype=np.uint8)
    bgr[:, :, 0] = np.arange(640, dtype=np.uint16) % 256
    bgr[:, :, 2] = 255
    face, left, right, rect = preprocess(bgr, observation())
    assert face.shape == (1, 224, 224, 3)
    assert left.shape == right.shape == (1, 112, 112, 3)
    assert rect.shape == (1, 12)
    assert all(x.dtype == np.float32 for x in (face, left, right, rect))
    assert np.all(face[..., 0] == 1)  # Camera BGR must become network RGB.
    # Upstream geometry: padded eye (341,174)-(419,233), flipped image-right.
    expected = cv2.resize(bgr[174:233, 341:419], (112, 112))[:, ::-1, ::-1] / 255.0
    np.testing.assert_allclose(right[0], expected, atol=1e-7)
    np.testing.assert_allclose(rect[0], np.array([
        260/640, 260/480, 190/640, 110/480,
        78/640, 59/480, 221/640, 174/480,
        78/640, 59/480, 341/640, 174/480,
    ]), atol=1e-7)


def test_reject_bad_geometry_and_nan():
    image = np.zeros((480, 640, 3), dtype=np.uint8)
    obs = observation()
    obs.lm[33, 0] = 2
    with pytest.raises(AppearanceError, match="eye crop"):
        preprocess(image, obs)
    obs = observation()
    obs.lm[0, 0] = np.nan
    with pytest.raises(AppearanceError, match="landmarks"):
        preprocess(image, obs)
    with pytest.raises(AppearanceError, match="dimensions"):
        preprocess(image[:200], observation())
    with pytest.raises(AppearanceError, match="uint8"):
        preprocess(image.astype(float), observation())


def test_model_preparation_never_downloads_implicitly(tmp_path, monkeypatch):
    monkeypatch.setenv("EYE_HOME", str(tmp_path))
    with pytest.raises(AppearanceError, match="missing"):
        prepare_model()
    corrupt = tmp_path / "corrupt.mnn"
    corrupt.write_bytes(b"not a model")
    with pytest.raises(AppearanceError, match="checksum"):
        prepare_model(corrupt)
    assert MGazeNetFeatures.fingerprint == FINGERPRINT
    assert MGazeNetFeatures.feature_count == FEATURE_COUNT == 258


def test_bad_download_does_not_install_weights(tmp_path, monkeypatch):
    import io
    import eye.appearance as module
    monkeypatch.setenv("EYE_HOME", str(tmp_path))
    monkeypatch.setattr(module.urllib.request, "urlopen", lambda *a, **kw: io.BytesIO(b"corrupt download"))
    with pytest.raises(AppearanceError, match="checksum"):
        prepare_model(download=True)
    assert not (tmp_path / "models" / "mgazenet-base.mnn").exists()
    assert not list((tmp_path / "models").glob("*.part"))


def test_inference_rejects_changed_output_contract():
    adapter = object.__new__(MGazeNetFeatures)
    adapter._inputs = [SimpleNamespace(write=lambda x: None)] * 4
    adapter._module = SimpleNamespace(onForward=lambda x: [SimpleNamespace(read=lambda: np.zeros(2))])
    with pytest.raises(AppearanceError, match="invalid appearance"):
        adapter.extract(np.zeros((480, 640, 3), dtype=np.uint8), observation())
