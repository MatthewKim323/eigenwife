import asyncio
import threading
import numpy as np
import pytest
from eye.iphone_live_appearance import LiveAppearance
from test_iphone_tracking import packet


def make(**kwargs):
    events=[]
    live=LiveAppearance(infer=lambda p: [0,0,1,0,0,1], predict=lambda f: np.array([[.4,.6]]),
        display=dict(x=0,y=0,w=1000,h=800,scale=2), emit=events.append, **kwargs)
    return live,events


def test_latest_only_and_session_discards_inflight():
    async def run():
        entered,release=threading.Event(),threading.Event()
        live,events=make()
        def infer(p):
            entered.set();release.wait(2)
            return [0]*6
        live.infer=infer
        p=packet(1);p['image']={}
        live.submit(p)
        await asyncio.to_thread(entered.wait,1)
        for i in range(2,20):
            p=packet(i,session=live.session);p['image']={};live.submit(p)
        assert live.counts['replaced']==17
        live.reset()
        release.set()
        await live.task
        assert not any(e.get('valid') for e in events)
        await live.close()
    asyncio.run(run())


def test_stale_output_and_profile_session_guard():
    async def run():
        now=[1.]
        live,events=make(clock=lambda:now[0])
        def infer(p):
            now[0]=2.
            return [0]*6
        live.infer=infer
        p=packet(1);p['image']={};live.submit(p)
        await live.task
        assert events[-1]['reason']=='appearance_result_stale'
        assert live.counts['valid']==0
        await live.close()
        live,events=make(session_id='different')
        live.submit(p)
        assert events[-1]['reason']=='profile_session_mismatch'
        assert live.task is None
        await live.close()
    asyncio.run(run())


def test_frozen_validation_and_request_ids():
    live,events=make()
    for cmd in ('calib_begin','calib_reset','calib_finish'):
        with pytest.raises(ValueError):live.browser_command(dict(type=cmd))
    live.browser_command(dict(type='calib_begin',validateOnly=True))
    for x,y in ((.1,.1),(.9,.1),(.5,.5),(.1,.9),(.9,.9)):
        live.browser_command(dict(type='calib_target',x=x*1000,y=y*800))
        live.target['attemptedImages']=5
        live.target['predictions']=[[x,y]]*5
        reply=live.browser_command(dict(type='calib_target_end',requestId=12))
        assert reply['ok'] and reply['requestId']==12
    result=live.browser_command(dict(type='calib_finish',validateOnly=True,requestId=13))
    assert result['ok'] and result['meanPoints']==0 and result['requestId']==13
    assert result['type']=='calib_result'
    live.executor.shutdown()


def test_blink_image_counts_against_validation_coverage():
    live,events=make()
    p=packet(1)
    live.submit(p)
    live.browser_command(dict(type='calib_begin',validateOnly=True))
    live.browser_command(dict(type='calib_target',nx=.5,ny=.5))
    p=packet(2,session=live.session);p['image']={};p['blinkLeft']=1
    live.submit(p)
    result=live.browser_command(dict(type='calib_target_end'))
    assert result['attempted']==1 and result['coverage']==0
    live.executor.shutdown()


def test_boundary_drain_preserves_received_target_without_late_contamination():
    async def run():
        entered,release=threading.Event(),threading.Event()
        live,events=make()
        p=packet(1);live.submit(p)
        live.browser_command(dict(type='calib_begin',validateOnly=True))
        live.browser_command(dict(type='calib_target',x=500,y=400))
        def infer(p):
            entered.set();release.wait(2);return [0]*6
        live.infer=infer
        p=packet(2,session=live.session);p['image']={};live.submit(p)
        await asyncio.to_thread(entered.wait,1)
        drain=asyncio.create_task(live.drain_target())
        await asyncio.sleep(0)
        assert live.target is None
        release.set();await drain
        reply=live.browser_command(dict(type='calib_target_end'))
        assert reply['samples']==1 and reply['attempted']==1
        live.browser_command(dict(type='calib_target',x=900,y=720))
        assert live.target['predictions']==[]
        assert any(e.get('type')=='face' and e.get('present') for e in events)
        await live.close()
    asyncio.run(run())
