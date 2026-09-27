"""Read-only, frozen-model benchmark; never fits, selects, or saves a model.

Run ``python -m eye.benchmark SESSION ... --model NAME=CALIBRATION``.
All models see the same validation windows; no error-based trimming occurs.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path

import numpy as np

from . import calibration as cal
from .features import GAZE_FEATURES, gaze_vector


def _digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _distribution(values):
    values = np.asarray(values, dtype=float)
    return dict(samples=len(values), mean_points=float(values.mean()) if len(values) else None,
                median_points=float(np.median(values)) if len(values) else None,
                p90_points=float(np.percentile(values, 90)) if len(values) else None,
                p95_points=float(np.percentile(values, 95)) if len(values) else None,
                worst_points=float(values.max()) if len(values) else None)


def compatibility(model, rec, geometry, camera):
    """Return explicit incompatibilities; older landmark archives remain valid."""
    issues = []
    display = model.meta.get('display', {})
    for key in ('w', 'h'):
        if display.get(key) != geometry.get(key):
            issues.append(f'display_{key}_mismatch')
    if model.meta.get('camera') != camera:
        issues.append('camera_mismatch')
    backend = model.meta.get('feature_backend', {'name': 'landmarks'})
    if backend.get('name') == 'landmarks':
        if not 0 < model.model.n_features <= len(GAZE_FEATURES):
            issues.append('landmark_dimension_mismatch')
    elif backend != rec.feature_backend or model.model.n_features != len(GAZE_FEATURES) + backend.get('feature_count', 0):
        issues.append('feature_schema_mismatch')
    return issues


def evaluate_models(rec, script, geometry, camera, models, latency=0.05, *, per_model_recordings=None):
    """Evaluate model-name -> Calibration on every recorded validation frame.

    Optional per-model recordings may differ in feature schema but must share
    exact timestamps, clocks, and frame counts. Targets come from one script.
    Coverage denominators include missing faces/features and all retry attempts.
    Temporal metrics use consecutive accepted frames within the same attempt;
    gaps >100ms never masquerade as ordinary sample-to-sample jitter.
    """
    recordings = per_model_recordings or {}
    if set(recordings) - set(models):
        raise ValueError('per-model recording names must match supplied models')
    for name, own in [('shared', rec), *recordings.items()]:
        if len(own.features) != len(rec.t) or not np.array_equal(own.t, rec.t) or not np.array_equal(own.clock, rec.clock):
            raise ValueError(f'{name} recording timestamps, clock, or feature count differ from shared frames')
    if not np.isfinite(latency) or latency < 0:
        raise ValueError('latency must be finite and nonnegative')
    scale = np.array([geometry['w'], geometry['h']], dtype=float)
    if not np.isfinite(scale).all() or (scale <= 0).any():
        raise ValueError('display dimensions must be finite and positive')
    targets = sorted({(s.x, s.y, s.what or 'neutral') for s in script.steps if s.kind == cal.VALIDATE})
    rows = []
    for i, t in enumerate(rec.script_times(latency)):
        cue = script.at(t) if t >= 0 else None
        if cue and cue.sampling and cue.step.kind == cal.VALIDATE:
            rows.append((i, cue.index, (cue.x, cue.y, cue.step.what or 'neutral')))
    ids = np.array([i for i, _, _ in rows], dtype=int)
    times = np.asarray(rec.t)[ids]
    predictions, masks, model_reports = {}, {}, {}
    for name, model in models.items():
        own = recordings.get(name, rec)
        issues = compatibility(model, own, geometry, camera)
        if issues:
            model_reports[name] = {'compatible': False, 'issues': issues}
            continue
        prediction = np.full((len(rows), 2), np.nan)
        reasons = Counter()
        for j, (i, _, _) in enumerate(rows):
            feature = own.features[i]
            if feature is None:
                reasons['no_face'] += 1
                continue
            vector = gaze_vector(feature)
            if len(vector) < model.model.n_features:
                reasons['missing_features'] += 1
                continue
            vector = vector[:model.model.n_features]
            if not np.isfinite(vector).all():
                reasons['nonfinite_features'] += 1
                continue
            if max(model.profile.gaze_closure(feature)) > .35:
                reasons['eyes_closed'] += 1
                continue
            p = np.asarray(model.model.predict(vector))[0]
            if not np.isfinite(p).all():
                reasons['nonfinite_prediction'] += 1
                continue
            prediction[j] = p
        mask = np.isfinite(prediction).all(axis=1)
        masks[name], predictions[name] = mask, prediction
        model_reports[name] = {'compatible': True, 'rejected_reasons': dict(reasons),
                              'failure_rate': float((~mask).mean()) if len(mask) else None}

    def summary(prediction, mask):
        truth = np.array([[target[0], target[1]] for _, _, target in rows]).reshape(-1, 2)
        errors = np.linalg.norm((prediction - truth) * scale, axis=1)
        per_target = []
        for target in targets:
            member = np.array([row[2] == target for row in rows], dtype=bool)
            accepted = member & mask
            per_target.append(dict(x=target[0], y=target[1], condition=target[2],
                                   expected_samples=int(member.sum()),
                                   coverage=float(accepted.sum() / member.sum()) if member.any() else 0.,
                                   **_distribution(errors[accepted])))
        supported = [v for v in per_target if v['samples']]
        # Each target-condition receives equal weight, regardless of retries/FPS.
        macro = {key: float(np.mean([v[key] for v in supported])) if supported else None
                 for key in ('mean_points', 'median_points', 'p90_points', 'p95_points', 'worst_points')}
        jumps, speeds, residuals, outages = [], [], [], []
        for attempt in sorted({r[1] for r in rows}):
            indices = np.array([j for j, r in enumerate(rows) if r[1] == attempt])
            good = indices[mask[indices]]
            if len(good):
                centered = (prediction[good] - np.median(prediction[good], axis=0)) * scale
                residuals.extend(np.linalg.norm(centered, axis=1))
            outage_start = None
            for pos, j in enumerate(indices):
                if not mask[j] and outage_start is None:
                    outage_start = times[j]
                if mask[j] and outage_start is not None:
                    outages.append(times[j] - outage_start)
                    outage_start = None
                if pos:
                    prev = indices[pos - 1]
                    dt = times[j] - times[prev]
                    if mask[j] and mask[prev] and 0 < dt <= .1:
                        jump = float(np.linalg.norm((prediction[j] - prediction[prev]) * scale))
                        jumps.append(jump)
                        speeds.append(jump / dt)
            if outage_start is not None:
                outages.append(times[indices[-1]] - outage_start)
        conditions = {}
        for condition in sorted({t[2] for t in targets}):
            member = np.array([r[2][2] == condition for r in rows], dtype=bool)
            accepted = member & mask
            conditions[condition] = dict(expected_samples=int(member.sum()),
                                         coverage=float(accepted.sum() / member.sum()) if member.any() else 0.,
                                         **_distribution(errors[accepted]))
        return dict(expected_samples=len(rows), coverage=float(mask.mean()) if len(mask) else 0.,
                    frame=_distribution(errors[mask]), targets=per_target,
                    macro_target=macro, targets_with_samples=len(supported), expected_targets=len(targets),
                    conditions=conditions,
                    temporal=dict(consecutive_jump=_distribution(jumps),
                                  median_speed_points_per_second=float(np.median(speeds)) if speeds else None,
                                  within_attempt_dispersion=_distribution(residuals),
                                  dropout_runs=len(outages), longest_observed_dropout_seconds=max(outages, default=0.)))
    for name, mask in masks.items():
        model_reports[name]['accepted_frames'] = summary(predictions[name], mask)
    common = np.logical_and.reduce(list(masks.values())) if masks else np.zeros(len(rows), dtype=bool)
    return {'models': model_reports, 'common_mask_models': list(masks),
            'common_mask': {name: summary(p, common) for name, p in predictions.items()},
            'notes': ['accuracy excludes rejected frames; coverage and failure rates must be read alongside it',
                      'macro metrics average supported target-condition metrics; missing targets remain listed',
                      'temporal dispersion includes real eye/head motion; it is not sensor noise or end-to-end latency',
                      'coverage counts captured frames, not unrecorded camera stalls; dropout durations are lower bounds',
                      'offline quality gate only; live pose and DOM gating are not simulated']}


def benchmark(session_paths, model_paths, training_sessions=None, latency=.05):
    """training_sessions maps model names to known training archives, if available.

    Provenance is caller-declared and content hashes catch renamed duplicates.
    Separate sessions are reported separately; no misleading pooled average.
    """
    if not model_paths:
        raise ValueError('at least one model is required')
    models, provenance = {}, {}
    for name, path in model_paths.items():
        model = cal.load(Path(path))
        if model is None:
            raise ValueError(f'model does not exist: {path}')
        models[name] = model
        training = (training_sessions or {}).get(name)
        provenance[name] = {'path': str(Path(path).resolve()), 'sha256': _digest(path),
                            'declared_training_hashes': None if training is None else [_digest(p) for p in training]}
    reports = []
    for path in session_paths:
        rec, script, geometry, camera = cal.load_session(Path(path))
        digest = _digest(path)
        report = evaluate_models(rec, script, geometry, camera, models, latency)
        report.update(session=str(Path(path).resolve()), sha256=digest, display=geometry, camera=camera,
                      relationship={name: ('unknown' if info['declared_training_hashes'] is None else
                                    'same_recording' if digest in info['declared_training_hashes'] else
                                    'independent_recording_by_declared_provenance') for name, info in provenance.items()})
        reports.append(report)
    return {'schema_version': 1, 'method': 'frozen models; all validation attempts; no fitting or model selection',
            'latency_seconds': latency, 'models': provenance, 'sessions': reports,
            'limitation': 'retrospective benchmark; do not select models repeatedly on these validation sessions; reserve a fresh prospective session'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('sessions', nargs='+', type=Path)
    parser.add_argument('--model', action='append', required=True, metavar='NAME=PATH')
    parser.add_argument('--training-session', action='append', default=[], metavar='NAME=PATH')
    parser.add_argument('--latency', type=float, default=.05)
    args = parser.parse_args()
    models, training = {}, {}
    for value in args.model:
        name, sep, path = value.partition('=')
        if not sep or not name or name in models:
            parser.error('--model requires a unique NAME=PATH')
        models[name] = Path(path)
    for value in args.training_session:
        name, sep, path = value.partition('=')
        if not sep or name not in models:
            parser.error('--training-session requires a known model NAME=PATH')
        training.setdefault(name, []).append(Path(path))
    print(json.dumps(benchmark(args.sessions, models, training, args.latency), indent=2, allow_nan=False))


if __name__ == '__main__':
    main()
