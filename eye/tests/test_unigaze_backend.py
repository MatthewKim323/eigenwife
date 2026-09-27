"""Geometry, artifact integrity, and optional real-weight challenger checks."""
import os
from pathlib import Path
from types import SimpleNamespace

import cv2
import numpy as np
import pytest

from eye.unigaze_backend import CameraCalibration, UniGazeBackend, fetch_model


def camera():
    return CameraCalibration(np.array([[800, 0, 320], [0, 800, 240], [0, 0, 1]]),
                             np.zeros(5), 640, 480, "synthetic-unit-test-only")


@pytest.mark.parametrize("matrix", [np.eye(2), np.zeros((3, 3)), np.full((3, 3), np.nan)])
def test_invalid_intrinsics(matrix):
    with pytest.raises(ValueError):
        CameraCalibration(matrix, np.zeros(5), 640, 480, "test")


def test_explicit_provenance_and_distortion_required():
    for kwargs in ({"calibration_id": ""}, {"distortion": np.array([])}, {"width": 0}):
        values = vars(camera()).copy()
        values.update(kwargs)
        with pytest.raises(ValueError):
            CameraCalibration(**values)


def test_calibration_copies_and_fingerprints_actual_intrinsics():
    matrix = camera().matrix.copy()
    a = CameraCalibration(matrix, np.zeros(5), 640, 480, "test")
    matrix[0, 0] += 1
    b = CameraCalibration(matrix, np.zeros(5), 640, 480, "test")
    assert a.matrix[0, 0] == 800
    assert a.fingerprint != b.fingerprint
    with pytest.raises(ValueError):
        a.matrix[0, 0] = 1


def test_existing_corrupt_weight_never_downloads_or_overwrites(tmp_path, monkeypatch):
    destination = tmp_path / "bad.safetensors"
    destination.write_bytes(b"bad")
    monkeypatch.setattr("urllib.request.urlretrieve", lambda *a: pytest.fail("unexpected network"))
    with pytest.raises(ValueError, match="SHA256"):
        fetch_model(destination)
    assert destination.read_bytes() == b"bad"


def test_invalid_download_is_removed(tmp_path, monkeypatch):
    destination = tmp_path / "weights.safetensors"
    monkeypatch.setattr("urllib.request.urlretrieve", lambda url, path: path.write_bytes(b"bad"))
    with pytest.raises(ValueError, match="SHA256"):
        fetch_model(destination)
    assert not destination.exists()
    assert not destination.with_suffix(".download").exists()


def test_no_implicit_camera_or_device_fallback():
    with pytest.raises(ValueError, match="mandatory"):
        UniGazeBackend(upstream="missing", weights="missing", camera=None)
    with pytest.raises(ValueError, match="explicit"):
        UniGazeBackend(upstream="missing", weights="missing", camera=camera(), device="auto")


def test_frame_and_landmark_shape_rejected_before_inference():
    backend = object.__new__(UniGazeBackend)
    backend.camera = camera()
    with pytest.raises(ValueError, match="dimensions"):
        backend.infer(np.zeros((10, 10, 3), np.uint8), np.zeros((68, 2)))
    with pytest.raises(ValueError, match="iBUG"):
        backend.infer(np.zeros((480, 640, 3), np.uint8), np.zeros((478, 2)))


@pytest.fixture
def optional_backend():
    upstream = os.environ.get("EYE_UNIGAZE_UPSTREAM")
    weights = os.environ.get("EYE_UNIGAZE_WEIGHTS")
    if not upstream or not weights:
        pytest.skip("set EYE_UNIGAZE_UPSTREAM and EYE_UNIGAZE_WEIGHTS for real-weight smoke")
    return UniGazeBackend(upstream=upstream, weights=weights, camera=camera(),
                          device=os.environ.get("EYE_UNIGAZE_DEVICE", "cpu"))


def synthetic_landmarks(backend):
    points = np.full((68, 2), [320., 240.])
    projected = cv2.projectPoints(backend.face_model, np.zeros(3), np.array([0., 0., 600.]),
                                  backend.camera.matrix, np.zeros(5))[0].reshape(6, 2)
    points[[36, 39, 42, 45, 31, 35]] = projected
    return points


