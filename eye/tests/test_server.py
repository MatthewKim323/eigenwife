"""Exercise actual HTTP responses and WebSocket handshakes, without a camera."""
import asyncio
import dataclasses
import json
import pytest
from websockets.asyncio.client import connect
from websockets.asyncio.server import serve
from websockets.exceptions import InvalidStatus
from eye.server import _static, _persist, load_correction
from eye.stream import Correction
from test_stream import _stream


def test_real_http_and_websocket_origin_handling():
    async def check():
        async def handler(ws):
            await ws.send('connected')
        async def request(connection, request):
            return _static(request)
        async with serve(handler, '127.0.0.1', 0, process_request=request) as server:
            port = server.sockets[0].getsockname()[1]
            async def http(origin):
                reader, writer = await asyncio.open_connection('127.0.0.1', port)
                writer.write(f'GET /eye-client.js HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: {origin}\r\nConnection: close\r\n\r\n'.encode())
                await writer.drain()
                result = (await reader.read()).decode()
                writer.close()
                await writer.wait_closed()
                return result
            for origin in ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://[::1]:5173']:
                response = await http(origin)
                assert '200 OK' in response
                assert f'Access-Control-Allow-Origin: {origin}' in response
                async with connect(f'ws://127.0.0.1:{port}/ws', origin=origin) as ws:
                    assert await ws.recv() == 'connected'
            for origin in ['https://evil.example', 'null', 'http://localhost.evil.example', 'http://127.0.0.1@evil.example']:
                assert '403 Forbidden' in await http(origin)
                with pytest.raises(InvalidStatus):
                    async with connect(f'ws://127.0.0.1:{port}/ws', origin=origin):
                        pass
            async with connect(f'ws://127.0.0.1:{port}/ws') as ws:
                assert await ws.recv() == 'connected'
    asyncio.run(check())


def test_correction_bound_to_model_and_display(tmp_path, monkeypatch):
    stream, _ = _stream(tmp_path)
    path = tmp_path / 'correction.json'
    monkeypatch.setattr('eye.server.paths.correction_file', lambda: path)
    stream.correction = Correction([[1,0,.1],[0,1,0]])
    _persist(stream)
    assert load_correction(stream) is not None
    stream.display = dataclasses.replace(stream.display, w=stream.display.w+1)
    assert load_correction(stream) is None
    stream.display = dataclasses.replace(stream.display, w=stream.display.w-1)
    # A changed regression coefficient invalidates an old correction.
    arrays = stream.calib.model.to_arrays()
    key = next(k for k, v in arrays.items() if getattr(v, 'size', 0) > 1)
    arrays[key].flat[0] += .5
    assert load_correction(stream) is None
    path.write_text(json.dumps({'a': [[1,0,.1],[0,1,0]]}))
    assert load_correction(stream) is None


def test_extension_origin_is_opt_in_exact_and_websocket_only():
    from websockets.http11 import Request
    from websockets.datastructures import Headers
    from eye.server import extension_origin
    origin = extension_origin('a' * 32)
    request = lambda path, value: Request(path, Headers({'Origin': value}))
    assert _static(request('/ws', origin)).status_code == 403
    assert _static(request('/ws', origin), origin) is None
    assert _static(request('/ws', 'chrome-extension://' + 'b' * 32), origin).status_code == 403
    assert _static(request('/ws', origin + '.evil'), origin).status_code == 403
    assert _static(request('/eye-client.js', origin), origin).status_code == 403
    assert _static(request('/ws', 'https://evil.example'), origin).status_code == 403
    with pytest.raises(ValueError):
        extension_origin('bad')
