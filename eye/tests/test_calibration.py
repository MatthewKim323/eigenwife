import numpy as np

from eye import calibration as cal
from eye.features import Eye, Features
from eye.screen import Display

DISPLAY = Display(1, "test", 0, 0, 1470, 956, 2.0, True, (290.6, 189.0))


def test_script_covers_all_steps_and_roundtrips():
    s = cal.build_script()
    assert {st.kind for st in s.steps} == {cal.FIXATE, cal.PURSUIT, cal.HEAD, cal.EXPRESS, cal.VALIDATE}
    assert {st.what for st in s.steps if st.kind == cal.EXPRESS} == {"both", "left", "right", "brow", "mouth"}
    assert s.at(s.duration + 1) is None
    for t in np.arange(0, s.duration, 0.05):
        c = s.at(t)
        assert 0 <= c.x <= 1 and 0 <= c.y <= 1
    assert cal.Script.from_json(s.to_json()).steps == s.steps


def test_pursuit_speed_is_slow_enough_for_smooth_pursuit():
    """Smooth pursuit breaks down much above ~6 deg/s; 1 deg is ~49 pt here."""
    step = next(s for s in cal.build_script().steps if s.kind == cal.PURSUIT)
    pts = np.array([cal._border_path(t / step.duration) for t in np.arange(0, step.duration, 1 / 60)])
    pts = pts * [DISPLAY.w, DISPLAY.h]
    speeds = np.linalg.norm(np.diff(pts, axis=0), axis=1) * 60 / 49.0  # deg/s at ~55 cm
    assert 3.0 < speeds.mean() < 8.0
    assert speeds.max() < 12.0  # no corner spikes: the path is walked at constant speed
    # and it reaches near the edges
    assert pts[:, 0].min() < 0.1 * DISPLAY.w and pts[:, 0].max() > 0.9 * DISPLAY.w


def test_fixations_sample_only_after_settling():
    s = cal.build_script(quick=True, expressions=False)
    assert s.at(0.0).sampling is False
    assert s.at(s.steps[0].sample_from + 0.01).sampling is True


def _eye(u, v, lid):
    return Eye(u=u, v=v, lid=lid, ear=0.3, width=40.0, iris=(0.0, 0.0))


def synthetic_recording(script, seed=0, swap=False, blink_every=None):
    """Features generated from the cue with a known mapping, incl. head compensation."""
    rng = np.random.default_rng(seed)
    rec = cal.Recording()
    t = 0.0
    while t < script.duration:
        cue = script.at(t)
        yaw = pitch = 0.0
        if cue.step.kind == cal.HEAD or (cue.step.kind == cal.VALIDATE and cue.step.what == "motion"):
            yaw, pitch = 9 * np.sin(cue.tau * 1.3), 5 * np.sin(cue.tau * 0.9)
        gx, gy = cue.x - 0.5, cue.y - 0.5
        # the eyes counter-rotate against the head to stay on the target
        u = 0.12 * gx + 0.004 * yaw + rng.normal(0, 0.004)
        v = -0.09 * gy - 0.004 * pitch + rng.normal(0, 0.004)
        ear = 0.30 - 0.03 * gy  # lids drop when looking down
        bs = 0.10 + 0.06 * gy
        ear_l = ear_r = ear
        bs_l = bs_r = bs
        brow, jaw = 0.04, 0.02
        what = cue.step.what if cue.step.kind == cal.EXPRESS and cue.sampling else None
        if what == "both":
            ear_l = ear_r = 0.05
            bs_l = bs_r = 0.62
        elif what == "left":
            ear_l, bs_l = 0.04, 0.5
            bs_r = 0.3  # blendshapes leak to the other eye
        elif what == "right":
            ear_r, bs_r = 0.04, 0.5
            bs_l = 0.3
        elif what == "brow":
            brow = 0.7
        elif what == "mouth":
            jaw = 0.6
        # a spontaneous blink now and then while following the dots
        if blink_every and cue.step.kind in cal.GAZE_KINDS and (int(t / blink_every) != int((t - 1 / 30) / blink_every)):
            for _ in range(4):  # ~130 ms shut
                rec.add(t, _features(t, u, v, 0.05, 0.05, 0.62, 0.62, brow, jaw, yaw, pitch), None)
                rec.clock.append((t, t))
                t += 1 / 30
            continue
        if swap:
            bs_l, bs_r = bs_r, bs_l
        rec.add(t, _features(t, u, v, ear_l, ear_r, bs_l, bs_r, brow, jaw, yaw, pitch), None)
        rec.clock.append((t, t))
        t += 1 / 30
    return rec


