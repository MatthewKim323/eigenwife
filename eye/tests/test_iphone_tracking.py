import copy
import uuid

import numpy as np
import pytest

from eye.iphone_tracking import decode_iphone_frame, IPhoneGazeStream


def matrix(m):
    return np.asarray(m).ravel(order="F").tolist()


def packet(seq=0, x=0, y=0, session=None):
    eye = np.eye(4)
    face = np.eye(4)
    face[2, 3] = -.5
    return dict(type="iphone_frame", schema=1, sessionId=session or str(uuid.uuid4()), seq=seq,
                timestamp=seq / 60 + 1, tracked=True, cameraTransform=matrix(eye),
                faceTransform=matrix(face), leftEyeTransform=matrix(eye), rightEyeTransform=matrix(eye),
                lookAtPoint=[x, y, 1], intrinsics=matrix([[500, 0, 320], [0, 500, 240], [0, 0, 1]]),
                imageSize=[640, 480], blinkLeft=0, blinkRight=0, depthAvailable=True, depthTimestamp=seq / 60 + 1)


def stream():
    events = []
    return IPhoneGazeStream(dict(x=0, y=0, w=1000, h=800, scale=2), events.append), events


def test_camera_relative_geometry_is_world_invariant():
    p = packet(x=.1, y=-.2)
    a = decode_iphone_frame(p)
    world = np.eye(4)
    world[:3, :3] = [[0, -1, 0], [1, 0, 0], [0, 0, 1]]
    world[:3, 3] = [2, 3, 1]
    p["cameraTransform"] = matrix(world)
    p["faceTransform"] = matrix(world @ np.asarray(p["faceTransform"]).reshape((4, 4), order="F"))
    b = decode_iphone_frame(p)
    np.testing.assert_allclose(a.features, b.features, atol=1e-12)
    np.testing.assert_allclose(a.origin, [0, 0, -.5])
    assert np.linalg.norm(a.direction) == pytest.approx(1)


@pytest.mark.parametrize("key,value", [("schema", True), ("seq", -1), ("timestamp", float("nan")),
    ("imageSize", [0, 480]), ("blinkLeft", 2), ("lookAtPoint", [0, 0, 0]),
    ("cameraTransform", matrix(np.diag([2, 1, 1, 1]))),
    ("faceTransform", matrix(np.diag([-1, 1, 1, 1]))), ("intrinsics", [0] * 9)])
def test_bad_geometry_rejected(key, value):
    p = packet()
    p[key] = value
    with pytest.raises(ValueError):
        decode_iphone_frame(p)


def test_tracking_heartbeat_and_blink():
    p = packet()
    p["blinkRight"] = .7
    assert decode_iphone_frame(p).reason == "iphone_blink"
    heartbeat = {k: p[k] for k in ("type", "schema", "sessionId", "seq", "timestamp")}
    heartbeat["tracked"] = False
    assert not decode_iphone_frame(heartbeat).valid


def collect(s, session, seq, targets):
    s.command({"type": "calib_begin"})
    for x, y in targets:
        s.command(dict(type="calib_target", nx=x, ny=y))
        for _ in range(8):
            seq += 1
            s.handle_frame(packet(seq, (x - .5) * .2, (y - .5) * .2, session), seq / 60)
        response = s.command(dict(type="calib_target_end", requestId="point"))
        assert response["ok"] and response["requestId"] == "point"
    return seq


GRID = [(x, y) for x in (.1, .5, .9) for y in (.1, .5, .9)]


def test_fit_then_frozen_validation_and_session_reset():
    s, events = stream()
    session = str(uuid.uuid4())
    s.handle_frame(packet(0, session=session), 0)
    assert events[-1]["reason"] == "iphone_needs_calibration"
    seq = collect(s, session, 0, GRID)
    result = s.command(dict(type="calib_finish", requestId="fit"))
    assert result["applied"] and not result["accuracyValidated"]
    before = copy.deepcopy(s.model.to_arrays())
    seq = collect(s, session, seq, [(x, y) for x in (.2, .5, .8) for y in (.2, .5, .8)])
    result = s.command(dict(type="calib_finish", validateOnly=True))
    assert result["ok"] and result["accuracyValidated"] and not result["applied"]
    assert result["meanPoints"] < 5
    assert result["measurement"] == "raw_unsmoothed"
    assert len(result["perTarget"]) == 9
    assert all(p["samples"] == 8 and p["jitterRmsPoints"] < 1e-8 for p in result["perTarget"])
    for k, v in before.items():
        np.testing.assert_array_equal(v, s.model.to_arrays()[k])
    s.handle_frame(packet(seq + 1, session=session), 10)
    assert events[-1]["valid"]
    s.handle_frame(packet(), 11)
    assert not s.calibrated and not s.hello()["accuracyValidated"]


