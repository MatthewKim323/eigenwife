"""Bounded validation recovery; retries never change the fitted model.

Coverage decides whether to repeat a target. Prediction error never does. All
attempts, including failed ones, remain in the reported accuracy and coverage.
"""

from dataclasses import replace
import math

import numpy as np

from . import calibration as cal
from .features import gaze_vector

MAX_RETRIES = 2
MIN_SAMPLES = 5
MIN_COVERAGE = 0.8


def _target(step):
    return step.x, step.y, step.what or "neutral"


def evaluate(result, rec, script, display, latency=0.05, distance_cm=55.0):
    """Update only validation metrics using the frozen model and eye profile.

    Every recorded sampling-window frame is counted, including missing faces,
    closed eyes and nonfinite features. No feature or prediction outliers are
    removed. Repeated coordinates in different pose conditions stay separate.
    """
    attempts = {}
    for index, step in enumerate(script.steps):
        if step.kind == cal.VALIDATE:
            attempts[index] = dict(step=index, x=step.x, y=step.y,
                                   condition=step.what or "neutral", n=0,
                                   expected_samples=0, rejected_reasons={}, errors=[], predictions=[])
    for t, feature in zip(rec.script_times(latency), rec.features):
        cue = script.at(t) if t >= 0 else None
        if cue is None or not cue.sampling or cue.step.kind != cal.VALIDATE:
            continue
        attempt = attempts[cue.index]
        attempt["expected_samples"] += 1
        reason = None
        if feature is None:
            reason = "no_face"
        elif len(gaze_vector(feature)) < result.model.n_features:
            reason = "appearance_features_unavailable"
        elif not np.isfinite(gaze_vector(feature)).all():
            reason = "nonfinite_features"
        elif max(result.profile.gaze_closure(feature)) > 0.35:
            reason = "eyes_closed"
        else:
            prediction = result.model.predict(gaze_vector(feature))[0]
            if not np.isfinite(prediction).all():
                reason = "nonfinite_prediction"
            else:
                attempt["n"] += 1
                attempt["predictions"].append(prediction)
                attempt["errors"].append(float(np.linalg.norm(
                    (prediction - [cue.x, cue.y]) * [display.w, display.h])))
        if reason:
            reasons = attempt["rejected_reasons"]
            reasons[reason] = reasons.get(reason, 0) + 1

    validation, all_errors, conditions, latest = [], [], {}, {}
    for index, attempt in attempts.items():
        errors = attempt.pop("errors")
        predictions = attempt.pop("predictions")
        expected = attempt["expected_samples"]
        attempt["coverage"] = attempt["n"] / expected if expected else 0.0
        attempt["usable"] = attempt["coverage"] >= MIN_COVERAGE and attempt["n"] >= MIN_SAMPLES
        latest[_target(script.steps[index])] = attempt
        if errors:
            prediction = np.median(predictions, axis=0)
            attempt.update(px=float(prediction[0]), py=float(prediction[1]),
                           mean_points=float(np.mean(errors)),
                           p90_points=float(np.percentile(errors, 90)),
                           worst_points=max(errors))
            validation.append(attempt)
            all_errors.extend(errors)
            conditions.setdefault(attempt["condition"], []).extend(errors)

    stats = result.stats
    stats["quality_filter_version"] = "observable-open-eye-v1" if result.profile.gaze_quality_coeffs else "legacy-label-free"
    # Clear old summaries if a caller reevaluates a recording with no usable frames.
    for key in list(stats):
        if key.startswith("validation_"):
            del stats[key]
    expected = sum(a["expected_samples"] for a in attempts.values())
    rejected_reasons = {}
    for attempt in attempts.values():
        for reason, count in attempt["rejected_reasons"].items():
            rejected_reasons[reason] = rejected_reasons.get(reason, 0) + count
    stats.update(
        validation_samples=len(all_errors), validation_expected_samples=expected,
        validation_coverage=len(all_errors) / expected if expected else 0.0,
        validation_targets=sum(a["n"] > 0 for a in latest.values()),
        validation_expected_targets=len(latest),
        validation_complete=bool(latest and all(a["usable"] for a in latest.values())),
        validation_attempts=list(attempts.values()),
        validation_retry_count=len(attempts) - len(latest),
        validation_rejected_samples=expected - len(all_errors),
        validation_rejected_reasons=rejected_reasons,
        validation_completed_targets=sum(a["usable"] for a in latest.values()),
    )
    if all_errors:
        target_errors = [math.hypot((v["px"] - v["x"]) * display.w,
                                    (v["py"] - v["y"]) * display.h) for v in validation]
        stats.update(validation_points=float(np.mean(target_errors)),
                     validation_worst=max(target_errors),
                     validation_deg=display.degrees(float(np.mean(target_errors)), distance_cm),
                     validation_frame_mean_points=float(np.mean(all_errors)),
                     validation_frame_p90_points=float(np.percentile(all_errors, 90)),
                     validation_frame_worst_points=max(all_errors),
                     validation_frame_mean_deg=display.degrees(float(np.mean(all_errors)), distance_cm),
                     validation_conditions={condition: dict(samples=len(errors),
                         mean_points=float(np.mean(errors)), p90_points=float(np.percentile(errors, 90)),
                         worst_points=max(errors)) for condition, errors in conditions.items()})
    result.validation = validation


def append_retries(script, stats, max_retries=MAX_RETRIES):
    """Append only coverage failures, at most max_retries per target.

    Retry windows are at least 1.8 seconds so a normal blink is a small fraction
    of a trial. Initial attempts and their frames stay in the script/recording.
    Returns how many targets were added; the caller resumes at the old duration.
    """
    by_target = {}
    for attempt in stats.get("validation_attempts", []):
        step = script.steps[attempt["step"]]
        by_target.setdefault(_target(step), []).append(attempt)
    added = 0
    previous = (script.steps[-1].x, script.steps[-1].y)
    for attempts in by_target.values():
        last = attempts[-1]
        if last["usable"] or len(attempts) > max_retries:
            continue
        step = script.steps[last["step"]]
        sample_to = max(step.sample_to, step.sample_from + 1.8)
        script.steps.append(replace(step, from_x=previous[0], from_y=previous[1],
                                    duration=sample_to + 0.15, sample_to=sample_to,
                                    text=f"retry {len(attempts)}/{max_retries}: " + script.steps[attempts[0]["step"]].text))
        previous = (step.x, step.y)
        added += 1
    return added
