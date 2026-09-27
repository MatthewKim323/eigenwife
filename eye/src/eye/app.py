"""The live eye cursor: tracking in, cursor moves and clicks out."""

from __future__ import annotations

import math
import threading
import time
from collections import deque

import numpy as np

from . import sound
from .calibration import Calibration
from .config import Settings
from .features import gaze_vector
from .gestures import TIER_CLICK, TIER_RIGHT, Gesture, GestureDetector
from .mouse import Mouse, cursor_position
from .pointer import Pointer
from .profile import FaceProfile
from .screen import Display
from .snap import Snapper
from .tracker import Tracker

SOUNDS = {
    TIER_CLICK: ("Tink", 0.35),  # "click is armed, open your eyes"
    TIER_RIGHT: ("Pop", 0.4),  # "right click is armed"
    "click": ("Tink", 0.3),
    "right": ("Pop", 0.35),
    "grab": ("Morse", 0.4),
    "drop": ("Morse", 0.25),
    "scroll_on": ("Purr", 0.4),
    "scroll_off": ("Bottle", 0.3),
    "pause": ("Submarine", 0.4),
    "resume": ("Glass", 0.4),
}


class CursorAnimator:
    """Glides the real cursor toward its target at 120 Hz.

    Tracking runs at camera rate (30 fps); moving the cursor only that often
    looks steppy. This also watches for the physical mouse or trackpad: if the
    cursor turns up somewhere we didn't put it, we back off for a moment.
    """

    def __init__(self, mouse: Mouse, tau: float = 0.035, yield_s: float = 1.5, tolerance: float = 8.0):
        self.mouse = mouse
        self.tau = tau
        self.yield_s = yield_s
        self.tolerance = tolerance
        self.override_until = 0.0
        self._target: np.ndarray | None = None
        self._pos: np.ndarray | None = None
        self._sent: deque[np.ndarray] = deque(maxlen=60)  # ~0.5s of positions we asked for
        self._lock = threading.Lock()
        self._running = False
        self._thread: threading.Thread | None = None

    @property
    def overridden(self) -> bool:
        return time.monotonic() < self.override_until

    def set_target(self, p) -> None:
        with self._lock:
            self._target = None if p is None else np.asarray(p, dtype=np.float64)

    def sync(self, p) -> None:
        """We moved the cursor ourselves (a click); don't mistake it for the trackpad."""
        with self._lock:
            self._pos = np.asarray(p, dtype=np.float64)
            self._sent.append(self._pos.copy())

    def start(self) -> None:
        self._running = True
        self._thread = threading.Thread(target=self._loop, name="eye-cursor", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._running = False
        if self._thread:
            self._thread.join(timeout=1.0)

    def _loop(self) -> None:
        period = 1 / 120
        last = time.monotonic()
        while self._running:
            now = time.monotonic()
            dt, last = now - last, now
            actual = np.array(cursor_position())
            with self._lock:
                target = self._target
                if self._sent and min(math.dist(actual, s) for s in self._sent) > self.tolerance:
                    self.override_until = now + self.yield_s
                    self._sent.clear()
                if target is None or now < self.override_until or self._pos is None:
                    self._pos = actual
                    time.sleep(period)
                    continue
                k = 1.0 - math.exp(-dt / self.tau)
                new = self._pos + (target - self._pos) * k
                if math.dist(new, self._pos) >= 0.3:
                    self.mouse.move(*new)
                    self._sent.append(new.copy())
                self._pos = new
            time.sleep(period)


class EyeCursor:
    def __init__(self, settings: Settings, display: Display, calib: Calibration | None, camera=None, dry_run=False):
        self.s = settings
        self.display = display
        self.calib = calib
        self.model = calib.model if calib else None
        self.profile = calib.profile if calib else FaceProfile()
        if self.model is None:
            settings.pointer.mode = "head"
        settings.gestures.click_s = self.profile.click_s
        self.pointer = Pointer(settings.pointer, display)
        self.gestures = GestureDetector(settings.gestures, winks=(self.profile.wink_l, self.profile.wink_r))
        self.mouse = Mouse(double_click_s=1.5, dry_run=dry_run)
        self.animator = CursorAnimator(self.mouse)
        self.snapper = Snapper(radius=settings.snap_radius) if settings.snap else None
        from .backend import for_calibration
        self.tracker = Tracker(camera if camera is not None else settings.camera, on_frame=self.on_frame,
                               appearance=for_calibration(calib))
        sound.enabled = settings.sounds

        # state the overlay reads
        self.paused = False
        self.dragging = False
        self.scrolling = False
        self.face = False
        self.closure = (0.0, 0.0)
        self.gaze_raw = None
        self.flashes: deque = deque(maxlen=8)  # (t, x, y, kind)
        self.targets: deque = deque(maxlen=4)  # (t, snap.Target)
        self.notice: tuple[str, float] | None = None
        self.clicks = 0
        self.learned = 0

        self._gaze_y = 0.5
        self._recent: deque = deque(maxlen=60)  # (t, gaze vector) with the eyes open
        self._online_x: deque = deque(maxlen=40)
        self._online_y: deque = deque(maxlen=40)
        self._stable_since: float | None = None
        self._scroll_ref: float | None = None
        self._scroll_t = 0.0
        self._scroll_carry = 0.0

    # lifecycle
    def start(self) -> None:
        self.pointer.place(*cursor_position())
        self.tracker.start()
        self.animator.start()
        self.say(f"eye on · {self.pointer.cfg.mode} mode", 2.5)

    def stop(self) -> None:
        if self.dragging and self.pointer.cursor is not None:
            self.mouse.release(*self.pointer.cursor)
        self.animator.stop()
        self.tracker.stop()

    def say(self, text: str, seconds: float = 2.0) -> None:
        self.notice = (text, time.monotonic() + seconds)

    def set_mode(self, mode: str) -> None:
        if mode != "head" and self.model is None:
            self.say("calibrate first: eye calibrate", 3)
            return
        self.pointer.set_mode(mode)
        self.say(f"{mode} mode")

    def toggle_pause(self) -> None:
        self.paused = not self.paused
        if self.paused:
            if self.dragging:
                self._drop(*self.pointer.cursor)
            if self.scrolling:
                self._set_scroll(False)
            sound.play(*SOUNDS["pause"])
            self.say("paused · shut your eyes ~2.5s to resume", 3)
        else:
            self.pointer.place(*cursor_position())
            sound.play(*SOUNDS["resume"])
            self.say("resumed")

    # tracker thread
    def on_frame(self, frame, obs, feats) -> None:
        t = frame.t
        if feats is None or (self.model is not None and len(gaze_vector(feats)) < self.model.n_features):
            self.face = False
            self._stable_since = None
            self.gestures.reset()
            self.animator.set_target(None)
            return
        if self._stable_since is None:
            self._stable_since = t
            self.pointer.reacquire()
        self.face = True

        gv = gaze_vector(feats)
        gaze_pt = None
        if self.model is not None:
            nx, ny = self.model.predict(gv)[0]
            gaze_pt = self.display.to_global(nx, ny)
            self.gaze_raw = gaze_pt
        self.closure = self.profile.closure(feats, self._gaze_y)

        events: list[Gesture] = []
        # Gestures need a moment of solid tracking first: a fresh lock or a fast
        # head turn produces closure spikes that look like blinks.
        if t - self._stable_since >= 0.3:
            if self.pointer.head_speed > self.s.max_head_speed:
                self.gestures.cancel()
            events += self.gestures.update(
                t,
                *self.closure,
                smile=feats.smile,
                winks_ok=abs(feats.yaw) <= self.s.wink_max_yaw,
            )
            events += self.gestures.update_expressions(t, self.profile.brow_level(feats), self.profile.jaw_level(feats))
        if not self.gestures.closing:
            self._recent.append((t, gv))
            if self.pointer.gaze is not None:
                self._gaze_y = self.display.to_norm(*self.pointer.gaze)[1]

        cursor = self.pointer.update(
            t,
            gaze_pt,
            feats.yaw,
            feats.pitch,
            self.gestures.closing,
            head_hold=self.gestures.expression or self.scrolling,
        )
        for e in events:
            self._handle(e)
        if self.scrolling and not self.gestures.closing:
            self._scroll(t, feats.pitch)
        if self.paused or cursor is None:
            self.animator.set_target(None)
        else:
            self.animator.set_target(cursor)

    def _handle(self, e: Gesture) -> None:
        if e.kind in SOUNDS and e.kind.startswith("tier"):
            sound.play(*SOUNDS[e.kind])  # you can't see the screen with your eyes shut
            return
        action = self.s.actions.get(e.kind, "none")
        if action == "pause":
            self.toggle_pause()
            return
        if self.paused or action == "none":
            return
        if self.scrolling:
            self._set_scroll(False)  # any gesture leaves scroll mode, and does nothing else
            return
        pos = self.pointer.frozen if self.pointer.frozen is not None else self.pointer.cursor
        if pos is None:
            return
        x, y = float(pos[0]), float(pos[1])
        if action in ("left_click", "right_click", "double_click"):
            if self.dragging:
                self._drop(x, y)
                return
            button = "right" if action == "right_click" else "left"
            (x, y), target = self._snap(x, y)
            n = self.mouse.click(x, y, button)
            if action == "double_click" and n == 1:
                n = self.mouse.click(x, y, button)
            self.animator.sync((x, y))
            self.clicks += 1
            self.flashes.append((time.monotonic(), x, y, "double" if n > 1 else button))
            sound.play(*SOUNDS["right" if button == "right" else "click"])
            if button == "left":
                self._learn(e, x, y)
        elif action == "drag":
            if self.dragging:
                self._drop(x, y)
            else:
                (x, y), _ = self._snap(x, y)
                self.mouse.press(x, y)
                self.animator.sync((x, y))
                self.dragging = True
                self.pointer.place(x, y)
                self.pointer.hold_until = e.t + self.s.drag_settle_s  # don't drag with the gesture itself
                sound.play(*SOUNDS["grab"])
                self.say("dragging · raise brows again to drop")
        elif action == "scroll":
            self._set_scroll(not self.scrolling)

    def _snap(self, x: float, y: float):
        if self.snapper is None:
            return (x, y), None
        point, target = self.snapper.snap(x, y)
        if target is not None:
            self.targets.append((time.monotonic(), target))
        return point, target

    def _drop(self, x: float, y: float) -> None:
        self.mouse.release(x, y)
        self.dragging = False
        self.flashes.append((time.monotonic(), x, y, "left"))
        sound.play(*SOUNDS["drop"])

    def _set_scroll(self, on: bool) -> None:
        self.scrolling = on
        self.pointer.held = on
        self._scroll_ref = None
        self._scroll_carry = 0.0
        sound.play(*SOUNDS["scroll_on" if on else "scroll_off"])
        if on:
            self.say("scrolling · tilt your head, blink to stop")

    def _scroll(self, t: float, pitch: float) -> None:
        if self._scroll_ref is None:
            self._scroll_ref, self._scroll_t = pitch, t
            return
        dt, self._scroll_t = t - self._scroll_t, t
        d = pitch - self._scroll_ref  # positive: head tilted down
        past = max(abs(d) - self.s.scroll_deadzone_deg, 0.0)
        # Cubic-ish: gentle near the dead zone, fast when you really tilt.
        speed = math.copysign(past * (1 + (past / 8.0) ** 2), d) * self.s.scroll_speed
        self._scroll_carry += speed * dt
        step = int(self._scroll_carry)
        if step:
            self.mouse.scroll(step)
            self._scroll_carry -= step

    def _learn(self, e: Gesture, x: float, y: float) -> None:
        """Hybrid mode: you steered the cursor onto what you clicked, while looking at it.

        So the gaze features from just before the blink, labeled with the click
        position, are a free calibration sample. Refitting with them tracks
        drift (you slid down in your chair, the light changed).
        """
        if not (self.s.learn_from_clicks and self.model is not None and self.calib.train is not None):
            return
        if self.pointer.cfg.mode != "hybrid":
            return
        gv = next((v for t, v in reversed(self._recent) if t <= e.t_start - 0.12), None)
        if gv is None:
            return
        nx, ny = self.display.to_norm(x, y)
        px, py = self.model.predict(gv)[0]
        err = math.hypot((px - nx) * self.display.w, (py - ny) * self.display.h)
        if err < 0.5 * self.pointer.pt_per_deg or err > 8 * self.pointer.pt_per_deg:
            return  # nothing to learn, or you clearly weren't looking at it
        self._online_x.append(gv)
        self._online_y.append((nx, ny))
        tx, ty, tw = self.calib.train
        self.model.refit(
            np.vstack([tx, np.array(self._online_x)]),
            np.vstack([ty, np.array(self._online_y)]),
            np.concatenate([tw, np.full(len(self._online_x), 15.0)]),
        )
        self.learned += 1


def run(settings: Settings, display: Display, calib: Calibration | None, camera=None, dry_run=False, debug=False) -> None:
    import AppKit
    from PyObjCTools import AppHelper

    from .ui.overlay import EyeOverlay

    app = AppKit.NSApplication.sharedApplication()
    app.setActivationPolicy_(AppKit.NSApplicationActivationPolicyAccessory)
    eye = EyeCursor(settings, display, calib, camera=camera, dry_run=dry_run)
    eye.start()
    try:
        overlay = EyeOverlay.alloc().init().setup(display, eye, debug=debug)
        overlay.show()
        AppHelper.runEventLoop(installInterrupt=True)
    finally:
        eye.stop()