def test_optional_real_model_smoke(optional_backend):
    b = optional_backend
    result = b.infer(np.full((480, 640, 3), 128, np.uint8), synthetic_landmarks(b))
    assert np.isfinite(result.direction_camera).all()
    assert np.linalg.norm(result.direction_camera) == pytest.approx(1)
    assert result.direction_camera[2] < 0  # gaze travels from face toward display
    assert result.origin_camera_mm[2] > 500
    assert result.reprojection_error_px < 1e-3
    np.testing.assert_allclose(result.camera_to_normalized_rotation @ result.camera_to_normalized_rotation.T,
                               np.eye(3), atol=1e-6)


def test_optional_forward_ray_sign_and_upstream_normalization(optional_backend):
    b = optional_backend
    b.model = lambda tensor: {"pred_gaze": b.torch.zeros((1, 2), device=b.device)}
    frame = np.full((480, 640, 3), 128, np.uint8)
    result = b.infer(frame, synthetic_landmarks(b))
    expected = -result.origin_camera_mm / np.linalg.norm(result.origin_camera_mm)
    np.testing.assert_allclose(result.direction_camera, expected, atol=1e-6)
    # With normalized angles zero, ray points exactly back along the camera-to-face axis.
    assert result.undistorted_to_crop_homography.shape == (3, 3)


def test_intrinsics_tool_schema_load(tmp_path):
    import json
    path = tmp_path / "camera.json"
    c = camera()
    path.write_text(json.dumps(dict(schema_version=1, camera_id=c.calibration_id,
                                   image_size=[c.width, c.height], camera_matrix=c.matrix.tolist(),
                                   distortion_coefficients=c.distortion.tolist())))
    assert CameraCalibration.load(path).fingerprint == c.fingerprint
    data = json.loads(path.read_text())
    del data['distortion_coefficients']
    path.write_text(json.dumps(data))
    with pytest.raises(KeyError):
        CameraCalibration.load(path)


def test_landmark_frontend_rejects_multiple_faces():
    from eye.unigaze_backend import LandmarkFrontend
    frontend = object.__new__(LandmarkFrontend)
    frontend.detector = SimpleNamespace(get_landmarks_from_image=lambda image: [np.zeros((68, 2))] * 2)
    with pytest.raises(ValueError, match="exactly one"):
        frontend.detect(np.zeros((480, 640, 3), np.uint8))


def test_landmark_frontend_preserves_upstream_rgb_and_half_scale():
    from eye.unigaze_backend import LandmarkFrontend
    frontend = object.__new__(LandmarkFrontend)
    def detect(image):
        assert image.shape == (240, 320, 3)
        assert image[0, 0].tolist() == [30, 20, 10]
        return [np.ones((68, 2)) * 42]
    frontend.detector = SimpleNamespace(get_landmarks_from_image=detect)
    result = frontend.detect(np.full((480, 640, 3), [10, 20, 30], np.uint8))
    np.testing.assert_array_equal(result, np.ones((68, 2)) * 84)


@pytest.mark.parametrize("identity", [None, "", "another-camera"])
def test_capture_camera_identity_required(identity):
    from eye.unigaze_backend import validate_capture_camera
    manifest = {"metadata": {"camera": {"device": {"unique_id": identity}, "actual_size": [640, 480]}}}
    with pytest.raises(ValueError, match="unique_id"):
        validate_capture_camera(manifest, camera())


def test_capture_camera_and_dimensions_match():
    from eye.unigaze_backend import validate_capture_camera
    manifest = {"metadata": {"camera": {"device": {"unique_id": camera().calibration_id}, "actual_size": [640, 480]}}}
    validate_capture_camera(manifest, camera())
    manifest['metadata']['camera']['actual_size'] = [1280, 960]
    with pytest.raises(ValueError, match="size"):
        validate_capture_camera(manifest, camera())