def test_rejection_coverage_counts_blink_and_stale():
    s, events = stream()
    session = str(uuid.uuid4())
    s.handle_frame(packet(0, session=session), 0)
    s.command(dict(type="calib_target", nx=.5, ny=.5))
    for seq in range(1, 9):
        p = packet(seq, session=session)
        p["blinkLeft"] = 1 if seq > 4 else 0
        s.handle_frame(p, seq / 60)
    s.tick(2)
    reply = s.command(dict(type="calib_target_end"))
    assert reply["samples"] == 4 and reply["attempted"] == 9
    assert not reply["ok"] and events[-1]["reason"] == "iphone_stale"


def test_duplicate_packets_do_not_train():
    s, events = stream()
    p = packet()
    s.handle_frame(p, 0)
    s.command(dict(type="calib_target", nx=.5, ny=.5))
    s.handle_frame(p, .1)
    assert events[-1]["reason"] == "iphone_out_of_order"
    assert s.command(dict(type="calib_target_end"))["samples"] == 0


def test_disconnect_clears_mapping_and_failed_validation_restores_cv_estimate():
    s, _ = stream()
    session = str(uuid.uuid4())
    s.handle_frame(packet(0, session=session), 0)
    seq = collect(s, session, 0, GRID)
    assert s.command(dict(type="calib_finish"))["applied"]
    cv_radius = s.radius
    seq = collect(s, session, seq, [(x, y) for x in (.2, .5, .8) for y in (.2, .5, .8)])
    assert s.command(dict(type="calib_finish", validateOnly=True))["ok"]
    assert s.validation is not None
    s.command(dict(type="calib_begin"))
    assert not s.command(dict(type="calib_finish", validateOnly=True))["ok"]
    assert s.radius == cv_radius and s.validation is None
    s.lost()
    assert s.model is None and not s.hello()["calibrated"]


class DirectModel:
    def predict(self, features):
        return np.array([[.5 + features[0], .5 + features[1]]])


def test_smoothing_reduces_jitter_and_responds_to_saccade():
    s, events = stream()
    session = str(uuid.uuid4())
    s.handle_frame(packet(session=session), 0)
    s.model = DirectModel()
    raw, smooth = [], []
    for i in range(1, 101):
        p = packet(i, x=.01 * (-1)**i, session=session)
        p['timestamp'] = 1 + i / 22
        s.handle_frame(p, i / 22)
        raw.append(events[-1]['raw']['x'])
        smooth.append(events[-1]['x'])
        assert events[-1]['nx'] == pytest.approx(events[-1]['x'] / 1000)
    assert np.std(smooth[20:]) < .6 * np.std(raw[20:])
    for i in range(101, 104):
        p = packet(i, x=.4, session=session)
        p['timestamp'] = 1 + i / 22
        s.handle_frame(p, i / 22)
    # Three frames at observed device rate: <140 ms to within 10% of a large step.
    assert abs(events[-1]['x'] - events[-1]['raw']['x']) < 40


def test_smoothing_does_not_contaminate_validation_or_bridge_tracking_loss():
    s, events = stream()
    session = str(uuid.uuid4())
    s.handle_frame(packet(session=session), 0)
    s.model = DirectModel()
    s.command(dict(type='calib_target', nx=.5, ny=.5))
    s.handle_frame(packet(1, x=0, session=session), .05)
    s.handle_frame(packet(2, x=.4, session=session), .1)
    assert events[-1]['x'] != events[-1]['raw']['x']
    assert s.collecting.predictions[-1][0] * 1000 == pytest.approx(events[-1]['raw']['x'])
    s.lost('iphone_stale', 1)
    s.handle_frame(packet(40, x=-.4, session=session), 2)
    assert events[-1]['x'] == events[-1]['raw']['x']


