"""Snap clicks onto real UI targets using the macOS accessibility tree.

Webcam gaze lands within a couple of degrees, which is 100-200 points: bigger
than most Mac controls (28 pt by default). Rather than demand impossible
precision, hit-test the accessibility tree around the click point and land on
the nearest thing that can actually be pressed. This is the single biggest
usability win for gaze pointing (bubble cursor / GazeTheWeb).

If the click point already sits inside something clickable, nothing moves:
in hybrid mode you steered it there on purpose.
"""

from __future__ import annotations

import math
import os
import time
from dataclasses import dataclass

from ApplicationServices import (
    AXUIElementCopyActionNames,
    AXUIElementCopyAttributeValue,
    AXUIElementCopyElementAtPosition,
    AXUIElementCreateSystemWide,
    AXUIElementGetPid,
    AXUIElementSetMessagingTimeout,
    AXValueGetValue,
    kAXValueCGPointType,
    kAXValueCGSizeType,
)

# Roles worth landing on even when they expose no AXPress action.
FOCUSABLE = {"AXTextField", "AXTextArea", "AXSearchField", "AXComboBox", "AXSlider", "AXIncrementor", "AXStepper"}
# Never snap to these: they're containers that happen to be pressable.
SKIP = {"AXWindow", "AXApplication", "AXScrollArea", "AXSplitGroup", "AXToolbar", "AXWebArea", "AXSheet", "AXDrawer"}
MAX_W, MAX_H = 700.0, 420.0  # anything bigger is a container, not a target


@dataclass(frozen=True)
class Target:
    x: float
    y: float
    w: float
    h: float
    role: str

    @property
    def center(self) -> tuple[float, float]:
        return self.x + self.w / 2, self.y + self.h / 2

    def contains(self, px: float, py: float) -> bool:
        return self.x <= px <= self.x + self.w and self.y <= py <= self.y + self.h

    def distance(self, px: float, py: float) -> float:
        dx = max(self.x - px, 0.0, px - (self.x + self.w))
        dy = max(self.y - py, 0.0, py - (self.y + self.h))
        return math.hypot(dx, dy)


class Snapper:
    def __init__(self, radius: float = 150.0, budget_s: float = 0.12, timeout_s: float = 0.05):
        self.radius = radius
        self.budget_s = budget_s
        self.system = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(self.system, timeout_s)
        self.own_pid = os.getpid()
        self.blocked_by_overlay = False

    def _attr(self, element, name):
        err, value = AXUIElementCopyAttributeValue(element, name, None)
        return value if err == 0 else None

    def _frame(self, element) -> tuple[float, float, float, float] | None:
        pos, size = self._attr(element, "AXPosition"), self._attr(element, "AXSize")
        if pos is None or size is None:
            return None
        ok_p, point = AXValueGetValue(pos, kAXValueCGPointType, None)
        ok_s, dims = AXValueGetValue(size, kAXValueCGSizeType, None)
        if not (ok_p and ok_s):
            return None
        return float(point.x), float(point.y), float(dims.width), float(dims.height)

    def _pressable(self, element) -> bool:
        role = self._attr(element, "AXRole")
        if role in SKIP:
            return False
        if role in FOCUSABLE:
            return True
        err, actions = AXUIElementCopyActionNames(element, None)
        return err == 0 and actions is not None and "AXPress" in actions

    def target_at(self, x: float, y: float) -> Target | None:
        """Nearest pressable element under (x, y), walking up from the deepest hit."""
        err, element = AXUIElementCopyElementAtPosition(self.system, x, y, None)
        if err != 0 or element is None:
            return None
        err, pid = AXUIElementGetPid(element, None)
        if err == 0 and pid == self.own_pid:
            self.blocked_by_overlay = True  # our own overlay answered the hit test
            return None
        for _ in range(5):
            if self._pressable(element):
                role = self._attr(element, "AXRole") or "?"
                frame = self._frame(element)
                if frame and frame[2] <= MAX_W and frame[3] <= MAX_H:
                    return Target(*frame, role=str(role))
            element = self._attr(element, "AXParent")
            if element is None:
                break
        return None

    def snap(self, x: float, y: float) -> tuple[tuple[float, float], Target | None]:
        """Where to click, and the target we snapped to (None if we didn't move)."""
        deadline = time.monotonic() + self.budget_s
        here = self.target_at(x, y)
        if here is not None and here.contains(x, y):
            return (x, y), here
        best = here
        r = self.radius
        for ring in (r / 2, r):
            for i in range(8):
                if time.monotonic() > deadline:
                    break
                angle = math.pi / 4 * i + (math.pi / 8 if ring == r else 0.0)
                found = self.target_at(x + ring * math.cos(angle), y + ring * math.sin(angle))
                if found is None:
                    continue
                if best is None or found.distance(x, y) < best.distance(x, y):
                    best = found
        if best is None or best.distance(x, y) > self.radius:
            return (x, y), None
        cx, cy = best.center
        return (cx, cy), best
