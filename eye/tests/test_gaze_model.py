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


def test_model_fitted_on_fewer_features_reads_leading_columns():
    """Features are only ever appended, so an older saved model keeps working."""
    rng = np.random.default_rng(1)
    x = rng.normal(size=(200, 12))
    y = np.stack([0.5 + 0.1 * x[:, 0], 0.5 + 0.1 * x[:, 1]], axis=1)
    m = GazeModel(degree=1)
    m.fit(x, y)
    wider = np.hstack([x, rng.normal(size=(200, 4))])
    assert m.n_features == 12
    assert np.allclose(m.predict(wider), m.predict(x))


def test_grouped_cv_matches_independent_fits_with_training_only_normalization():
    # An extreme held-out feature range used to leak into training scaling.
    rng = np.random.default_rng(42)
    x = np.concatenate([rng.normal(i * 8, 0.4, (20, 2)) for i in range(4)])
    y = np.column_stack([x[:, 0] * 0.1, x[:, 1] * 0.2])
    groups = np.repeat(np.arange(4), 20)
    weights = rng.uniform(0.5, 1.5, len(x))
    alpha = 4.0
    expected = np.zeros(len(x))
    for group in np.unique(groups):
        held = groups == group
        fold = GazeModel(degree=1)
        fold.alpha = alpha
        fold.fit(x[~held], y[~held], weights=weights[~held])
        expected[held] = np.linalg.norm(fold.predict(x[held]) - y[held], axis=1)
    model = GazeModel(degree=1)
    result = model.fit(x, y, groups, weights, alphas=[alpha])
    assert np.isclose(result["cv_error"], np.average(expected, weights=weights))


def test_cv_measures_error_in_actual_screen_dimensions():
    x, y, groups = _data(n=120)
    scale = np.array([1512, 982])
    expected = np.zeros(len(x))
    for group in np.unique(groups):
        held = groups == group
        fold = GazeModel(degree=1)
        fold.alpha = 4.0
        fold.fit(x[~held], y[~held])
        expected[held] = np.linalg.norm((fold.predict(x[held]) - y[held]) * scale, axis=1)
    result = GazeModel(degree=1).fit(x, y, groups, alphas=[4.0], error_scale=scale)
    assert np.isclose(result["cv_error"], expected.mean())


def test_robust_cv_matches_independent_training_only_folds_and_roundtrips():
    rng = np.random.default_rng(77)
    x = rng.normal(size=(120, 4))
    y = .5 + x[:, :2] * .12
    y[::7] += rng.normal(0, .8, (len(y[::7]), 2))
    groups = np.repeat(np.arange(6), 20)
    scale = np.array([1512, 982])
    expected = np.zeros(len(x))
    for group in np.unique(groups):
        held = groups == group
        fold = GazeModel(degree=1)
        fold.alpha = 4.0
        fold.robust_delta = 100.0
        fold.fit(x[~held], y[~held], error_scale=scale)
        expected[held] = np.linalg.norm((fold.predict(x[held]) - y[held]) * scale, axis=1)
    model = GazeModel(degree=1, robust_deltas=(100.0,))
    result = model.fit(x, y, groups, alphas=[4.0], error_scale=scale)
    assert np.isclose(result['cv_error'], expected.mean())
    restored = GazeModel.from_arrays(model.to_arrays())
    np.testing.assert_allclose(restored.predict(x), model.predict(x))
    model.refit(x, y)
    restored.refit(x, y)
    np.testing.assert_allclose(restored.predict(x), model.predict(x))


def test_robust_selection_recovers_mapping_despite_bad_training_fixations():
    rng = np.random.default_rng(15)
    x = rng.normal(size=(240, 4))
    clean_y = .5 + x[:, :2] * .12
    y = clean_y.copy()
    y[::8] += [.8, -.8]
    groups = np.repeat(np.arange(8), 30)
    robust = GazeModel(degree=1, robust_deltas=(None, 100.0, 200.0))
    report = robust.fit(x, y, groups, error_scale=[1512, 982])
    plain = GazeModel(degree=1)
    plain.fit(x, y, groups, error_scale=[1512, 982])
    assert report['robust_delta_points'] == 100.0
    assert np.linalg.norm(robust.predict(x) - clean_y, axis=1).mean() < np.linalg.norm(plain.predict(x) - clean_y, axis=1).mean() * .5


def test_older_saved_model_without_robust_metadata_still_loads():
    x, y, _ = _data(n=120)
    model = GazeModel(degree=1)
    model.fit(x, y)
    arrays = model.to_arrays()
    del arrays['gaze_robust_delta']
    del arrays['gaze_error_scale']
    restored = GazeModel.from_arrays(arrays)
    assert restored.robust_delta is None
    np.testing.assert_allclose(restored.predict(x), model.predict(x))
