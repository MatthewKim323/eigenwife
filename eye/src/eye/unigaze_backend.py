"""Offline, optional UniGaze-B research challenger; never changes the live tracker.

Uses pinned upstream code, including its CC BY-NC-SA normalization, at runtime.
The model has ModelGo noncommercial terms. See docs/GAZE-UNIGAZE.md.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import urllib.request

import cv2
import numpy as np

UPSTREAM_COMMIT = "9c240fbe33f3d6146970a77b7c8fa06a7e60019e"
MODEL_REVISION = "d3f8335cd4b7d249adbc32389986ce49b52f6f72"
MODEL_SHA256 = "2580d707b1395840ecabe7906e2cb35705f38c4ddb0be9c3c38ebb2d5546ffb8"
MODEL_NAME = "unigaze_b16_joint.safetensors"
MODEL_URL = f"https://huggingface.co/UniGaze/UniGaze-models/resolve/{MODEL_REVISION}/{MODEL_NAME}"
FINGERPRINT = f"unigaze-b-joint-calibrated-v1:{UPSTREAM_COMMIT}:{MODEL_SHA256}"


@dataclass(frozen=True)
class CameraCalibration:
    """Measured full-frame intrinsics. Dimensions refer to unmirrored input pixels."""
    matrix: np.ndarray
    distortion: np.ndarray
    width: int
    height: int
    calibration_id: str

    def __post_init__(self):
        k = np.asarray(self.matrix, dtype=np.float64).copy()
        d = np.asarray(self.distortion, dtype=np.float64).reshape(-1).copy()
        if (k.shape != (3, 3) or not np.isfinite(k).all()
                or k[0, 0] <= 0 or k[1, 1] <= 0
                or not np.allclose(k[2], [0, 0, 1]) or abs(k[1, 0]) > 1e-10):
            raise ValueError("invalid calibrated camera matrix")
        if d.size not in (4, 5, 8, 12, 14) or not np.isfinite(d).all():
            raise ValueError("explicit OpenCV distortion coefficients required")
        if (not isinstance(self.width, int) or not isinstance(self.height, int)
                or self.width <= 0 or self.height <= 0 or not self.calibration_id.strip()):
            raise ValueError("camera dimensions and calibration provenance are required")
        k.setflags(write=False)
        d.setflags(write=False)
        object.__setattr__(self, "matrix", k)
        object.__setattr__(self, "distortion", d)

    @classmethod
    def load(cls, path: str | Path) -> CameraCalibration:
        data = json.loads(Path(path).read_text())
        if data.get("schema_version") != 1:
            raise ValueError("camera calibration schema_version must be 1")
        return cls(np.array(data["camera_matrix"]), np.array(data["distortion_coefficients"]),
                   *data["image_size"], data["camera_id"])

    @property
    def fingerprint(self):
        payload = dict(matrix=self.matrix.tolist(), distortion=self.distortion.tolist(),
                       width=self.width, height=self.height, calibration_id=self.calibration_id)
        return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()


@dataclass(frozen=True)
class GazeRay:
    origin_camera_mm: np.ndarray
    direction_camera: np.ndarray  # unit vector FROM face center TOWARD gaze target
    pitch_yaw_normalized: np.ndarray  # raw upstream angles; radians
    camera_to_normalized_rotation: np.ndarray
    undistorted_to_crop_homography: np.ndarray
    reprojection_error_px: float
    fingerprint: str
    camera_fingerprint: str


def _sha256(path):
    with Path(path).open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def fetch_model(destination: str | Path) -> Path:
    """Explicit network operation. Inference itself never downloads anything."""
    destination = Path(destination)
    if destination.exists():
        if _sha256(destination) != MODEL_SHA256:
            raise ValueError("existing UniGaze weights failed SHA256 verification")
        return destination
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(".download")
    try:
        urllib.request.urlretrieve(MODEL_URL, temporary)
        if _sha256(temporary) != MODEL_SHA256:
            raise ValueError("downloaded UniGaze weights failed SHA256 verification")
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)
    return destination


def _load_module(name, path, *, package=False):
    existing = sys.modules.get(name)
    if existing is not None:
        if Path(existing.__file__).resolve() != Path(path).resolve():
            raise ValueError("a different UniGaze checkout is already loaded in this process")
        return existing
    spec = importlib.util.spec_from_file_location(
        name, path, submodule_search_locations=[str(Path(path).parent)] if package else None)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
    except Exception:
        sys.modules.pop(name, None)
        raise
    return module


def _verified_upstream(path):
    path = Path(path).resolve()
    revision = subprocess.check_output(["git", "-C", str(path), "rev-parse", "HEAD"], text=True).strip()
    if revision != UPSTREAM_COMMIT:
        raise ValueError(f"UniGaze checkout must be pinned to {UPSTREAM_COMMIT}")
    subprocess.run(["git", "-C", str(path), "diff", "--exit-code", "HEAD", "--"],
                   check=True, stdout=subprocess.DEVNULL)
    return path


class UniGazeBackend:
    """Input: BGR full frame + 68-point landmarks in its distorted pixel space.

    No landmark-index approximation is made for MediaPipe. Caller supplies the
    standard iBUG-68 topology, including the eye corners and nose sides.
    """
    def __init__(self, *, upstream: str | Path, weights: str | Path,
                 camera: CameraCalibration, device: str = "cpu",
                 max_reprojection_error_px: float = 8.0):
        if not isinstance(camera, CameraCalibration):
            raise ValueError("explicit calibrated intrinsics are mandatory")
        if device not in ("cpu", "mps"):
            raise ValueError("choose an explicit cpu or mps device")
        if not np.isfinite(max_reprojection_error_px) or max_reprojection_error_px <= 0:
            raise ValueError("positive reprojection error threshold required")
        upstream = _verified_upstream(upstream)
        if _sha256(weights) != MODEL_SHA256:
            raise ValueError("UniGaze weights failed SHA256 verification")
        import torch
        if device == "mps" and not torch.backends.mps.is_available():
            raise RuntimeError("MPS requested but unavailable; no silent device fallback")
        package = _load_module("_eye_unigaze_pinned", upstream / "unigaze_easy/src/unigaze/__init__.py", package=True)
        self.normalizer = _load_module("_eye_unigaze_normalizer", upstream / "unigaze/gazelib/gaze/normalize.py")
        self.model = package.loader.build_unigaze_model("unigaze_b16_joint")
        self.model.load_unigaze_weights(str(weights))
        self.model.to(device).eval()
        self.torch = torch
        self.device = device
        self.camera = camera
        self.max_reprojection_error_px = max_reprojection_error_px
        self.face_model = np.loadtxt(upstream / "unigaze/data/face_model.txt")[[20, 23, 26, 29, 15, 19]]

    def infer(self, bgr: np.ndarray, landmarks68: np.ndarray) -> GazeRay:
        camera = self.camera
        if bgr.dtype != np.uint8 or bgr.shape != (camera.height, camera.width, 3):
            raise ValueError("frame must match calibrated full-frame dimensions and uint8 BGR")
        points = np.asarray(landmarks68, dtype=np.float64)
        if points.shape != (68, 2) or not np.isfinite(points).all():
            raise ValueError("68 finite unmirrored iBUG landmarks required")
        if np.any(points < 0) or np.any(points >= [camera.width, camera.height]):
            raise ValueError("landmarks lie outside the calibrated frame")
        image = cv2.undistort(bgr, camera.matrix, camera.distortion)
        points = cv2.undistortPoints(points[:, None, :], camera.matrix,
                                     camera.distortion, P=camera.matrix).reshape(68, 2)
        selected = points[[36, 39, 42, 45, 31, 35]]
        rvec, tvec = self.normalizer.estimateHeadPose(
            selected.reshape(6, 1, 2), self.face_model.reshape(6, 1, 3), camera.matrix, np.zeros(5))
        if not np.isfinite(rvec).all() or not np.isfinite(tvec).all():
            raise ValueError("invalid head pose")
        rotation = cv2.Rodrigues(rvec)[0]
        face_camera = (rotation @ self.face_model.T + tvec).T
        origin = (face_camera[:4].mean(axis=0) + face_camera[4:].mean(axis=0)) / 2
        if origin[2] <= 0 or np.linalg.norm(np.cross(origin, rotation[:, 0])) < 1e-8:
            raise ValueError("degenerate head geometry")
        projected = cv2.projectPoints(self.face_model, rvec, tvec, camera.matrix, np.zeros(5))[0].reshape(6, 2)
        error = float(np.linalg.norm(projected - selected, axis=1).mean())
        if error > self.max_reprojection_error_px:
            raise ValueError(f"head reprojection error {error:.2f}px exceeds calibrated quality gate")
        crop, transform, normalized_head, _, _, homography = self.normalizer.normalize(
            image, points, 960, 600, (224, 224), origin, rvec, tvec, camera.matrix)
        head_angles = np.array([np.arcsin(np.clip(normalized_head[1, 2], -1, 1)),
                               np.arctan2(normalized_head[0, 2], normalized_head[2, 2])])
        if np.linalg.norm(head_angles) > np.deg2rad(80):
            raise ValueError("head pose exceeds upstream 80-degree normalization gate")
        tensor = np.ascontiguousarray(crop[:, :, ::-1].transpose(2, 0, 1), dtype=np.float32) / 255
        tensor = (tensor - np.array([.485, .456, .406], dtype=np.float32)[:, None, None]) / np.array([.229, .224, .225], dtype=np.float32)[:, None, None]
        with self.torch.inference_mode():
            angles = self.model(self.torch.from_numpy(tensor[None]).to(self.device))["pred_gaze"][0].cpu().numpy().astype(float)
        if angles.shape != (2,) or not np.isfinite(angles).all():
            raise ValueError("model returned invalid gaze angles")
        pitch, yaw = angles
        # Upstream pitchyaw_to_vector points toward +z; its demo draws -vector.
        normalized_ray = -np.array([np.cos(pitch) * np.sin(yaw), np.sin(pitch), np.cos(pitch) * np.cos(yaw)])
        ray = transform.T @ normalized_ray
        ray /= np.linalg.norm(ray)
        return GazeRay(origin.copy(), ray, angles, transform.copy(), homography.copy(),
                       error, FINGERPRINT, camera.fingerprint)


class LandmarkFrontend:
    """Pinned iBUG-68 frontend; local verified assets only, no MediaPipe remapping."""
    def __init__(self, cache: str | Path, device="cpu"):
        import importlib.metadata
        import torch
        import face_alignment
        if importlib.metadata.version("face-alignment") != "1.4.1":
            raise ValueError("landmark frontend requires face-alignment==1.4.1")
        if device not in ("cpu", "mps"):
            raise ValueError("choose cpu or mps explicitly")
        if device == "mps" and not torch.backends.mps.is_available():
            raise RuntimeError("MPS requested but unavailable")
        cache = Path(cache).resolve()
        for name, digest in LANDMARK_ASSETS.items():
            if _sha256(cache / "checkpoints" / name) != digest:
                raise ValueError("landmark model failed SHA256 verification")
        old_cache = torch.hub.get_dir()
        try:
            torch.hub.set_dir(str(cache))
            self.detector = face_alignment.FaceAlignment(face_alignment.LandmarksType.TWO_D,
                                                        device=device, flip_input=False)
        finally:
            torch.hub.set_dir(old_cache)

    def detect(self, bgr):
        # Match upstream UniGaze video detector's half-resolution RGB input.
        small = cv2.resize(bgr, dsize=None, fx=.5, fy=.5, interpolation=cv2.INTER_AREA)
        faces = self.detector.get_landmarks_from_image(cv2.cvtColor(small, cv2.COLOR_BGR2RGB))
        if faces is None or len(faces) != 1:
            raise ValueError("landmark frontend requires exactly one visible face")
        return np.asarray(faces[0], dtype=np.float64) * 2


LANDMARK_ASSETS = {
    "s3fd-619a316812.pth": "619a31681264d3f7f7fc7a16a42cbbe8b23f31a256f75a366e5a1bcd59b33543",
    "2DFAN4-cd938726ad.zip": "cd938726adb1f15f361263cce2db9cb820c42585fa8796ec72ce19107f369a46",
}


def fetch_landmarks(cache):
    """Explicitly fetch and pin the two face-alignment 1.4.1 model assets."""
    directory = Path(cache) / "checkpoints"
    directory.mkdir(parents=True, exist_ok=True)
    for name, digest in LANDMARK_ASSETS.items():
        destination = directory / name
        if destination.exists():
            if _sha256(destination) != digest:
                raise ValueError(f"existing landmark asset failed SHA256: {name}")
            continue
        temporary = destination.with_suffix(destination.suffix + ".download")
        try:
            urllib.request.urlretrieve("https://www.adrianbulat.com/downloads/python-fan/" + name, temporary)
            if _sha256(temporary) != digest:
                raise ValueError(f"downloaded landmark asset failed SHA256: {name}")
            temporary.replace(destination)
        finally:
            temporary.unlink(missing_ok=True)
    return directory


def validate_capture_camera(manifest, camera):
    """A matching image size is insufficient to establish camera identity."""
    metadata = manifest.get("metadata", {})
    recorded = metadata.get("camera", {}) if isinstance(metadata, dict) else {}
    device = recorded.get("device", {}) if isinstance(recorded, dict) else {}
    identity = device.get("unique_id") if isinstance(device, dict) else None
    if not isinstance(identity, str) or not identity or identity != camera.calibration_id:
        raise ValueError("capture camera unique_id must match measured intrinsics camera_id")
    if recorded.get("actual_size") != [camera.width, camera.height]:
        raise ValueError("capture camera size must match measured intrinsics image_size")


def _serializable(result):
    return {key: value.tolist() if isinstance(value, np.ndarray) else value
            for key, value in vars(result).items()}


def main():
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    fetch = commands.add_parser("fetch", help="download and SHA256-verify the pinned 346 MB model")
    fetch.add_argument("destination", type=Path)
    landmarks = commands.add_parser("fetch-landmarks", help="download and verify the exact 68-point frontend")
    landmarks.add_argument("cache", type=Path)
    for name in ("infer", "replay"):
        command = commands.add_parser(name, help="offline image or integrity-checked capture inference")
        for arg in ("upstream", "weights", "camera"):
            command.add_argument(f"--{arg}", required=True, type=Path)
        command.add_argument("--landmark-cache", type=Path)
        command.add_argument("--device", choices=("cpu", "mps"), default="cpu")
        command.add_argument("--landmark-device", choices=("cpu", "mps"), default="cpu")
        if name == "infer":
            command.add_argument("--image", type=Path, required=True)
            command.add_argument("--landmarks", type=Path, help="optional precomputed iBUG-68 .npy")
        else:
            command.add_argument("--capture", type=Path, required=True)
            command.add_argument("--session", type=Path)
            command.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "fetch":
        print(fetch_model(args.destination))
        return
    if args.command == "fetch-landmarks":
        print(fetch_landmarks(args.cache))
        return
    if not args.landmark_cache and not getattr(args, "landmarks", None):
        parser.error("provide --landmark-cache or explicit --landmarks for an image")
    backend = UniGazeBackend(upstream=args.upstream, weights=args.weights,
                             camera=CameraCalibration.load(args.camera), device=args.device)
    frontend = LandmarkFrontend(args.landmark_cache, args.landmark_device) if args.landmark_cache else None
    if args.command == "infer":
        frame = cv2.imread(str(args.image))
        if frame is None:
            raise ValueError("image could not be decoded")
        points = np.load(args.landmarks, allow_pickle=False) if args.landmarks else frontend.detect(frame)
        print(json.dumps(_serializable(backend.infer(frame, points)), indent=2))
    else:
        from .capture_replay import CaptureReplay
        replay = CaptureReplay(args.capture, session_path=args.session)
        validate_capture_camera(replay.manifest, backend.camera)
        # Exclusive creation prevents overwriting another experiment's output.
        with args.output.open("x") as output:
            for frame in replay.frames():
                row = dict(index=frame.index, seq=frame.seq, t=frame.t, valid=False,
                           fingerprint=FINGERPRINT, camera_fingerprint=backend.camera.fingerprint)
                if frame.image is None:
                    row["reason"] = frame.dropped or "image_unavailable"
                else:
                    try:
                        row.update(_serializable(backend.infer(frame.image, frontend.detect(frame.image))))
                        row["valid"] = True
                    except (ValueError, cv2.error) as exc:
                        row["reason"] = str(exc)
                output.write(json.dumps(row) + "\n")
        print(args.output)


if __name__ == "__main__":
    main()
