"""Display geometry.

Everything outside the AppKit views uses CoreGraphics global coordinates: points
(not pixels), origin at the top-left of the main display, y growing downward.
That is the space CGEvent mouse positions live in.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import AppKit
import Quartz


@dataclass(frozen=True)
class Display:
    id: int
    name: str
    x: float
    y: float
    w: float
    h: float
    scale: float
    builtin: bool
    mm: tuple[float, float]

    def to_global(self, nx: float, ny: float) -> tuple[float, float]:
        """Normalized display coords (0..1, top-left origin) to global points."""
        return self.x + nx * self.w, self.y + ny * self.h

    def to_norm(self, gx: float, gy: float) -> tuple[float, float]:
        return (gx - self.x) / self.w, (gy - self.y) / self.h

    def clamp(self, gx: float, gy: float) -> tuple[float, float]:
        return (
            min(max(gx, self.x), self.x + self.w - 1),
            min(max(gy, self.y), self.y + self.h - 1),
        )

    @property
    def points_per_mm(self) -> float:
        return self.w / self.mm[0] if self.mm[0] > 0 else 5.0

    def degrees(self, points: float, distance_cm: float = 55.0) -> float:
        """Visual angle of an on-screen distance, for a viewer distance_cm away."""
        mm = points / self.points_per_mm
        return math.degrees(math.atan2(mm, distance_cm * 10.0))

    def ns_screen(self):
        for screen in AppKit.NSScreen.screens():
            if int(screen.deviceDescription()["NSScreenNumber"]) == self.id:
                return screen
        return AppKit.NSScreen.mainScreen()


def displays() -> list[Display]:
    out = []
    for screen in AppKit.NSScreen.screens():
        did = int(screen.deviceDescription()["NSScreenNumber"])
        bounds = Quartz.CGDisplayBounds(did)
        size = Quartz.CGDisplayScreenSize(did)
        out.append(
            Display(
                id=did,
                name=str(screen.localizedName()),
                x=bounds.origin.x,
                y=bounds.origin.y,
                w=bounds.size.width,
                h=bounds.size.height,
                scale=float(screen.backingScaleFactor()),
                builtin=bool(Quartz.CGDisplayIsBuiltin(did)),
                mm=(size.width, size.height),
            )
        )
    return out


def pick(which: str | int | None = None) -> Display:
    """Pick a display by index or name substring; default is the built-in one.

    The built-in display is the right default because the camera is mounted on
    it, so the camera-to-screen geometry the calibration learns stays fixed.
    """
    found = displays()
    if not found:
        raise RuntimeError("no displays found")
    if which is None:
        return next((d for d in found if d.builtin), found[0])
    if isinstance(which, int) or str(which).isdigit():
        return found[int(which)]
    needle = str(which).lower()
    for d in found:
        if needle in d.name.lower():
            return d
    raise ValueError(f"no display matching {which!r}: {[d.name for d in found]}")
