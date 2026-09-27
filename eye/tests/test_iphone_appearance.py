import base64
import copy
from types import SimpleNamespace
import numpy as np
import pytest
import cv2
from eye.iphone_appearance import rotate_camera, ray_to_arkit, extract, benchmark, capture_digest
from eye.iphone_capture import IPhoneCapture
from eye.unigaze_backend import FINGERPRINT
from test_iphone_tracking import packet


def image_payload():
    pixels = np.zeros((24,32,3), np.uint8)
    ok, encoded = cv2.imencode('.jpg', pixels)
    assert ok
    return dict(encoding='jpeg', data=base64.b64encode(encoded).decode(), width=32, height=24,
                intrinsics=np.array([[25,0,16],[0,26,12],[0,0,1]]).ravel(order='F').tolist(),
                mirrored=False, orientation='sensor')


@pytest.mark.parametrize('angle', [0,90,180,270])
def test_rotate_pixels_intrinsics_and_inverse_ray(angle):
    frame = np.zeros((24,32,3), np.uint8)
    frame[7,10] = [20,40,60]
    K = np.array([[25.,0,16],[0,26,12],[0,0,1]])
    pixels, kr, R = rotate_camera(frame,K,angle)
    xyz = np.linalg.inv(K)@np.array([10,7,1])
    p = kr@R@xyz; p=p[:2]/p[2]
    np.testing.assert_array_equal(pixels[round(p[1]),round(p[0])],[20,40,60])
    original = np.array([.1,.2,-1.]); original/=np.linalg.norm(original)
    ray = SimpleNamespace(direction_camera=R@original, origin_camera_mm=R@np.array([10,20,500]))
    actual = ray_to_arkit(ray,R)
    np.testing.assert_allclose(actual[:3], original*[1,-1,-1])
    np.testing.assert_allclose(actual[3:], [.01,-.02,-.5])
    assert kr[0,0]>0 and kr[1,1]>0


class Frontend:
    def detect(self, bgr):
        return np.zeros((68,2))


class Backend:
    def __init__(self,camera): self.camera=camera
    def infer(self,bgr,points):
        assert bgr.shape == (self.camera.height,self.camera.width,3)
        return SimpleNamespace(direction_camera=np.array([0.,0.,-1.]), origin_camera_mm=np.array([0.,0.,500.]), reprojection_error_px=1.)


def make_capture(tmp_path, validation_shift=0., reset=False, rejection_events=False, recenter=False):
    c=IPhoneCapture(tmp_path, {'display':dict(x=0,y=0,w=1000,h=800,scale=2)})
    import uuid
    session=str(uuid.UUID(int=1)); seq=0
    def put_packet(x=.5,y=.5,image=True):
        nonlocal seq
        p=packet(seq,(x-.5)*.2,(y-.5)*.2,session)
        if image: p['image']=image_payload()
        c.record_packet(p,seq/30+1);seq+=1
    def cmd(**kw): c.record_command(kw,seq/30+1)
    put_packet()
    for validate in (False,True):
        if validate and reset: cmd(type='calib_reset')
        if validate and recenter:
            cmd(type='calib_begin');cmd(type='calib_target',nx=.5,ny=.5)
            for _ in range(20): put_packet()
            cmd(type='calib_target_end');cmd(type='calib_finish',recenterOnly=True)
        cmd(type='calib_begin')
        for x in (.1,.5,.9):
            for y in (.1,.5,.9):
                cmd(type='calib_target',nx=x+(validation_shift if validate else 0),ny=y)
                for _ in range(4): put_packet(x,y)
                put_packet(x,y,image=False)
                if rejection_events:
                    for reason in ('iphone_stale','iphone_out_of_order','invalid_iphone_packet','iphone_invalid_packet'):
                        c.record_event(dict(type='gaze',valid=False,reason=reason),seq/30+1)
                cmd(type='calib_target_end')
        cmd(type='calib_finish',validateOnly=validate)
    c.close()
    return c.path


