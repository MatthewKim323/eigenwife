import numpy as np
import pytest
from eye.iphone_models import design, fit_iphone_model, FEATURE_NAMES


def dataset(seed=12):
    rng = np.random.default_rng(seed)
    xs, ys, groups = [], [], []
    for g, (u, v) in enumerate(( (u, v) for u in (.1, .35, .65, .9) for v in (.1, .35, .65, .9))):
        for _ in range(15):
            origin = np.array([rng.uniform(-.12, .12), rng.uniform(-.08, .08), rng.uniform(-.8, -.3)])
            target = np.array([(u-.5)*.5, (v-.5)*.35, .05])
            ray = target-origin
            ray /= np.linalg.norm(ray)
            angle = rng.uniform(-.15, .15)
            head = np.array([np.cos(angle), 0, -np.sin(angle), 0, 1, 0])
            eyes = [origin + [-.032, 0, 0], origin + [.032, 0, 0]]
            dirs = [(target-o)/np.linalg.norm(target-o) for o in eyes]
            xs.append(np.r_[ray, origin, head, *dirs, *eyes])
            ys.append([u, v]); groups.append(g)
    return np.array(xs), np.array(ys), np.array(groups)


def test_projective_candidate_handles_translation_depth_and_pose():
    x, y, groups = dataset()
    model, stats = fit_iphone_model(x, y, groups, np.ones(len(x)), [1000, 800])
    rows = {r['name']: r for r in stats['modelCandidates']}
    assert len(FEATURE_NAMES) == 24
    assert model.name in ('fused_projective', 'binocular_projective')
    assert stats['cv_error'] < rows['fused_linear']['cvMeanPoints'] * .2
    x2, y2, _ = dataset(seed=23)
    assert np.linalg.norm((model.predict(x2)-y2)*[1000, 800], axis=1).mean() < 3
    assert not rows['head_only']['eligible']
    assert rows['head_only']['cvMeanPoints'] > 100


def test_binocular_retains_information_lost_in_fused_estimate():
    x, y, groups = dataset()
    # Corrupt fused gaze only, while eye rays still intersect the actual target.
    x[:, :3] = np.array([0., 0., 1.])
    model, stats = fit_iphone_model(x, y, groups, np.ones(len(x)), [1000, 800])
    assert model.name == 'binocular_projective'
    assert stats['cv_error'] < 3


def test_parallel_rays_disable_only_projective_candidates():
    x, y, groups = dataset()
    x[:, 2] = x[:, 14] = x[:, 17] = 0
    model, stats = fit_iphone_model(x, y, groups, np.ones(len(x)), [1000, 800])
    assert model.name == 'fused_linear'
    assert all(not r['eligible'] for r in stats['modelCandidates'][1:])
    with pytest.raises(ValueError, match='parallel'):
        design(x, 'fused_projective')


def test_repeat_target_samples_cannot_create_more_cv_groups():
    x, y, groups = dataset()
    with pytest.raises(ValueError, match='nine distinct'):
        fit_iphone_model(x, y, groups % 8, np.ones(len(x)), [1000, 800])


def test_projective_model_abstains_on_new_parallel_ray():
    x, y, groups = dataset()
    model, _ = fit_iphone_model(x, y, groups, np.ones(len(x)), [1000, 800])
    bad = x[0].copy()
    bad[2] = bad[14] = bad[17] = 0
    assert not np.isfinite(model.predict(bad)).any()


def test_posture_support_abstains_on_pitch_shift_but_allows_tracking_noise():
    from eye.iphone_models import PostureSupport
    x, y, groups = dataset()
    model, _ = fit_iphone_model(x, y, groups, np.ones(len(x)), [1000, 800])
    baseline = x[0].copy()
    def pitched(degrees):
        row = baseline.copy()
        a = np.deg2rad(degrees)
        r = np.array([[1, 0, 0], [0, np.cos(a), -np.sin(a)], [0, np.sin(a), np.cos(a)]])
        row[6:9] = r @ row[6:9]
        row[9:12] = r @ row[9:12]
        return row
    assert model.supports(pitched(1))[0]
    assert np.isfinite(model.predict(pitched(1))).all()
    assert not model.supports(pitched(5))[0]
    assert np.isnan(model.predict(pitched(5))).all()
    assert PostureSupport(x).contains(x).all()
    shifted = baseline.copy()
    shifted[3] = x[:, 3].max() + .03
    assert not model.supports(shifted)[0]
