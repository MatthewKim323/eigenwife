import numpy as np

from eye.pointer import Pointer, PointerConfig
from eye.screen import Display

DISPLAY = Display(1, "test", 0, 0, 1470, 956, 2.0, True, (290.6, 189.0))


def make(mode="hybrid", **kw):
    return Pointer(PointerConfig(mode=mode, **kw), DISPLAY)


def feed(p, t0, seconds, gaze, yaw=0.0, pitch=0.0, closing=False, fps=30):
    t = t0
    out = None
    for _ in range(int(seconds * fps)):
        t += 1 / fps
        out = p.update(t, gaze, yaw, pitch, closing)
    return t, out


def test_gaze_mode_settles_on_the_fixation():
    p = make("gaze")
    rng = np.random.default_rng(0)
    t = 0.0
    for _ in range(45):
        t += 1 / 30
        target = np.array([700.0, 400.0]) + rng.normal(0, 40, 2)
        out = p.update(t, target, 0.0, 0.0, False)
    assert np.linalg.norm(out - [700, 400]) < 40


def test_hybrid_jumps_on_a_far_look_but_not_a_near_one():
    p = make()
    t, _ = feed(p, 0, 1.0, (400.0, 400.0))
    near = (400.0 + 1.5 * p.pt_per_deg, 400.0)  # inside the warp radius
    t, out = feed(p, t, 1.0, near)
    assert np.linalg.norm(out - [400, 400]) < 20
    far = (1100.0, 700.0)
    t, out = feed(p, t, 1.0, far)
    assert np.linalg.norm(out - far) < 60


def test_head_turn_nudges_the_cursor_the_way_you_turned():
    p = make("head")
    p.place(700, 400)
    t, _ = feed(p, 0, 0.5, None, yaw=0.0, pitch=0.0)
    t, out = feed(p, t, 1.0, None, yaw=-4.0, pitch=0.0)  # turning to your right
    assert out[0] > 740  # cursor went right
    t, out2 = feed(p, t, 1.0, None, yaw=-4.0, pitch=-4.0)  # tilting up
    assert out2[1] < out[1] - 20  # cursor went up


def test_head_moves_do_not_trigger_gaze_jumps():
    """A shaky gaze estimate while the head turns must not yank the cursor."""
    p = make()
    t, _ = feed(p, 0, 1.0, (400.0, 400.0))
    yaw = 0.0
    out = None
    for _ in range(30):
        t += 1 / 30
        yaw -= 1.2  # fast, steady turn: 36 deg/s
        drift = (400.0 + abs(yaw) * 30, 400.0)  # gaze estimate drifts badly with pose
        out = p.update(t, drift, yaw, 0.0, False)
    assert p.warps == 0  # the initial placement isn't a warp, and the drift never triggered one
    assert out[0] > 400  # head control still moved it


def test_blink_freeze_rewinds_and_holds():
    p = make("gaze", freeze_lookback_s=0.15)
    t, _ = feed(p, 0, 1.0, (500.0, 500.0))
    # gaze slides away as the lids come down, then the episode starts
    t, _ = feed(p, t, 0.1, (900.0, 500.0))
    t, frozen = feed(p, t, 0.4, (1200.0, 900.0), closing=True)
    assert np.linalg.norm(frozen - [500, 500]) < 80  # the pre-blink position, not the corrupted one
    # and it stays put for the whole closure
    t, still = feed(p, t, 0.3, (1400.0, 900.0), closing=True)
    assert np.allclose(still, frozen)


def test_cursor_stays_inside_the_display():
    p = make("head")
    p.place(100, 100)
    t, out = feed(p, 0, 2.0, None, yaw=40.0, pitch=40.0)
    assert 0 <= out[0] <= DISPLAY.w and 0 <= out[1] <= DISPLAY.h