def bundle_for(path):
    value=extract(path,rotation=0,assume_rectified=True,frontend=Frontend(),backend_factory=Backend)
    # Controlled synthetic learned ray, exactly paired with each packet's target.
    from eye.iphone_replay import load_capture
    records=load_capture(path)['records']
    for row in value['rows']:
        if row['valid']:
            p=records[row['recordIndex']]['payload']
            d=np.array(p['lookAtPoint']);d/=np.linalg.norm(d)
            row['appearance']=[*d,0,0,-.5]
    return value


def test_extract_retains_missing_images_and_exact_pairing(tmp_path):
    path=make_capture(tmp_path)
    bundle=bundle_for(path)
    assert bundle['complete'] and bundle['modelFingerprint']==FINGERPRINT
    assert sum(r['reason']=='image_unavailable' for r in bundle['rows'] if not r['valid'])==18
    assert all(r['timestamp']==r['seq']/60+1 for r in bundle['rows'])
    broken=copy.deepcopy(bundle);broken['rows'][1]['timestamp']+=.001
    with pytest.raises(ValueError,match='timestamp'):
        benchmark(path,broken)
    with pytest.raises(ValueError,match='rectified'):
        extract(path,rotation=0,assume_rectified=False,frontend=Frontend(),backend_factory=Backend)


def test_frozen_validation_and_common_subset_without_label_leakage(tmp_path):
    a=make_capture(tmp_path/'a');b=make_capture(tmp_path/'b',validation_shift=.04)
    first=benchmark(a,bundle_for(a));second=benchmark(b,bundle_for(b))
    assert first['reports'][0]['models']==second['reports'][0]['models']
    validation=first['reports'][1]
    assert validation['ok'] and validation['commonSamples']==36
    assert validation['imageCoverage']==1 and validation['packetCoverage']==.8
    assert all(m['meanPoints']<3 for m in validation['models'].values())
    assert all(m['meanPoints']>35 for m in second['reports'][1]['models'].values())
    assert not first['promoted']


def test_reset_invalidates_all_comparators(tmp_path):
    path=make_capture(tmp_path,reset=True)
    result=benchmark(path,bundle_for(path))
    assert result['reports'][0]['ok']
    assert not result['reports'][1]['ok']
    assert result['reports'][1]['reason']=='no frozen calibration for this session'


def test_raw_comparison_does_not_hide_posture_abstentions(tmp_path, monkeypatch):
    from eye.iphone_models import IPhoneModel
    path = make_capture(tmp_path)
    monkeypatch.setattr(IPhoneModel, 'supports', lambda self, x: np.zeros(len(np.atleast_2d(x)), dtype=bool))
    report = benchmark(path, bundle_for(path))['reports'][1]
    assert report['ok'] and report['commonSamples'] == 36
    assert report['geometrySupportedFraction'] == 0
    assert report['models']['geometry']['samples'] == 36
    assert report['models']['geometry']['meanPoints'] < 3


def test_initialization_failure_aborts_instead_of_fabricating_completed_run(tmp_path):
    path=make_capture(tmp_path)
    def bad(camera): raise ValueError('missing verified weights')
    with pytest.raises(RuntimeError,match='initialization'):
        extract(path,rotation=90,assume_rectified=True,frontend=Frontend(),backend_factory=bad)


def test_receiver_rejections_reduce_observation_coverage(tmp_path):
    path=make_capture(tmp_path,rejection_events=True)
    result=benchmark(path,bundle_for(path))
    report=result['reports'][1]
    assert report['imageCoverage']==1
    assert report['packetCoverage']==.8
    assert report['observationCoverage']==pytest.approx(4/9)
    assert report['attemptedObservations']==81
    assert result['rejected']['iphone_out_of_order']==18


def test_recenter_is_replayed_before_frozen_validation(tmp_path):
    path=make_capture(tmp_path,recenter=True)
    result=benchmark(path,bundle_for(path))
    assert [r['mode'] for r in result['reports']]==['training','recenter','validation']
    assert all(r['ok'] for r in result['reports'])
    assert set(result['reports'][1]['correctionsPoints'])=={'geometry','appearance','fused'}
