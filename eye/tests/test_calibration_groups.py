"""Protect the actual fitter inputs against spatial and temporal CV leakage."""

from types import SimpleNamespace

import numpy as np

from eye import calibration as cal
from test_calibration import _features, synthetic_recording, DISPLAY


def _training_groups(steps, observations):
    script = cal.Script(steps)
    rec = cal.Recording()
    rows = []
    for i, (step_index, tau) in enumerate(observations):
        step = steps[step_index]
        feature = _features(i / 30, .01, .02, .3, .3, .1, .1, .0, .0, .0, .0)
        rec.add(feature.t, feature, None)
        rows.append((i, cal.Cue(step_index, step, tau, step.x, step.y, True, 1.0)))
    profile = SimpleNamespace(gaze_closure=lambda _: (0.0, 0.0))
    return cal._training_set(rec, script, rows, profile)


def test_neutral_and_all_head_conditions_share_spatial_target_fold():
    steps = [cal.Step(kind, 3, x=x, y=y) for kind, x, y in [
        (cal.HEAD, .5, .5), (cal.FIXATE, .1, .1),
        (cal.FIXATE, .5, .5), (cal.HEAD, .5, .5),
        (cal.FIXATE, .1, .1), (cal.HEAD, .1, .1),
        (cal.VALIDATE, .5, .5), (cal.VALIDATE, .5, .5),
    ]]
    _, _, groups, weights, _, _ = _training_groups(steps, [(i, 1.) for i in range(len(steps))])
    assert groups.tolist() == [0, 1000, 0, 0, 1000, 1000, 6000, 7000]
    assert np.all(weights == 1.)


def test_pursuit_neighboring_frames_remain_in_one_step_fold():
    steps = [cal.Step(cal.PURSUIT, 15), cal.Step(cal.PURSUIT, 15)]
    _, _, groups, weights, _, _ = _training_groups(
        steps, [(0, .99), (0, 1.01), (0, 14.9), (1, .99), (1, 1.01)])
    assert groups.tolist() == [0, 0, 0, 1000, 1000]
    assert np.all(weights == .5)


def test_fitter_records_cv_protocol_without_merging_validation_episodes():
    script = cal.build_script(quick=True, expressions=False)
    result = cal.fit(synthetic_recording(script), script, DISPLAY, latency=0.)
    assert result.stats["cv_grouping"] == "spatial-target-and-pursuit-step-v2"
    assert result.stats["cv_error_units"] == "screen_points"
    assert result.stats["cv_error"] is not None
    expected = sum(step.kind == cal.VALIDATE for step in script.steps)
    assert result.stats["validation_targets"] == expected
    assert result.stats["validation_expected_targets"] == expected
