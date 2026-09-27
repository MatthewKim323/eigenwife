"""Per-user face signal normalization.

Raw signals vary a lot between people and with gaze direction: looking at the
bottom of the screen drops the upper lids, which lowers the eye aspect ratio
and raises MediaPipe's eyeBlink scores with the eyes open. The profile maps
raw values to 0 at a relaxed open eye (adjusted for where you're looking) and
1 at a deliberately closed one, so gesture thresholds can stay fixed.

Two closure signals exist: EAR from the landmarks, and the eyeBlink
blendshapes. They mostly agree for blinks, but blendshapes tend to read winks
as partly symmetric, so calibration picks the mix that separates best for you.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

import numpy as np

from .features import Features


@dataclass
class FaceProfile:
    mix: float = 0.0  # 0 = EAR only, 1 = blendshapes only, 0.5 = average of both
    swap: bool = False  # True if MediaPipe's eyeBlinkLeft follows the anatomical right eye
    ear_open_l: float = 0.28
    ear_open_r: float = 0.28
    ear_slope_l: float = 0.0  # change in the open baseline per unit of normalized gaze y
    ear_slope_r: float = 0.0
    ear_closed_l: float = 0.10
    ear_closed_r: float = 0.10
    bs_open_l: float = 0.10
    bs_open_r: float = 0.10
    bs_slope_l: float = 0.0
    bs_slope_r: float = 0.0
    bs_closed_l: float = 0.65
    bs_closed_r: float = 0.65
    wink_l: bool = False  # winks stay off until calibration shows you can do them cleanly
    wink_r: bool = False
    click_s: float = 0.35  # long-blink threshold, personalized from your spontaneous blinks
    brow_neutral: float = 0.05
    brow_raised: float = 0.65
    jaw_neutral: float = 0.02
    jaw_open: float = 0.55
    calibrated: bool = False
    # Open-eye models use observable iris position and head pitch, never the
    # displayed target or the gaze prediction that this filter is protecting.
    gaze_quality_coeffs: tuple = ()  # four (intercept, iris-v, pitch/30) models
    gaze_quality_bounds: tuple = ()  # min/max for left-v, right-v, pitch/30

    def gaze_closure(self, f: Features) -> tuple[float, float]:
        """Gaze data quality, separate from intentional expression gestures."""
        if len(self.gaze_quality_coeffs) != 12 or len(self.gaze_quality_bounds) != 6:
            return self.closure(f)
        inputs = np.array([f.left.v, f.right.v, f.pitch / 30.0])
        if not np.isfinite(inputs).all():
            return 1.5, 1.5
        bounds = np.asarray(self.gaze_quality_bounds).reshape(2, 3)
        lv, rv, pitch = np.clip(inputs, bounds[0], bounds[1])
        coeffs = np.asarray(self.gaze_quality_coeffs).reshape(4, 3)
        open_values = [float(c @ [1, v, pitch])
                       for c, v in zip(coeffs, [lv, rv, lv, rv])]
        bl, br = self._bs(f)
        result = []
        for ear, bs, eo, bo, ec, bc in zip(
            [f.left.ear, f.right.ear], [bl, br], open_values[:2], open_values[2:],
            [self.ear_closed_l, self.ear_closed_r], [self.bs_closed_l, self.bs_closed_r],
        ):
            if not np.isfinite([ear, bs]).all():
                result.append(1.5)
                continue
            e = _norm(ear, max(eo, ec + 0.04), ec)
            b = _norm(bs, min(bo, bc - 0.12), bc)
            # Moderate closure needs agreement. Severe geometric closure is
            # still rejected even if the expression model misses a blink.
            result.append(max(min(e, b), e if e >= 0.75 else 0.0))
        return tuple(result)

    def _bs(self, f: Features) -> tuple[float, float]:
        a, b = f.bs_blink
        return (b, a) if self.swap else (a, b)

    def closure_parts(self, f: Features, gaze_y: float | None = None):
        """(ear_l, ear_r, bs_l, bs_r) normalized closures."""
        dy = 0.0 if gaze_y is None else min(max(gaze_y, 0.0), 1.0) - 0.5
        bl, br = self._bs(f)
        return (
            _norm(f.left.ear, self.ear_open_l + self.ear_slope_l * dy, self.ear_closed_l),
            _norm(f.right.ear, self.ear_open_r + self.ear_slope_r * dy, self.ear_closed_r),
            _norm(bl, self.bs_open_l + self.bs_slope_l * dy, self.bs_closed_l),
            _norm(br, self.bs_open_r + self.bs_slope_r * dy, self.bs_closed_r),
        )

    def closure(self, f: Features, gaze_y: float | None = None) -> tuple[float, float]:
        """Anatomical (left, right) eye closure, 0 open .. 1 shut."""
        el, er, bl, br = self.closure_parts(f, gaze_y)
        m = self.mix
        return (1 - m) * el + m * bl, (1 - m) * er + m * br

    def brow_level(self, f: Features) -> float:
        return _norm(f.brow, self.brow_neutral, self.brow_raised)

    def jaw_level(self, f: Features) -> float:
        return _norm(f.jaw, self.jaw_neutral, self.jaw_open)

    def to_arrays(self, prefix: str = "profile_") -> dict[str, np.ndarray]:
        return {prefix + k: np.array(v) for k, v in asdict(self).items()}

    @classmethod
    def from_arrays(cls, d, prefix: str = "profile_") -> "FaceProfile":
        kwargs = {}
        for name, default in asdict(cls()).items():
            if prefix + name in d:
                value = np.asarray(d[prefix + name])
                kwargs[name] = tuple(value.tolist()) if isinstance(default, tuple) else type(default)(value.item())
        return cls(**kwargs)


def _norm(raw: float, open_: float, closed: float) -> float:
    span = closed - open_
    if abs(span) < 1e-6:
        return 0.0
    return float(min(max((raw - open_) / span, 0.0), 1.5))
