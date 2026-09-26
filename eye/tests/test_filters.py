import numpy as np

from eye.filters import FixationFilter, OneEuro


def test_one_euro_reduces_jitter_and_tracks_steps():
    rng = np.random.default_rng(0)
    # Noise inflates the speed estimate (~230 px/s here), so a gaze-sized beta is tiny.
    f = OneEuro(min_cutoff=0.5, beta=0.001)
    t = 0.0
    out = []
    for _ in range(300):
        t += 1 / 30
        out.append(f(np.array([100.0, 200.0]) + rng.normal(0, 20, 2), t))
    out = np.array(out[60:])
    assert out.std(axis=0).max() < 8.0
    for _ in range(30):
        t += 1 / 30
        y = f(np.array([800.0, 200.0]), t)
    assert abs(y[0] - 800.0) < 40.0  # a fast move isn't smeared out for long


def test_one_euro_ignores_non_increasing_time():
    f = OneEuro()
    a = f([1.0], 1.0)
    b = f([5.0], 1.0)
    assert np.allclose(a, b)


def test_fixation_filter_holds_then_jumps():
    rng = np.random.default_rng(1)
    fx = FixationFilter(radius=60, confirm=3)
    for _ in range(30):
        c = fx.update(np.array([300.0, 300.0]) + rng.normal(0, 15, 2))
    assert np.linalg.norm(c - [300, 300]) < 10
    assert fx.fixations == 1
    # one outlier doesn't move it
    c = fx.update([900.0, 300.0])
    assert np.linalg.norm(c - [300, 300]) < 10
    # a real saccade does, after `confirm` agreeing samples
    for _ in range(3):
        c = fx.update(np.array([900.0, 300.0]) + rng.normal(0, 10, 2))
    assert np.linalg.norm(c - [900, 300]) < 20
    assert fx.fixations == 2


def test_fixation_filter_scattered_outliers_are_not_a_saccade():
    fx = FixationFilter(radius=50, confirm=3)
    for _ in range(10):
        fx.update([0.0, 0.0])
    for p in ([500.0, 0.0], [0.0, 500.0], [-500.0, 0.0], [0.0, -500.0]):
        c = fx.update(p)
    assert np.allclose(c, [0, 0])
