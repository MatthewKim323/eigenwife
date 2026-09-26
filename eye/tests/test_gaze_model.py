import numpy as np

from eye.gaze_model import GazeModel


def _data(n=600, seed=0):
    rng = np.random.default_rng(seed)
    x = rng.normal(0, 1, (n, 6))
    y = np.stack(
        [0.5 + 0.2 * x[:, 0] + 0.05 * x[:, 0] ** 2 - 0.1 * x[:, 3], 0.5 + 0.15 * x[:, 1] + 0.03 * x[:, 1] * x[:, 2]],
        axis=1,
    )
    groups = np.repeat(np.arange(n // 30), 30)
    return x, y + rng.normal(0, 0.01, y.shape), groups


def test_fits_quadratic_mapping():
    x, y, groups = _data()
    m = GazeModel()
    stats = m.fit(x, y, groups)
    assert stats["cv_error"] < 0.03
    xt, yt, _ = _data(seed=1)
    assert np.linalg.norm(m.predict(xt) - yt, axis=1).mean() < 0.03


def test_roundtrip_preserves_predictions():
    x, y, groups = _data()
    m = GazeModel()
    m.fit(x, y, groups)
    m2 = GazeModel.from_arrays(m.to_arrays())
    assert np.allclose(m.predict(x[:20]), m2.predict(x[:20]))


def test_scale_floor_keeps_unexercised_features_tame():
    x, y, groups = _data()
    x[:, 5] = 3.0 + np.random.default_rng(2).normal(0, 1e-6, len(x))  # never moved during calibration
    m = GazeModel(scale_floor=np.array([0, 0, 0, 0, 0, 1.0]))
    m.fit(x, y, groups)
    probe = x[:1].copy()
    base = m.predict(probe)
    probe[0, 5] += 2.0  # it moves a lot at runtime
    assert np.linalg.norm(m.predict(probe) - base) < 0.2


def test_refit_with_extra_samples_moves_prediction():
    x, y, groups = _data()
    m = GazeModel()
    m.fit(x, y, groups)
    probe = np.zeros((1, 6))
    before = m.predict(probe)[0]
    xs = np.vstack([x, np.repeat(probe, 50, axis=0)])
    ys = np.vstack([y, np.repeat([[0.9, 0.9]], 50, axis=0)])
    m.refit(xs, ys)
    after = m.predict(probe)[0]
    assert np.linalg.norm(after - [0.9, 0.9]) < np.linalg.norm(before - [0.9, 0.9])
