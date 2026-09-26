"""Gaze as a stream of events, for apps instead of the OS cursor.

`eye run` turns gaze into mouse moves and clicks. `eye serve` runs this
instead: the same tracking, blink gestures and fixation filter, but the output
is events (gaze samples, fixations, held blinks) that a web app or an agent can
consume. Nothing here moves the mouse.

On top of the saved calibration sits a `Correction`: a small affine fix fit from
a few "look here" dots shown by the app itself. The full calibration takes a
minute and a half and should happen before the demo; the correction takes ten
seconds and soaks up drift from sitting differently since then.
"""

from __future__ import annotations

import json
import math
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field

import numpy as np

from .calibration import Calibration
from .features import gaze_vector
from .filters import FixationFilter, OneEuro
from .gestures import GestureConfig, GestureDetector
from .profile import FaceProfile
from .screen import Display

Emit = Callable[[dict], None]

# gesture kind -> the name apps see. A held blink is the "confirm" click.
GESTURE_NAMES = {
    "long_blink": "confirm",
    "longer_blink": "back",
    "long_close": "long_close",
    "wink_left": "wink_left",
    "wink_right": "wink_right",
    "brow_hold": "brow",
    "mouth_hold": "mouth",
    "tier_click": "tier_confirm",  # still holding: opening now would confirm
    "tier_right": "tier_back",
}


