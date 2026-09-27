"""Quick calibration recovery must retain missed frames and honest validation."""

import numpy as np
import pytest

from eye import calibration as cal
from eye.stream import Correction
from test_calibration import synthetic_recording
from test_stream import _feed, _shifted, _stream


def test_retry_accumulates_blink_attempts_and_coverage(tmp_path):
    stream, _ = _stream(tmp_path)
    base = next(f for f in synthetic_recording(cal.build_script(quick=True, expressions=False)).features if f is not None)
    stream.settle_s = 0  # Isolate blink coverage from the separate reopening delay.
    _feed(stream, [_shifted(base, i / 30) for i in range(30)])
    stream.command({"type": "calib_begin"})
    stream.command({"type": "calib_target", "nx": .5, "ny": .5})
    _feed(stream, [_shifted(base, 1 + i / 30, shut=i >= 6) for i in range(10)])
    first = stream.command({"type": "calib_target_end", "validateOnly": True, "requestId": 7})
    assert first["requestId"] == 7
    assert not first["ok"]
    assert first["samples"] == 6 and first["attempted"] == 10
    assert first["coverage"] == .6
    assert first["rejected"] == {"blink_or_settling": 4}
    point = stream._calib[0]

    stream.command({"type": "calib_target", "nx": .5, "ny": .5, "retry": True})
    _feed(stream, [_shifted(base, 2 + i / 30) for i in range(10)])
    second = stream.command({"type": "calib_target_end", "validateOnly": True, "requestId": 8})
    assert second["requestId"] == 8 and second["ok"]
    assert second["index"] == 0 and len(stream._calib) == 1
    assert stream._calib[0] is point
    assert second["samples"] == 16 and second["attempted"] == 20
    assert second["coverage"] == .8
    assert second["rejected"] == first["rejected"]


def test_retry_rejects_different_target_without_replacing_prior_data(tmp_path):
    stream, _ = _stream(tmp_path)
    stream.command({"type": "calib_begin"})
    with pytest.raises(ValueError, match="previous calibration target"):
        stream.command({"type": "calib_target", "nx": .5, "ny": .5, "retry": True})
    stream.command({"type": "calib_target", "nx": .5, "ny": .5})
    point = stream._collecting
    point.preds.append(np.array([.4, .6]))
    point.attempted = 1
    stream.command({"type": "calib_target_end"})
    with pytest.raises(ValueError, match="previous calibration target"):
        stream.command({"type": "calib_target", "nx": .8, "ny": .5, "retry": True})
    assert len(stream._calib) == 1
    assert stream._calib[0] is point
    assert point.attempted == 1 and len(point.preds) == 1
    assert stream._collecting is None


def test_pose_failure_emits_actionable_guidance_and_recovers(tmp_path):
    stream, events = _stream(tmp_path)
    base = next(f for f in synthetic_recording(cal.build_script(quick=True, expressions=False)).features if f is not None)
    rejected = _shifted(base, 1)
    rejected.yaw = 100
    _feed(stream, [rejected])
    sample = events[-1]
    assert sample["type"] == "gaze" and not sample["valid"]
    assert sample["reason"] == "head_pose_outside_calibration"
    assert "calibration posture" in sample["guidance"]
    assert "yaw" in sample["pose"]["outside"]
    assert sample["pose"]["values"]["yaw"] == 100
    assert sample["pose"]["allowed"]["yaw"][1] < 100
    _feed(stream, [_shifted(base, 2)])
    assert events[-1]["valid"]
    assert "guidance" not in events[-1] and "pose" not in events[-1]


def test_validation_retry_preserves_all_samples_without_fitting(tmp_path, monkeypatch):
    stream, _ = _stream(tmp_path)
    stream.correction = Correction([[1, 0, .1], [0, 1, .1]])
    original = stream.correction

    def never_fit(*args, **kwargs):
        raise AssertionError("validation must not fit a correction")

    monkeypatch.setattr(Correction, "fit", never_fit)
    stream.command({"type": "calib_begin"})
    targets = np.array([[.1, .1], [.9, .1], [.5, .5], [.1, .9], [.9, .9]])
    for i, target in enumerate(targets):
        stream.command({"type": "calib_target", "nx": target[0], "ny": target[1]})
        point = stream._collecting
        point.preds.extend([target - .1] * 6)
        point.attempted = 10 if i == 0 else 6
        if i == 0:
            point.rejected["blink_or_settling"] = 4
        reply = stream.command({"type": "calib_target_end", "validateOnly": True})
        if i == 0:
            assert not reply["ok"]
            stream.command({"type": "calib_target", "nx": target[0], "ny": target[1], "retry": True})
            stream._collecting.preds.extend([target - .1] * 10)
            stream._collecting.attempted += 10
            assert stream.command({"type": "calib_target_end", "validateOnly": True})["ok"]
    result = stream.command({"type": "calib_finish", "validateOnly": True})
    assert result["ok"] and result["validationOnly"] and not result["applied"]
    assert stream.correction is original
    assert result["validation"]["points"] == 5
    assert result["validation"]["samples"] == 40
    assert result["validation"]["coverage"] == pytest.approx(40 / 44)
    assert result["validation"]["meanDeg"] == 0
