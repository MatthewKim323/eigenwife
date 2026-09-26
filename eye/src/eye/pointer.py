"""Turns gaze and head measurements into a cursor position.

Modes:
  hybrid  gaze jumps the cursor to wherever you look, then small head turns
          fine-tune it (MAGIC pointing plus head refinement, like Talon and
          Precision Gaze Mouse). Head refinement is what makes clicking
          possible: eye-only pointing is off by 2-4 degrees, and adding head
          refinement took one study from 2.42 degrees to 0.49.
  gaze    the cursor sits on the current gaze fixation (the mean of the
          samples in it, which is what makes it steady)
  head    head pointer only; needs no calibration

Head motion comes from the rigid head pose, not a single landmark, so blinks
and mouth movements don't drag the cursor around (GameFace #8).
"""

from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass

import numpy as np

from .filters import FixationFilter, OneEuro
from .screen import Display


@dataclass
class PointerConfig:
    mode: str = "hybrid"
    distance_cm: float = 55.0  # assumed viewing distance; converts degrees to points
    fixation_radius_deg: float = 2.5  # gaze noise inside this counts as one fixation
    fixation_confirm: int = 2  # samples that must agree before believing a saccade
    fixation_window: int = 15
    warp_radius_deg: float = 4.0  # hybrid: gaze must land this far from the last jump to jump again
    warp_max_head_speed: float = 12.0  # deg/s; no jumps while the head is steering
    head_gain: float = 24.0  # points of cursor travel per degree of head rotation
    head_gain_y: float = 1.6  # vertical head range is smaller, so gain more
    head_accel_ref: float = 0.2  # deg/frame where gain is 1x; slower is finer, faster is coarser
    head_deadzone: float = 0.02  # deg/frame treated as jitter
    head_min_cutoff: float = 1.5
    head_beta: float = 0.05
    freeze_lookback_s: float = 0.15  # on blink onset, rewind the cursor this far
    settle_s: float = 0.15  # ignore gaze this long after the eyes reopen


class Pointer:
    def __init__(self, cfg: PointerConfig, display: Display):
        self.cfg = cfg
        self.display = display
        self.pt_per_deg = display.points_per_mm * 10.0 * cfg.distance_cm * math.tan(math.radians(1.0))
        self.fix = FixationFilter(
            cfg.fixation_radius_deg * self.pt_per_deg, confirm=cfg.fixation_confirm, window=cfg.fixation_window
        )
        self.head_filter = OneEuro(cfg.head_min_cutoff, cfg.head_beta)
        self.cursor: np.ndarray | None = None
        self.anchor: np.ndarray | None = None  # gaze fixation we last jumped to
        self.gaze: np.ndarray | None = None  # latest smoothed gaze point (for display)
        self.frozen: np.ndarray | None = None
        self.held = False  # externally frozen (scroll mode)
        self.hold_until = 0.0  # ignore movement until this time (just grabbed a drag)
        self.head_speed = 0.0
        self.warps = 0
        self._history: deque[tuple[float, np.ndarray]] = deque(maxlen=120)
        self._head_prev: np.ndarray | None = None
        self._resume_t = 0.0

    def set_mode(self, mode: str) -> None:
        self.cfg.mode = mode
        self.anchor = None
        self._head_prev = None
        self.fix.reset()

    def place(self, x: float, y: float) -> None:
        self.cursor = np.array([x, y], dtype=np.float64)
        self.anchor = None

    def reacquire(self) -> None:
        """Face came back: drop stale filter state so the cursor doesn't lurch."""
        self._head_prev = None
        self.fix.reset()

    def _position_at(self, t: float) -> np.ndarray | None:
        best = None
        for ht, pos in self._history:
            if ht > t:
                break
            best = pos
        if best is None:
            best = self.cursor
        return None if best is None else best.copy()

    def update(
        self,
        t: float,
        gaze,
        yaw: float | None,
        pitch: float | None,
        closing: bool,
        head_hold: bool = False,
    ) -> np.ndarray | None:
        cfg = self.cfg
        head = None
        if yaw is not None:
            head = self.head_filter((yaw, pitch), t)
            self.head_speed = self.head_filter.speed

        if closing or self.held:
            if self.frozen is None:
                self.frozen = self._position_at(t - cfg.freeze_lookback_s) if closing else self.cursor
            self._head_prev = head
            return self.frozen
        if self.frozen is not None:
            self.cursor = self.frozen
            self.frozen = None
            self._resume_t = t + cfg.settle_s
            self.fix.reset()  # post-blink samples start a fresh fixation
        if t < max(self._resume_t, self.hold_until):
            self._head_prev = head
            if self.cursor is not None:
                self._history.append((t, self.cursor.copy()))
            return self.cursor

        mode = cfg.mode
        if gaze is not None and mode in ("gaze", "hybrid"):
            g = self.fix.update(gaze)
            self.gaze = g
            if mode == "gaze" or self.cursor is None:
                self.cursor, self.anchor = g.copy(), g.copy()
            elif self.anchor is None or (
                math.dist(g, self.anchor) > cfg.warp_radius_deg * self.pt_per_deg
                and self.head_speed < cfg.warp_max_head_speed
                and self.fix.age >= cfg.fixation_confirm
            ):
                self.cursor, self.anchor = g.copy(), g.copy()
                self.warps += 1

        if head is not None and mode in ("hybrid", "head") and not head_hold:
            if self.cursor is None:
                self.cursor = np.array(self.display.to_global(0.5, 0.5))
            if self._head_prev is not None:
                d = head - self._head_prev
                d = np.where(np.abs(d) < cfg.head_deadzone, 0.0, d - np.sign(d) * cfg.head_deadzone)
                speed = float(np.hypot(*d))
                # Slow turns get less gain (precision), fast turns more (reach).
                mult = min(max(math.sqrt(speed / cfg.head_accel_ref) if speed > 0 else 0.0, 0.3), 3.0)
                # Turning your head to your right is negative yaw; tilting it up is negative pitch.
                step = np.array([-d[0], d[1] * cfg.head_gain_y]) * cfg.head_gain * mult
                self.cursor = self.cursor + step
            self._head_prev = head
        elif head_hold:
            self._head_prev = head

        if self.cursor is not None:
            self.cursor = np.array(self.display.clamp(*self.cursor))
            self._history.append((t, self.cursor.copy()))
        return self.cursor
