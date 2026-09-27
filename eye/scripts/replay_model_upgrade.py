"""Read-only upgrade comparison on a recorded session's frozen validation frames.

Candidate/alpha selection uses training groups only. This retrospective report
must not be used to repeatedly tune hyperparameters on the validation targets.
An optional candidate path saves a separate model; the active model is protected.
"""
import argparse
import json
from pathlib import Path

import numpy as np

from eye import calibration as cal, paths
from eye.features import gaze_vector
from eye.screen import Display
from eye.validation_recovery import evaluate


def replay(session: Path, baseline_path: Path, candidate_path: Path | None = None):
    if candidate_path is not None and candidate_path.resolve() in {paths.calibration_file().resolve(), baseline_path.resolve(), session.resolve()}:
        raise ValueError("candidate output must not overwrite the active calibration, baseline, or recording")
    rec, script, geometry, camera = cal.load_session(session)
    display = Display(0, geometry['name'], 0, 0, geometry['w'], geometry['h'], 1, True, tuple(geometry['mm']))
    baseline = cal.load(baseline_path)
    if baseline is None:
        raise ValueError("baseline calibration does not exist")
    result = cal.fit(rec, script, display)
    evaluate(result, rec, script, display)
    rows = [(rec.features[i], cue) for i, cue in cal._label(rec, script, .05)
            if cue.step.kind == cal.VALIDATE and len(gaze_vector(rec.features[i])) == result.model.n_features
            and np.isfinite(gaze_vector(rec.features[i])).all()]
    x = np.array([gaze_vector(feature) for feature, cue in rows])
    y = np.array([[cue.x, cue.y] for feature, cue in rows])
    new_mask = np.array([max(result.profile.gaze_closure(feature)) <= .35 for feature, cue in rows])
    # Reproduce the previous calibration report's target-dependent legacy gate.
    old_mask = np.array([max(baseline.profile.closure(feature, cue.y)) <= .35 for feature, cue in rows])
    conditions = np.array([cue.step.what or 'neutral' for feature, cue in rows])
    errors = {name: np.linalg.norm((model.predict(x) - y) * [display.w, display.h], axis=1)
              for name, model in [('baseline', baseline.model), ('candidate', result.model)]}

    def summarize(mask):
        return {'samples': int(mask.sum()), **{name: {
            'mean_points': float(values[mask].mean()), 'median_points': float(np.median(values[mask])),
            'p90_points': float(np.percentile(values[mask], 90)), 'worst_points': float(values[mask].max()),
        } for name, values in errors.items()}} if mask.any() else {'samples': 0}

    masks = {'both_gates': new_mask & old_mask, 'newly_accepted': new_mask & ~old_mask, 'new_gate': new_mask}
    report = {'session': str(session), 'baseline': str(baseline_path), 'stats': result.stats,
              'limitations': 'one-session retrospective comparison; no fresh prospective or human-labelled blink validation',
              'comparisons': {name: summarize(mask) for name, mask in masks.items()},
              'conditions_on_new_gate': {str(condition): summarize(new_mask & (conditions == condition))
                                         for condition in np.unique(conditions)}}
    if candidate_path is not None:
        cal.save(result, display, camera, candidate_path)
        report['candidate'] = str(candidate_path)
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('session', type=Path)
    parser.add_argument('--baseline', type=Path, required=True)
    parser.add_argument('--candidate', type=Path)
    args = parser.parse_args()
    print(json.dumps(replay(args.session, args.baseline, args.candidate), indent=2, allow_nan=False))
