"""Fullscreen calibration screen."""

from __future__ import annotations

import math
import time

import AppKit
import objc
import numpy as np
from Foundation import NSObject
from PyObjCTools import AppHelper

from .. import calibration as cal
from .. import sound
from ..features import gaze_vector
from ..screen import Display
from ..tracker import Tracker
from . import draw, loop

KEY_SPACE, KEY_RETURN, KEY_ESC, KEY_R = 49, 36, 53, 15
AUTO_START_S = 12.0
AUTO_SAVE_S = 40.0


class EyeCalibrationWindow(AppKit.NSWindow):
    def canBecomeKeyWindow(self):
        return True

    def canBecomeMainWindow(self):
        return True


class EyeCalibrationView(AppKit.NSView):
    def isFlipped(self):
        return True

    def acceptsFirstResponder(self):
        return True

    def keyDown_(self, event):
        self.owner.key(int(event.keyCode()))

    def drawRect_(self, rect):
        self.owner.draw(self.bounds())


class EyeCalibrator(NSObject):
    """Owns the window, the script clock, and the recording. Lives on the main thread."""

    @objc.python_method
    def setup(self, display: Display, tracker: Tracker, script: cal.Script, camera_name: str):
        self.display = display
        self.tracker = tracker
        self.script = script
        self.camera_name = camera_name
        self.saved_path = None
        self.session_path = None
        self.cancelled = False
        self.live = None
        self._reset()
        self.state = "intro"
        self.started_at = time.monotonic()
        tracker.on_frame = self.on_frame
        return self

    @objc.python_method
    def _reset(self):
        self.rec = cal.Recording()
        self.script_t = 0.0
        self.last_tick = None
        self.cue = None
        self.result = None
        self.error = None
        self.face_ok = False
        self.sounded: set = set()

    # tracker thread
    @objc.python_method
    def on_frame(self, frame, obs, feats):
        if self.state == "run":
            self.rec.add(frame.t, feats, obs)
        elif self.state == "results" and feats is not None and self.result is not None:
            nx, ny = self.result.model.predict(gaze_vector(feats))[0]
            prev = self.live
            self.live = (nx, ny) if prev is None else (0.7 * prev[0] + 0.3 * nx, 0.7 * prev[1] + 0.3 * ny)

    # main thread
    @objc.python_method
    def show(self):
        screen = self.display.ns_screen()
        frame = screen.frame()
        win = EyeCalibrationWindow.alloc().initWithContentRect_styleMask_backing_defer_(
            frame, AppKit.NSWindowStyleMaskBorderless, AppKit.NSBackingStoreBuffered, False
        )
        win.setFrame_display_(frame, True)
        win.setLevel_(AppKit.NSScreenSaverWindowLevel)
        win.setBackgroundColor_(AppKit.NSColor.blackColor())
        win.setOpaque_(True)
        win.setCollectionBehavior_(
            AppKit.NSWindowCollectionBehaviorCanJoinAllSpaces | AppKit.NSWindowCollectionBehaviorFullScreenAuxiliary
        )
        view = EyeCalibrationView.alloc().initWithFrame_(((0, 0), frame.size))
        view.owner = self
        win.setContentView_(view)
        win.makeKeyAndOrderFront_(None)
        win.makeFirstResponder_(view)
        AppKit.NSApp.activateIgnoringOtherApps_(True)
        AppKit.NSCursor.hide()
        self.window, self.view = win, view
        self.timer = AppKit.NSTimer.scheduledTimerWithTimeInterval_target_selector_userInfo_repeats_(
            1 / 60, self, "tick:", None, True
        )
        AppKit.NSRunLoop.currentRunLoop().addTimer_forMode_(self.timer, AppKit.NSRunLoopCommonModes)

    def tick_(self, timer):
        now = time.monotonic()
        dt = 0.0 if self.last_tick is None else min(now - self.last_tick, 0.1)
        self.last_tick = now
        self.face_ok = now - self.tracker.last_face_t < 0.3
        if self.state == "intro" and now - self.started_at > AUTO_START_S:
            self.begin()
        elif self.state == "run":
            if self.face_ok:  # the script clock stops while we can't see you
                self.script_t += dt
            self.rec.clock.append((now, self.script_t))
            self.cue = self.script.at(self.script_t)
            if self.cue is None:
                self.finish_run()
            else:
                self._blink_sounds(self.cue)
        elif self.state == "results" and now - self.results_at > AUTO_SAVE_S and self.result is not None:
            self.accept()
        self.view.setNeedsDisplay_(True)

    @objc.python_method
    def _blink_sounds(self, cue):
        if cue.step.kind != cal.EXPRESS:
            return
        red_at, beep_at = cue.step.sample_from - 0.3, cue.step.sample_to + 0.1
        if cue.tau >= red_at and (cue.index, "red") not in self.sounded:
            self.sounded.add((cue.index, "red"))
            sound.play("Pop", 0.5)
        if cue.tau >= beep_at and (cue.index, "beep") not in self.sounded:
            self.sounded.add((cue.index, "beep"))
            sound.play("Glass", 0.6)

    @objc.python_method
    def begin(self):
        self._reset()
        self.state = "run"

    @objc.python_method
    def finish_run(self):
        self.state = "fit"
        self.view.display()
        try:
            self.result = cal.fit(self.rec, self.script, self.display)
        except Exception as e:  # noqa: BLE001 - show it on screen, don't crash the UI
            self.error = str(e)
        self.state = "results"
        self.results_at = time.monotonic()
        sound.play("Hero", 0.4)

    @objc.python_method
    def accept(self):
        if self.result is None:
            return
        self.saved_path = cal.save(self.result, self.display, self.camera_name)
        self.session_path = cal.save_session(
            self.rec, self.script, self.display, self.camera_name, self.tracker.blend_names
        )
        self.close()

    @objc.python_method
    def close(self, cancelled: bool = False):
        self.cancelled = cancelled
        self.state = "done"
        self.timer.invalidate()
        AppKit.NSCursor.unhide()
        self.window.orderOut_(None)
        loop.stop()

    @objc.python_method
    def key(self, code: int):
        if code == KEY_ESC:
            self.close(cancelled=True)
        elif self.state == "intro" and code in (KEY_SPACE, KEY_RETURN):
            self.begin()
        elif self.state == "results":
            if code in (KEY_SPACE, KEY_RETURN):
                self.accept()
            elif code == KEY_R:
                self.live = None
                self.begin()

    # drawing (main thread)
    @objc.python_method
    def draw(self, bounds):
        w, h = bounds.size.width, bounds.size.height
        draw.fill_rect(0, 0, w, h, draw.BLACK)
        if self.state == "intro":
            self._draw_intro(w, h)
        elif self.state == "run" and self.cue is not None:
            self._draw_cue(w, h)
        elif self.state == "fit":
            draw.text("fitting...", w / 2, h / 2 - 12, 24, draw.GRAY)
        elif self.state == "results":
            self._draw_results(w, h)
        if self.state in ("intro", "run") and not self.face_ok:
            draw.pill("can't see your face. look at the screen, check the light", w / 2, h * 0.5 + 110, 15, draw.RED)

    @objc.python_method
    def _draw_intro(self, w, h):
        y = h * 0.3
        draw.text("eye calibration", w / 2, y, 36, draw.WHITE, bold=True)
        lines = [
            "sit like you normally do, about an arm's length from the screen",
            "follow the dot with your eyes. keep your head natural",
            "at the end: a few blinks and winks, guided by sounds",
            "takes about a minute and a half",
        ]
        for i, s in enumerate(lines):
            draw.text(s, w / 2, y + 80 + i * 34, 19, draw.GRAY)
        left = max(0, math.ceil(AUTO_START_S - (time.monotonic() - self.started_at)))
        draw.text(f"space to start  ·  esc to cancel  ·  starting in {left}", w / 2, y + 80 + 5 * 34, 16, draw.DIM)

    @objc.python_method
    def _draw_cue(self, w, h):
        cue = self.cue
        x, y = cue.x * w, cue.y * h
        kind = cue.step.kind
        if kind == cal.PURSUIT:
            draw.circle(x, y, 10, draw.WHITE)
            draw.circle(x, y, 3, draw.BLACK)
        elif kind == cal.EXPRESS:
            red_at, beep_at = cue.step.sample_from - 0.3, cue.step.sample_to + 0.1
            closing = red_at <= cue.tau < beep_at
            draw.circle(x, y, 42, draw.RED if closing else draw.WHITE, fill=False, width=4)
            if closing:
                draw.arc(x, y, 52, (cue.tau - red_at) / (beep_at - red_at), draw.RED, 3)
            elif cue.tau < red_at:
                draw.text(str(math.ceil(red_at - cue.tau)), x, y - 17, 30, draw.WHITE, bold=True)
        else:
            color = draw.AMBER if kind == cal.VALIDATE else draw.WHITE
            draw.circle(x, y, 5 + 24 * cue.shrink, color, fill=False, width=2.5)
            draw.circle(x, y, 4, color)
        if cue.step.text:
            ty = y + 72 if y < h * 0.7 else y - 100
            draw.text(cue.step.text, w / 2, ty, 20, draw.GRAY)
        draw.fill_rect(0, h - 4, w * min(self.script_t / self.script.duration, 1.0), 4, draw.DIM)

    @objc.python_method
    def _draw_results(self, w, h):
        if self.error:
            draw.text("calibration failed", w / 2, h * 0.38, 30, draw.RED, bold=True)
            draw.text(self.error, w / 2, h * 0.38 + 56, 18, draw.GRAY)
            draw.text("r: try again  ·  esc: quit", w / 2, h * 0.38 + 110, 16, draw.DIM)
            return
        res = self.result
        for v in res.validation:
            tx, ty, px, py = v["x"] * w, v["y"] * h, v["px"] * w, v["py"] * h
            draw.line(tx, ty, px, py, draw.DIM, 1.5)
            draw.circle(tx, ty, 14, draw.GRAY, fill=False, width=1.5)
            draw.circle(px, py, 6, draw.AMBER)
        if self.live is not None:
            lx, ly = np.clip(self.live[0], 0, 1) * w, np.clip(self.live[1], 0, 1) * h
            draw.circle(lx, ly, 11, draw.CYAN, fill=False, width=3)
        st = res.stats
        y = h * 0.1
        if "validation_deg" in st:
            draw.text(
                f"accuracy ~{st['validation_deg']:.1f}°  ({st['validation_points']:.0f} pt)", w / 2, y, 30, draw.WHITE, bold=True
            )
        draw.text(
            f"{st.get('samples', 0)} samples  ·  worst point {st.get('validation_worst', 0):.0f} pt  ·  "
            f"pursuit lag {st.get('pursuit_lag', 0) * 1000:.0f} ms",
            w / 2,
            y + 48,
            16,
            draw.GRAY,
        )
        p = res.profile
        signal = {0.0: "eye shape", 0.5: "eye shape + blendshapes", 1.0: "blendshapes"}.get(p.mix, f"mix {p.mix:g}")
        winks = "both winks on" if (p.wink_l and p.wink_r) else (
            "left wink on" if p.wink_l else "right wink on" if p.wink_r else "winks off, blinks do everything"
        )
        draw.text(
            f"blink click at {p.click_s * 1000:.0f} ms  ·  signal: {signal}  ·  {winks}", w / 2, y + 76, 16, draw.GRAY
        )
        draw.text("look around: the blue ring is your live gaze", w / 2, h * 0.82, 18, draw.CYAN)
        left = max(0, math.ceil(AUTO_SAVE_S - (time.monotonic() - self.results_at)))
        draw.text(f"space: save  ·  r: redo  ·  esc: discard  ·  saving in {left}", w / 2, h * 0.82 + 36, 16, draw.DIM)


def run(display: Display, camera: str | None, quick: bool = False, expressions: bool = True) -> "EyeCalibrator":
    tracker = Tracker(camera)
    tracker.start()
    try:
        app = AppKit.NSApplication.sharedApplication()
        app.setActivationPolicy_(AppKit.NSApplicationActivationPolicyRegular)
        ui = EyeCalibrator.alloc().init().setup(display, tracker, cal.build_script(quick=quick, expressions=expressions), tracker.camera.info.name)
        ui.show()
        AppHelper.runEventLoop(installInterrupt=True)
    finally:
        tracker.stop()
    return ui