def _features(t, u, v, ear_l, ear_r, bs_l, bs_r, brow, jaw, yaw, pitch):
    left, right = _eye(u, v, 0.35), _eye(u, v, 0.35)
    left.ear, right.ear = ear_l, ear_r
    return Features(
        t=t,
        left=left,
        right=right,
        yaw=yaw,
        pitch=pitch,
        roll=0.0,
        pos=(0.0, 0.0, -55.0),
        bs_blink=(bs_l, bs_r),
        nose=(0.0, 0.0),
        brow=brow,
        jaw=jaw,
        smile=0.0,
    )


def test_end_to_end_fit_on_synthetic_data():
    script = cal.build_script()
    res = cal.fit(synthetic_recording(script), script, DISPLAY, latency=0.0)
    assert res.stats["validation_points"] < 60
    assert res.stats["head_range_deg"][0] > 10  # head motion actually made it into training
    p = res.profile
    assert p.swap is False and p.calibrated
    assert p.wink_l and p.wink_r  # EAR separates the winks cleanly
    assert p.mix == 0.0  # ...so it should prefer the eye-shape signal over blendshapes
    assert 0.55 < p.brow_raised < 0.8 and 0.4 < p.jaw_open < 0.7


def test_profile_detects_swapped_blendshape_sides():
    script = cal.build_script()
    res = cal.fit(synthetic_recording(script, swap=True), script, DISPLAY, latency=0.0)
    assert res.profile.swap is True


def test_click_threshold_is_personalized_above_your_own_blinks():
    script = cal.build_script()
    rec = synthetic_recording(script, blink_every=3.0)
    res = cal.fit(rec, script, DISPLAY, latency=0.0)
    assert res.stats["profile"]["blinks"]["count"] > 5
    longest = res.stats["profile"]["blinks"]["longest"]
    assert res.profile.click_s >= longest  # never fires on a blink that long
    assert 0.25 <= res.profile.click_s <= 0.5


def test_head_only_calibration_still_fits_but_says_so():
    script = cal.build_script(quick=True)
    res = cal.fit(synthetic_recording(script), script, DISPLAY, latency=0.0)
    assert res.stats["validation_points"] < 80
    assert res.stats["head_range_deg"][0] < 2  # quick run has no head motion


def test_validation_cannot_change_profile_or_model():
    script = cal.build_script(quick=True, expressions=False)
    rec = synthetic_recording(script)
    before = cal.fit(rec, script, DISPLAY, latency=0)
    # Corrupt only validation with open eyes and extreme gaze features.
    for t, f in zip(rec.t, rec.features):
        if script.at(t).step.kind == cal.VALIDATE:
            f.left.u += 0.4
            f.right.u += 0.4
            f.brow = 0.9
            f.jaw = 0.9
    after = cal.fit(rec, script, DISPLAY, latency=0)
    for key, value in before.profile.to_arrays().items():
        assert np.array_equal(value, after.profile.to_arrays()[key])
    assert np.allclose(before.model.coef, after.model.coef)
    assert after.stats["validation_frame_mean_points"] > before.stats["validation_frame_mean_points"] * 2
    assert after.stats["validation_samples"] == before.stats["validation_samples"]


def test_pursuit_lag_does_not_shift_static_or_validation_labels():
    script = cal.build_script(expressions=False)
    rec = synthetic_recording(script)
    base = {i: cue for i, cue in cal._label(rec, script, 0.05)}
    shifted = {i: cue for i, cue in cal._label(rec, script, 0.05, pursuit_latency=0.3)}
    for i, cue in base.items():
        if cue.step.kind != cal.PURSUIT:
            assert shifted[i] == cue


def test_head_targets_repeat_across_poses_and_are_held_out_together():
    script = cal.build_script(expressions=False)
    rec = synthetic_recording(script)
    profile, _ = cal.fit_profile(rec, script)
    _, y, groups, _, kinds, _ = cal._prepare(rec, script, profile, 0)
    heads = [step for step in script.steps if step.kind == cal.HEAD]
    for target in cal.HEAD_POINTS:
        assert len({step.what for step in heads if (step.x, step.y) == target}) == 2
        mask = (kinds == cal.HEAD) & np.all(y == target, axis=1)
        assert len(np.unique(groups[mask])) == 1
    assert sum(step.kind == cal.VALIDATE and step.what == "motion" for step in script.steps) == 5
    assert script.duration < 160


def test_validation_outliers_remain_and_missing_faces_reduce_coverage():
    script = cal.build_script(quick=True, expressions=False)
    rec = synthetic_recording(script)
    rows = [(i, cue) for i, cue in cal._label(rec, script, 0) if cue.step.kind == cal.VALIDATE]
    rec.features[rows[1][0]].left.u = 100
    for i, _ in rows[::2]:
        rec.features[i] = None
    res = cal.fit(rec, script, DISPLAY, latency=0)
    assert 0.45 < res.stats["validation_coverage"] < 0.55
    assert res.stats["validation_complete"] is False
    assert res.stats["validation_frame_worst_points"] > res.stats["validation_frame_p90_points"]
    assert res.stats["validation_samples"] == len(rows) - len(rows[::2])
