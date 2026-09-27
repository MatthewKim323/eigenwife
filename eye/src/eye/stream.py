"""Gaze as a stream of events, for apps instead of the OS cursor.

`eye run` turns gaze into mouse moves and clicks. `eye serve` runs this
instead: the same tracking and fixation filter, but the output is events (gaze
samples and fixations) that a web app or an agent can consume, so it knows what
you're looking at. Gaze is context only: nothing here moves the mouse or clicks.

On top of the saved calibration sits a `Correction`: a small affine fix fit from
a few "look here" dots shown by the app itself. The full calibration takes a
minute and a half and should happen before the demo; the correction takes ten
seconds and soaks up drift from sitting differently since then.
"""

from __future__ import annotations

import json
import hashlib
import math
import time
import threading
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field

import numpy as np

from .calibration import Calibration
from .features import gaze_vector
from .filters import FixationFilter, OneEuro
from .profile import FaceProfile
from .gaze_quality import GazeQualityGate
from .screen import Display

Emit = Callable[[dict], None]

class Correction:
    """Affine drift fix in normalized display coords, shrunk toward identity.

    With few or badly spread points an unconstrained affine can shear the whole
    screen off a single bad fixation, so the fit is ridge regularized toward
    "no change" and falls back to a pure offset under four points.
    """

    def __init__(self, a: np.ndarray | None = None):
        self.a = np.array([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]]) if a is None else np.asarray(a, dtype=np.float64)
        if self.a.shape != (2, 3) or not np.isfinite(self.a).all():
            raise ValueError("invalid correction matrix")

    @property
    def identity(self) -> bool:
        return np.allclose(self.a, [[1, 0, 0], [0, 1, 0]])

    def apply(self, n) -> np.ndarray:
        n = np.asarray(n, dtype=np.float64)
        return self.a[:, :2] @ n + self.a[:, 2]

    @classmethod
    def fit(cls, pred, target, shrink: float = 0.05) -> "Correction":
        pred = np.asarray(pred, dtype=np.float64).reshape(-1, 2)
        target = np.asarray(target, dtype=np.float64).reshape(-1, 2)
        if len(pred) == 0:
            return cls()
        if len(pred) < 4:
            off = np.mean(target - pred, axis=0)
            return cls(np.array([[1.0, 0.0, off[0]], [0.0, 1.0, off[1]]]))
        p = np.hstack([pred, np.ones((len(pred), 1))])
        prior = np.array([[1.0, 0.0], [0.0, 1.0], [0.0, 0.0]])
        reg = shrink * len(pred) * np.diag([1.0, 1.0, 0.0])  # the offset is free
        coef = np.linalg.solve(p.T @ p + reg, p.T @ target + reg @ prior)
        return cls(coef.T)

    def to_json(self) -> str:
        return json.dumps({"a": self.a.tolist()})

    @classmethod
    def from_json(cls, text: str) -> "Correction":
        return cls(np.array(json.loads(text)["a"]))


@dataclass
class CalibPoint:
    x: float  # target, normalized display coords
    y: float
    preds: list = field(default_factory=list)  # uncorrected model predictions while sampling
    attempted: int = 0
    rejected: dict[str, int] = field(default_factory=dict)


def _errors(pred: np.ndarray, target: np.ndarray, display: Display, distance_cm: float) -> list[float]:
    pts = np.hypot((pred[:, 0] - target[:, 0]) * display.w, (pred[:, 1] - target[:, 1]) * display.h)
    return [display.degrees(float(p), distance_cm) for p in pts]