def test_recenter_uses_new_samples_and_invalidates_previous_accuracy():
    s, events = stream()
    session = str(uuid.uuid4())
    s.handle_frame(packet(session=session), 0)
    s.model = DirectModel()
    s.cv_radius = s.radius = 100
    s.validation = {'meanDeg': 1}
    s.command(dict(type='calib_begin'))
    s.command(dict(type='calib_target', nx=.5, ny=.5))
    for i in range(1, 21):
        s.handle_frame(packet(i, x=.2, y=-.1, session=session), i / 60)
    s.command(dict(type='calib_target_end'))
    before = s.model
    result = s.command(dict(type='calib_finish', recenterOnly=True))
    assert result['ok'] and result['applied'] and result['recenterOnly']
    assert not result['accuracyValidated'] and s.validation is None
    assert s.model is before
    s.handle_frame(packet(21, x=.2, y=-.1, session=session), 21 / 60)
    assert events[-1]['x'] == pytest.approx(500)
    assert events[-1]['y'] == pytest.approx(400)
    s.lost()
    np.testing.assert_array_equal(s.offset, [0, 0])


def test_failed_recenter_preserves_mapping_and_validation():
    s, _ = stream()
    session = str(uuid.uuid4())
    s.handle_frame(packet(session=session), 0)
    s.model = DirectModel()
    s.validation = {'meanDeg': 1}
    s.command(dict(type='calib_target', nx=.5, ny=.5))
    for i in range(1, 21):
        s.handle_frame(packet(i, x=.3*(-1)**i, session=session), i / 60)
    s.command(dict(type='calib_target_end'))
    result = s.command(dict(type='calib_finish', recenterOnly=True))
    assert not result['ok'] and not result['applied']
    np.testing.assert_array_equal(s.offset, [0, 0])
    assert s.validation == {'meanDeg': 1}
    with pytest.raises(ValueError, match='separate'):
        s.command(dict(type='calib_finish', recenterOnly=True, validateOnly=True))


def test_separate_eye_geometry_uses_positive_z_and_is_world_invariant():
    p = packet()
    left = np.eye(4)
    angle = .2
    left[:3, :3] = [[np.cos(angle), 0, np.sin(angle)], [0, 1, 0], [-np.sin(angle), 0, np.cos(angle)]]
    left[:3, 3] = [-.032, 0, .01]
    p['leftEyeTransform'] = matrix(left)
    f = decode_iphone_frame(p)
    assert f.features.shape == (12,)
    assert f.geometry_features.shape == (24,)
    np.testing.assert_allclose(f.geometry_features[12:15], [np.sin(angle), 0, np.cos(angle)])
    np.testing.assert_allclose(f.geometry_features[18:21], [-.032, 0, -.49])
    world = np.eye(4)
    world[:3, :3] = [[0, -1, 0], [1, 0, 0], [0, 0, 1]]
    world[:3, 3] = [2, -1, 3]
    p['cameraTransform'] = matrix(world)
    p['faceTransform'] = matrix(world @ np.asarray(p['faceTransform']).reshape(4, 4, order='F'))
    np.testing.assert_allclose(f.geometry_features, decode_iphone_frame(p).geometry_features, atol=1e-12)


def test_posture_rejection_counts_validation_coverage_and_allows_new_calibration():
    class GuardedModel(DirectModel):
        def supports(self, features):
            return np.array([False])
    s, events = stream()
    session = str(uuid.uuid4())
    s.handle_frame(packet(0, session=session), 0)
    s.model = GuardedModel()
    s.command(dict(type='calib_begin', validateOnly=True))
    s.command(dict(type='calib_target', nx=.5, ny=.5))
    s.handle_frame(packet(1, session=session), .02)
    assert events[-1]['reason'] == 'head_pose_outside_calibration'
    assert 'calibrated head position' in events[-1]['guidance']
    reply = s.command(dict(type='calib_target_end'))
    assert reply['samples'] == 0 and reply['attempted'] == 1
    assert reply['coverage'] == 0
    assert reply['rejected'] == {'head_pose_outside_calibration': 1}
    # Legacy/default begin remains a fresh calibration, free to expand support.
    s.command(dict(type='calib_begin'))
    s.command(dict(type='calib_target', nx=.5, ny=.5))
    s.handle_frame(packet(2, session=session), .04)
    assert not events[-1]['valid']
    reply = s.command(dict(type='calib_target_end'))
    assert reply['samples'] == reply['attempted'] == 1
    assert reply['rejected'] == {}
