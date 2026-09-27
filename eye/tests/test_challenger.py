import json
from types import SimpleNamespace

import numpy as np
import pytest

from eye import calibration as cal
from eye import challenger
from eye.capture_replay import CaptureIntegrityError
from test_calibration import synthetic_recording, DISPLAY


@pytest.fixture
def rays(tmp_path):
    script = cal.build_script(quick=True, expressions=False)
    rec = synthetic_recording(script)
    frames = [dict(seq=i*2, t=t) for i, t in enumerate(rec.t)]
    rows = [dict(index=i, seq=r['seq'], t=r['t'], valid=True, fingerprint='pinned-model',
                 camera_fingerprint='measured-camera', origin_camera_mm=[0, 0, 500], direction_camera=[0, 0, -1])
            for i, r in enumerate(frames)]
    path = tmp_path / 'rays.jsonl'
    def write():
        path.write_text(''.join(json.dumps(r) + '\n' for r in rows))
    write()
    return SimpleNamespace(recording=rec, rows=frames), script, rows, path, write


def test_ray_encoding_preserves_base_features_and_original(rays):
    replay, _, rows, path, write = rays
    rows[1].update(valid=False, reason='no_landmarks')
    replay.recording.features[2] = None
    write()
    rec, stats = challenger.ray_recording(replay, path)
    np.testing.assert_array_equal(rec.features[0].appearance, [0, 0, .5, 0, 0, -1])
    assert rec.features[0].left == replay.recording.features[0].left
    assert replay.recording.features[0].appearance is None
    assert rec.features[1].appearance is None and rec.features[2] is None
    assert rec.feature_backend['feature_count'] == 6
    assert stats['valid_rays'] == len(rows) - 1
    assert stats['usable_with_landmarks'] == len(rows) - 2


@pytest.mark.parametrize('change,match', [
    (lambda rows: rows.pop(), 'row count'),
    (lambda rows: rows[0].update(seq=100), 'aligned'),
    (lambda rows: rows[0].update(t=99), 'aligned'),
    (lambda rows: rows[0].update(direction_camera=[0, 0, 2]), 'unit direction'),
    (lambda rows: rows[0].update(origin_camera_mm=[float('nan'), 0, 0]), 'finite origin'),
    (lambda rows: rows[0].update(fingerprint='different'), 'mixes'),
    (lambda rows: rows[0].update(camera_fingerprint='different'), 'mixes'),
    (lambda rows: rows[0].update(valid=False), 'failure reason'),
    (lambda rows: rows[0].update(valid=1), 'boolean'),
])
def test_bad_ray_contract_rejected(rays, change, match):
    replay, _, rows, path, write = rays
    change(rows)
    write()
    with pytest.raises(CaptureIntegrityError, match=match):
        challenger.ray_recording(replay, path)


def test_cannot_infer_on_missing_image(rays):
    replay, _, _, path, _ = rays
    replay.rows[0]['dropped'] = 'queue_full'
    with pytest.raises(CaptureIntegrityError, match='dropped image'):
        challenger.ray_recording(replay, path)


def test_validation_hidden_from_fit_and_hyperparameters(rays):
    replay, script, _, path, _ = rays
    rec, _ = challenger.ray_recording(replay, path)
    train = challenger.training_recording(rec, script, 0)
    for i, t in enumerate(rec.script_times(0)):
        cue = script.at(t) if t >= 0 else None
        if cue and cue.step.kind == cal.VALIDATE:
            assert train.features[i] is None
            assert rec.features[i] is not None
    first = cal.fit(train, script, DISPLAY, latency=0)
    for i, f in enumerate(rec.features):
        if train.features[i] is None and f:
            f.left.u += 100
            f.appearance += 100
    second = cal.fit(challenger.training_recording(rec, script, 0), script, DISPLAY, latency=0)
    np.testing.assert_array_equal(first.model.coef, second.model.coef)
    assert first.stats['alpha'] == second.stats['alpha']


def test_existing_output_never_overwritten(tmp_path):
    with pytest.raises(FileExistsError):
        challenger.build('irrelevant', 'irrelevant', tmp_path)


def test_candidate_artifacts_are_separate_and_provenance_bound(rays, tmp_path, monkeypatch):
    replay, script, _, ray_path, _ = rays
    capture = tmp_path / 'capture'
    capture.mkdir()
    (capture / 'manifest.json').write_text('{}')
    (capture / 'frames.jsonl').write_text('source ledger')
    source = tmp_path / 'source.npz'
    np.savez(source, blend_names=np.array(json.dumps(['eyeBlinkLeft', 'eyeBlinkRight', 'browInnerUp',
                                                    'jawOpen', 'mouthSmileLeft', 'mouthSmileRight'])))
    before = source.read_bytes()
    replay.session_path = source
    replay.script = script
    replay.geometry = {'name': DISPLAY.name, 'w': DISPLAY.w, 'h': DISPLAY.h, 'mm': DISPLAY.mm}
    replay.camera = 'test'
    replay.report = {'integrity': 'verified'}
    monkeypatch.setattr(challenger, 'CaptureReplay', lambda *a, **k: replay)
    output = tmp_path / 'experiment'
    baseline_path = tmp_path / 'incumbent.npz'
    baseline = cal.fit(replay.recording, script, DISPLAY, latency=0)
    cal.save(baseline, DISPLAY, 'test', path=baseline_path)
    baseline_bytes = baseline_path.read_bytes()
    report = challenger.build(capture, ray_path, output, latency=0, baseline_path=baseline_path)
    assert baseline_path.read_bytes() == baseline_bytes
    assert report['validation']['common_mask_models'] == ['challenger', 'baseline']
    assert set(report['validation']['common_mask']) == {'challenger', 'baseline'}
    assert source.read_bytes() == before
    assert set(p.name for p in output.iterdir()) == {'candidate.npz', 'session.npz', 'report.json'}
    saved = cal.load(output / 'candidate.npz')
    assert saved.model.n_features == 22
    assert saved.meta['stats']['challenger_provenance']['rays_sha256'] == challenger._sha(ray_path)
    assert report['validation']['models']['challenger']['compatible']
    with np.load(output / 'session.npz', allow_pickle=False) as archive:
        assert archive['appearance'].shape == (len(replay.rows), 6)
    json.dumps(report, allow_nan=False)
