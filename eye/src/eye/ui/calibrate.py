"""Fullscreen calibration screen."""

from __future__ import annotations

import math
import time
import threading
from pathlib import Path

import AppKit
import objc
import numpy as np
from Foundation import NSObject
from PyObjCTools import AppHelper

from .. import calibration as cal
from .. import sound
from .. import validation_recovery
from ..features import gaze_vector
from ..screen import Display
from ..tracker import Tracker
from . import draw, loop

KEY_SPACE, KEY_RETURN, KEY_ESC, KEY_R = 49, 36, 53, 15


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
    def setup(self, display: Display, tracker: Tracker, script: cal.Script, camera_name: str, capture_root=None, candidate_only=False,
              capture_max_bytes=2_000_000_000):
        self.capture_root = Path(capture_root) if capture_root is not None else None
        self.candidate_only = candidate_only
        self.capture_max_bytes = capture_max_bytes
        self.image_capture = None
        self.capture_paths = []
        self.recording_lock = threading.RLock()
        self.display = display
        self.tracker = tracker
        self.script = script
        self.base_steps = list(script.steps)
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
        self.script = cal.Script(list(self.base_steps))
        self.rec = cal.Recording(feature_backend=dict(self.tracker.feature_backend))
        self.script_t = 0.0
        self.last_tick = None
        self.cue = None
        self.result = None
        self.baseline = None
        self.error = None
        self.face_ok = False
        self.sounded: set = set()
        self.pose_min = np.array([float("inf"), float("inf")])
        self.pose_max = -self.pose_min

    # tracker thread
    @objc.python_method
    def on_frame(self, frame, obs, feats):
        with self.recording_lock:
            if feats is None:
                self.live = None
            if self.state == "run":
                self.rec.add(frame.t, feats, obs)
                if self.image_capture is not None:
                    self.image_capture.submit(frame, timing=dict(self.tracker.stage_timing))
                if feats is not None and self.cue is not None and self.cue.step.kind == cal.HEAD:
                    self.pose_min = np.minimum(self.pose_min, [feats.yaw, feats.pitch])
                    self.pose_max = np.maximum(self.pose_max, [feats.yaw, feats.pitch])
            elif self.state == "results" and feats is not None and self.result is not None:
                if len(gaze_vector(feats)) < self.result.model.n_features:
                    self.live = None
                    return
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
        self.face_ok = now - self.tracker.last_face_t < 0.3 and not self.tracker.feature_error
        if self.state == "run":
            current = self.script.at(self.script_t)
            # Training waits for usable features. Validation always counts
            # failures over a bounded window, then retries only that target.
            if self.face_ok or (current is not None and current.step.kind == cal.VALIDATE):
                self.script_t += dt
            self.rec.clock.append((now, self.script_t))
            self.cue = self.script.at(self.script_t)
            if self.cue is None:
                self.finish_run()
            else:
                self._blink_sounds(self.cue)
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
        with self.recording_lock:
            self.state = "intro"
            self._finish_capture("restarted")
            self._reset()
            self.session_path = None
            if self.capture_root is not None:
                from ..capture import ImageCapture, camera_metadata
                self.image_capture = ImageCapture(self.capture_root, {
                    "camera": camera_metadata(self.tracker.camera),
                    "feature_backend": self.tracker.feature_backend,
                    "display": {"name": self.display.name, "w": self.display.w,
                                "h": self.display.h, "mm": list(self.display.mm)},
                }, max_bytes=self.capture_max_bytes)
                self.capture_paths.append(self.image_capture.path)
            self.state = "run"

    @objc.python_method
    def _finish_capture(self, status):
        if self.image_capture is None:
            return
        if self.session_path is None:
            self.session_path = cal.save_session(
                self.rec, self.script, self.display, self.camera_name, self.tracker.blend_names)
        self.image_capture.close(status=status, session_path=self.session_path,
                                 script=self.script.to_json(), clock=self.rec.clock)
        self.image_capture = None

    @objc.python_method
    def finish_run(self):
        with self.recording_lock:
            self.state = "fit"
        self.view.display()
        try:
            if self.result is None:
                self.result = cal.fit(self.rec, self.script, self.display)
                if self.rec.feature_backend.get("name") != "landmarks":
                    self.baseline = cal.fit(cal.landmark_recording(self.rec), self.script, self.display)
            # Freeze the fit before collecting retries. Coverage, never error,
            # determines retries, and all attempts remain in validation stats.
            validation_recovery.evaluate(self.result, self.rec, self.script, self.display)
            if self.baseline is not None:
                validation_recovery.evaluate(self.baseline, self.rec, self.script, self.display)
                self.result.stats["landmark_baseline"] = {key: self.baseline.stats.get(key) for key in (
                    "validation_frame_mean_points", "validation_frame_p90_points", "validation_coverage")}
            resume_at = self.script.duration
            if validation_recovery.append_retries(self.script, self.result.stats):
                self.script_t = resume_at
                self.last_tick = time.monotonic()
                self.rec.clock.append((self.last_tick, self.script_t))
                self.cue = self.script.at(self.script_t)
                self.state = "run"
                return
        except Exception as e:  # noqa: BLE001 - show it on screen, don't crash the UI
            self.error = str(e)
        self.state = "results"
        self.results_at = time.monotonic()
        sound.play("Hero", 0.4)

    @objc.python_method
    def accept(self):
        if self.result is None or self.error:
            return
        self.session_path = cal.save_session(
            self.rec, self.script, self.display, self.camera_name, self.tracker.blend_names
        )
        candidate_path = self.session_path.with_name(self.session_path.stem + "-candidate.npz") if self.candidate_only else None
        self.saved_path = cal.save(self.result, self.display, self.camera_name, path=candidate_path)
        self.close()

    @objc.python_method
    def close(self, cancelled: bool = False):
        self.cancelled = cancelled
        self.state = "done"
        try:
            self.tracker.stop()
            self._finish_capture("cancelled" if cancelled else "complete")
        finally:
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
            draw.pill(self.tracker.feature_error or "can't see your face. look at the screen, check the light",
                      w / 2, h * 0.5 + 110, 15, draw.RED)

    @objc.python_method
    def _draw_intro(self, w, h):
        y = h * 0.3
        draw.text("eye calibration", w / 2, y, 36, draw.WHITE, bold=True)
        lines = [
            "sit like you normally do, about an arm's length from the screen",
            "follow the dot with your eyes. keep your head natural",
            "follow head movement cues; finish with independent validation",
            f"takes about {math.ceil(self.script.duration / 60)} minutes; follow the head movement cues",
        ]
        if self.tracker.appearance is not None:
            lines[0] = "image-based research model: sit in your normal laptop position"
        if self.capture_root is not None:
            lines.append("local image recording enabled; captures remain saved even if cancelled")
        for i, s in enumerate(lines):
            draw.text(s, w / 2, y + 80 + i * 34, 19, draw.GRAY)
        draw.text("ready when you are  ·  space to start  ·  esc to cancel", w / 2, y + 80 + 5 * 34, 16, draw.DIM)

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
        if kind == cal.HEAD and np.isfinite(self.pose_min).all():
            draw.text(f"head movement captured: {self.pose_max[0] - self.pose_min[0]:.0f}° left/right · "
                      f"{self.pose_max[1] - self.pose_min[1]:.0f}° up/down", w / 2, h - 28, 14, draw.GRAY)
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
        if "validation_frame_mean_points" in st:
            draw.text(
                f"held-out frame error: {st['validation_frame_mean_points']:.0f} pt mean; "
                f"{st['validation_frame_p90_points']:.0f} pt at 90%", w / 2, y, 27, draw.WHITE, bold=True
            )
        else:
            draw.text("no usable validation: accuracy unknown", w / 2, y, 27, draw.RED, bold=True)
        draw.text(
            f"validation coverage {st.get('validation_coverage', 0):.0%}  ·  "
            f"{st.get('validation_targets', 0)}/{st.get('validation_expected_targets', 0)} targets  ·  "
            f"worst frame {st.get('validation_frame_worst_points', 0):.0f} pt",
            w / 2,
            y + 48,
            16,
            draw.GRAY,
        )
        draw.text(
            f"{st.get('validation_completed_targets', 0)} targets complete  ·  "
            f"{st.get('validation_retry_count', 0)} retries  ·  "
            f"{st.get('validation_rejected_samples', 0)} rejected frames (included in coverage)",
            w / 2, y + 102, 15, draw.GRAY,
        )
        p = res.profile
        signal = {0.0: "eye shape", 0.5: "eye shape + blendshapes", 1.0: "blendshapes"}.get(p.mix, f"mix {p.mix:g}")
        winks = "both winks on" if (p.wink_l and p.wink_r) else (
            "left wink on" if p.wink_l else "right wink on" if p.wink_r else "winks off, blinks do everything"
        )
        if any(step.kind == cal.EXPRESS for step in self.script.steps):
            detail = f"blink click at {p.click_s * 1000:.0f} ms  ·  signal: {signal}  ·  {winks}"
        else:
            conditions = st.get("validation_conditions", {})
            neutral = conditions.get("neutral", {}).get("mean_points", float("nan"))
            motion = conditions.get("motion", {}).get("mean_points", float("nan"))
            detail = f"mean error: sitting naturally {neutral:.0f} pt  ·  moving your head {motion:.0f} pt"
        draw.text(detail, w / 2, y + 76, 16, draw.GRAY)
        draw.text("look around: the blue ring is your live gaze", w / 2, h * 0.82, 18, draw.CYAN)
        baseline = st.get("landmark_baseline")
        if baseline and baseline.get("validation_frame_mean_points") is not None:
            draw.text(f"same-session landmark baseline: {baseline['validation_frame_mean_points']:.0f} pt mean; "
                      f"{baseline['validation_frame_p90_points']:.0f} pt at 90%", w / 2, h * 0.76, 16, draw.GRAY)
        suffix = "review the error before saving" if st.get("validation_complete", False) else "coverage incomplete; accuracy unverified"
        draw.text(f"space: {'save candidate' if self.candidate_only else 'save'}  ·  r: redo  ·  esc: discard  ·  {suffix}", w / 2, h * 0.82 + 36, 16, draw.DIM)


def run(display: Display, camera: str | None, quick: bool = False, expressions: bool = True, backend: str = "landmarks",
        capture_root=None, candidate_only=False, capture_max_bytes=2_000_000_000,
        width=1280, height=720) -> "EyeCalibrator":
    from ..backend import AppearanceFactory
    tracker = Tracker(camera, width=width, height=height, appearance=AppearanceFactory() if backend == "appearance" else None)
    tracker.start()
    try:
        app = AppKit.NSApplication.sharedApplication()
        app.setActivationPolicy_(AppKit.NSApplicationActivationPolicyRegular)
        ui = EyeCalibrator.alloc().init().setup(display, tracker, cal.build_script(quick=quick, expressions=expressions), tracker.camera.info.name,
              capture_root=capture_root, candidate_only=candidate_only, capture_max_bytes=capture_max_bytes)
        ui.show()
        AppHelper.runEventLoop(installInterrupt=True)
    finally:
        tracker.stop()
        if 'ui' in locals():
            ui._finish_capture("interrupted")
    return ui
