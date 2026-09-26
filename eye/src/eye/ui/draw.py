"""Tiny drawing helpers for flipped (top-left origin) NSViews."""

from __future__ import annotations

import math

import AppKit


def rgba(r: float, g: float, b: float, a: float = 1.0):
    return AppKit.NSColor.colorWithSRGBRed_green_blue_alpha_(r, g, b, a)


WHITE = rgba(1, 1, 1)
GRAY = rgba(0.62, 0.62, 0.66)
DIM = rgba(0.35, 0.35, 0.4)
RED = rgba(1.0, 0.27, 0.23)
GREEN = rgba(0.2, 0.84, 0.45)
CYAN = rgba(0.3, 0.8, 1.0)
PINK = rgba(1.0, 0.42, 0.78)
AMBER = rgba(1.0, 0.75, 0.2)
BLACK = rgba(0, 0, 0)


def fill_rect(x: float, y: float, w: float, h: float, color) -> None:
    color.set()
    AppKit.NSRectFill(((x, y), (w, h)))


def clear(rect) -> None:
    AppKit.NSColor.clearColor().set()
    AppKit.NSRectFillUsingOperation(rect, AppKit.NSCompositingOperationClear)


def circle(cx: float, cy: float, r: float, color, fill: bool = True, width: float = 2.0) -> None:
    path = AppKit.NSBezierPath.bezierPathWithOvalInRect_(((cx - r, cy - r), (2 * r, 2 * r)))
    color.set()
    if fill:
        path.fill()
    else:
        path.setLineWidth_(width)
        path.stroke()


def arc(cx: float, cy: float, r: float, frac: float, color, width: float = 3.0) -> None:
    """Progress arc starting at 12 o'clock, going clockwise on screen."""
    if frac <= 0:
        return
    path = AppKit.NSBezierPath.bezierPath()
    start = -90.0
    path.appendBezierPathWithArcWithCenter_radius_startAngle_endAngle_clockwise_(
        (cx, cy), r, start, start + 360.0 * min(frac, 1.0), False
    )
    path.setLineWidth_(width)
    path.setLineCapStyle_(AppKit.NSLineCapStyleRound)
    color.set()
    path.stroke()


def line(x0: float, y0: float, x1: float, y1: float, color, width: float = 1.5) -> None:
    path = AppKit.NSBezierPath.bezierPath()
    path.moveToPoint_((x0, y0))
    path.lineToPoint_((x1, y1))
    path.setLineWidth_(width)
    color.set()
    path.stroke()


def text(s: str, x: float, y: float, size: float = 18.0, color=WHITE, center: bool = True, bold: bool = False):
    font = AppKit.NSFont.systemFontOfSize_weight_(size, AppKit.NSFontWeightSemibold if bold else AppKit.NSFontWeightRegular)
    attrs = {AppKit.NSFontAttributeName: font, AppKit.NSForegroundColorAttributeName: color}
    ns = AppKit.NSString.stringWithString_(s)
    w, h = ns.sizeWithAttributes_(attrs)
    ns.drawAtPoint_withAttributes_((x - w / 2 if center else x, y), attrs)
    return w, h


def pill(s: str, cx: float, y: float, size: float = 13.0, fg=WHITE, bg=None) -> None:
    font = AppKit.NSFont.systemFontOfSize_weight_(size, AppKit.NSFontWeightMedium)
    attrs = {AppKit.NSFontAttributeName: font, AppKit.NSForegroundColorAttributeName: fg}
    ns = AppKit.NSString.stringWithString_(s)
    w, h = ns.sizeWithAttributes_(attrs)
    pad = 10
    rect = ((cx - w / 2 - pad, y), (w + 2 * pad, h + 8))
    path = AppKit.NSBezierPath.bezierPathWithRoundedRect_xRadius_yRadius_(rect, (h + 8) / 2, (h + 8) / 2)
    (bg or rgba(0.08, 0.08, 0.1, 0.82)).set()
    path.fill()
    ns.drawAtPoint_withAttributes_((cx - w / 2, y + 4), attrs)


def ring_points(cx: float, cy: float, r: float, n: int):
    return [(cx + r * math.cos(2 * math.pi * i / n), cy + r * math.sin(2 * math.pi * i / n)) for i in range(n)]
