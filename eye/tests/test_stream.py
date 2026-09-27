"""The event stream behind `eye serve`, driven by synthetic frames."""

import copy

import numpy as np

from eye import calibration as cal
from eye.stream import Correction, GazeStream
from test_calibration import DISPLAY, synthetic_recording


class Frame:
    def __init__(self, t):
        self.t = t
        self.image = None


def _calib(tmp_path):
    script = cal.build_script()
    result = cal.fit(synthetic_recording(script), script, DISPLAY, latency=0.0)
    return cal.load(cal.save(result, DISPLAY, "FaceTime HD Camera", tmp_path / "calibration.npz"))


def _stream(tmp_path):
    events = []
    stream = GazeStream(DISPLAY, _calib(tmp_path), emit=events.append)
    return stream, events


def _feed(stream, frames):
    for f in frames:
        stream.on_frame(Frame(f.t), None, f)


def _shifted(f, t, du=0.0, shut=False):
    g = copy.deepcopy(f)
    g.t = t
    g.left.u += du
    g.right.u += du
    if shut:
        g.left.ear = g.right.ear = 0.05
        g.bs_blink = (0.9, 0.9)
    return g


def test_correction_offset_and_affine():
    pred = np.array([[0.2, 0.2], [0.8, 0.3]])
    assert np.allclose(Correction.fit(pred, pred + [0.05, -0.02]).apply([0.5, 0.5]), [0.55, 0.48])
    rng = np.random.default_rng(0)
    pred = rng.uniform(0.1, 0.9, (9, 2))
    a = np.array([[1.1, 0.0, -0.04], [0.02, 0.9, 0.06]])
    target = pred @ a[:, :2].T + a[:, 2]
    fitted = Correction.fit(pred, target, shrink=0.0)
    assert np.allclose(fitted.a, a, atol=1e-9)
    assert Correction.from_json(fitted.to_json()).a.tolist() == fitted.a.tolist()
    assert Correction().identity and not fitted.identity


def test_fixations_follow_the_dots_and_report_durations(tmp_path):
    stream, events = _stream(tmp_path)
    rec = synthetic_recording(cal.build_script(quick=True, expressions=False), seed=5)
    _feed(stream, [f for f in rec.features if f is not None])
    kinds = [e["type"] for e in events]
    assert kinds[0] == "face" and events[0]["present"]
    starts = [e for e in events if e["type"] == "fixation_start"]
    ends = [e for e in events if e["type"] == "fixation_end"]
    assert 9 <= len(starts) <= 40  # 14 dots, each glide may add a short one
    assert all(e["ms"] >= 0 for e in ends)
    assert max(e["ms"] for e in ends) > 800  # the dwell on a dot is one long fixation
    gaze = np.array([(e["nx"], e["ny"]) for e in events if e["type"] == "gaze"])
    assert np.ptp(gaze[:, 0]) > 0.6 and np.ptp(gaze[:, 1]) > 0.6


def test_a_blink_freezes_gaze_and_is_not_an_event(tmp_path):
    stream, events = _stream(tmp_path)
    rec = synthetic_recording(cal.build_script(quick=True, expressions=False), seed=1)
    base = [f for f in rec.features if f is not None][40]
    t = 0.0
    frames = []
    for n, shut in ((30, False), (15, True), (10, False)):
        for _ in range(n):
            t += 1 / 30
            frames.append(_shifted(base, t, shut=shut))
    _feed(stream, frames)
    looked = [e for e in events if e["type"] == "gaze" and not e["blink"]][0]
    frozen = [e for e in events if e["type"] == "gaze" and e["blink"]]
    assert frozen  # held where you were looking while the lids were down
    assert all(abs(e["x"] - looked["x"]) < 20 and abs(e["y"] - looked["y"]) < 20 for e in frozen)
    assert {e["type"] for e in events} <= {"face", "gaze", "fixation_start", "fixation_end"}


