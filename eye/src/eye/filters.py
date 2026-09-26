"""Smoothing for gaze and head signals."""

from __future__ import annotations

import math
from collections import deque

import numpy as np


def _alpha(dt: float, cutoff: float) -> float:
    tau = 1.0 / (2.0 * math.pi * cutoff)
    return 1.0 / (1.0 + tau / dt)


class OneEuro:
    """One Euro filter (Casiez, Roussel & Vogel, CHI 2012) over a vector.

    min_cutoff (Hz) controls jitter when the signal is still; beta raises the
    cutoff with speed so fast moves don't lag. All components share one
    adaptive cutoff driven by the vector's speed, so x and y stay coherent.
    """

    def __init__(self, min_cutoff: float = 1.0, beta: float = 0.0, d_cutoff: float = 1.0):
        self.min_cutoff = min_cutoff
        self.beta = beta
        self.d_cutoff = d_cutoff
        self.reset()

    def reset(self) -> None:
        self.x: np.ndarray | None = None
        self.dx: np.ndarray | None = None
        self.t: float | None = None

    @property
    def speed(self) -> float:
        return float(np.linalg.norm(self.dx)) if self.dx is not None else 0.0

    def __call__(self, x, t: float) -> np.ndarray:
        x = np.asarray(x, dtype=np.float64)
        if self.x is None:
            self.x, self.dx, self.t = x.copy(), np.zeros_like(x), t
            return self.x.copy()
        dt = t - self.t
        if dt <= 0:
            return self.x.copy()
        self.t = t
        a_d = _alpha(dt, self.d_cutoff)
        self.dx = a_d * (x - self.x) / dt + (1.0 - a_d) * self.dx
        a = _alpha(dt, self.min_cutoff + self.beta * self.speed)
        self.x = a * x + (1.0 - a) * self.x
        return self.x.copy()


class FixationFilter:
    """Holds still during fixations and jumps on saccades (dispersion based, like I-DT).

    While samples stay within `radius` of the current fixation the output is the
    mean of the recent samples, so it gets steadier the longer you look. Once
    `confirm` consecutive samples land outside the radius and agree with each
    other, that's a saccade: a new fixation starts where they are.
    """

    def __init__(self, radius: float, confirm: int = 3, window: int = 20):
        self.radius = radius
        self.confirm = confirm
        self.window = window
        self.reset()

    def reset(self) -> None:
        self.points: deque[np.ndarray] = deque(maxlen=self.window)
        self.pending: list[np.ndarray] = []
        self.center: np.ndarray | None = None
        self.fixations = 0  # increments each time a new fixation starts

    @property
    def age(self) -> int:
        return len(self.points)

    def update(self, p) -> np.ndarray:
        p = np.asarray(p, dtype=np.float64)
        if self.center is None:
            self.points.append(p)
            self.center = p.copy()
            self.fixations += 1
            return self.center.copy()
        if math.dist(p, self.center) <= self.radius:
            self.points.append(p)
            self.pending.clear()
            self.center = np.mean(self.points, axis=0)
            return self.center.copy()
        if self.pending and math.dist(p, np.mean(self.pending, axis=0)) > self.radius:
            self.pending.clear()  # scattered outliers, not a saccade
        self.pending.append(p)
        if len(self.pending) >= self.confirm:
            self.points.clear()
            self.points.extend(self.pending)
            self.pending.clear()
            self.center = np.mean(self.points, axis=0)
            self.fixations += 1
        return self.center.copy()
