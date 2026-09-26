"""Synthetic mouse input through CoreGraphics.

Posting events needs the Accessibility permission for whatever app launched
us (Terminal, iTerm, Ghostty, ...). Without it macOS silently drops them.
"""

from __future__ import annotations

import math
import time

import Quartz as Q

_BUTTONS = {
    "left": (Q.kCGEventLeftMouseDown, Q.kCGEventLeftMouseUp, Q.kCGEventLeftMouseDragged, Q.kCGMouseButtonLeft),
    "right": (Q.kCGEventRightMouseDown, Q.kCGEventRightMouseUp, Q.kCGEventRightMouseDragged, Q.kCGMouseButtonRight),
}


def accessibility_trusted(prompt: bool = False) -> bool:
    from ApplicationServices import AXIsProcessTrustedWithOptions, kAXTrustedCheckOptionPrompt

    return bool(AXIsProcessTrustedWithOptions({kAXTrustedCheckOptionPrompt: prompt}))


def cursor_position() -> tuple[float, float]:
    p = Q.CGEventGetLocation(Q.CGEventCreate(None))
    return p.x, p.y


class Mouse:
    """Moves and clicks the real system cursor.

    Click counts are tracked here rather than left to the OS: a double click is
    just a second click whose kCGMouseEventClickState is 2. Doing it ourselves
    lets two winks count as a double click even when they're slower than the
    system double-click interval.
    """

    def __init__(self, double_click_s: float = 0.9, double_click_px: float = 12.0, dry_run: bool = False):
        self.double_click_s = double_click_s
        self.double_click_px = double_click_px
        self.dry_run = dry_run
        self.held: str | None = None
        self._last_click: tuple[float, str, float, float, int] | None = None

    def _post(self, kind, x: float, y: float, button, clicks: int | None = None) -> None:
        if self.dry_run:
            return
        event = Q.CGEventCreateMouseEvent(None, kind, (x, y), button)
        if clicks:
            Q.CGEventSetIntegerValueField(event, Q.kCGMouseEventClickState, clicks)
        Q.CGEventPost(Q.kCGHIDEventTap, event)

    def move(self, x: float, y: float) -> None:
        if self.held:
            _, _, drag, button = _BUTTONS[self.held]
            self._post(drag, x, y, button, 1)
        else:
            self._post(Q.kCGEventMouseMoved, x, y, Q.kCGMouseButtonLeft)

    def click(self, x: float, y: float, button: str = "left") -> int:
        """Click at (x, y); returns the click count sent (2 means double click)."""
        now = time.monotonic()
        clicks = 1
        if self._last_click:
            t, b, lx, ly, n = self._last_click
            if b == button and now - t <= self.double_click_s and math.hypot(x - lx, y - ly) <= self.double_click_px:
                clicks = min(n + 1, 3)
                x, y = lx, ly  # land exactly on the first click so apps accept the pair
        down, up, _, btn = _BUTTONS[button]
        self._post(Q.kCGEventMouseMoved, x, y, Q.kCGMouseButtonLeft)
        self._post(down, x, y, btn, clicks)
        self._post(up, x, y, btn, clicks)
        self._last_click = (now, button, x, y, clicks)
        return clicks

    def press(self, x: float, y: float, button: str = "left") -> None:
        down, _, _, btn = _BUTTONS[button]
        self._post(Q.kCGEventMouseMoved, x, y, Q.kCGMouseButtonLeft)
        self._post(down, x, y, btn, 1)
        self.held = button

    def release(self, x: float, y: float) -> None:
        if not self.held:
            return
        _, up, _, btn = _BUTTONS[self.held]
        self._post(up, x, y, btn, 1)
        self.held = None

    def scroll(self, dy: float, dx: float = 0.0) -> None:
        """Pixel scroll; positive dy scrolls content down (like dragging the page up)."""
        if self.dry_run or (abs(dy) < 1 and abs(dx) < 1):
            return
        event = Q.CGEventCreateScrollWheelEvent(None, Q.kCGScrollEventUnitPixel, 2, -int(dy), -int(dx))
        Q.CGEventPost(Q.kCGHIDEventTap, event)
