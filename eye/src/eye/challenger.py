"""Fit an isolated personal ray + landmark challenger from identical-frame replay.

Pass --baseline incumbent.npz for paired common-mask comparison against the
original recording features. The supplied baseline is never fitted or changed.
This never activates a model. Validation rows are removed before fitting and
restored only for scoring. Requires a fresh, nonexistent experiment directory.
"""
from __future__ import annotations

import argparse
from dataclasses import replace
import hashlib
import json
from pathlib import Path

import numpy as np

from . import calibration as cal
from .benchmark import evaluate_models
from .capture_replay import CaptureReplay, CaptureIntegrityError
from .screen import Display
from .validation_recovery import evaluate


def _sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def ray_recording(replay, ray_path):
    """Preserve the base features and all timestamps; append origin(m) + unit ray."""
    try:
        ray_bytes = Path(ray_path).read_bytes()
        rows = [json.loads(line) for line in ray_bytes.decode().splitlines() if line.strip()]
    except (OSError, ValueError) as exc:
        raise CaptureIntegrityError(f'invalid ray file: {exc}') from exc
    if len(rows) != len(replay.rows):
        raise CaptureIntegrityError('ray row count differs from capture')
    fingerprints, cameras, features = set(), set(), []
    valid_count = usable_count = 0
    for index, (row, captured, feature) in enumerate(zip(rows, replay.rows, replay.recording.features)):
        if not isinstance(row, dict) or (row.get('index'), row.get('seq'), row.get('t')) != (index, captured['seq'], captured['t']):
            raise CaptureIntegrityError(f'ray row {index} is not aligned with capture')
        for key, values in [('fingerprint', fingerprints), ('camera_fingerprint', cameras)]:
            value = row.get(key)
            if not isinstance(value, str) or not value:
                raise CaptureIntegrityError(f'ray row {index} lacks {key}')
            values.add(value)
        if type(row.get('valid')) is not bool:
            raise CaptureIntegrityError(f'ray row {index} lacks boolean validity')
        vector = None
        if row['valid']:
            if captured.get('dropped'):
                raise CaptureIntegrityError(f'ray row {index} claims inference on a dropped image')
            try:
                origin = np.asarray(row['origin_camera_mm'], dtype=float)
                direction = np.asarray(row['direction_camera'], dtype=float)
            except (KeyError, ValueError, TypeError) as exc:
                raise CaptureIntegrityError(f'ray row {index} has invalid geometry') from exc
            if (origin.shape != (3,) or direction.shape != (3,) or
                    not np.isfinite(origin).all() or not np.isfinite(direction).all() or
                    not np.isclose(np.linalg.norm(direction), 1., rtol=0, atol=1e-5)):
                raise CaptureIntegrityError(f'ray row {index} requires finite origin and unit direction')
            vector = np.concatenate([origin / 1000., direction])
            valid_count += 1
            usable_count += feature is not None
        elif not isinstance(row.get('reason'), str) or not row['reason']:
            raise CaptureIntegrityError(f'invalid ray row {index} lacks failure reason')
        features.append(None if feature is None else replace(feature, appearance=vector))
    if len(fingerprints) != 1 or len(cameras) != 1:
        raise CaptureIntegrityError('ray file mixes model or camera fingerprints, or is empty')
    backend = {'name': 'unigaze-ray-landmarks', 'feature_count': 6,
               'fingerprint': next(iter(fingerprints)), 'camera_fingerprint': next(iter(cameras)),
               'encoding': 'origin-metres-plus-camera-unit-direction-v1'}
    return replace(replay.recording, features=features, feature_backend=backend), {
        'rows': len(rows), 'sha256': hashlib.sha256(ray_bytes).hexdigest(),
        'valid_rays': valid_count, 'usable_with_landmarks': usable_count,
        'invalid_reasons': {reason: sum(r.get('reason') == reason for r in rows if not r['valid'])
                            for reason in sorted({r['reason'] for r in rows if not r['valid']})}}


def training_recording(rec, script, latency):
    """Hide all validation features even from preprocessing/profile selection."""
    heldout = np.zeros(len(rec.t), dtype=bool)
    for timing in (0., latency):
        for index, t in enumerate(rec.script_times(timing)):
            cue = script.at(t) if t >= 0 else None
            if cue and cue.step.kind == cal.VALIDATE:
                heldout[index] = True
    return replace(rec, features=[None if heldout[i] else f for i, f in enumerate(rec.features)])


