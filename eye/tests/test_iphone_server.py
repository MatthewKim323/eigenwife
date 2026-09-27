"""Exercise paired sensor and browser listeners using real loopback sockets."""
import asyncio
import json

import pytest
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

from eye.iphone_server import IPhoneBridge, validate_phone_host
from eye.iphone_tracking import IPhoneGazeStream
from test_iphone_tracking import packet

TOKEN = 'test-pairing-secret-0123456789abcdef'
EXTENSION = 'a' * 32


def bridge():
    stream = IPhoneGazeStream(dict(x=0, y=0, w=1000, h=800, scale=2), lambda _: None)
    return IPhoneBridge(stream, '127.0.0.1', phone_port=0, token=TOKEN, extension_id=EXTENSION)


async def http(port, path, headers=()):
    reader, writer = await asyncio.open_connection('127.0.0.1', port)
    supplied = list(headers)
    if not any(k.lower() == 'host' for k, _ in supplied):
        supplied.insert(0, ('Host', f'127.0.0.1:{port}'))
    lines = [f'GET {path} HTTP/1.1', *(f'{k}: {v}' for k, v in supplied), 'Connection: close', '', '']
    writer.write('\r\n'.join(lines).encode())
    await writer.drain()
    result = (await asyncio.wait_for(reader.read(), 2)).decode()
    writer.close()
    await writer.wait_closed()
    return result


async def until(ws, kind):
    for _ in range(30):
        raw = await asyncio.wait_for(ws.recv(), 2)
        assert TOKEN not in raw
        msg = json.loads(raw)
        if msg.get('type') == kind:
            return msg
    raise AssertionError(f'did not receive {kind}')


def test_phone_bearer_auth_origin_and_path_gate():
    async def check():
        b = bridge()
        async with b.listen(browser_port=0) as (phone, _):
            port = phone.sockets[0].getsockname()[1]
            url = f'ws://127.0.0.1:{port}/iphone'
            cases = [({}, None), ({'Authorization': 'Bearer wrong'}, None),
                     ({'Authorization': 'Bearer ' + TOKEN}, 'http://127.0.0.1'),
                     ({'Authorization': 'Bearer ' + TOKEN}, 'null'),
                     ([('Authorization', 'Bearer ' + TOKEN), ('Authorization', 'Bearer ' + TOKEN)], None)]
            for headers, origin in cases:
                with pytest.raises(InvalidStatus) as exc:
                    async with connect(url, additional_headers=headers, origin=origin):
                        pass
                assert exc.value.response.status_code == 403
            with pytest.raises(InvalidStatus) as exc:
                async with connect(url.replace('/iphone', '/pairing'), additional_headers={'Authorization': 'Bearer ' + TOKEN}):
                    pass
            assert exc.value.response.status_code == 403
            for path in ('/pairing', '/status', '/'):
                result = await http(port, path)
                assert '403 Forbidden' in result and TOKEN not in result
            async with connect(url, additional_headers={'Authorization': 'Bearer ' + TOKEN}) as ws:
                assert (await until(ws, 'paired'))['schema'] == 1
    asyncio.run(check())


def test_browser_origin_host_gates_and_pairing_isolation():
    async def check():
        b = bridge()
        async with b.listen(browser_port=0) as (_, browser):
            port = browser.sockets[0].getsockname()[1]
            origin = f'http://127.0.0.1:{port}'
            url = f'ws://127.0.0.1:{port}/ws'
            for allowed in (None, origin, 'chrome-extension://' + EXTENSION):
                async with connect(url, origin=allowed) as ws:
                    hello = await until(ws, 'hello')
                    assert hello['backend']['name'] == 'iphone-arkit'
            for disallowed in ('null', 'https://evil.example', 'http://127.0.0.1:99',
                               origin + '/path', 'chrome-extension://' + 'b' * 32):
                with pytest.raises(InvalidStatus) as exc:
                    async with connect(url, origin=disallowed):
                        pass
                assert exc.value.response.status_code == 403
                result = await http(port, '/pairing', [('Origin', disallowed)])
                assert '403 Forbidden' in result and TOKEN not in result
            for headers in ([('Host', 'evil.example')], [('Host', '127.0.0.1'), ('Host', 'evil.example')],
                            [('Host', '127.0.0.1@evil.example')], [('Origin', origin), ('Origin', origin)]):
                result = await http(port, '/pairing', headers)
                assert '403 Forbidden' in result and TOKEN not in result
            # Extension can read gaze but cannot request the pairing secret.
            result = await http(port, '/pairing', [('Origin', 'chrome-extension://' + EXTENSION)])
            assert '403 Forbidden' in result and TOKEN not in result
            result = await http(port, '/pairing', [('Origin', origin)])
            assert '200 OK' in result and 'Cache-Control: no-store' in result
            pairing = json.loads(result.split('\r\n\r\n', 1)[1])
            assert pairing['token'] == TOKEN and pairing['endpoint'].endswith('/iphone')
            for path in ('/status', '/eye-client.js', '/', '/../iphone_server.py'):
                result = await http(port, path, [('Origin', origin)])
                assert TOKEN not in result
    asyncio.run(check())


