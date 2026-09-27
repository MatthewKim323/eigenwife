import base64
import json
import stat
import cv2
import numpy as np
import pytest
from eye.iphone_capture import IPhoneCapture, validate_phone_image
from eye.iphone_replay import load_capture, iter_capture, replay_numeric


def jpeg():
    ok, data = cv2.imencode('.jpg', np.zeros((32, 48, 3), np.uint8))
    assert ok
    return dict(encoding='jpeg', data=base64.b64encode(data).decode(), width=48, height=32,
                intrinsics=[50,0,0,0,50,0,24,16,1], mirrored=False, orientation='sensor')


def test_roundtrip_private_images_and_numeric(tmp_path):
    c = IPhoneCapture(tmp_path, {'display': {'x':0,'y':0,'w':1000,'h':800,'scale':2,'ptPerDeg':50}})
    packet = {'type':'iphone_frame', 'schema':1,'sessionId':'12345678-1234-1234-1234-123456789012', 'seq':0,'timestamp':10,'tracked':False,'image':jpeg()}
    c.record_packet(packet, 100)
    c.record_command({'type':'record_start'}, 100)
    c.record_event({'type':'hello'}, 100)
    c.close()
    assert stat.S_IMODE(c.path.stat().st_mode) == 0o700
    assert stat.S_IMODE((c.path/'records.jsonl').stat().st_mode) == 0o600
    assert 'data' not in load_capture(c.path)['records'][0]['payload']['image']
    assert next(iter_capture(c.path))['payload'] == packet
    assert replay_numeric(c.path)['packets'] == 1
    assert c.close()['complete']
    with pytest.raises(ValueError): c.record_event({}, 101)


@pytest.mark.parametrize('mutation', [lambda i:i.update(width=49),lambda i:i.update(data='oops'),lambda i:i.update(mirrored=True),lambda i:i.update(width=99999),lambda i:i.update(intrinsics=[0]*9)])
def test_image_rejections(mutation):
    image = jpeg(); mutation(image)
    with pytest.raises(ValueError): validate_phone_image(image)


def test_secret_and_bounds(tmp_path):
    with pytest.raises(ValueError): IPhoneCapture(tmp_path, {'pairingToken':'private'})
    c = IPhoneCapture(tmp_path, {}, max_records=1)
    with pytest.raises(ValueError): c.record_event({'nested':{'Authorization':'secret'}}, 1)
    c.record_command({'type':'hello'}, 1)
    with pytest.raises(ValueError): c.record_command({}, 2)
    c.close()
    d = IPhoneCapture(tmp_path, {}, max_bytes=10)
    with pytest.raises(ValueError): d.record_packet({'image':jpeg()}, 1)
    assert not list((d.path/'images').iterdir())
    d.close()
    e = IPhoneCapture(tmp_path, {}, max_duration=1)
    e.record_event({}, 1)
    with pytest.raises(ValueError): e.record_event({}, 3)
    e.close()


def test_corruption_incomplete_and_unsafe(tmp_path):
    c = IPhoneCapture(tmp_path, {})
    c.record_event({'type':'test'}, 1)
    with pytest.raises(ValueError, match='incomplete'): load_capture(c.path)
    c.close()
    (c.path/'records.jsonl').write_text('corrupt')
    with pytest.raises(ValueError): load_capture(c.path)
    manifest = json.loads((c.path/'manifest.json').read_text())
    manifest['files']['../escape'] = {'bytes':0,'sha256':''}
    (c.path/'manifest.json').write_text(json.dumps(manifest))
    with pytest.raises(ValueError): load_capture(c.path)


def test_image_checksum_corruption(tmp_path):
    c = IPhoneCapture(tmp_path,{})
    c.record_packet({'image':jpeg()},1)
    c.close()
    file = next((c.path/'images').iterdir())
    raw = bytearray(file.read_bytes()); raw[-3] ^= 1; file.write_bytes(raw)
    with pytest.raises(ValueError,match='checksum'): load_capture(c.path)