def build(capture_dir, ray_path, output_directory, *, session_path=None, latency=.05, baseline_path=None):
    if not np.isfinite(latency) or latency < 0:
        raise ValueError('latency must be finite and nonnegative')
    output = Path(output_directory).resolve()
    if output.exists():
        raise FileExistsError('experiment output directory must not exist')
    replay = CaptureReplay(capture_dir, session_path=session_path)
    rec, ray_stats = ray_recording(replay, ray_path)
    geometry = replay.geometry
    display = Display(0, geometry['name'], 0, 0, geometry['w'], geometry['h'], 1., True, tuple(geometry['mm']))
    # Fit gets no validation features. No validation score chooses hyperparameters.
    result = cal.fit(training_recording(rec, replay.script, latency), replay.script, display, latency=latency)
    evaluate(result, rec, replay.script, display, latency=latency)
    provenance = {'source_session': str(replay.session_path), 'source_session_sha256': _sha(replay.session_path),
                  'capture_manifest_sha256': _sha(Path(capture_dir) / 'manifest.json'),
                  'capture_ledger_sha256': _sha(Path(capture_dir) / 'frames.jsonl'),
                  'rays': str(Path(ray_path).resolve()), 'rays_sha256': ray_stats['sha256'],
                  'training_relationship': 'same-recording training partition; validation hidden before fit',
                  'feature_backend': rec.feature_backend}
    result.stats['challenger_provenance'] = provenance
    frozen = cal.Calibration(result.model, result.profile,
                             {'display': geometry, 'camera': replay.camera, 'feature_backend': rec.feature_backend}, result.train)
    models = {'challenger': frozen}
    recordings = {'challenger': rec}
    if baseline_path is not None:
        baseline = cal.load(Path(baseline_path))
        if baseline is None:
            raise ValueError('baseline calibration does not exist')
        models['baseline'] = baseline
        recordings['baseline'] = replay.recording
        provenance['baseline'] = {'path': str(Path(baseline_path).resolve()), 'sha256': _sha(baseline_path),
                                  'training_relationship': 'unknown; frozen supplied model, never fitted here'}
    score = evaluate_models(rec, replay.script, geometry, replay.camera, models, latency,
                            per_model_recordings=recordings)
    report = {'provenance': provenance, 'capture': replay.report, 'rays': ray_stats,
              'validation': score, 'fit_stats': result.stats,
              'limitations': ['retrospective same-session validation; no prospective accuracy claim',
                              'model remains an offline challenger and is not activated',
                              'ray regression is personalized screen mapping, not measured ray-screen intersection',
                              'freeze this experiment before comparing against an independent session']}
    # Exclusive experiment directory prevents any overwrite, including active model.
    if _sha(ray_path) != ray_stats['sha256']:
        raise CaptureIntegrityError('ray file changed during challenger fitting')
    output.mkdir(parents=True, exist_ok=False)
    with np.load(replay.session_path, allow_pickle=False) as archive:
        blend_names = json.loads(str(archive['blend_names']))
    archive_path = cal.save_session(rec, replay.script, display, replay.camera, blend_names, path=output / 'session.npz')
    model_path = cal.save(result, display, replay.camera, path=output / 'candidate.npz')
    report['artifacts'] = {'session': str(archive_path), 'model': str(model_path),
                           'session_sha256': _sha(archive_path), 'model_sha256': _sha(model_path)}
    (output / 'report.json').write_text(json.dumps(report, indent=2, allow_nan=False))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--capture', type=Path, required=True)
    parser.add_argument('--rays', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True, help='new experiment directory')
    parser.add_argument('--session', type=Path)
    parser.add_argument('--baseline', type=Path, help='frozen incumbent calibration for identical-frame paired comparison')
    parser.add_argument('--latency', type=float, default=.05)
    args = parser.parse_args()
    print(json.dumps(build(args.capture, args.rays, args.output, session_path=args.session,
                           latency=args.latency, baseline_path=args.baseline), indent=2, allow_nan=False))


if __name__ == '__main__':
    main()