def test_single_phone_valid_frames_malformed_packets_and_disconnect():
    async def check():
        b = bridge()
        async with b.listen(browser_port=0) as (phone, browser):
            phone_port = phone.sockets[0].getsockname()[1]
            browser_port = browser.sockets[0].getsockname()[1]
            auth = {'Authorization': 'Bearer ' + TOKEN}
            url = f'ws://127.0.0.1:{phone_port}/iphone'
            async with connect(f'ws://127.0.0.1:{browser_port}/ws') as client:
                await until(client, 'hello')
                assert not (await until(client, 'iphone_status'))['connected']
                async with connect(url, additional_headers=auth) as sensor:
                    await until(sensor, 'paired')
                    assert (await until(client, 'iphone_status'))['connected']
                    async with connect(url, additional_headers=auth) as duplicate:
                        with pytest.raises(ConnectionClosed) as exc:
                            await duplicate.recv()
                        assert exc.value.rcvd.code == 1008
                    p = packet()
                    await sensor.send(json.dumps(p))
                    gaze = await until(client, 'gaze')
                    assert not gaze['valid'] and gaze['reason'] == 'iphone_needs_calibration'
                    assert b.stream.face and b.received == 1
                    await sensor.send(json.dumps(p))
                    assert (await until(client, 'gaze'))['reason'] == 'iphone_out_of_order'
                    assert b.received == 1
                    for malformed in ('{', '[]', b'bytes', json.dumps({**p, 'lookAtPoint': [0, 0, 0]})):
                        await sensor.send(malformed)
                        reply = await until(sensor, 'error')
                        assert reply['error']
                        assert not (await until(client, 'gaze'))['valid']
                    assert b.errors == 4 and b.received == 1
                    # Receiver remains useful after a malformed frame.
                    p['seq'], p['timestamp'] = 1, 2
                    await sensor.send(json.dumps(p))
                    for _ in range(10):
                        await until(client, 'gaze')
                        if b.received == 2:
                            break
                    assert b.received == 2 and b.stream.face
                # The original connection owns disconnection and map invalidation.
                for _ in range(10):
                    msg = await until(client, 'gaze')
                    if msg.get('reason') == 'iphone_disconnected':
                        break
                assert msg['reason'] == 'iphone_disconnected'
                assert b.phone is None and not b.stream.calibrated and not b.stream.face
                assert not (await until(client, 'iphone_status'))['connected']
    asyncio.run(check())


@pytest.mark.parametrize('host', ['0.0.0.0', '::', '::1', '8.8.8.8', '224.0.0.1', 'localhost'])
def test_phone_bind_rejects_public_wildcard_and_dns(host):
    with pytest.raises(ValueError):
        validate_phone_host(host)


def research_image():
    import base64
    import cv2
    import numpy as np
    rgb = np.random.default_rng(42).integers(0, 256, (256, 256, 3), dtype=np.uint8)
    ok, data = cv2.imencode('.jpg', rgb, [cv2.IMWRITE_JPEG_QUALITY, 85])
    assert ok and data.nbytes > 16384
    return dict(encoding='jpeg', data=base64.b64encode(data).decode(), width=256, height=256,
                intrinsics=[200,0,0,0,500*256/480,0,128,128,1], mirrored=False, orientation='sensor')


async def assert_numeric_until(ws, kind):
    for _ in range(100):
        raw = await asyncio.wait_for(ws.recv(), 2)
        assert TOKEN not in raw
        assert '"data"' not in raw and '"image"' not in raw and '/9j/' not in raw
        msg = json.loads(raw)
        if msg.get('type') == kind:
            return msg
    raise AssertionError(f'did not receive {kind}')