def test_numeric_replays_fit_validation_and_ignores_record_controls(tmp_path):
    from test_iphone_tracking import packet
    session = '12345678-1234-1234-1234-123456789012'
    c = IPhoneCapture(tmp_path, {'display': {'x':0,'y':0,'w':1000,'h':800,'scale':2,'ptPerDeg':50}})
    seq = 0
    c.record_packet(packet(seq, session=session), seq/60)
    c.record_command({'type':'record_start'}, 0)
    for validate, grid in [(False, (.1,.5,.9)), (True, (.2,.5,.8))]:
        c.record_command({'type':'calib_begin'}, seq/60)
        for x in grid:
            for y in grid:
                c.record_command({'type':'calib_target', 'nx':x,'ny':y}, seq/60)
                for _ in range(8):
                    seq += 1
                    c.record_packet(packet(seq,(x-.5)*.2,(y-.5)*.2,session),seq/60)
                c.record_command({'type':'calib_target_end'},seq/60)
        c.record_command({'type':'calib_finish','validateOnly':validate},seq/60)
    c.close()
    report = replay_numeric(c.path)
    assert len(report['results']) == 2
    assert report['results'][0]['applied']
    assert report['results'][1]['accuracyValidated']
    assert report['results'][1]['meanPoints'] < 5
    assert report['finalState']['accuracyValidated']


def test_manifest_path_and_symlink_rejected(tmp_path):
    c = IPhoneCapture(tmp_path, {})
    c.record_event({}, 0)
    c.close()
    manifest_path = c.path/'manifest.json'
    manifest = json.loads(manifest_path.read_text())
    manifest['files']['../outside.jpg'] = {'bytes':0,'sha256':''}
    manifest_path.write_text(json.dumps(manifest))
    with pytest.raises(ValueError, match='path'): load_capture(c.path)
    del manifest['files']['../outside.jpg']
    manifest_path.write_text(json.dumps(manifest))
    records = c.path/'records.jsonl'
    original = records.read_bytes()
    external = tmp_path/'external'; external.write_bytes(original)
    records.unlink(); records.symlink_to(external)
    with pytest.raises(ValueError, match='unsafe'): load_capture(c.path)


def test_replay_receiver_disconnect_clears_calibration(tmp_path):
    from test_iphone_tracking import packet
    c = IPhoneCapture(tmp_path, {'display': {'x':0,'y':0,'w':1000,'h':800,'scale':2}})
    c.record_packet(packet(), 1)
    c.record_event({'type':'gaze','reason':'iphone_disconnected','valid':False}, 2)
    c.close()
    assert not replay_numeric(c.path)['finalState']['face']
    assert not replay_numeric(c.path)['finalState']['calibrated']


def test_packet_image_intrinsics_must_match_source_resize():
    from eye.iphone_capture import validate_packet_image
    image = jpeg()
    packet = {'image':image, 'imageSize':[96,64], 'intrinsics':[100,0,0,0,100,0,48,32,1]}
    assert validate_packet_image(packet) == validate_phone_image(image)
    packet['image']['intrinsics'][0] = 51
    with pytest.raises(ValueError, match='scale'): validate_packet_image(packet)
    packet['image']['intrinsics'][0] = 50
    packet['imageSize'] = [True,64]
    with pytest.raises(ValueError, match='source'): validate_packet_image(packet)


@pytest.mark.parametrize('rejection', ['invalid_iphone_packet', 'iphone_invalid_packet', 'iphone_out_of_order', 'iphone_blink'])
def test_replay_rejected_packet_coverage_without_double_counting_accepted_blinks(tmp_path, rejection):
    from test_iphone_tracking import packet
    session = '12345678-1234-1234-1234-123456789012'
    c = IPhoneCapture(tmp_path, {'display': {'x':0,'y':0,'w':1000,'h':800,'scale':2}})
    seq = 0
    c.record_packet(packet(seq,session=session),0)
    c.record_command({'type':'calib_begin'},0)
    for x in (.1,.5,.9):
        for y in (.1,.5,.9):
            c.record_command({'type':'calib_target','nx':x,'ny':y},seq/60)
            for _ in range(5):
                seq += 1
                c.record_packet(packet(seq,(x-.5)*.2,(y-.5)*.2,session),seq/60)
            if x == .1 and y == .1:
                if rejection == 'iphone_blink':
                    # Blink packet is accepted by receiver and stored after its emitted event.
                    seq += 1
                    p = packet(seq,session=session); p['blinkLeft'] = .9
                    c.record_event({'type':'gaze','valid':False,'reason':rejection},seq/60)
                    c.record_packet(p,seq/60)
                else:
                    # Malformed/out-of-order packets aren't stored. Only rejection events remain.
                    for _ in range(2):
                        c.record_event({'type':'gaze','valid':False,'reason':rejection},seq/60)
            c.record_command({'type':'calib_target_end'},seq/60)
    c.record_command({'type':'calib_finish'},seq/60)
    c.close()
    result = replay_numeric(c.path)['results'][-1]
    if rejection == 'iphone_blink':
        assert result['ok'], 'one blink leaves 5/6 coverage, not duplicated 5/7'
    else:
        assert not result['ok'], 'two rejected packets must preserve 5/7 coverage failure'
        assert 'coverage' in result['error']
