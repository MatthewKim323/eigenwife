import copy
import json
import stat
import numpy as np
import pytest
from eye.iphone_appearance_profile import fit_profile, export_profile, load_profile
from test_iphone_appearance import make_capture, bundle_for


def test_export_roundtrip_private_no_validation_fitting(tmp_path):
    a=make_capture(tmp_path/'a');b=make_capture(tmp_path/'b',validation_shift=.04)
    profile=fit_profile(a,bundle_for(a));other=fit_profile(b,bundle_for(b))
    for key in profile.arrays:np.testing.assert_array_equal(profile.arrays[key],other.arrays[key])
    path=export_profile(profile,tmp_path/'profile.json')
    assert stat.S_IMODE(path.stat().st_mode)==0o600
    loaded=load_profile(path)
    assert loaded.metadata['promoted'] is False
    assert loaded.metadata['rotationClockwise']==0
    ray=np.array([0,0,1,0,0,-.5])
    np.testing.assert_array_equal(loaded.predict(ray),profile.predict(ray))
    with pytest.raises(FileExistsError):export_profile(profile,path)
    with pytest.raises(ValueError,match='unit gaze'):loaded.predict([0]*6)
    value=json.loads(path.read_text());value['payload']['arrays']['coef'][0][0]+=1
    path.write_text(json.dumps(value))
    with pytest.raises(ValueError,match='digest'):load_profile(path)


def test_profile_rejects_reset_or_bad_pairing(tmp_path):
    path=make_capture(tmp_path/'reset',reset=True)
    with pytest.raises(ValueError,match='complete current'):fit_profile(path,bundle_for(path))
    path=make_capture(tmp_path/'okay');bundle=bundle_for(path)
    broken=copy.deepcopy(bundle);broken['rows'][1]['seq']+=1
    with pytest.raises(ValueError,match='identity'):fit_profile(path,broken)
    broken=copy.deepcopy(bundle);broken['rotationClockwise']=42
    with pytest.raises(ValueError,match='rotation'):fit_profile(path,broken)


def test_profile_recenter_matches_benchmark_acceptance(tmp_path):
    from eye.iphone_appearance import benchmark
    path=make_capture(tmp_path,recenter=True);bundle=bundle_for(path)
    report=benchmark(path,bundle)
    profile=fit_profile(path,bundle)
    recenter=next(r for r in report['reports'] if r['mode']=='recenter')
    assert recenter['ok']
    np.testing.assert_allclose(profile.arrays['offset'],np.array(recenter['correctionsPoints']['appearance'])/[1000,800])


@pytest.mark.parametrize('suffix', ['unfinished','session_change','disconnect'])
def test_profile_rejects_ambiguous_or_invalidated_tail(tmp_path,suffix):
    from eye.iphone_capture import IPhoneCapture
    from eye.iphone_replay import iter_capture
    from test_iphone_tracking import packet
    path=make_capture(tmp_path/'source')
    c=IPhoneCapture(tmp_path/'copy',{'display':dict(x=0,y=0,w=1000,h=800,scale=2)})
    for record in iter_capture(path):
        getattr(c, 'record_'+record['kind'])(record['payload'],record['received_t'])
    if suffix=='unfinished':c.record_command(dict(type='calib_begin'),100.)
    elif suffix=='session_change':c.record_packet(packet(),100.)
    else:c.record_event(dict(type='gaze',valid=False,reason='iphone_disconnected'),100.)
    c.close()
    with pytest.raises(ValueError,match='complete current|unfinished'):fit_profile(c.path,bundle_for(c.path))