class Correction:
    """Affine drift fix in normalized display coords, shrunk toward identity.

    With few or badly spread points an unconstrained affine can shear the whole
    screen off a single bad fixation, so the fit is ridge regularized toward
    "no change" and falls back to a pure offset under four points.
    """

    def __init__(self, a: np.ndarray | None = None):
        self.a = np.array([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]]) if a is None else np.asarray(a, dtype=np.float64)

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
        gestures: GestureConfig | None = None,
        correction: Correction | None = None,
        distance_cm: float = 55.0,
        fixation_radius_deg: float = 2.5,
        min_fixation_s: float = 0.1,
        freeze_lookback_s: float = 0.15,
        settle_s: float = 0.15,
        max_head_speed: float = 60.0,
        on_gesture: Callable[[str], None] | None = None,
    ):
        self.display = display
        self.calib = calib
        self.model = calib.model if calib else None
        self.profile = calib.profile if calib else FaceProfile()
        self.emit = emit
        self.on_gesture = on_gesture
        cfg = gestures or GestureConfig()
        cfg.click_s = self.profile.click_s
        self.gestures = GestureDetector(cfg, winks=(self.profile.wink_l, self.profile.wink_r))
        self.correction = correction or Correction()
        self.distance_cm = distance_cm
        self.pt_per_deg = display.points_per_mm * 10.0 * distance_cm * math.tan(math.radians(1.0))
        self.fix = FixationFilter(fixation_radius_deg * self.pt_per_deg, confirm=2, window=15)
        self.head = OneEuro(1.5, 0.05)
        self.min_fixation_s = min_fixation_s
        self.freeze_lookback_s = freeze_lookback_s
        self.settle_s = settle_s
        self.max_head_speed = max_head_speed
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
            "display": {"x": d.x, "y": d.y, "w": d.w, "h": d.h, "ptPerDeg": round(self.pt_per_deg, 2)},
            "calibrated": self.calibrated,
            "accuracyDeg": st.get("validation_deg"),
            "corrected": not self.correction.identity,
        }

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
        t = frame.t
        if feats is None:
            if self.face:
                self._end_fixation(t)
                self.emit({"type": "face", "present": False, "t": self.ms(t)})
            self.face = False
            self._stable_since = None
            self.gestures.reset()
            self.fix.reset()
            self._frozen = None
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
            raw_n = self.model.predict(gaze_vector(feats))[0]
        gaze_y = self.display.to_norm(*self._history[-1][1])[1] if self._history else 0.5
        closure = self.profile.closure(feats, gaze_y)

        events = []
        if t - self._stable_since >= 0.3:  # a fresh face lock spikes closure
            if self.head.speed > self.max_head_speed:
                self.gestures.cancel()
            events += self.gestures.update(t, *closure, smile=feats.smile, winks_ok=abs(feats.yaw) <= 20.0)
            events += self.gestures.update_expressions(t, self.profile.brow_level(feats), self.profile.jaw_level(feats))

        closing = self.gestures.closing
        if closing and self._frozen is None:
            # Eyes roll down as the lids close: use where you were looking just before.
            self._frozen = self._at(t - self.freeze_lookback_s)
        elif not closing and self._frozen is not None:
            self._frozen = None
            self._resume_t = t + self.settle_s

        for e in events:
            self._gesture(e, t)
        if raw_n is None:
            return

        if not closing and t >= self._resume_t and self._collecting is not None:
            self._collecting.preds.append(raw_n.copy())

        if closing or t < self._resume_t:
            g = self._frozen if self._frozen is not None else self._at(t)
            if g is not None:
                self.emit({"type": "gaze", "t": self.ms(t), "blink": True, **self._point(g), "fix": self._fix_state(t)})
            return

        n = self.correction.apply(raw_n)
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
        self._history.append((t, center))
        self.emit(
            {
                "type": "gaze",
                "t": self.ms(t),
                "blink": False,
                **self._point(center),
                "raw": self._point(g),
                "fix": self._fix_state(t),
            }
        )

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

    def _gesture(self, e, t: float) -> None:
        name = GESTURE_NAMES.get(e.kind)
        if name is None:
            return
        g = self._frozen if self._frozen is not None else self._at(t)
        msg = {"type": "gesture", "kind": name, "t": self.ms(e.t), "startedAt": self.ms(e.t_start)}
        if g is not None:
            msg.update(self._point(g))
        self.emit(msg)
        if self.on_gesture:
            self.on_gesture(name)

    # app commands (any thread; the GIL keeps these list swaps atomic enough)
    def command(self, msg: dict) -> dict | None:
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
            self._collecting = CalibPoint(nx, ny)
            self._calib.append(self._collecting)
            return None
        if kind == "calib_target_end":
            point, self._collecting = self._collecting, None
            n = len(point.preds) if point else 0
            return {"type": "calib_point", "index": len(self._calib or []) - 1, "samples": n, "ok": n >= 5}
        if kind == "calib_finish":
            return self._finish(apply=msg.get("apply", True))
        if kind == "calib_reset":
            self.correction = Correction()
            self._calib, self._collecting = None, None
            return {"type": "calib_result", "reset": True, "corrected": False}
        return {"type": "error", "error": f"unknown command {kind!r}"}

    def _norm_target(self, msg: dict) -> tuple[float, float]:
        if "nx" in msg:
            return float(msg["nx"]), float(msg["ny"])
        return self.display.to_norm(float(msg["x"]), float(msg["y"]))

    def _finish(self, apply: bool = True) -> dict:
        points = [p for p in (self._calib or []) if len(p.preds) >= 5]
        self._calib, self._collecting = None, None
        if not points:
            return {"type": "calib_result", "ok": False, "error": "no usable points (face visible? calibrated?)"}
        pred = np.array([np.median(np.array(p.preds), axis=0) for p in points])
        target = np.array([(p.x, p.y) for p in points])
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
        # Keep the old correction if the new one doesn't generalize.
        improves = loo_deg is None or np.mean(loo_deg) < np.mean(before_deg)
        if apply and improves:
            self.correction = corr
        return {
            "type": "calib_result",
            "ok": True,
            "applied": bool(apply and improves),
            "corrected": not self.correction.identity,
            "points": len(points),
            "beforeDeg": round(float(np.mean(before_deg)), 2),
            "afterDeg": round(float(np.mean(after_deg)), 2),
            "looDeg": None if loo_deg is None else round(float(np.mean(loo_deg)), 2),
            "perPoint": [
                {"nx": round(float(p.x), 3), "ny": round(float(p.y), 3), "beforeDeg": round(b, 2), "afterDeg": round(a, 2)}
                for p, b, a in zip(points, before_deg, after_deg)
            ],
        }
