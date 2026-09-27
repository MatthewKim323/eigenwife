from copy import deepcopy
from types import SimpleNamespace

import numpy as np
import pytest

from eye import benchmark as bench, calibration as cal
from test_calibration import DISPLAY, synthetic_recording


@pytest.fixture
def scene():
    script = cal.build_script(quick=True, expressions=False)
    rec = synthetic_recording(script)
    result = cal.fit(rec, script, DISPLAY, latency=0)
    meta = {'display': {'w': DISPLAY.w, 'h': DISPLAY.h}, 'camera': 'test'}
    model = cal.Calibration(result.model, result.profile, meta, None)
    return rec, script, meta['display'], model


def test_identical_models_common_mask_and_missing_target(scene):
    rec, script, geometry, model = scene
    target = next(i for i, s in enumerate(script.steps) if s.kind == cal.VALIDATE)
    for i, t in enumerate(rec.t):
        if script.at(t).index == target:
            rec.features[i] = None
    report = bench.evaluate_models(rec, script, geometry, 'test', {'a': model, 'b': model}, latency=0)
    assert report['common_mask']['a'] == report['common_mask']['b']
    metrics = report['common_mask']['a']
    assert metrics['targets_with_samples'] == metrics['expected_targets'] - 1
    assert any(t['samples'] == 0 and t['mean_points'] is None for t in metrics['targets'])
    assert metrics['coverage'] < 1
    assert report['models']['a']['rejected_reasons']['no_face'] > 0


def test_target_macro_not_weighted_by_frame_count(scene):
    rec, script, geometry, model = scene
    report = bench.evaluate_models(rec, script, geometry, 'test', {'a': model}, latency=0)
    metrics = report['models']['a']['accepted_frames']
    assert metrics['macro_target']['p90_points'] == pytest.approx(np.mean([t['p90_points'] for t in metrics['targets']]))
    assert metrics['temporal']['consecutive_jump']['samples'] > 0


def test_common_mask_preserves_paired_frames_with_different_gates(scene):
    rec, script, geometry, model = scene
    changed = deepcopy(model)
    changed.profile = SimpleNamespace(gaze_closure=lambda f: (1., 1.) if f.left.u > .5 else (0., 0.))
    report = bench.evaluate_models(rec, script, geometry, 'test', {'a': model, 'b': changed}, latency=0)
    assert report['common_mask']['a']['frame'] == report['common_mask']['b']['frame']
    assert report['common_mask']['a']['coverage'] <= report['models']['a']['accepted_frames']['coverage']


def test_geometry_camera_schema_mismatch_explicit(scene):
    rec, script, geometry, model = scene
    model.meta['display']['w'] += 1
    report = bench.evaluate_models(rec, script, {**geometry, 'w': geometry['w'] - 1}, 'different', {'a': model})
    assert set(report['models']['a']['issues']) == {'display_w_mismatch', 'camera_mismatch'}
    assert report['common_mask'] == {}
    model.meta['feature_backend'] = {'name': 'unknown', 'feature_count': 258}
    assert 'feature_schema_mismatch' in bench.compatibility(model, rec, geometry, 'test')


def test_never_fits_and_content_hash_detects_renamed_training(scene, tmp_path, monkeypatch):
    rec, script, geometry, model = scene
    session = tmp_path / 'session.npz'
    renamed = tmp_path / 'renamed.npz'
    saved = tmp_path / 'model.npz'
    session.write_bytes(b'same recording')
    renamed.write_bytes(session.read_bytes())
    saved.write_bytes(b'model')
    monkeypatch.setattr(cal, 'load', lambda _: model)
    monkeypatch.setattr(cal, 'load_session', lambda _: (rec, script, geometry, 'test'))
    monkeypatch.setattr(cal, 'fit', lambda *a, **k: pytest.fail('benchmark must never fit'))
    report = bench.benchmark([session], {'a': saved}, {'a': [renamed]}, latency=0)
    assert report['sessions'][0]['relationship']['a'] == 'same_recording'
    unknown = bench.benchmark([session], {'a': saved}, latency=0)
    assert unknown['sessions'][0]['relationship']['a'] == 'unknown'