def test_explicit_recording_large_rgb_and_report_survives_disconnect(tmp_path):
    from eye.iphone_replay import load_capture, replay_numeric

    async def check():
        b = bridge()
        b.capture_root = tmp_path/'captures'
        b.capture_status['available'] = True
        async with b.listen(browser_port=0) as (phone, browser):
            pp, bp = phone.sockets[0].getsockname()[1], browser.sockets[0].getsockname()[1]
            origin = f'http://127.0.0.1:{bp}'
            async with connect(f'ws://127.0.0.1:{bp}/ws', origin=origin) as client:
                await until(client, 'record_status')
                async with connect(f'ws://127.0.0.1:{pp}/iphone', additional_headers={'Authorization':'Bearer '+TOKEN}) as sensor:
                    await until(sensor, 'paired')
                    p = packet()
                    p['image'] = research_image()
                    await sensor.send(json.dumps(p))
                    await assert_numeric_until(client, 'gaze')
                    assert b.image_frames == 1 and b.received == 1
                    assert not b.capture_root.exists(), 'live image reception must not silently record'
                    await client.send(json.dumps({'type':'record_start','requestId':'start'}))
                    started = await until(client, 'record_status')
                    assert started['active'] and started['requestId'] == 'start'
                    path = b.capture.path
                    # Start a complete new calibration while recording; fit can replay offline.
                    await client.send(json.dumps({'type':'calib_begin'}))
                    await until(client, 'calib_begin')
                    seq = 0
                    for x in (.1,.5,.9):
                        for y in (.1,.5,.9):
                            await client.send(json.dumps({'type':'calib_target','nx':x,'ny':y}))
                            # A round-trip on the same socket confirms the target command was handled.
                            await client.send(json.dumps({'type':'hello'}))
                            await until(client, 'hello')
                            for _ in range(5):
                                seq += 1
                                current = packet(seq,(x-.5)*.2,(y-.5)*.2,p['sessionId'])
                                if seq == 1:
                                    current['image'] = p['image']
                                await sensor.send(json.dumps(current))
                                await assert_numeric_until(client, 'gaze')
                            await client.send(json.dumps({'type':'calib_target_end'}))
                            assert (await until(client, 'calib_point'))['ok']
                    await client.send(json.dumps({'type':'calib_finish'}))
                    result = await until(client, 'calib_result')
                    assert result['ok'] and result['applied']
                    await client.send(json.dumps({'type':'record_stop','requestId':'stop'}))
                    stopped = await until(client, 'record_status')
                    assert not stopped['active'] and stopped['requestId'] == 'stop'
                    capture = load_capture(path)
                    assert len(list((path/'images').iterdir())) == 1
                    assert len([r for r in capture['records'] if r['kind']=='packet']) == 46
                    assert TOKEN not in json.dumps(capture)
                    recorded_packets = [r['payload'] for r in capture['records'] if r['kind']=='packet']
                    assert recorded_packets[0]['seq'] == 0 and 'image' not in recorded_packets[0]
                    report = replay_numeric(path)
                    assert report['packets'] == 46
                    assert report['results'][-1]['ok']
                    assert report['results'][-1]['trainMeanPoints'] == pytest.approx(result['trainMeanPoints'])
                while True:
                    disconnected = await until(client, 'iphone_status')
                    if not disconnected['connected']:
                        break
                response = await http(bp, '/report', [('Origin',origin)])
                retained = json.loads(response.split('\r\n\r\n',1)[1])
                assert retained['lastResult'] == result
                assert not retained['recording']['active']
                assert not b.stream.calibrated
    asyncio.run(check())


def test_malformed_image_isolated_and_no_image_bytes_reach_browser(tmp_path):
    async def check():
        b = bridge()
        b.capture_root = tmp_path
        async with b.listen(browser_port=0) as (phone,browser):
            pp,bp = phone.sockets[0].getsockname()[1],browser.sockets[0].getsockname()[1]
            async with connect(f'ws://127.0.0.1:{bp}/ws') as client:
                await until(client,'record_status')
                async with connect(f'ws://127.0.0.1:{pp}/iphone',additional_headers={'Authorization':'Bearer '+TOKEN}) as sensor:
                    await until(sensor,'paired')
                    p = packet()
                    p['image'] = {**research_image(), 'data':'not JPEG'}
                    await sensor.send(json.dumps(p))
                    assert (await until(sensor,'error'))['error']
                    assert b.received == 0 and b.errors == 1 and b.image_frames == 0
                    p['image'] = research_image()
                    p['image']['intrinsics'][0] += 10
                    await sensor.send(json.dumps(p))
                    assert 'scale' in (await until(sensor,'error'))['error']
                    assert b.received == 0 and b.errors == 2 and b.image_frames == 0
                    del p['image']
                    await sensor.send(json.dumps(p))
                    assert (await assert_numeric_until(client,'gaze'))['reason'] == 'iphone_needs_calibration'
                    assert b.received == 1 and b.stream.face
                    assert not list(tmp_path.iterdir())
    asyncio.run(check())


