import numpy as np

from eye import calibration as cal
from eye import validation_recovery as recovery
from test_calibration import DISPLAY, synthetic_recording


def _setup():
    script = cal.build_script(quick=True, expressions=False)
    rec = synthetic_recording(script)
    result = cal.fit(rec, script, DISPLAY, latency=0)
    return script, rec, result


def _lose_target(rec, script, index):
    for i, t in enumerate(rec.t):
        cue = script.at(t)
        if cue.index == index and cue.sampling:
            rec.features[i] = None


def test_blink_retries_only_failed_target_and_preserves_original_errors():
    script, rec, result = _setup()
    index = next(i for i, step in enumerate(script.steps) if step.kind == cal.VALIDATE)
    rows = [(i, cue) for i, cue in cal._label(rec, script, 0) if cue.index == index]
    # A normal blink consuming 10 of 26 frames used to invalidate a full run.
    for i, _ in rows[:10]:
        rec.features[i].left.ear = rec.features[i].right.ear = 0.02
        rec.features[i].bs_blink = (0.9, 0.9)
    # Keep an extreme error: coverage recovery must not cherry-pick accuracy.
    rec.features[rows[-1][0]].left.u += 5
    recovery.evaluate(result, rec, script, DISPLAY, latency=0)
    before = result.stats.copy()
    assert not before["validation_complete"]
    assert before["validation_rejected_reasons"] == {"eyes_closed": 10}
    coef = result.model.coef.copy()
    old_duration = script.duration
    assert recovery.append_retries(script, result.stats) == 1
    assert script.steps[-1].sample_to - script.steps[-1].sample_from >= 1.8 - 1e-9
    fresh = synthetic_recording(script)
    for i, t in enumerate(fresh.t):
        if t >= old_duration:
            rec.add(t, fresh.features[i], None)
            rec.clock.append((t, t))
    recovery.evaluate(result, rec, script, DISPLAY, latency=0)
    assert result.stats["validation_complete"]
    assert result.stats["validation_expected_targets"] == 9
    assert result.stats["validation_retry_count"] == 1
    assert result.stats["validation_rejected_reasons"] == {"eyes_closed": 10}
    assert result.stats["validation_expected_samples"] > before["validation_expected_samples"]
    assert result.stats["validation_frame_worst_points"] == before["validation_frame_worst_points"]
    assert np.array_equal(result.model.coef, coef)
    assert recovery.append_retries(script, result.stats) == 0


def test_missing_targets_retry_at_most_twice_and_stay_incomplete():
    script, rec, result = _setup()
    first = next(i for i, step in enumerate(script.steps) if step.kind == cal.VALIDATE)
    original_targets = sum(s.kind == cal.VALIDATE for s in script.steps)
    for expected_additions in (1, 1, 0):
        # All attempts at the selected target miss the face entirely.
        rec = synthetic_recording(script)
        for index, step in enumerate(script.steps):
            if step.kind == cal.VALIDATE and (step.x, step.y) == (script.steps[first].x, script.steps[first].y):
                _lose_target(rec, script, index)
        recovery.evaluate(result, rec, script, DISPLAY, latency=0)
        assert not result.stats["validation_complete"]
        assert recovery.append_retries(script, result.stats) == expected_additions
    assert result.stats["validation_expected_targets"] == original_targets
    assert result.stats["validation_retry_count"] == 2
    assert result.stats["validation_rejected_reasons"]["no_face"] > 100


def test_poor_predictions_alone_never_trigger_retries():
    script, rec, result = _setup()
    for t, f in zip(rec.t, rec.features):
        if script.at(t).step.kind == cal.VALIDATE:
            f.left.u += 10
    recovery.evaluate(result, rec, script, DISPLAY, latency=0)
    assert result.stats["validation_complete"]
    assert result.stats["validation_frame_mean_points"] > 1000
    assert recovery.append_retries(script, result.stats) == 0


def test_conditions_at_same_coordinate_remain_distinct_and_missing_frames_count():
    script, rec, result = _setup()
    script.steps.append(cal.Step(cal.VALIDATE, 2, x=0.5, y=0.5,
                                 sample_from=0.5, sample_to=2, what="motion"))
    rec = synthetic_recording(script)
    _lose_target(rec, script, len(script.steps) - 1)
    recovery.evaluate(result, rec, script, DISPLAY, latency=0)
    assert result.stats["validation_expected_targets"] == 10
    assert result.stats["validation_targets"] == 9
    assert recovery.append_retries(script, result.stats) == 1
    assert script.steps[-1].what == "motion"
