from dataclasses import replace

import numpy as np

from eye.features import Eye, Features
from eye.gaze_quality import GazeQualityGate, fit_gaze_quality
from eye.profile import FaceProfile


def feature(v=0., pitch=0., t=0., shut=False):
    ear = .30 + .8 * v - .001 * pitch
    bs = .1 - 1.2 * v + .001 * pitch
    eye = Eye(u=0, v=v, lid=.2, ear=.065 if shut else ear, width=40, iris=(0, 0))
    return Features(t, eye, replace(eye), 0, pitch, 0, (0, 0, -55),
                    (.85, .85) if shut else (bs, bs), (0, 0))


def fitted():
    p = FaceProfile(ear_closed_l=.065, ear_closed_r=.065, bs_closed_l=.85, bs_closed_r=.85)
    frames = [feature(v, pitch) for v in np.linspace(-.14, .06, 30)
              for pitch in [-10, 0, 10]]
    frames += [feature(v, 0, shut=True) for v in np.linspace(-.14, .06, 10)]
    assert fit_gaze_quality(p, frames)['fitted']
    return p


def test_sustained_downward_gaze_is_open_across_head_pitch():
    p = fitted()
    assert max(p.closure(feature(-.14))) > .35
    for pitch in [-10, 0, 10]:
        assert max(p.gaze_closure(feature(-.14, pitch))) < .15


def test_blinks_and_held_closures_stay_rejected_in_every_direction():
    p = fitted()
    gate = GazeQualityGate(p)
    for t in np.arange(0, 3, .03):
        assert gate.update(feature(-.14, t=t, shut=True))
    for v in [-.14, 0, .06]:
        assert min(p.gaze_closure(feature(v, shut=True))) > .75


def test_moderate_single_signal_artifact_requires_agreement_but_severe_ear_does_not():
    p = fitted()
    f = feature()
    f.bs_blink = (.85, .85)
    assert max(p.gaze_closure(f)) < .35
    f = feature()
    f.left.ear = .065
    assert p.gaze_closure(f)[0] >= .75


def test_recovery_does_not_emit_one_open_frame_between_blinks():
    gate = GazeQualityGate(fitted())
    assert not gate.update(feature(t=0))
    assert gate.update(feature(t=.03, shut=True))
    assert gate.update(feature(t=.06))
    assert gate.update(feature(t=.09))
    assert not gate.update(feature(t=.13))
    gate.reset()
    assert not gate.update(feature(t=2))


def test_profiles_roundtrip_and_legacy_files_load():
    p = fitted()
    assert FaceProfile.from_arrays(p.to_arrays()) == p
    legacy = {k:v for k,v in FaceProfile().to_arrays().items() if 'gaze_quality' not in k}
    old = FaceProfile.from_arrays(legacy)
    assert old.gaze_closure(feature()) == old.closure(feature())


def test_nonfinite_features_are_rejected_and_too_few_training_samples_not_fitted():
    p = fitted()
    assert max(p.gaze_closure(feature(float('nan')))) > .35
    before = p.to_arrays()
    assert not fit_gaze_quality(p, [feature()])['fitted']
    for k,v in before.items():
        np.testing.assert_equal(v, p.to_arrays()[k])


def test_outside_iris_range_cannot_make_closed_eyes_acceptable():
    p = fitted()
    for v in [-100, 100]:
        assert min(p.gaze_closure(feature(v, shut=True))) > .75
