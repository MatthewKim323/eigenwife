import json
from types import SimpleNamespace

import numpy as np
import pytest

from eye import calibration as cal
from eye.capture import ImageCapture
from eye.capture_replay import CaptureReplay, CaptureIntegrityError
from eye.face import FaceObs


@pytest.fixture
def captured(tmp_path, monkeypatch):
    image = np.arange(12 * 16 * 3, dtype=np.uint8).reshape(12, 16, 3)
    rec = cal.Recording(clock=[(1., 0.), (2., 1.)])
    obs = FaceObs(1., (16, 12), np.ones((478, 3)), np.ones(52), np.eye(4))
    rec.add(1., object(), obs)
    rec.add(2., None, None)
    script = cal.Script([])
    session = tmp_path / 'session.npz'
    session.write_bytes(b'fixture session, content identity verified')
    monkeypatch.setattr(cal, 'load_session', lambda path: (rec, script, {'w': 100, 'h': 100}, 'camera'))
    cap = ImageCapture(tmp_path, {})
    cap.submit(SimpleNamespace(seq=5, t=1., image=image), timing={'inference_ms': 14})
    cap.submit(SimpleNamespace(seq=8, t=2., image=image))
    cap.close(session_path=session, script=script.to_json(), clock=rec.clock)
    return cap.path, rec, image, session


def test_identical_pixels_observations_and_no_face_retained(captured):
    path, rec, image, _ = captured
    replay = CaptureReplay(path)
    frames = list(replay.frames())
    assert [f.seq for f in frames] == [5, 8]
    np.testing.assert_array_equal(frames[0].image, image)
    assert frames[0].observation.size == (16, 12)
    np.testing.assert_array_equal(frames[0].observation.lm, rec.lm[0])
    assert frames[0].timing == {'inference_ms': 14}
    assert frames[1].observation is None and frames[1].image is not None
    assert replay.report['no_face_frames'] == 1
    assert replay.report['image_coverage'] == 1


def test_out_of_order_async_ledger_is_aligned(captured):
    path, *_ = captured
    ledger = path / 'frames.jsonl'
    lines = ledger.read_text().splitlines()
    ledger.write_text('\n'.join(reversed(lines)) + '\n')
    assert [f.t for f in CaptureReplay(path).frames()] == [1., 2.]


def test_explicit_drops_are_yielded_and_counted(captured, tmp_path):
    _, rec, image, session = captured
    cap = ImageCapture(tmp_path, {}, max_bytes=1)
    for seq, t in enumerate(rec.t):
        cap.submit(SimpleNamespace(seq=seq, t=t, image=image))
    cap.close(session_path=session)
    replay = CaptureReplay(cap.path)
    frames = list(replay.frames())
    assert len(frames) == 2 and all(f.image is None for f in frames)
    assert all(f.dropped == 'byte_limit' for f in frames)
    assert frames[0].observation is not None
    assert replay.report['dropped'] == 2 and replay.report['image_coverage'] == 0


def test_session_hash_relocation_and_mutation(captured, tmp_path):
    path, _, _, session = captured
    relocated = tmp_path / 'moved.npz'
    relocated.write_bytes(session.read_bytes())
    assert CaptureReplay(path, relocated).session_path == relocated
    relocated.write_bytes(b'different')
    with pytest.raises(CaptureIntegrityError, match='session SHA256'):
        CaptureReplay(path, relocated)


def test_image_mutation_detected_before_and_during_replay(captured):
    path, *_ = captured
    replay = CaptureReplay(path)
    (path / '000000005.png').write_bytes(b'changed')
    with pytest.raises(CaptureIntegrityError, match='image SHA256'):
        CaptureReplay(path)
    with pytest.raises(CaptureIntegrityError, match='image SHA256'):
        list(replay.frames())


@pytest.mark.parametrize('mutation,message', [
    (lambda rows: rows[0].update(t=1.1), 'timestamps'),
    (lambda rows: rows[0].update(seq=8), 'duplicate'),
    (lambda rows: rows[0].update(size=[1, 1]), 'dimensions'),
    (lambda rows: rows[0].update(file='../outside.png'), 'PNG filename'),
    (lambda rows: rows[0].update(dropped='queue_full'), 'also declares'),
    (lambda rows: rows.pop(), 'counts differ'),
])
def test_corrupt_ledger_fails_closed(captured, mutation, message):
    path, *_ = captured
    ledger = path / 'frames.jsonl'
    rows = [json.loads(line) for line in ledger.read_text().splitlines()]
    mutation(rows)
    ledger.write_text(''.join(json.dumps(row) + '\n' for row in rows))
    with pytest.raises(CaptureIntegrityError, match=message):
        CaptureReplay(path)


def test_incomplete_capture_rejected(captured):
    path, *_ = captured
    file = path / 'manifest.json'
    manifest = json.loads(file.read_text())
    manifest['status'] = 'recording'
    file.write_text(json.dumps(manifest))
    with pytest.raises(CaptureIntegrityError, match='not complete'):
        CaptureReplay(path)


def test_real_session_archive_roundtrip_retains_all_no_face_frames(tmp_path, monkeypatch):
    from test_calibration import DISPLAY
    monkeypatch.setattr(cal.paths, 'sessions_dir', lambda: tmp_path)
    rec = cal.Recording(clock=[(1., 0.), (2., 1.)])
    rec.add(1., None, None)
    rec.add(2., None, None)
    script = cal.Script([cal.Step(cal.VALIDATE, 2, sample_from=0, sample_to=2)])
    names = ['eyeBlinkLeft', 'eyeBlinkRight', 'browInnerUp', 'jawOpen', 'mouthSmileLeft', 'mouthSmileRight']
    session = cal.save_session(rec, script, DISPLAY, 'test', names)
    cap = ImageCapture(tmp_path, {})
    for seq, t in enumerate(rec.t):
        cap.submit(SimpleNamespace(seq=seq, t=t, image=np.zeros((6, 8, 3), dtype=np.uint8)))
    cap.close(session_path=session, script=script.to_json(), clock=rec.clock)
    replay = CaptureReplay(cap.path)
    assert replay.report['frames'] == replay.report['no_face_frames'] == 2
    assert all(frame.observation is None and frame.image is not None for frame in replay.frames())