def test_all_missing_is_json_safe(scene):
    import json
    rec, script, geometry, model = scene
    rec.features = [None] * len(rec.features)
    report = bench.evaluate_models(rec, script, geometry, 'test', {'a': model}, latency=0)
    json.dumps(report, allow_nan=False)
    metrics = report['common_mask']['a']
    assert metrics['coverage'] == 0
    assert metrics['frame']['mean_points'] is None
    assert report['models']['a']['failure_rate'] == 1


def test_outliers_are_retained_and_temporal_metrics_do_not_bridge_gaps(scene):
    rec, script, geometry, model = scene
    target = next(i for i, s in enumerate(script.steps) if s.kind == cal.VALIDATE)
    rows = [(i, cue) for i, cue in cal._label(rec, script, 0) if cue.index == target]
    for i, _ in rows[1:-1]:
        rec.features[i] = None
    rec.features[rows[-1][0]].left.u += 100
    report = bench.evaluate_models(rec, script, geometry, 'test', {'a': model}, latency=0)
    metrics = report['models']['a']['accepted_frames']
    assert metrics['frame']['worst_points'] > 1000
    # Only adjacent accepted timestamps count, not the first-to-last gap.
    actual_pairs = 0
    for i in range(1, len(rec.t)):
        previous, current = script.at(rec.t[i-1]), script.at(rec.t[i])
        if (previous and current and previous.index == current.index and current.step.kind == cal.VALIDATE
                and previous.sampling and current.sampling and rec.features[i-1] and rec.features[i]
                and 0 < rec.t[i] - rec.t[i-1] <= .1
                and max(model.profile.gaze_closure(rec.features[i-1])) <= .35
                and max(model.profile.gaze_closure(rec.features[i])) <= .35):
            actual_pairs += 1
    assert metrics['temporal']['consecutive_jump']['samples'] == actual_pairs


def test_distribution_median_and_p95():
    metrics = bench._distribution([0, 10, 20, 100])
    assert metrics['median_points'] == 15
    assert metrics['p95_points'] == pytest.approx(88)
    assert bench._distribution([])['p95_points'] is None


def test_paired_different_backends_use_own_features_on_shared_frames(scene):
    from dataclasses import replace
    rec, script, geometry, model = scene
    own = replace(rec, features=[replace(f, appearance=np.array([.1])) for f in rec.features],
                  feature_backend={'name': 'other', 'feature_count': 1, 'fingerprint': 'v1'})
    # Equivalent predictions with a different feature schema and dropout mask.
    alternative = cal.Calibration(SimpleNamespace(n_features=17, predict=lambda v: model.model.predict(v[:16])),
                                  model.profile, {**model.meta, 'feature_backend': own.feature_backend}, None)
    row = next(i for i, cue in cal._label(own, script, 0) if cue.step.kind == cal.VALIDATE)
    own.features[row] = replace(own.features[row], appearance=None)
    report = bench.evaluate_models(rec, script, geometry, 'test', {'a': model, 'b': alternative}, latency=0,
                                   per_model_recordings={'b': own})
    assert report['common_mask_models'] == ['a', 'b']
    assert report['models']['b']['rejected_reasons'] == {'missing_features': 1}
    assert report['common_mask']['a']['frame'] == report['common_mask']['b']['frame']
    assert report['models']['a']['accepted_frames']['coverage'] > report['models']['b']['accepted_frames']['coverage']


@pytest.mark.parametrize('field', ['t', 'clock', 'features'])
def test_paired_recordings_require_exact_alignment(scene, field):
    rec, script, geometry, model = scene
    own = deepcopy(rec)
    if field == 't':
        own.t[0] += .0001
    elif field == 'clock':
        own.clock[0] = (99, 0)
    else:
        own.features.pop()
    with pytest.raises(ValueError, match='differ from shared frames'):
        bench.evaluate_models(rec, script, geometry, 'test', {'a': model}, per_model_recordings={'a': own})
