import json
import cv2
import numpy as np
import pytest
from eye import intrinsics as intr

PARAMS = dict(columns=8, rows=5, square_mm=25., camera_id="test-camera")
SIZE = (1280, 720)
K = np.array([[1000., 0, 640], [0, 990., 360], [0, 0, 1.]])


def synthetic_views(noise=.05):
    rng = np.random.default_rng(9)
    obj = intr.board_points(8, 5, 25.)
    views = []
    for _ in range(20):
        rotation = rng.uniform(-.5, .5, 3)
        translation = np.array([-87.5 + rng.uniform(-170, 170), -50 + rng.uniform(-70, 70), rng.uniform(600, 900)])
        corners, _ = cv2.projectPoints(obj, rotation, translation, K, np.zeros(5))
        views.append((corners + rng.normal(0, noise, corners.shape)).astype(np.float32))
    return views


def test_recovers_known_intrinsics_and_keeps_holdout_out_of_camera_fit(monkeypatch):
    actual_calibrate = cv2.calibrateCamera
    observed = []
    def calibrate(objects, images, *args):
        observed.append(len(images))
        return actual_calibrate(objects, images, *args)
    monkeypatch.setattr(cv2, "calibrateCamera", calibrate)
    result = intr.fit_corners(synthetic_views(), SIZE, **PARAMS)
    assert observed == [16]
    np.testing.assert_allclose(result["camera_matrix"], K, atol=6)
    assert result["validation"]["max_view_rms_px"] < .15
    assert result["validation"]["source_views"] == ["4", "9", "14", "19"]
    assert result["schema_version"] == 1
    assert result["image_size"] == list(SIZE)
    json.dumps(result, allow_nan=False)


@pytest.mark.parametrize("views", [lambda: synthetic_views()[:9], lambda: [synthetic_views()[0]] * 20])
def test_rejects_too_few_or_duplicate_views(views):
    with pytest.raises(intr.IntrinsicsError):
        intr.fit_corners(views(), SIZE, **PARAMS)


def test_rejects_front_parallel_translation_without_tilt():
    obj = intr.board_points(8, 5, 25.)
    views = [cv2.projectPoints(obj, np.zeros(3), np.array([x, -50., 700.]), K, np.zeros(5))[0]
             for x in np.linspace(-230, 100, 20)]
    with pytest.raises(intr.IntrinsicsError, match="diversity"):
        intr.fit_corners(views, SIZE, **PARAMS)


def test_holdout_corruption_does_not_get_hidden_by_refitting():
    views = synthetic_views()
    views[4] += np.random.default_rng(30).normal(0, 8, views[4].shape)
    with pytest.raises(intr.IntrinsicsError, match="reprojection"):
        intr.fit_corners(views, SIZE, **PARAMS)


@pytest.mark.parametrize("change", [{"columns": 0}, {"rows": 3.5}, {"square_mm": float("nan")},
                                    {"square_mm": -1}, {"camera_id": ""}, {"max_rms_px": 0}])
def test_invalid_configuration(change):
    with pytest.raises(intr.IntrinsicsError):
        intr.fit_corners(synthetic_views(), SIZE, **(PARAMS | change))


def test_invalid_corner_arrays_and_resolution():
    views = synthetic_views()
    views[0][0] = np.nan
    with pytest.raises(intr.IntrinsicsError, match="nonfinite"):
        intr.fit_corners(views, SIZE, **PARAMS)
    with pytest.raises(intr.IntrinsicsError, match="image_size"):
        intr.fit_corners(synthetic_views(), (1280., 720), **PARAMS)


def test_directory_rejects_mixed_resolutions(tmp_path):
    cv2.imwrite(str(tmp_path / "a.png"), np.zeros((100, 100), np.uint8))
    cv2.imwrite(str(tmp_path / "b.png"), np.zeros((200, 100), np.uint8))
    with pytest.raises(intr.IntrinsicsError, match="same resolution"):
        intr.calibrate_directory(tmp_path, **PARAMS)


