"""Observable, frozen open-eye baselines and stateful blink recovery.

Fit only on training fixation/head-motion frames. These signals are identical
at fit, validation and deployment; screen labels are deliberately not accepted.
This is a heuristic quality filter, not a clinically validated blink detector.
"""
from __future__ import annotations

import numpy as np

from .profile import FaceProfile


def _robust_line(x, y, upper):
    """Trim blink-contaminated residuals before a small regularized fit."""
    weights = np.ones(len(y))
    coef = np.zeros(3)
    # EAR blinks are negative residuals; blendshape blinks are positive.
    for _ in range(6):
        coef = np.linalg.solve(x.T @ (weights[:, None] * x) + np.diag([1e-8, .002, .002]),
                               x.T @ (weights * y))
        residual = y - x @ coef
        median = np.median(residual)
        scale = max(float(np.median(np.abs(residual - median))) * 1.4826, .005)
        signed = (residual - median) * (1 if upper else -1)
        weights = np.where(signed < -2 * scale, .02, 1.0)
    return coef


def fit_gaze_quality(profile: FaceProfile, features) -> dict:
    """Fit a frozen baseline from open-eye tasks, allowing spontaneous blinks.

    Caller must exclude validation and deliberate expression frames. Returns
    diagnostics; fewer than 30 finite frames retain the legacy profile.
    """
    rows = []
    for f in features:
        if f is None:
            continue
        bl, br = profile._bs(f)
        row = [f.left.v, f.right.v, f.pitch / 30, f.left.ear, f.right.ear, bl, br]
        if np.isfinite(row).all():
            rows.append(row)
    if len(rows) < 30:
        return {"fitted": False, "samples": len(rows), "reason": "too_few_samples"}
    values = np.asarray(rows)
    bounds = np.percentile(values[:, :3], [1, 99], axis=0)
    predictors = np.clip(values[:, :3], bounds[0], bounds[1])
    coefficients = []
    for target, eye in [(3, 0), (4, 1), (5, 0), (6, 1)]:
        x = np.column_stack((np.ones(len(rows)), predictors[:, eye], predictors[:, 2]))
        coefficients.extend(_robust_line(x, values[:, target], upper=target < 5))
    profile.gaze_quality_coeffs = tuple(float(v) for v in coefficients)
    profile.gaze_quality_bounds = tuple(float(v) for v in bounds.ravel())
    return {"fitted": True, "samples": len(rows), "version": "observable-open-eye-v1"}


class GazeQualityGate:
    """Reject closure immediately, then require 60 ms of open-eye recovery.

    Never adapts an open baseline from live frames: holding closed cannot turn
    into an accepted frame. Reset after face loss or timestamp discontinuity.
    """
    def __init__(self, profile, on=.35, off=.25, recovery_s=.06):
        self.profile, self.on, self.off, self.recovery_s = profile, on, off, recovery_s
        self.reset()

    def reset(self):
        self.closed = False
        self.open_since = None
        self.last_t = None

    def update(self, feature):
        if self.last_t is not None and (feature.t <= self.last_t or feature.t - self.last_t > .5):
            self.reset()
        self.last_t = feature.t
        shut = max(self.profile.gaze_closure(feature))
        threshold = self.off if self.closed else self.on
        if shut > threshold:
            self.closed, self.open_since = True, None
        elif self.closed:
            if self.open_since is None:
                self.open_since = feature.t
            if feature.t - self.open_since >= self.recovery_s:
                self.closed = False
        return self.closed
