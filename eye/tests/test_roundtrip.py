"""Calibrate -> save -> load -> run, without a camera or a UI.

EyeCursor only touches hardware in start(), so the runtime can be driven with
recorded frames as long as the mouse is in dry-run mode.
"""

import numpy as np

from eye import calibration as cal
from eye.app import EyeCursor
from eye.config import Settings
from eye.features import gaze_vector
from test_calibration import DISPLAY, synthetic_recording


def _calibrated(tmp_path, **kw):
    script = cal.build_script()
    rec = synthetic_recording(script, **kw)
    result = cal.fit(rec, script, DISPLAY, latency=0.0)
    return rec, result, cal.load(cal.save(result, DISPLAY, "FaceTime HD Camera", tmp_path / "calibration.npz"))


def test_calibration_survives_save_and_load(tmp_path):
    rec, result, loaded = _calibrated(tmp_path, blink_every=4.0)
    assert loaded.profile == result.profile
    assert loaded.meta["display"]["name"] == DISPLAY.name
    assert loaded.meta["stats"]["validation_deg"] == result.stats["validation_deg"]
    sample = np.array([gaze_vector(f) for f in rec.features[:20] if f is not None])
    assert np.allclose(loaded.model.predict(sample), result.model.predict(sample))
    assert loaded.train is not None and len(loaded.train[0]) == result.stats["samples"]


def _runtime(calib):
    settings = Settings()
    settings.sounds = False
    settings.snap = False  # no accessibility calls in tests
    eye = EyeCursor(settings, DISPLAY, calib, dry_run=True)
    eye.pointer.place(*DISPLAY.to_global(0.5, 0.5))
    return eye


def test_a_loaded_calibration_drives_the_cursor(tmp_path):
    _, _, calib = _calibrated(tmp_path)
    eye = _runtime(calib)
    # Replay gaze-only frames: the expression steps of a calibration really do
    # contain held closures, and those are supposed to click.
    rec = synthetic_recording(cal.build_script(expressions=False), seed=3)
    moved = []
    for t, f in zip(rec.t, rec.features):
        if f is None:
            continue
        eye.on_frame(type("Frame", (), {"t": t, "image": None}), None, f)
        if eye.pointer.cursor is not None:
            moved.append(eye.pointer.cursor.copy())
    assert len(moved) > 100
    spread = np.ptp(np.array(moved), axis=0)
    assert spread[0] > 0.5 * DISPLAY.w and spread[1] > 0.4 * DISPLAY.h  # followed the dots around
    assert eye.clicks == 0  # nothing in the recording is a held blink


def test_a_held_blink_clicks_and_teaches_the_model(tmp_path):
    _, _, calib = _calibrated(tmp_path)
    eye = _runtime(calib)
    frames = [f for f in synthetic_recording(cal.build_script(quick=True)).features if f is not None]
    held = eye.profile.click_s + 0.2

    def feed(seconds, template, shut=False):
        t0 = eye._last_t = getattr(eye, "_last_t", 0.0)
        for i in range(int(seconds * 30)):
            f = _copy(template, t0 + (i + 1) / 30, shut)
            eye._last_t = f.t
            eye.on_frame(type("Frame", (), {"t": f.t, "image": None}), None, f)

    feed(1.0, frames[60])  # settle, eyes open
    feed(held, frames[60], shut=True)
    feed(0.5, frames[60])
    assert eye.clicks == 1
    assert eye.learned in (0, 1)  # learns only if the click landed off the estimate


def _copy(f, t, shut):
    import copy

    g = copy.deepcopy(f)
    g.t = t
    if shut:
        g.left.ear = g.right.ear = 0.05
        g.bs_blink = (0.9, 0.9)
    return g