def test_real_board_detection_and_subpixel_refinement(tmp_path, monkeypatch):
    board = np.full((420, 600), 255, np.uint8)
    for y in range(6):
        for x in range(9):
            if (x + y) % 2 == 0:
                board[30 + y * 60:30 + (y + 1) * 60, 30 + x * 60:30 + (x + 1) * 60] = 0
    cv2.imwrite(str(tmp_path / "board.png"), board)
    captured = []
    def capture(views, image_size, **kwargs):
        captured.extend(views)
        assert image_size == (600, 420)
        return {"protocol": {}}
    monkeypatch.setattr(intr, "fit_corners", capture)
    intr.calibrate_directory(tmp_path, **PARAMS)
    assert captured[0].shape == (40, 1, 2)
    assert np.isfinite(captured[0]).all()


def test_board_cli_never_overwrites_existing_output(tmp_path):
    output = tmp_path / "checkerboard.svg"
    args = ["board", "--columns", "8", "--rows", "5", "--square-mm", "20", "--output", str(output)]
    intr.main(args)
    original = output.read_text()
    assert 'width="220.0mm"' in original
    with pytest.raises(SystemExit):
        intr.main(args)
    assert output.read_text() == original


def test_fit_schema_loads_directly_into_unigaze_camera(tmp_path):
    from eye.unigaze_backend import CameraCalibration
    result = intr.fit_corners(synthetic_views(), SIZE, **PARAMS)
    path = tmp_path / "camera.json"
    path.write_text(json.dumps(result))
    camera = CameraCalibration.load(path)
    np.testing.assert_allclose(camera.matrix, result["camera_matrix"])
    assert (camera.width, camera.height) == SIZE
    assert camera.calibration_id == PARAMS["camera_id"]


def test_capture_metadata_guards_camera_board_and_resolution(tmp_path):
    metadata = {"camera_id": "physical-device", "image_size": [100, 100],
                "board": {"columns": 8, "rows": 5, "square_mm": 25.}}
    (tmp_path / "capture.json").write_text(json.dumps(metadata))
    with pytest.raises(intr.IntrinsicsError, match="physical camera"):
        intr.calibrate_directory(tmp_path, **PARAMS)
    with pytest.raises(intr.IntrinsicsError, match="checkerboard parameters"):
        intr.calibrate_directory(tmp_path, **(PARAMS | {"camera_id": None, "square_mm": 20}))
    cv2.imwrite(str(tmp_path / "a.png"), np.zeros((100, 200), np.uint8))
    with pytest.raises(intr.IntrinsicsError, match="resolution"):
        intr.calibrate_directory(tmp_path, **(PARAMS | {"camera_id": None}))


def test_capture_saves_only_on_space_and_closes_camera(tmp_path, monkeypatch):
    from types import SimpleNamespace
    from eye import camera
    events = []
    frame = SimpleNamespace(seq=1, image=np.zeros((720, 1280, 3), np.uint8))
    class FakeCamera:
        frame_size = SIZE
        info = SimpleNamespace(unique_id="physical-device", name="Test camera")
        def __init__(self, *args, **kwargs):
            pass
        def start(self):
            events.append("start")
        def stop(self):
            events.append("stop")
        def read(self, **kwargs):
            return frame
    monkeypatch.setattr(camera, "Camera", FakeCamera)
    monkeypatch.setattr(cv2, "findChessboardCorners", lambda *args: (True, synthetic_views()[0]))
    monkeypatch.setattr(cv2, "imshow", lambda *args: None)
    monkeypatch.setattr(cv2, "destroyAllWindows", lambda: None)
    keys = iter([32, 113])
    monkeypatch.setattr(cv2, "waitKey", lambda _: next(keys))
    directory = tmp_path / "captures"
    assert intr.capture_directory(directory, columns=8, rows=5, square_mm=25.) == 1
    metadata = json.loads((directory / "capture.json").read_text())
    assert metadata["camera_id"] == "physical-device"
    assert metadata["image_size"] == list(SIZE)
    assert len(list(directory.glob("*.png"))) == 1
    assert events == ["start", "stop"]
    with pytest.raises(FileExistsError):
        intr.capture_directory(directory, columns=8, rows=5, square_mm=25.)
    assert events == ["start", "stop"]
