"""TrueDepth/ARKit packet geometry and personal screen mapping, without networking.

ARKit provides estimated gaze, not an infrared pupil measurement. All transforms
are column-major meters. Mapping is valid only while the phone stays mounted.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import math
import time
import uuid

import numpy as np

from .iphone_models import fit_iphone_model, FEATURE_SCHEMA
from .filters import OneEuro


def _array(packet, key, n):
    value = packet.get(key)
    if not isinstance(value, list) or len(value) != n or any(isinstance(v, bool) or not isinstance(v, (int, float)) for v in value):
        raise ValueError(f"{key} must contain {n} numbers")
    result = np.asarray(value, dtype=float)
    if not np.isfinite(result).all():
        raise ValueError(f"{key} must be finite")
    return result


def _number(packet, key):
    value = packet.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{key} must be finite")
    return float(value)


def _transform(packet, key):
    m = _array(packet, key, 16).reshape((4, 4), order="F")
    r = m[:3, :3]
    if not np.allclose(m[3], [0, 0, 0, 1], atol=1e-5) or not np.allclose(r.T @ r, np.eye(3), atol=.01) or not np.isclose(np.linalg.det(r), 1, atol=.01):
        raise ValueError(f"{key} must be a proper rigid transform")
    return m


@dataclass(frozen=True)
class IPhoneFrame:
    session_id: str
    seq: int
    t: float
    valid: bool
    reason: str | None
    features: np.ndarray | None = None
    origin: np.ndarray | None = None
    direction: np.ndarray | None = None
    depth_available: bool = False
    depth_timestamp: float | None = None
    tracked: bool = False
    geometry_features: np.ndarray | None = None


def decode_iphone_frame(packet: dict) -> IPhoneFrame:
    if not isinstance(packet, dict) or packet.get("type") != "iphone_frame" or type(packet.get("schema")) is not int or packet["schema"] != 1:
        raise ValueError("expected iphone_frame schema 1")
    session = packet.get("sessionId")
    if not isinstance(session, str):
        raise ValueError("sessionId must be a UUID")
    try:
        uuid.UUID(session)
    except (ValueError, AttributeError) as exc:
        raise ValueError("sessionId must be a UUID") from exc
    seq = packet.get("seq")
    if type(seq) is not int or seq < 0:
        raise ValueError("seq must be a nonnegative integer")
    t = _number(packet, "timestamp")
    if t < 0 or type(packet.get("tracked")) is not bool:
        raise ValueError("invalid timestamp or tracked flag")
    if not packet["tracked"]:
        return IPhoneFrame(session, seq, t, False, "iphone_face_lost")
    camera = _transform(packet, "cameraTransform")
    face = _transform(packet, "faceTransform")
    left = _transform(packet, "leftEyeTransform")
    right = _transform(packet, "rightEyeTransform")
    look = _array(packet, "lookAtPoint", 3)
    intrinsics = _array(packet, "intrinsics", 9).reshape((3, 3), order="F")
    size = _array(packet, "imageSize", 2)
    if np.any(size <= 0) or not np.equal(size, np.floor(size)).all() or intrinsics[0, 0] <= 0 or intrinsics[1, 1] <= 0 or not np.allclose(intrinsics[2], [0, 0, 1], atol=1e-5) or not (0 <= intrinsics[0, 2] < size[0] and 0 <= intrinsics[1, 2] < size[1]):
        raise ValueError("invalid camera intrinsics or image dimensions")
    blinks = [_number(packet, key) for key in ("blinkLeft", "blinkRight")]
    if any(v < 0 or v > 1 for v in blinks):
        raise ValueError("blink coefficients must be in [0,1]")
    if type(packet.get("depthAvailable")) is not bool:
        raise ValueError("depthAvailable must be boolean")
    depth_t = _number(packet, "depthTimestamp") if packet.get("depthTimestamp") is not None else None
    if depth_t is not None and depth_t < 0:
        raise ValueError("invalid depth timestamp")
    relative = np.linalg.inv(camera) @ face
    eye_origin = (left[:3, 3] + right[:3, 3]) / 2
    local_dir = look - eye_origin
    length = np.linalg.norm(local_dir)
    if length < 1e-6:
        raise ValueError("lookAtPoint coincides with eye origin")
    origin = (relative @ np.r_[eye_origin, 1])[:3]
    direction = relative[:3, :3] @ (local_dir / length)
    direction /= np.linalg.norm(direction)
    # Camera-relative ray avoids AR world's arbitrary origin/reset. Rotation's
    # first two columns encode head orientation continuously (no Euler wraps).
    features = np.r_[direction, origin, relative[:3, :2].T.ravel()]
    # Apple documents +Z as pupil-forward for both eye transforms:
    # https://developer.apple.com/documentation/arkit/arfaceanchor/lefteyetransform
    eye_directions = [relative[:3, :3] @ eye[:3, 2] for eye in (left, right)]
    eye_origins = [(relative @ np.r_[eye[:3, 3], 1])[:3] for eye in (left, right)]
    geometry_features = np.r_[features, *eye_directions, *eye_origins]
    reason = "iphone_blink" if max(blinks) >= .55 else None
    return IPhoneFrame(session, seq, t, reason is None, reason, features, origin, direction,
                       packet["depthAvailable"], depth_t, True, geometry_features)


@dataclass
class _Target:
    xy: np.ndarray
    samples: list = field(default_factory=list)
    predictions: list = field(default_factory=list)
    attempted: int = 0
    rejected: dict = field(default_factory=dict)


class IPhoneGazeStream:
    def __init__(self, display, emit, pt_per_deg=49.0):
        self.display = {k: (display[k] if isinstance(display, dict) else getattr(display, k)) for k in ("x", "y", "w", "h", "scale")}
        if not all(math.isfinite(float(v)) for v in self.display.values()) or min(self.display["w"], self.display["h"], self.display["scale"], pt_per_deg) <= 0:
            raise ValueError("invalid display geometry")
        self.emit = emit
        self.pt_per_deg = float(pt_per_deg)
        self.model = None
        self.offset = np.zeros(2)
        self.face = False
        self.session_id = None
        self.last_seq = -1
        self.last_phone_t = -1
        self.last_received = None
        self.radius = None
        self.cv_radius = None
        self.validation = None
        self.targets = []
        self.collecting = None
        self.collecting_calibration = False
        self.depth_available = False
        # Screen-point units: steady fixation with a faster response to saccades.
        self.smooth = OneEuro(min_cutoff=1.5, beta=.02)
        self.last_valid_t = None

    @property
    def calibrated(self):
        return self.model is not None

    def hello(self):
        return {"type": "hello", "display": {**self.display, "ptPerDeg": self.pt_per_deg},
                "face": self.face, "calibrated": self.calibrated, "canCalibrate": True, "corrected": bool(np.any(self.offset)),
                "backend": {"name": "iphone-arkit", "features": 24, "featureSchema": FEATURE_SCHEMA,
                            "selectedModel": getattr(self.model, "name", None)},
                "accuracyDeg": self.validation["meanDeg"] if self.validation else None,
                "uncertaintyDeg": self.radius / self.pt_per_deg if self.radius is not None else None,
                "uncertaintySource": "current_live_validation" if self.validation else "grouped_cv_estimate",
                "accuracyValidated": self.validation is not None, "depthAvailable": self.depth_available,
                "angularAssumption": "approximate; display points per degree assumes viewing distance"}

    def _reject(self, reason, now):
        if self.collecting is not None:
            self.collecting.attempted += 1
            self.collecting.rejected[reason] = self.collecting.rejected.get(reason, 0) + 1
        guidance = ({"guidance": "return to your calibrated head position, or calibrate again to include this posture"}
                    if reason == "head_pose_outside_calibration" else {})
        self.emit({"type": "gaze", "t": now * 1000, "valid": False, "quality": "invalid", "reason": reason, **guidance})

    def lost(self, reason="iphone_disconnected", received_t=None):
        now = time.monotonic() if received_t is None else received_t
        self.face = False
        self.smooth.reset()
        self.last_valid_t = None
        if reason == "iphone_disconnected":
            self.model = self.radius = self.cv_radius = self.validation = None
            self.offset = np.zeros(2)
            self.targets, self.collecting = [], None
            self.session_id = None
            self.emit(self.hello())
        self.emit({"type": "face", "present": False, "t": now * 1000})
        self._reject(reason, now)

    def tick(self, received_t=None):
        now = time.monotonic() if received_t is None else received_t
        if self.last_received is None or now - self.last_received > .5:
            self.lost("iphone_stale", now)

    def handle_frame(self, packet, received_t=None):
        now = time.monotonic() if received_t is None else received_t
        try:
            f = decode_iphone_frame(packet)
        except ValueError:
            self.lost("iphone_invalid_packet", now)
            raise
        if f.session_id != self.session_id:
            self.smooth.reset()
            self.last_valid_t = None
            self.model = None
            self.offset = np.zeros(2)
            self.radius = self.cv_radius = self.validation = None
            self.targets, self.collecting = [], None
            self.session_id, self.last_seq, self.last_phone_t = f.session_id, -1, -1
            self.emit(self.hello())
        if f.seq <= self.last_seq or f.t <= self.last_phone_t:
            self._reject("iphone_out_of_order", now)
            return
        self.last_seq, self.last_phone_t, self.last_received = f.seq, f.t, now
        self.face, self.depth_available = f.tracked, f.depth_available
        self.emit({"type": "face", "present": self.face, "t": now * 1000})
        if not f.valid:
            self._reject(f.reason, now)
            return
        supported = self.model is None or not hasattr(self.model, "supports") or bool(self.model.supports(f.geometry_features)[0])
        if not supported and not (self.collecting is not None and self.collecting_calibration):
            self.smooth.reset()
            self.last_valid_t = None
            self._reject("head_pose_outside_calibration", now)
            return
        pred = self.model.predict(f.geometry_features)[0] + self.offset if self.model else None
        if self.collecting is not None:
            self.collecting.attempted += 1
            self.collecting.samples.append(f.geometry_features.copy())
            if pred is not None and np.isfinite(pred).all():
                self.collecting.predictions.append(pred.copy())
        if not supported:
            # New calibration may expand support, but the old cursor must abstain.
            # The sample was accepted above; do not count it again as rejected.
            self.smooth.reset()
            self.last_valid_t = None
            self.emit({"type": "gaze", "t": now * 1000, "valid": False, "quality": "invalid",
                       "reason": "head_pose_outside_calibration",
                       "guidance": "collecting this new posture; cursor resumes after calibration"})
            return
        if pred is None:
            self.emit({"type": "gaze", "t": now * 1000, "valid": False, "quality": "invalid", "reason": "iphone_needs_calibration"})
            return
        d = self.display
        raw = pred * [d["w"], d["h"]] + [d["x"], d["y"]]
        if not np.isfinite(raw).all():
            self.smooth.reset()
            self._reject("iphone_invalid_prediction", now)
            return
        # Use capture time, not Wi-Fi arrival time. Never interpolate across a
        # long blink, lost face, new calibration, or interrupted camera session.
        if self.last_valid_t is None or f.t - self.last_valid_t > .25:
            self.smooth.reset()
        xy = self.smooth(raw, f.t)
        self.last_valid_t = f.t
        normalized = (xy - [d["x"], d["y"]]) / [d["w"], d["h"]]
        self.emit({"type": "gaze", "t": now * 1000, "valid": bool(np.isfinite(xy).all()), "quality": "tracked",
                   "x": float(xy[0]), "y": float(xy[1]), "nx": float(normalized[0]), "ny": float(normalized[1]),
                   "raw": {"x": float(raw[0]), "y": float(raw[1])}, "blink": False,
                   "depthAvailable": f.depth_available})

    def command(self, msg):
        result = self._command(msg)
        if result is not None and "requestId" in msg:
            result["requestId"] = msg["requestId"]
        return result

    def _command(self, msg):
        kind = msg.get("type")
        if kind == "hello":
            return self.hello()
        if kind == "calib_begin":
            self.targets, self.collecting = [], None
            self.collecting_calibration = not (msg.get("validateOnly") or msg.get("recenterOnly"))
            return {"type": kind}
        if kind == "calib_target":
            d = self.display
            xy = np.array([float(msg["nx"]), float(msg["ny"])]) if "nx" in msg else (np.array([float(msg["x"]), float(msg["y"])]) - [d["x"], d["y"]]) / [d["w"], d["h"]]
            if not np.isfinite(xy).all() or np.any(xy < 0) or np.any(xy > 1):
                raise ValueError("target must be within display")
            if msg.get("retry"):
                if not self.targets or not np.allclose(self.targets[-1].xy, xy, atol=1e-6, rtol=0):
                    raise ValueError("retry must match previous target")
                self.collecting = self.targets[-1]
            else:
                self.collecting = _Target(xy)
                self.targets.append(self.collecting)
            return None
        if kind == "calib_target_end":
            p, self.collecting = self.collecting, None
            n, attempted = (len(p.samples), p.attempted) if p else (0, 0)
            coverage = n / attempted if attempted else 0
            return {"type": "calib_point", "index": len(self.targets) - 1, "samples": n, "attempted": attempted,
                    "coverage": coverage, "rejected": p.rejected if p else {}, "ok": n >= 5 and coverage >= .8}
        if kind == "calib_reset":
            self.smooth.reset()
            self.last_valid_t = None
            self.model = self.radius = self.cv_radius = self.validation = None
            self.offset = np.zeros(2)
            self.targets, self.collecting = [], None
            return {"type": "calib_result", "reset": True, "corrected": False, "accuracyValidated": False}
        if kind == "calib_finish":
            if msg.get("recenterOnly"):
                if msg.get("validateOnly"):
                    raise ValueError("recenter and validation must be separate")
                return self._recenter()
            return self._finish(bool(msg.get("validateOnly")))
        return {"type": "error", "error": f"unknown command {kind!r}"}

    def _recenter(self):
        points, self.targets, self.collecting = self.targets, [], None
        base = {"type": "calib_result", "ok": False, "applied": False, "recenterOnly": True}
        if self.model is None or len(points) != 1:
            return {**base, "error": "recenter needs an existing calibration and one center target"}
        p = points[0]
        if (np.any(np.abs(p.xy - .5) > .15) or len(p.samples) < 15 or
                len(p.samples) / max(1, p.attempted) < .8 or len(p.predictions) != len(p.samples)):
            return {**base, "error": "look at the center: need 15 samples with 80% coverage"}
        scale = np.array([self.display["w"], self.display["h"]])
        predictions = np.array(p.predictions)
        center = np.median(predictions, axis=0)
        jitter = float(np.sqrt(np.mean(np.sum(((predictions-center)*scale)**2, axis=1))))
        correction = p.xy - center
        if jitter > 60 or np.linalg.norm(correction * scale) > .3 * np.linalg.norm(scale):
            return {**base, "error": "center samples too unstable or offset too large; run a fresh calibration",
                    "jitterRmsPoints": jitter}
        self.offset += correction
        self.validation = None
        self.radius = self.cv_radius
        self.smooth.reset()
        self.last_valid_t = None
        return {**base, "ok": True, "applied": True, "accuracyValidated": False,
                "corrected": True, "correctionPoints": (correction * scale).tolist(),
                "jitterRmsPoints": jitter, "uncertaintySource": "grouped_cv_estimate",
                "uncertaintyDeg": self.radius / self.pt_per_deg if self.radius is not None else None}

    def _finish(self, validate):
        points, self.targets, self.collecting = self.targets, [], None
        base = {"type": "calib_result", "ok": False, "applied": False, "validationOnly": validate}
        if validate:
            self.validation = None
            self.radius = self.cv_radius
            base["accuracyValidated"] = False
        minimum = 5 if validate else 9
        if len(points) < minimum or any(len(p.samples) < 5 or len(p.samples) / max(p.attempted, 1) < .8 for p in points):
            return {**base, "error": f"need {minimum} targets with at least five samples and 80% coverage each"}
        y = np.array([p.xy for p in points])
        unique, target_groups = np.unique(y.round(5), axis=0, return_inverse=True)
        if len(unique) < minimum or np.any(np.ptp(y, axis=0) < .5):
            return {**base, "error": "targets must be distinct and span both screen axes"}
        scale = np.array([self.display["w"], self.display["h"]])
        if validate:
            if self.model is None or any(len(p.predictions) != len(p.samples) for p in points):
                return {**base, "error": "calibrate before validation"}
            errors = [np.linalg.norm((np.array(p.predictions) - p.xy) * scale, axis=1) for p in points]
            mean = float(np.mean([e.mean() for e in errors]))
            p90 = float(np.percentile(np.concatenate(errors), 90))
            residuals = [(np.array(p.predictions) - p.xy) * scale for p in points]
            per_target = [{"nx": float(p.xy[0]), "ny": float(p.xy[1]),
                           "biasXPoints": float(r[:, 0].mean()), "biasYPoints": float(r[:, 1].mean()),
                           "meanPoints": float(e.mean()), "p90Points": float(np.percentile(e, 90)),
                           "jitterRmsPoints": float(np.sqrt(np.mean(np.sum((r-r.mean(axis=0))**2, axis=1)))),
                           "samples": len(r)} for p, r, e in zip(points, residuals, errors)]
            self.radius = p90
            self.validation = {"meanPoints": mean, "p90Points": p90, "meanDeg": mean / self.pt_per_deg,
                               "p90Deg": p90 / self.pt_per_deg, "worstDeg": float(max(e.max() for e in errors)) / self.pt_per_deg,
                               "coverage": sum(len(p.samples) for p in points) / sum(p.attempted for p in points),
                               "targets": len(points), "perTarget": per_target, "measurement": "raw_unsmoothed"}
            return {**base, "ok": True, **self.validation, "currentDeg": mean / self.pt_per_deg,
                    "accuracyValidated": True, "uncertaintyDeg": p90 / self.pt_per_deg,
                    "uncertaintySource": "current_live_validation"}
        x = np.vstack([p.samples for p in points])
        labels = np.vstack([np.tile(p.xy, (len(p.samples), 1)) for p in points])
        groups = np.concatenate([np.full(len(p.samples), target_groups[i]) for i, p in enumerate(points)])
        weights = np.concatenate([np.full(len(p.samples), 1 / len(p.samples)) for p in points])
        candidate, stats = fit_iphone_model(x, labels, groups, weights, scale)
        self.smooth.reset()
        self.last_valid_t = None
        self.offset = np.zeros(2)
        self.model, self.validation = candidate, None
        # Mean CV is not a 90% containment radius. Label estimate explicitly and
        # keep it conservative until a separate frozen-model validation run.
        self.radius = self.cv_radius = max(float(stats["cv_error"]) * 2, 1)
        return {**base, "ok": True, "applied": True, "currentDeg": stats["cv_error"] / self.pt_per_deg,
                "cvMeanPoints": stats["cv_error"], "trainMeanPoints": stats["train_error"],
                "selectedModel": stats["selectedModel"], "modelCandidates": stats["modelCandidates"],
                "featureSchema": stats["featureSchema"], "selectionPolicy": stats["selectionPolicy"],
                "accuracyValidated": False, "uncertaintyDeg": self.radius / self.pt_per_deg,
                "uncertaintySource": "grouped_cv_estimate", "corrected": False}
