"""`eye debug`: camera preview with landmarks, magnified eyes, and live signal readouts.

Nothing here moves the cursor. Use it to check lighting, camera placement, and
what the blink signals look like before calibrating.
"""

from __future__ import annotations

import threading
from collections import deque

import cv2
import numpy as np

from . import calibration, screen
from .features import LEFT_EYE, RIGHT_EYE, gaze_vector
from .gestures import GestureDetector
from .profile import FaceProfile
from .tracker import Tracker

GREEN, CYAN, PINK, WHITE, GRAY, AMBER, RED = (80, 220, 110), (255, 210, 80), (200, 110, 255), (240, 240, 240), (150, 150, 150), (60, 190, 255), (70, 70, 240)


def _put(img, text, x, y, color=WHITE, scale=0.5):
    cv2.putText(img, text, (int(x), int(y)), cv2.FONT_HERSHEY_SIMPLEX, scale, (0, 0, 0), 3, cv2.LINE_AA)
    cv2.putText(img, text, (int(x), int(y)), cv2.FONT_HERSHEY_SIMPLEX, scale, color, 1, cv2.LINE_AA)


def _bar(img, x, y, w, value, marks, color):
    cv2.rectangle(img, (x, y), (x + w, y + 10), (60, 60, 60), -1)
    cv2.rectangle(img, (x, y), (x + int(w * min(max(value, 0), 1)), y + 10), color, -1)
    for m in marks:
        cv2.line(img, (x + int(w * m), y - 2), (x + int(w * m), y + 12), WHITE, 1)