def test_recording_limits_stop_capture_and_extension_cannot_control_it(tmp_path):
    from eye.iphone_replay import load_capture

    async def check():
        b = bridge()
        b.capture_root = tmp_path
        async with b.listen(browser_port=0) as (phone,browser):
            pp,bp = phone.sockets[0].getsockname()[1],browser.sockets[0].getsockname()[1]
            url = f'ws://127.0.0.1:{bp}/ws'
            async with connect(url,origin='chrome-extension://'+EXTENSION) as extension:
                await until(extension,'record_status')
                await extension.send(json.dumps({'type':'record_start'}))
                assert 'local console' in (await until(extension,'error'))['error']
                assert b.capture is None and not list(tmp_path.iterdir())
                async with connect(url,origin=f'http://127.0.0.1:{bp}') as client:
                    await until(client,'record_status')
                    await client.send(json.dumps({'type':'record_start'}))
                    assert (await until(client,'record_status'))['active']
                    await until(extension,'record_status')
                    await extension.send(json.dumps({'type':'record_stop'}))
                    assert 'local console' in (await until(extension,'error'))['error']
                    assert b.capture is not None
                    path = b.capture.path
                    limit = b.capture.count+1
                    b.capture.max_records = limit
                    async with connect(f'ws://127.0.0.1:{pp}/iphone',additional_headers={'Authorization':'Bearer '+TOKEN}) as sensor:
                        await until(sensor,'paired')
                        await sensor.send(json.dumps(packet()))
                        stopped = await until(client,'record_status')
                        assert not stopped['active'] and 'limit' in stopped['error']
                        assert b.capture is None
                        capture = load_capture(path)
                        assert capture['manifest']['records'] <= limit
                        # Exhausting disk-capture bounds must not stop numeric tracking.
                        await until(client,'gaze')
                        assert b.received == 1
                        before = (path/'records.jsonl').stat().st_size
                        await client.send(json.dumps({'type':'hello'}))
                        await until(client,'hello')
                        assert (path/'records.jsonl').stat().st_size == before
    asyncio.run(check())


def test_recording_disabled_by_default_and_filesystem_error_is_recoverable(tmp_path):
    async def check():
        b = bridge()
        async with b.listen(browser_port=0) as (_, browser):
            bp = browser.sockets[0].getsockname()[1]
            async with connect(f'ws://127.0.0.1:{bp}/ws') as client:
                status = await until(client, 'record_status')
                assert not status['available'] and not status['active']
                await client.send(json.dumps({'type':'record_start'}))
                assert 'not configured' in (await until(client,'error'))['error']
                blocked = tmp_path/'not-a-directory'
                blocked.write_text('preserve me')
                b.capture_root = blocked
                await client.send(json.dumps({'type':'record_start'}))
                failure = await until(client,'error')
                assert failure['error'] and b.capture is None
                assert blocked.read_text() == 'preserve me'
                # Disk failure must not tear down the otherwise useful client socket.
                await client.send(json.dumps({'type':'hello'}))
                assert (await until(client,'hello'))['backend']['name'] == 'iphone-arkit'
    asyncio.run(check())


def test_appearance_endpoint_isolated_frozen_and_explicit():
    from eye.iphone_live_appearance import LiveAppearance
    async def check():
        b = bridge()
        b.appearance = LiveAppearance(infer=lambda _: [0]*6, predict=lambda _: [.5,.5],
            display=b.stream.display, emit=b.emit_appearance)
        async with b.listen(browser_port=0) as (_, browser):
            port=browser.sockets[0].getsockname()[1]
            url=f'ws://127.0.0.1:{port}'
            assert '200 OK' in await http(port,'/?source=appearance')
            with pytest.raises(InvalidStatus):
                async with connect(url+'/appearance/ws',origin='chrome-extension://'+EXTENSION):
                    pass
            async with connect(url+'/appearance/ws') as appearance, connect(url+'/ws') as numeric:
                assert (await until(appearance,'hello'))['backend']['name']=='iphone-appearance-frozen'
                assert (await until(numeric,'hello'))['backend']['name']=='iphone-arkit'
                await until(appearance,'record_status');await until(numeric,'record_status')
                await appearance.send(json.dumps(dict(type='calib_reset')))
                assert 'unsupported' in (await until(appearance,'error'))['error']
                b.emit_appearance(dict(type='appearance_gaze',valid=True,nx=.5,ny=.5))
                assert (await until(appearance,'gaze'))['valid']
                with pytest.raises(asyncio.TimeoutError):
                    await asyncio.wait_for(numeric.recv(),.03)
    asyncio.run(check())