def test_quick_recalibration_fixes_drift(tmp_path):
    """You moved since calibrating: every estimate is now off to one side."""
    stream, events = _stream(tmp_path)
    rec = synthetic_recording(cal.build_script(quick=True, expressions=False), seed=2)
    frames = [f for f in rec.features if f is not None]
    drift = 0.02  # iris offset in eye widths, ~0.17 of the screen width

    stream.command({"type": "calib_begin"})
    by_target: dict = {}
    for f in frames:
        cue = rec_cue(rec, f)
        if cue is not None and cue.step.kind == cal.FIXATE and cue.sampling:
            by_target.setdefault((cue.x, cue.y), []).append(f)
    for (x, y), fs in by_target.items():
        stream.command({"type": "calib_target", "nx": x, "ny": y})
        _feed(stream, [_shifted(f, f.t, du=drift) for f in fs])
        assert stream.command({"type": "calib_target_end"})["ok"]
    result = stream.command({"type": "calib_finish"})
    assert result["ok"] and result["applied"] and result["points"] == len(by_target)
    assert result["beforeDeg"] > 3.0
    assert result["afterDeg"] < 1.0 and result["looDeg"] < 1.5

    events.clear()
    target = frames[len(frames) // 2]
    _feed(stream, [_shifted(target, target.t + 100 + i / 30, du=drift) for i in range(30)])
    cue = rec_cue(rec, target)
    last = [e for e in events if e["type"] == "gaze"][-1]
    assert abs(last["nx"] - cue.x) < 0.05 and abs(last["ny"] - cue.y) < 0.05

    assert stream.command({"type": "calib_reset"})["reset"]
    assert stream.correction.identity


def test_bad_recalibration_is_not_applied(tmp_path):
    stream, _ = _stream(tmp_path)
    assert not stream.command({"type": "calib_finish"})["ok"]  # nothing collected
    assert stream.correction.identity


def test_failed_recalibration_reports_rejected_frames(tmp_path):
    stream, _ = _stream(tmp_path)
    rec = synthetic_recording(cal.build_script(quick=True, expressions=False))
    base = copy.deepcopy(next(f for f in rec.features if f is not None))
    base.yaw = 100
    stream.command({"type": "calib_begin"})
    stream.command({"type": "calib_target", "nx": .5, "ny": .5})
    _feed(stream, [_shifted(base, i / 30) for i in range(10)])
    assert stream.command({"type": "calib_target_end"})["samples"] == 0
    result = stream.command({"type": "calib_finish"})
    assert not result["ok"]
    assert "head_pose_outside_calibration" in result["error"]
    assert result["targetSamples"] == [0]
    assert result["rejected"]["head_pose_outside_calibration"] == 10


def rec_cue(rec, f):
    script = cal.build_script(quick=True, expressions=False)
    return script.at(f.t)


def test_current_correction_is_baseline_and_sparse_targets_rejected(tmp_path):
    from eye.stream import CalibPoint
    stream, _ = _stream(tmp_path)
    targets = np.array([[.1,.1],[.9,.1],[.5,.5],[.1,.9],[.9,.9]])
    stream.correction = Correction(np.array([[1,0,.1],[0,1,.1]]))
    original = stream.correction
    stream._calib = [CalibPoint(*p, preds=[p - .1]*5) for p in targets]
    result = stream._finish()
    assert result['currentDeg'] == 0
    assert not result['applied'] and stream.correction is original
    stream._calib = [CalibPoint(*p, preds=[p]*5) for p in targets[:4]]
    assert not stream._finish()['ok']
    stream._calib = [CalibPoint(.5,.5,preds=[[.5,.5]]*5) for _ in range(5)]
    assert not stream._finish()['ok']


def test_display_moves_without_waiting_for_fixation_window(tmp_path):
    stream, events = _stream(tmp_path)
    rec = synthetic_recording(cal.build_script(quick=True, expressions=False))
    base = next(f for f in rec.features if f is not None)
    _feed(stream, [_shifted(base, i/30) for i in range(30)])
    before = [e for e in events if e['type']=='gaze' and e.get('valid')][-1]
    _feed(stream, [_shifted(base, 1+i/30, du=.007) for i in range(3)])
    after = [e for e in events if e['type']=='gaze' and e.get('valid')][-1]
    assert abs(after['x'] - before['x']) > .7 * abs(after['raw']['x'] - before['x'])
    stream.on_frame(Frame(2), None, None)
    assert not stream._history and stream._frozen is None
    assert events[-1]['reason']=='face_lost'


def test_pose_extrapolation_and_nonfinite_are_invalid(tmp_path):
    stream, events = _stream(tmp_path)
    rec = synthetic_recording(cal.build_script(quick=True, expressions=False))
    base = copy.deepcopy(next(f for f in rec.features if f is not None))
    base.yaw = 100
    _feed(stream, [base])
    assert events[-1]['reason'] == 'head_pose_outside_calibration'
    base.yaw = float('nan')
    _feed(stream, [base])
    assert events[-1]['reason'] == 'nonfinite_features'


def test_validation_measures_current_mapping_without_fitting(tmp_path):
    from eye.stream import CalibPoint
    stream, _ = _stream(tmp_path)
    targets = np.array([[.1,.1],[.9,.1],[.5,.5],[.1,.9],[.9,.9]])
    stream.correction = Correction([[1,0,.1],[0,1,.1]])
    original = stream.correction
    stream._calib = [CalibPoint(*p, preds=[p-.1]*5, attempted=5) for p in targets]
    result = stream.command({'type':'calib_finish','validateOnly':True})
    assert result['validationOnly'] and not result['applied']
    assert result['validation']['samples'] == 25
    assert result['validation']['p90Deg'] == 0
    assert stream.correction is original
    assert stream.hello()['accuracyValidated']
    assert stream.hello()['accuracyDeg'] == 0
    stream.command({'type':'calib_reset'})
    assert stream.live_validation is None


def test_validation_requires_all_targets_and_coverage(tmp_path):
    from eye.stream import CalibPoint
    stream, _ = _stream(tmp_path)
    targets = np.array([[.1,.1],[.9,.1],[.5,.5],[.1,.9],[.9,.9]])
    stream._calib = [CalibPoint(*p, preds=[p]*5, attempted=10) for p in targets]
    assert not stream._finish(validate_only=True)['ok']
    assert stream.live_validation is None
    stream._calib = [CalibPoint(*p, preds=[p]*5, attempted=5) for p in targets]
    stream._calib.append(CalibPoint(.3,.3,attempted=20))
    assert not stream._finish(validate_only=True)['ok']
    assert stream.live_validation is None


def test_first_frame_closed_eyes_is_invalid_without_a_previous_gaze(tmp_path):
    stream, events = _stream(tmp_path)
    rec = synthetic_recording(cal.build_script(quick=True, expressions=False))
    base = next(f for f in rec.features if f is not None)
    stream.command({'type': 'calib_begin'})
    stream.command({'type': 'calib_target', 'nx': .5, 'ny': .5})
    _feed(stream, [_shifted(base, i / 30, shut=True) for i in range(6)])
    gaze = [event for event in events if event['type'] == 'gaze']
    assert len(gaze) == 6
    assert all(event['valid'] is False and event['reason'] == 'blink' for event in gaze)
    assert not any(event['type'] == 'fixation_start' for event in events)
    assert stream.command({'type': 'calib_target_end'})['samples'] == 0


def test_blink_ends_fixation_once_and_requires_reopening_settle(tmp_path):
    stream, events = _stream(tmp_path)
    rec = synthetic_recording(cal.build_script(quick=True, expressions=False))
    base = next(f for f in rec.features if f is not None)
    _feed(stream, [_shifted(base, i / 30) for i in range(30)])
    assert any(event['type'] == 'fixation_start' for event in events)
    events.clear()
    _feed(stream, [_shifted(base, 1 + i / 30, shut=True) for i in range(6)])
    assert len([event for event in events if event['type'] == 'fixation_end']) == 1
    assert not any(event.get('valid') for event in events)
    events.clear()
    _feed(stream, [_shifted(base, 1.2 + i / 30) for i in range(4)])
    assert not any(event.get('valid') for event in events)
    _feed(stream, [_shifted(base, 1.4 + i / 30) for i in range(20)])
    assert any(event.get('valid') for event in events)
    assert len([event for event in events if event['type'] == 'fixation_start']) == 1


def test_first_blink_without_history_still_requires_reopening_settle(tmp_path):
    stream, events = _stream(tmp_path)
    rec = synthetic_recording(cal.build_script(quick=True, expressions=False))
    base = next(f for f in rec.features if f is not None)
    _feed(stream, [_shifted(base, i / 30, shut=True) for i in range(6)])
    events.clear()
    _feed(stream, [_shifted(base, .2 + i / 30) for i in range(4)])
    assert not any(event.get('valid') for event in events)
    _feed(stream, [_shifted(base, .4)])
    assert events[-1]['valid']