def run(camera=None, mirror: bool = True) -> None:
    calib = calibration.load()
    profile = calib.profile if calib else FaceProfile()
    model = calib.model if calib else None
    display = screen.pick()
    det = GestureDetector(winks=(profile.wink_l, profile.wink_r))
    det.cfg.click_s = profile.click_s
    events: deque = deque(maxlen=6)
    latest: dict = {}
    lock = threading.Lock()

    def on_frame(frame, obs, feats):
        # Gestures run per camera frame here, not per redraw.
        info = {"frame": frame, "obs": obs, "feats": feats}
        if feats is not None:
            cl, cr = profile.closure(feats)
            gestures = det.update(frame.t, cl, cr, smile=feats.smile)
            gestures += det.update_expressions(frame.t, profile.brow_level(feats), profile.jaw_level(feats))
            for e in gestures:
                events.appendleft(f"{e.kind}  ({(e.t - e.t_start) * 1000:.0f} ms)")
            info["closure"] = (cl, cr)
            info["parts"] = profile.closure_parts(feats)
            info["expr"] = (profile.brow_level(feats), profile.jaw_level(feats))
            if model is not None and len(gaze_vector(feats)) >= model.n_features:
                info["gaze"] = model.predict(gaze_vector(feats))[0]
        with lock:
            latest.clear()
            latest.update(info)

    from .backend import for_calibration
    tracker = Tracker(camera, on_frame=on_frame, appearance=for_calibration(calib)).start()
    print(f"camera: {tracker.camera.info.name} {tracker.camera.frame_size}. q or esc to quit")
    cv2.namedWindow("eye debug", cv2.WINDOW_NORMAL)
    try:
        while True:
            with lock:
                snap = dict(latest)
            if "frame" not in snap:
                if cv2.waitKey(10) & 0xFF in (27, ord("q")):
                    break
                continue
            img = snap["frame"].image.copy()
            h, w = img.shape[:2]
            obs, feats = snap["obs"], snap["feats"]
            if mirror:
                img = cv2.flip(img, 1)

            def X(x):
                return (w - 1 - x) if mirror else x

            if obs is not None:
                lm = obs.lm
                for idx, color in ((LEFT_EYE, CYAN), (RIGHT_EYE, PINK)):
                    for i in (idx.a, idx.b):
                        cv2.circle(img, (int(X(lm[i, 0])), int(lm[i, 1])), 2, color, -1)
                    for up, lo in idx.lids:
                        cv2.circle(img, (int(X(lm[up, 0])), int(lm[up, 1])), 1, GRAY, -1)
                        cv2.circle(img, (int(X(lm[lo, 0])), int(lm[lo, 1])), 1, GRAY, -1)
                    c = lm[idx.iris[0], :2]
                    r = float(np.mean(np.linalg.norm(lm[list(idx.iris[1:]), :2] - c, axis=1)))
                    cv2.circle(img, (int(X(c[0])), int(c[1])), max(int(r), 1), color, 1, cv2.LINE_AA)
                    cv2.circle(img, (int(X(c[0])), int(c[1])), 1, color, -1)
                # magnified eyes, top left
                crops = []
                for idx in (RIGHT_EYE, LEFT_EYE) if mirror else (LEFT_EYE, RIGHT_EYE):
                    cx = X((lm[idx.a, 0] + lm[idx.b, 0]) / 2)
                    cy = (lm[idx.a, 1] + lm[idx.b, 1]) / 2
                    half = max(int(abs(lm[idx.b, 0] - lm[idx.a, 0]) * 0.9), 12)
                    x0, y0 = int(max(cx - half, 0)), int(max(cy - half * 0.6, 0))
                    crop = img[y0 : int(cy + half * 0.6), x0 : int(cx + half)]
                    if crop.size:
                        crops.append(cv2.resize(crop, (220, int(220 * crop.shape[0] / max(crop.shape[1], 1)))))
                if len(crops) == 2 and crops[0].shape == crops[1].shape:
                    strip = np.hstack(crops)
                    img[8 : 8 + strip.shape[0], 8 : 8 + strip.shape[1]] = strip

            panel_x, y = w - 330, 24
            cv2.rectangle(img, (panel_x - 10, 0), (w, h), (20, 20, 20), -1)
            _put(img, f"{tracker.fps:4.1f} fps   {tracker.latency_ms:4.1f} ms   {tracker.camera.info.name}", panel_x, y)
            y += 26
            if feats is None:
                _put(img, "no face", panel_x, y, RED, 0.7)
            else:
                _put(img, f"head yaw {feats.yaw:+5.1f}  pitch {feats.pitch:+5.1f}  roll {feats.roll:+5.1f}", panel_x, y)
                y += 20
                _put(img, f"distance ~{-feats.pos[2]:.0f} cm", panel_x, y, GRAY)
                y += 26
                for name, e, color in (("L", feats.left, CYAN), ("R", feats.right, PINK)):
                    _put(img, f"{name} u {e.u:+.3f} v {e.v:+.3f} lid {e.lid:.3f} ear {e.ear:.3f}", panel_x, y, color)
                    y += 20
                y += 8
                el, er, bl, br = snap.get("parts", (0, 0, 0, 0))
                _put(img, f"closure from shape L {el:.2f} R {er:.2f} · blendshape L {bl:.2f} R {br:.2f}", panel_x, y, GRAY)
                y += 22
                cl, cr = snap.get("closure", (0, 0))
                g = det.cfg
                for name, v, color in (("L", cl, CYAN), ("R", cr, PINK)):
                    _put(img, f"{name} closed", panel_x, y + 10, color)
                    _bar(img, panel_x + 80, y, 220, v, (g.onset, g.close_off, g.close_on), color)
                    y += 22
                brow, jaw = snap.get("expr", (0.0, 0.0))
                for name, v, color, marks in (
                    ("brow", brow, AMBER, (g.brow_off, g.brow_on)),
                    ("jaw", jaw, GREEN, (g.mouth_off, g.mouth_on)),
                ):
                    _put(img, f"{name}", panel_x, y + 10, color)
                    _bar(img, panel_x + 80, y, 220, v, marks, color)
                    y += 22
                kind, held = det.held(snap["frame"].t)
                tier = "click" if held >= g.click_s else ""
                if held >= g.right_click_s:
                    tier = "right click"
                if held >= g.pause_s:
                    tier = "pause"
                _put(img, f"state {det.symbol:6s} {'closing' if det.closing else ''} {kind} {held:.2f}s {tier}", panel_x, y + 8)
                y += 26
                _put(
                    img,
                    f"click at {g.click_s * 1000:.0f} ms · winks {'L' if profile.wink_l else '-'}{'R' if profile.wink_r else '-'}"
                    f" · mix {profile.mix:g}{'' if profile.calibrated else ' (uncalibrated)'}",
                    panel_x,
                    y,
                    GRAY,
                )
                y += 26
                for e in events:
                    _put(img, e, panel_x, y, AMBER)
                    y += 20
            # gaze minimap
            if "gaze" in snap:
                mw, mh = 300, int(300 * display.h / display.w)
                mx, my = panel_x, h - mh - 20
                cv2.rectangle(img, (mx, my), (mx + mw, my + mh), GRAY, 1)
                gx, gy = snap["gaze"]
                cv2.circle(img, (int(mx + np.clip(gx, 0, 1) * mw), int(my + np.clip(gy, 0, 1) * mh)), 6, GREEN, -1)
                _put(img, f"gaze {gx:.2f}, {gy:.2f}", mx, my - 8, GRAY)
            elif calib is None:
                _put(img, "no calibration yet: run `eye calibrate`", panel_x, h - 20, GRAY)
            cv2.imshow("eye debug", img)
            if cv2.waitKey(1) & 0xFF in (27, ord("q")):
                break
    finally:
        tracker.stop()
        cv2.destroyAllWindows()
        cv2.waitKey(1)
