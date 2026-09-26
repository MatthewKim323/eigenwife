"""Click-through overlay and menu bar item for `eye run`."""

from __future__ import annotations

import math
import time

import AppKit
import objc
from Foundation import NSObject
from . import draw, loop


class EyeOverlayView(AppKit.NSView):
    def isFlipped(self):
        return True

    def drawRect_(self, rect):
        self.owner.draw(self.bounds())


class EyeOverlay(NSObject):
    @objc.python_method
    def setup(self, display, eye, debug: bool = False):
        self.display = display
        self.eye = eye
        self.debug = debug
        return self

    @objc.python_method
    def show(self):
        screen = self.display.ns_screen()
        frame = screen.frame()
        win = AppKit.NSWindow.alloc().initWithContentRect_styleMask_backing_defer_(
            frame, AppKit.NSWindowStyleMaskBorderless, AppKit.NSBackingStoreBuffered, False
        )
        win.setFrame_display_(frame, True)
        win.setOpaque_(False)
        win.setBackgroundColor_(AppKit.NSColor.clearColor())
        win.setHasShadow_(False)
        win.setIgnoresMouseEvents_(True)
        win.setLevel_(AppKit.NSScreenSaverWindowLevel)
        win.setCollectionBehavior_(
            AppKit.NSWindowCollectionBehaviorCanJoinAllSpaces
            | AppKit.NSWindowCollectionBehaviorStationary
            | AppKit.NSWindowCollectionBehaviorFullScreenAuxiliary
            | AppKit.NSWindowCollectionBehaviorIgnoresCycle
        )
        view = EyeOverlayView.alloc().initWithFrame_(((0, 0), frame.size))
        view.owner = self
        win.setContentView_(view)
        win.orderFrontRegardless()
        self.window, self.view = win, view
        self._build_menu()
        self.timer = AppKit.NSTimer.scheduledTimerWithTimeInterval_target_selector_userInfo_repeats_(
            1 / 60, self, "tick:", None, True
        )
        AppKit.NSRunLoop.currentRunLoop().addTimer_forMode_(self.timer, AppKit.NSRunLoopCommonModes)

    @objc.python_method
    def _build_menu(self):
        self.item = AppKit.NSStatusBar.systemStatusBar().statusItemWithLength_(AppKit.NSVariableStatusItemLength)
        self._icon_paused = None
        self._set_icon(False)
        menu = AppKit.NSMenu.alloc().init()
        self.pause_item = self._add(menu, "Pause", "togglePause:")
        menu.addItem_(AppKit.NSMenuItem.separatorItem())
        self.mode_items = {
            "hybrid": self._add(menu, "Hybrid (gaze jumps, head fine-tunes)", "modeHybrid:"),
            "gaze": self._add(menu, "Gaze only", "modeGaze:"),
            "head": self._add(menu, "Head only", "modeHead:"),
        }
        menu.addItem_(AppKit.NSMenuItem.separatorItem())
        self._add(menu, "Quit eye", "quit:")
        self.item.setMenu_(menu)

    @objc.python_method
    def _add(self, menu, title, action):
        item = AppKit.NSMenuItem.alloc().initWithTitle_action_keyEquivalent_(title, action, "")
        item.setTarget_(self)
        menu.addItem_(item)
        return item

    @objc.python_method
    def _set_icon(self, paused: bool):
        if self._icon_paused is paused:
            return
        self._icon_paused = paused
        name = "eye.slash" if paused else "eye"
        image = AppKit.NSImage.imageWithSystemSymbolName_accessibilityDescription_(name, "eye")
        button = self.item.button()
        if image is not None:
            image.setTemplate_(True)
            button.setImage_(image)
        else:
            button.setTitle_("eye")

    # menu actions
    def togglePause_(self, sender):
        self.eye.toggle_pause()

    def modeHybrid_(self, sender):
        self.eye.set_mode("hybrid")

    def modeGaze_(self, sender):
        self.eye.set_mode("gaze")

    def modeHead_(self, sender):
        self.eye.set_mode("head")

    def quit_(self, sender):
        self.timer.invalidate()
        loop.stop()

    def tick_(self, timer):
        eye = self.eye
        self._set_icon(eye.paused)
        self.pause_item.setTitle_("Resume" if eye.paused else "Pause")
        for mode, item in self.mode_items.items():
            item.setState_(AppKit.NSControlStateValueOn if eye.pointer.cfg.mode == mode else AppKit.NSControlStateValueOff)
        self.view.setNeedsDisplay_(True)

    @objc.python_method
    def draw(self, bounds):
        draw.clear(bounds)
        eye, d = self.eye, self.display
        now = time.monotonic()
        w = bounds.size.width

        def local(p):
            return p[0] - d.x, p[1] - d.y

        if self.debug and eye.gaze_raw is not None:
            gx, gy = local(eye.gaze_raw)
            draw.circle(gx, gy, 4, draw.rgba(0.6, 0.6, 0.65, 0.8))
            if eye.pointer.gaze is not None:
                fx, fy = local(eye.pointer.gaze)
                draw.circle(fx, fy, eye.pointer.fix.radius, draw.rgba(0.6, 0.6, 0.65, 0.35), fill=False, width=1)

        cursor = eye.pointer.frozen if eye.pointer.frozen is not None else eye.pointer.cursor
        if cursor is not None and not eye.paused:
            cx, cy = local(cursor)
            g = eye.gestures.cfg
            kind, held = eye.gestures.held(now)
            if eye.gestures.closing and held > 0.05:
                # One arc scaled to the pause threshold, with ticks where the
                # tones fire: open now for a click, later for a right click.
                color = draw.WHITE if held < g.click_s else (draw.CYAN if held < g.right_click_s else draw.PINK)
                if kind in ("left", "right"):
                    color = draw.CYAN if kind == "left" else draw.PINK
                    draw.arc(cx, cy, 18, held / g.wink_max_s, color, 3)
                else:
                    draw.circle(cx, cy, 18, draw.rgba(1, 1, 1, 0.35), fill=False, width=1)
                    draw.arc(cx, cy, 18, held / g.pause_s, color, 3)
                    for mark in (g.click_s, g.right_click_s):
                        a = 2 * math.pi * mark / g.pause_s - math.pi / 2
                        draw.circle(cx + 18 * math.cos(a), cy + 18 * math.sin(a), 2, draw.rgba(1, 1, 1, 0.8))
            brow, mouth = eye.gestures.brow.progress(now), eye.gestures.mouth.progress(now)
            if brow > 0:
                draw.arc(cx, cy, 24, brow, draw.AMBER, 2.5)
            if mouth > 0:
                draw.arc(cx, cy, 28, mouth, draw.GREEN, 2.5)
            if eye.dragging:
                draw.circle(cx + 14, cy + 14, 5, draw.AMBER)
            if eye.scrolling:
                draw.text("\u21c5", cx + 12, cy - 30, 20, draw.AMBER, center=False, bold=True)

        for t, target in list(eye.targets):
            age = now - t
            if age < 0.4:
                tx, ty = local((target.x, target.y))
                path = AppKit.NSBezierPath.bezierPathWithRoundedRect_xRadius_yRadius_(
                    ((tx, ty), (target.w, target.h)), 5, 5
                )
                draw.rgba(0.3, 0.8, 1.0, 0.9 * (1 - age / 0.4)).set()
                path.setLineWidth_(2.0)
                path.stroke()

        for t, x, y, kind in list(eye.flashes):
            age = now - t
            if age < 0.35:
                fx, fy = local((x, y))
                color = {"right": draw.PINK, "double": draw.AMBER}.get(kind, draw.CYAN)
                draw.circle(fx, fy, 8 + 40 * age, color, fill=False, width=2.5 * (1 - age / 0.35) + 0.5)

        top = 40
        if eye.paused:
            draw.pill("eye paused", w / 2, top, 13)
        elif not eye.face:
            draw.pill("eye: can't see your face", w / 2, top, 13, fg=draw.RED)
        elif eye.animator.overridden:
            draw.pill("eye: trackpad in use", w / 2, top, 13, fg=draw.GRAY)
        if eye.notice and now < eye.notice[1]:
            draw.pill(eye.notice[0], w / 2, top + (30 if (eye.paused or not eye.face) else 0), 13)