class GazeStream:
    """Tracker frames in, app events out. Call `on_frame` from the tracker thread."""

    def __init__(
        self,
        display: Display,
        calib: Calibration | None,
        emit: Emit,
        correction: Correction | None = None,
        distance_cm: float = 55.0,
        fixation_radius_deg: float = 2.5,
        min_fixation_s: float = 0.1,
        freeze_lookback_s: float = 0.15,
        settle_s: float = 0.15,
        blink_on: float = 0.35,  # normalized closure where a blink starts...
        blink_off: float = 0.25,  # ...and where it's over
    ):
        self.display = display
        self._lock = threading.RLock()
        self.calib = calib
        self.model = calib.model if calib else None
        self.profile = calib.profile if calib else FaceProfile()
        self.emit = emit
        self.blink_on, self.blink_off = blink_on, blink_off
        self.gaze_quality = GazeQualityGate(self.profile, on=blink_on, off=blink_off, recovery_s=0.0)
        self.blinking = False
        self.correction = correction or Correction()
        self.correction_loo_deg: float | None = None
        self.live_validation: dict | None = None
        self.distance_cm = distance_cm
        self.pt_per_deg = display.points_per_mm * 10.0 * distance_cm * math.tan(math.radians(1.0))
        self.fix = FixationFilter(fixation_radius_deg * self.pt_per_deg, confirm=2, window=15)
        self.head = OneEuro(1.5, 0.05)
        self.smooth = OneEuro(1.5, 0.02)
        self._pose_bounds = None
        if calib is not None and calib.train is not None and len(calib.train[0]):
            pose = calib.train[0][:, 6:12]
            lo, hi = np.min(pose, axis=0), np.max(pose, axis=0)
            # A tolerance envelope, not a calibrated confidence probability.
            margin = np.maximum((hi - lo) * 0.25, [4, 4, 4, 0.04, 0.04, 5])
            self._pose_bounds = (lo - margin, hi + margin)
        self.min_fixation_s = min_fixation_s
        self.freeze_lookback_s = freeze_lookback_s
        self.settle_s = settle_s
        # monotonic -> epoch ms, so apps get wall clock times
        self._epoch = time.time() - time.monotonic()

        self.face = False
        self._stable_since: float | None = None
        self._history: deque = deque(maxlen=30)  # (t, corrected gaze point) with the eyes open
        self._frozen: np.ndarray | None = None
        self._resume_t = 0.0
        self._fix_id = 0  # FixationFilter.fixations value of the current fixation
        self._fix_start: float | None = None
        self._fix_started = False  # fixation_start sent for the current fixation
        self._fix_last: tuple[float, np.ndarray] | None = None
        self._calib: list[CalibPoint] | None = None
        self._collecting: CalibPoint | None = None

    # helpers
    def ms(self, t: float) -> int:
        return int((t + self._epoch) * 1000)

    @property
    def calibrated(self) -> bool:
        return self.model is not None

    def hello(self) -> dict:
        d = self.display
        st = self.calib.meta.get("stats", {}) if self.calib else {}
        return {
            "type": "hello",
            "display": {"x": d.x, "y": d.y, "w": d.w, "h": d.h, "scale": d.scale,
                        "ptPerDeg": round(self.pt_per_deg, 2)},
            "calibrated": self.calibrated,
            "accuracyDeg": self.live_validation["meanDeg"] if self.live_validation else (st.get("validation_deg") if self.correction.identity else None),
            "face": self.face,
            "uncertaintyDeg": self.uncertainty_deg(),
            "uncertaintySource": "current_live_validation" if self.live_validation else "conservative_estimate",
            "accuracyValidated": self.live_validation is not None,
            "corrected": not self.correction.identity,
            "backend": self.calib.meta.get("feature_backend", {"name": "landmarks"}) if self.calib else None,
        }

    def pose_diagnostic(self, vector: np.ndarray) -> dict | None:
        if self._pose_bounds is None:
            return None
        pose = vector[6:12]
        lo, hi = self._pose_bounds
        names = ("yaw", "pitch", "roll", "horizontal_position", "vertical_position", "distance")
        outside = [i for i in range(6) if pose[i] < lo[i] or pose[i] > hi[i]]
        if not outside:
            return None
        guidance = ("face the laptop camera and return to your calibration posture"
                    if any(i < 3 for i in outside) else "return to the position and distance used during calibration")
        i = outside[0]
        guidance += f" ({names[i]} {pose[i]:.1f}; calibrated range {lo[i]:.1f} to {hi[i]:.1f})"
        return {"guidance": guidance, "outside": [names[i] for i in outside],
                "values": {names[i]: round(float(pose[i]), 3) for i in outside},
                "allowed": {names[i]: [round(float(lo[i]), 3), round(float(hi[i]), 3)] for i in outside}}

    def uncertainty_deg(self) -> float | None:
        if self.live_validation:
            return self.live_validation["p90Deg"]
        stats = self.calib.meta.get("stats", {}) if self.calib else {}
        values = [stats.get("validation_frame_p90_deg"), stats.get("validation_p90_deg"), stats.get("validation_deg"), self.correction_loo_deg]
        p90_points = stats.get("validation_frame_p90_points")
        if isinstance(p90_points, (int, float)) and math.isfinite(p90_points):
            values.append(self.display.degrees(p90_points, self.distance_cm))
        finite = [float(v) for v in values if isinstance(v, (float, int)) and math.isfinite(v) and v > 0]
        return max(finite) if finite else None

    def _point(self, g: np.ndarray) -> dict:
        nx, ny = self.display.to_norm(*g)
        return {"x": round(float(g[0]), 1), "y": round(float(g[1]), 1), "nx": round(nx, 4), "ny": round(ny, 4)}

    def _end_fixation(self, t: float) -> None:
        if self._fix_started and self._fix_last is not None:
            last_t, center = self._fix_last
            self.emit(
                {
                    "type": "fixation_end",
                    "id": self._fix_id,
                    "t": self.ms(last_t),
                    "ms": int((last_t - self._fix_start) * 1000),
                    **self._point(center),
                }
            )
        self._fix_started = False
        self._fix_start = None
        self._fix_last = None

    # tracker thread
    def on_frame(self, frame, obs, feats) -> None:
        # Commands arrive on the websocket loop while inference runs on a
        # camera thread. A target cannot change halfway through a frame.
        with self._lock:
            self._on_frame(frame, obs, feats)

    def _on_frame(self, frame, obs, feats) -> None:
        t = frame.t
        if self._collecting is not None:
            self._collecting.attempted += 1
        if feats is None:
            if self._collecting is not None:
                self._collecting.rejected["face_lost"] = self._collecting.rejected.get("face_lost", 0) + 1
            if self.face:
                self._end_fixation(t)
                self.emit({"type": "face", "present": False, "t": self.ms(t)})
            self.face = False
            self._stable_since = None
            self.blinking = False
            self.gaze_quality.reset()
            self.fix.reset()
            self.smooth.reset()
            self._history.clear()
            self._resume_t = 0.0
            self._frozen = None
            self.emit({"type": "gaze", "t": self.ms(t), "valid": False, "quality": "invalid", "reason": "face_lost", "fix": None})
            return
        if not self.face:
            self.emit({"type": "face", "present": True, "t": self.ms(t)})
            self.face = True
            self._stable_since = t
            self.head.reset()
            self.fix.reset()

        self.head((feats.yaw, feats.pitch), t)
        raw_n = None
        if self.model is not None:
            vector = gaze_vector(feats)
            reason = None
            if len(vector) < self.model.n_features:
                reason = "appearance_features_unavailable"
            elif not np.isfinite(vector).all():
                reason = "nonfinite_features"
            if reason:
                self._invalidate(t, reason)
                return
            pose = self.pose_diagnostic(vector)
            if pose:
                self._invalidate(t, "head_pose_outside_calibration", guidance=pose["guidance"], pose=pose)
                return
            raw_n = self.model.predict(vector)[0]
            if not np.isfinite(raw_n).all():
                self._invalidate(t, "nonfinite_prediction")
                return
        # Blinks only matter as bad data: the eyes roll down as the lids close.
        # Baseline depends only on observed eye/head geometry, never predicted
        # gaze. Otherwise a downward look can lock itself into a false blink.
        was_blinking = self.blinking
        self.blinking = self.gaze_quality.update(feats)
        closing = self.blinking
        if closing and self._frozen is None:
            # Eyes roll down as the lids close: use where you were looking just before.
            self._frozen = self._at(t - self.freeze_lookback_s)
        elif not closing and was_blinking:
            self._frozen = None
            self._resume_t = t + self.settle_s

        if raw_n is None:
            self._invalidate(t, "uncalibrated")
            return

        if not closing and t >= self._resume_t and self._collecting is not None:
            self._collecting.preds.append(raw_n.copy())

        if closing or t < self._resume_t:
            if self._collecting is not None:
                reason = "blink_or_settling"
                self._collecting.rejected[reason] = self._collecting.rejected.get(reason, 0) + 1
            g = self._frozen if self._frozen is not None else self._at(t)
            if g is not None:
                self.emit({"type": "gaze", "t": self.ms(t), "blink": True, "valid": False, "quality": "invalid", "reason": "blink", **self._point(g), "fix": None})
            else:
                self.emit({"type": "gaze", "t": self.ms(t), "blink": True, "valid": False, "quality": "invalid", "reason": "blink", "fix": None})
            self._end_fixation(t)
            self.fix.reset()
            self.smooth.reset()
            return

        n = self.correction.apply(raw_n)
        if not np.isfinite(n).all() or np.any(n < -0.1) or np.any(n > 1.1):
            self._invalidate(t, "outside_display")
            return
        g = np.array(self.display.to_global(*np.clip(n, -0.1, 1.1)))
        before = self.fix.fixations
        center = self.fix.update(g)
        if self.fix.fixations != before:
            self._end_fixation(t)
            self._fix_id = self.fix.fixations
            self._fix_start = t
        self._fix_last = (t, center)
        if not self._fix_started and self._fix_start is not None and t - self._fix_start >= self.min_fixation_s:
            self._fix_started = True
            self.emit({"type": "fixation_start", "id": self._fix_id, "t": self.ms(self._fix_start), **self._point(center)})
        displayed = self.smooth(g, t)
        self._history.append((t, displayed))
        self.emit(
            {
                "type": "gaze",
                "t": self.ms(t),
                "blink": False,
                "valid": True,
                "quality": "usable" if self._pose_bounds is not None else "unknown",
                "reason": None if self._pose_bounds is not None else "pose_coverage_unavailable",
                **self._point(displayed),
                "raw": self._point(g),
                "fix": self._fix_state(t),
            }
        )

    def _invalidate(self, t: float, reason: str, **details) -> None:
        if self._collecting is not None:
            self._collecting.rejected[reason] = self._collecting.rejected.get(reason, 0) + 1
        self._end_fixation(t)
        self.fix.reset()
        self.smooth.reset()
        self._history.clear()
        self._frozen = None
        self.emit({"type": "gaze", "t": self.ms(t), "valid": False,
                   "quality": "invalid", "reason": reason, "fix": None, **details})

    def fingerprint(self) -> str | None:
        """Bind correction to model, profile, and physical display geometry."""
        if self.calib is None:
            return None
        digest = hashlib.sha256()
        for arrays in (self.calib.model.to_arrays(), self.calib.profile.to_arrays()):
            for name, value in sorted(arrays.items()):
                array = np.asarray(value)
                digest.update(name.encode())
                digest.update(str((array.shape, array.dtype)).encode())
                digest.update(array.tobytes())
        d = self.display
        digest.update(json.dumps([d.id, d.name, d.x, d.y, d.w, d.h, d.scale, d.mm]).encode())
        return digest.hexdigest()

    def _fix_state(self, t: float) -> dict | None:
        if not self._fix_started:
            return None
        return {"id": self._fix_id, "ms": int((t - self._fix_start) * 1000)}

    def _at(self, t: float) -> np.ndarray | None:
        best = None
        for ht, g in self._history:
            if ht > t:
                break
            best = g
        if best is None and self._history:
            best = self._history[-1][1]
        return None if best is None else best.copy()

    # app commands, serialized with frame processing
    def command(self, msg: dict) -> dict | None:
        with self._lock:
            return self._command(msg)

    def _command(self, msg: dict) -> dict | None:
        kind = msg.get("type")
        if kind == "hello":
            return self.hello()
        if kind == "calib_begin":
            self._calib, self._collecting = [], None
            return {"type": "calib_begin"}
        if kind == "calib_target":
            if self._calib is None:
                self._calib = []
            nx, ny = self._norm_target(msg)
            if not all(math.isfinite(v) and 0 <= v <= 1 for v in (nx, ny)):
                raise ValueError("calibration target must be within the display")
            if msg.get("retry"):
                if not self._calib or not np.allclose([nx, ny], [self._calib[-1].x, self._calib[-1].y], rtol=0, atol=1e-6):
                    raise ValueError("retry must refer to the previous calibration target")
                self._collecting = self._calib[-1]
            else:
                self._collecting = CalibPoint(nx, ny)
                self._calib.append(self._collecting)
            return None
        if kind == "calib_target_end":
            point, self._collecting = self._collecting, None
            n = len(point.preds) if point else 0
            attempted = point.attempted if point else 0
            coverage = n / attempted if attempted else 0.0
            return {"type": "calib_point", "index": len(self._calib or []) - 1, "samples": n,
                    "attempted": attempted, "coverage": coverage, "rejected": dict(point.rejected) if point else {},
                    "requestId": msg.get("requestId"),
                    "ok": n >= 5 and (not msg.get("validateOnly") or coverage >= 0.8)}
        if kind == "calib_finish":
            return self._finish(apply=msg.get("apply", True), validate_only=msg.get("validateOnly", False))
        if kind == "calib_reset":
            self.correction = Correction()
            self.correction_loo_deg = None
            self.live_validation = None
            self._end_fixation(time.monotonic())
            self.fix.reset()
            self.smooth.reset()
            self._history.clear()
            self._frozen = None
            self._calib, self._collecting = None, None
            return {"type": "calib_result", "reset": True, "corrected": False,
                    "accuracyDeg": self.hello()["accuracyDeg"], "uncertaintyDeg": self.uncertainty_deg()}
        return {"type": "error", "error": f"unknown command {kind!r}"}

    def _norm_target(self, msg: dict) -> tuple[float, float]:
        if "nx" in msg:
            return float(msg["nx"]), float(msg["ny"])
        return self.display.to_norm(float(msg["x"]), float(msg["y"]))

    def _finish(self, apply: bool = True, validate_only: bool = False) -> dict:
        if validate_only:
            self.live_validation = None
        requested = self._calib or []
        points = [p for p in requested if len(p.preds) >= 5]
        self._calib, self._collecting = None, None
        if validate_only and (len(points) != len(requested) or any(
                p.attempted == 0 or len(p.preds) / p.attempted < 0.8 for p in requested)):
            return {"type": "calib_result", "ok": False, "applied": False, "validationOnly": True,
                    "error": "every validation target needs five samples and at least 80% valid-frame coverage"}
        if len(points) < 5:
            rejected: dict[str, int] = {}
            for point in requested:
                for reason, count in point.rejected.items():
                    rejected[reason] = rejected.get(reason, 0) + count
            cause = max(rejected, key=rejected.get) if rejected else "too_few_camera_frames"
            return {"type": "calib_result", "ok": False, "applied": False, "currentDeg": None,
                    "error": f"only {len(points)}/{len(requested)} targets had enough usable frames ({cause}); "
                             "if your head pose is outside the saved calibration, run a new base calibration",
                    "targetSamples": [len(p.preds) for p in requested], "rejected": rejected}
        pred = np.array([np.median(np.array(p.preds), axis=0) for p in points])
        target = np.array([(p.x, p.y) for p in points])
        if (not np.isfinite(pred).all() or not np.isfinite(target).all()
                or np.any(target < 0) or np.any(target > 1)
                or np.any(np.ptp(target, axis=0) < 0.5)
                or np.linalg.svd(target - target.mean(axis=0), compute_uv=False)[-1] / np.sqrt(len(target)) < 0.12
                or len(np.unique(target, axis=0)) < 5):
            return {"type": "calib_result", "ok": False, "applied": False, "currentDeg": None, "error": "targets must be finite, distinct, and spread across both screen axes"}
        if validate_only:
            frame_errors = []
            for point in points:
                samples = np.asarray(point.preds)
                if not np.isfinite(samples).all():
                    return {"type": "calib_result", "ok": False, "applied": False, "validationOnly": True, "error": "nonfinite validation samples"}
                corrected = np.array([self.correction.apply(p) for p in samples])
                targets = np.repeat([[point.x, point.y]], len(samples), axis=0)
                frame_errors.extend(_errors(corrected, targets, self.display, self.distance_cm))
            self.live_validation = {
                "meanDeg": round(float(np.mean(frame_errors)), 2),
                "p90Deg": round(float(np.percentile(frame_errors, 90)), 2),
                "worstDeg": round(float(np.max(frame_errors)), 2),
                "points": len(points), "samples": len(frame_errors),
                "attempted": sum(p.attempted for p in points),
                "coverage": len(frame_errors) / sum(p.attempted for p in points),
                "sampleScope": "valid_frames",
            }
            return {"type": "calib_result", "ok": True, "applied": False, "validationOnly": True,
                    "validation": self.live_validation, "corrected": not self.correction.identity,
                    "accuracyDeg": self.live_validation["meanDeg"], "uncertaintyDeg": self.live_validation["p90Deg"],
                    "uncertaintySource": "current_live_validation", "accuracyValidated": True}
        corr = Correction.fit(pred, target)
        after = np.array([corr.apply(p) for p in pred])
        # Honest number: each point predicted by a correction fit without it.
        loo = []
        if len(points) >= 3:
            for i in range(len(points)):
                keep = np.arange(len(points)) != i
                loo.append(Correction.fit(pred[keep], target[keep]).apply(pred[i]))
        before_deg = _errors(pred, target, self.display, self.distance_cm)
        after_deg = _errors(after, target, self.display, self.distance_cm)
        loo_deg = _errors(np.array(loo), target, self.display, self.distance_cm) if loo else None
        current_deg = _errors(np.array([self.correction.apply(p) for p in pred]), target, self.display, self.distance_cm)
        # Compare the candidate held-out estimate to the mapping actually in use.
        improves = loo_deg is not None and np.mean(loo_deg) < np.mean(current_deg)
        if apply and improves:
            self.correction = corr
            self.live_validation = None
            self.correction_loo_deg = float(np.mean(loo_deg))
            self._frozen = None
            self._end_fixation(time.monotonic())
            self.fix.reset()
            self.smooth.reset()
            self._history.clear()
        return {
            "type": "calib_result",
            "ok": True,
            "applied": bool(apply and improves),
            "corrected": not self.correction.identity,
            "currentDeg": round(float(np.mean(current_deg)), 2),
            "reason": "applied" if apply and improves else ("preview" if not apply else "no_heldout_improvement"),
            "accuracyDeg": None,
            "uncertaintyDeg": self.uncertainty_deg(),
            "uncertaintySource": "current_live_validation" if self.live_validation else "conservative_estimate",
            "accuracyValidated": self.live_validation is not None,
            "points": len(points),
            "beforeDeg": round(float(np.mean(before_deg)), 2),
            "afterDeg": round(float(np.mean(after_deg)), 2),
            "looDeg": None if loo_deg is None else round(float(np.mean(loo_deg)), 2),
            "perPoint": [
                {"nx": round(float(p.x), 3), "ny": round(float(p.y), 3), "beforeDeg": round(b, 2), "afterDeg": round(a, 2)}
                for p, b, a in zip(points, before_deg, after_deg)
            ],
        }
