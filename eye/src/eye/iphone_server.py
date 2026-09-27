"""Paired iPhone sensor input on a private interface; browser output on loopback.

Numeric ARKit tracking and optional bounded RGB research frames are accepted.
Images stay local and are saved only during an explicit recording. No cloud service
or saved webcam calibration is involved. Pairing expires when this process exits.
"""
from __future__ import annotations

import argparse
import asyncio
from collections import deque
from contextlib import asynccontextmanager
import hmac
import ipaddress
import json
import math
import mimetypes
import os
from pathlib import Path
import secrets
import subprocess
import time
from urllib.parse import urlsplit

from websockets.asyncio.server import broadcast, serve
from websockets.datastructures import Headers
from websockets.http11 import Response

WEB_DIR = Path(__file__).parent / 'web'


def response(status, text, content_type='text/plain'):
    return Response(status, 'OK' if status == 200 else 'Forbidden',
                    Headers({'Content-Type': content_type, 'Cache-Control': 'no-store',
                             'X-Content-Type-Options': 'nosniff'}), text.encode())


def validate_phone_host(host):
    try:
        address = ipaddress.ip_address(host)
    except ValueError as exc:
        raise ValueError('phone host must be a literal private IPv4 address') from exc
    if address.version != 4 or not address.is_private or address.is_unspecified or address.is_multicast:
        raise ValueError('phone listener must bind one private IPv4 interface, never all interfaces')
    return host


def local_host(request):
    hosts = request.headers.get_all('Host')
    if len(hosts) != 1:
        return False
    try:
        parsed = urlsplit('http://' + hosts[0])
        return (parsed.hostname in ('127.0.0.1', 'localhost', '::1') and not parsed.username
                and not parsed.password and not parsed.path and not parsed.query and not parsed.fragment)
    except ValueError:
        return False


class IPhoneBridge:
    def __init__(self, stream, phone_host, phone_port=8766, token=None, extension_id=None, capture_root=None, appearance=None):
        self.stream = stream
        self.phone_host = validate_phone_host(phone_host)
        self.phone_port = phone_port
        self.token = token or secrets.token_urlsafe(24)
        if len(self.token) < 24:
            raise ValueError('pairing token must have at least 24 characters')
        self.extension_origin = None
        if extension_id is not None:
            import re
            if not re.fullmatch('[a-p]{32}', extension_id):
                raise ValueError('invalid extension ID')
            self.extension_origin = 'chrome-extension://' + extension_id
        self.clients = set()
        self.phone = None
        self.received = 0
        self.errors = 0
        self.last_received = None
        self.arrivals = deque()
        self.stream.emit = self.emit
        self.capture_root = Path(capture_root) if capture_root is not None else None
        self.capture = None
        self.capture_status = {'type': 'record_status', 'active': False, 'available': self.capture_root is not None}
        self.last_result = None
        self.image_frames = 0
        self.latest_packet = None
        self.appearance = appearance
        self.appearance_clients = set()
        self.appearance_result = None
        if appearance is not None:
            appearance.emit = self.emit_appearance

    def emit_appearance(self, message):
        if message.get('type') == 'appearance_gaze':
            message = {**message, 'type': 'gaze', 'quality': 'tracked' if message.get('valid') else 'invalid'}
        if message.get('type') == 'calib_result':
            self.appearance_result = message
        broadcast(self.appearance_clients, json.dumps(message, allow_nan=False))

    async def appearance_handler(self, ws):
        if self.appearance is None:
            await ws.close(code=1008, reason='appearance profile not configured')
            return
        self.appearance_clients.add(ws)
        await ws.send(json.dumps(self.appearance.hello()))
        await ws.send(json.dumps(self.status()))
        await ws.send(json.dumps(dict(type='record_status', available=False, active=False)))
        try:
            async for text in ws:
                try:
                    msg = json.loads(text)
                    if not isinstance(msg, dict):
                        raise ValueError('object required')
                    if msg.get('type') == 'calib_target_end':
                        await self.appearance.drain_target()
                    reply = self.appearance.browser_command(msg)
                except (ValueError, KeyError, TypeError, OverflowError) as exc:
                    reply = dict(type='error', error=str(exc)[:240])
                if reply:
                    if reply.get('type') == 'calib_result':
                        self.emit_appearance(reply)
                    else:
                        await ws.send(json.dumps(reply, allow_nan=False))
        finally:
            self.appearance_clients.discard(ws)

    def _record(self, method, value, now=None):
        if self.capture is None:
            return
        try:
            getattr(self.capture, method)(value, time.monotonic() if now is None else now)
        except (OSError, ValueError, RuntimeError) as exc:
            capture, self.capture = self.capture, None
            try:
                capture.close()
            except (OSError, ValueError, RuntimeError):
                pass
            self.capture_status = {'type': 'record_status', 'active': False,
                                   'available': True, 'error': str(exc)[:240]}
            broadcast(self.clients, json.dumps(self.capture_status))

    def emit(self, message):
        if message.get('type') == 'calib_result':
            self.last_result = message
        self._record('record_event', message)
        broadcast(self.clients, json.dumps(message, separators=(',', ':'), allow_nan=False))

    def pairing(self):
        return {'endpoint': f'ws://{self.phone_host}:{self.phone_port}/iphone',
                'token': self.token, 'transport': 'local-wifi', 'phoneConnected': self.phone is not None}

    def status(self):
        now = time.monotonic()
        while self.arrivals and self.arrivals[0] < now - 1:
            self.arrivals.popleft()
        return {'type': 'iphone_status', 'connected': self.phone is not None,
                'stale': self.last_received is None or now - self.last_received > .5,
                'receivingHz': len(self.arrivals),
                'depthAvailable': self.stream.depth_available,
                'source': 'ARKit TrueDepth', 'imageFrames': self.image_frames}

    def phone_request(self, connection, request):
        if request.path != '/iphone' or request.headers.get_all('Origin'):
            return response(403, 'native paired phone input only\n')
        values = request.headers.get_all('Authorization')
        if len(values) != 1 or not hmac.compare_digest(values[0], 'Bearer ' + self.token):
            return response(403, 'pairing required\n')
        if request.headers.get('Upgrade', '').lower() != 'websocket':
            return response(403, 'websocket required\n')
        return None

    def browser_request(self, connection, request):
        if not local_host(request):
            return response(403, 'loopback host required\n')
        origins = request.headers.get_all('Origin')
        if origins:
            if len(origins) != 1:
                return response(403, 'one origin required\n')
            origin = origins[0]
            try:
                parsed = urlsplit(origin)
                same = (parsed.scheme == 'http' and parsed.netloc == request.headers['Host']
                        and not parsed.path and not parsed.query and not parsed.fragment)
            except ValueError:
                same = False
            extension_ws = origin == self.extension_origin and self.extension_origin is not None and request.path == '/ws'
            if not same and not extension_ws:
                return response(403, 'same-origin browser required\n')
        if request.path in ('/ws', '/appearance/ws'):
            return None
        if request.path == '/pairing':
            # Secrets are never exposed on the phone listener or in gaze events.
            return response(200, json.dumps(self.pairing()), 'application/json')
        if request.path == '/report':
            return response(200, json.dumps({'lastResult': self.last_result, 'recording': self.capture_status, 'appearanceResult': self.appearance_result, 'appearanceAvailable': self.appearance is not None}), 'application/json')
        if request.path == '/status':
            return response(200, json.dumps({'phoneConnected': self.phone is not None,
                'received': self.received, 'invalidPackets': self.errors,
                'lastReceivedAgeMs': None if self.last_received is None else (time.monotonic() - self.last_received) * 1000}), 'application/json')
        static_path = urlsplit(request.path).path
        name = 'iphone.html' if static_path in ('/', '/iphone.html') else static_path.lstrip('/')
        if name not in ('iphone.html', 'eye-client.js', 'dom-targets.js', 'iphone-protocol.js'):
            return response(404, 'not found\n')
        path = WEB_DIR / name
        if not path.is_file():
            return response(404, 'not found\n')
        return response(200, path.read_text(), mimetypes.guess_type(path.name)[0] or 'text/plain')

    async def phone_handler(self, ws):
        if self.phone is not None:
            await ws.close(code=1008, reason='another phone is paired')
            return
        self.phone = ws
        self.latest_packet = None
        self.last_received = None
        self.arrivals.clear()
        self.emit(self.status())
        await ws.send(json.dumps({'type': 'paired', 'schema': 1}))
        try:
            async for text in ws:
                try:
                    if not isinstance(text, str):
                        raise ValueError('text JSON required')
                    packet = json.loads(text)
                    if not isinstance(packet, dict):
                        raise ValueError('object required')
                except (ValueError, TypeError, KeyError, OverflowError) as exc:
                    self.errors += 1
                    self.stream.lost('invalid_iphone_packet')
                    await ws.send(json.dumps({'type': 'error', 'error': str(exc)[:240]}))
                    continue
                if 'image' in packet:
                    from .iphone_capture import validate_packet_image
                    try:
                        validate_packet_image(packet)
                    except ValueError as exc:
                        self.errors += 1
                        await ws.send(json.dumps({'type': 'error', 'error': str(exc)[:240]}))
                        continue
                before = self.stream.last_received
                try:
                    self.stream.handle_frame(packet, received_t=time.monotonic())
                except (ValueError, TypeError, KeyError, OverflowError) as exc:
                    self.errors += 1
                    await ws.send(json.dumps({'type': 'error', 'error': str(exc)[:240]}))
                    continue
                if self.stream.last_received == before:
                    continue
                if self.appearance is not None:
                    self.appearance.submit(packet, self.stream.last_received)
                self.latest_packet = {k:v for k,v in packet.items() if k != 'image'}
                self._record('record_packet', packet, self.stream.last_received)
                self.image_frames += int('image' in packet)
                self.received += 1
                self.last_received = self.stream.last_received
                self.arrivals.append(self.last_received)
        finally:
            if self.phone is ws:
                self.phone = None
                self.latest_packet = None
                self.stream.lost('iphone_disconnected')
                if self.appearance is not None:
                    self.appearance.reset()
                self.last_received = None
                self.arrivals.clear()
                self.emit(self.status())

    async def browser_handler(self, ws):
        if ws.request.path == '/appearance/ws':
            return await self.appearance_handler(ws)
        self.clients.add(ws)
        await ws.send(json.dumps(self.stream.hello()))
        await ws.send(json.dumps(self.status()))
        await ws.send(json.dumps(self.capture_status))
        try:
            async for text in ws:
                try:
                    msg = json.loads(text)
                    if not isinstance(msg, dict):
                        raise ValueError('object required')
                    if msg.get('type') in ('record_start', 'record_stop'):
                        if ws.request.headers.get('Origin', '').startswith('chrome-extension:'):
                            raise ValueError('recording is controlled by the local console only')
                        if msg['type'] == 'record_start':
                            if self.capture_root is None:
                                raise ValueError('recording directory not configured')
                            if self.capture is not None:
                                raise ValueError('recording already active')
                            from .iphone_capture import IPhoneCapture
                            hello = self.stream.hello()
                            self.capture = IPhoneCapture(self.capture_root, {'display': hello['display'],
                                'backend': hello['backend'], 'protocol': 'iphone-repeated-pose-v1'})
                            if self.latest_packet is not None:
                                self.capture.record_packet(self.latest_packet, self.stream.last_received)
                            self.capture_status = {'type': 'record_status', 'active': True, 'available': True,
                                                   'path': str(self.capture.path)}
                        else:
                            if self.capture is not None:
                                capture, self.capture = self.capture, None
                                capture.close()
                            self.capture_status = {**self.capture_status, 'active': False}
                        reply = {**self.capture_status, 'requestId': msg.get('requestId')}
                        self.emit(reply)
                        continue
                    self._record('record_command', msg)
                    reply = self.stream.command(msg)
                except (ValueError, TypeError, KeyError, OverflowError, OSError) as exc:
                    reply = {'type': 'error', 'error': str(exc)[:240]}
                if reply:
                    if reply.get('type') in ('calib_result', 'hello'):
                        self.emit(reply)
                    else:
                        await ws.send(json.dumps(reply, allow_nan=False))
        finally:
            self.clients.discard(ws)

    @asynccontextmanager
    async def listen(self, browser_port=8767):
        async with serve(self.phone_handler, self.phone_host, self.phone_port,
                         process_request=self.phone_request, max_size=768 * 1024, max_queue=1,
                         compression=None) as phone_server:
            self.phone_port = phone_server.sockets[0].getsockname()[1]
            async with serve(self.browser_handler, '127.0.0.1', browser_port,
                             process_request=self.browser_request, max_size=4096,
                             max_queue=8, compression=None) as browser_server:
                try:
                    yield phone_server, browser_server
                finally:
                    if self.appearance is not None:
                        await self.appearance.close()
                    if self.capture is not None:
                        capture, self.capture = self.capture, None
                        try:
                            capture.close()
                        except (OSError, ValueError, RuntimeError) as exc:
                            self.capture_status = {**self.capture_status, 'error': str(exc)[:240]}
                        self.capture_status = {**self.capture_status, 'active': False}

    async def run(self, browser_port=8767):
        async with self.listen(browser_port) as (_, browser):
            port = browser.sockets[0].getsockname()[1]
            print(f'iPhone tracking console: http://127.0.0.1:{port}/', flush=True)
            print('Open the console for pairing and explicit local experiment recording. RGB images are optional.', flush=True)
            last_status = 0
            while True:
                self.stream.tick(received_t=time.monotonic())
                if self.appearance is not None:
                    self.appearance.tick()
                if time.monotonic() - last_status >= .5:
                    self.emit(self.status())
                    broadcast(self.appearance_clients, json.dumps(self.status()))
                    last_status = time.monotonic()
                await asyncio.sleep(1 / 30)


def discover_host():
    for interface in ('en0', 'en1'):
        found = subprocess.run(['ipconfig', 'getifaddr', interface], capture_output=True, text=True)
        if found.returncode == 0:
            return validate_phone_host(found.stdout.strip())
    raise ValueError('no Wi-Fi IPv4 address found; pass --phone-host with your Mac’s private LAN address')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--phone-host', help='private Mac Wi-Fi IPv4; defaults to en0/en1')
    parser.add_argument('--phone-port', type=int, default=8766)
    parser.add_argument('--port', type=int, default=8767, help='loopback browser port')
    parser.add_argument('--extension-id')
    parser.add_argument('--capture-root', type=Path, help='enable explicit local recording into this directory')
    parser.add_argument('--appearance-profile', type=Path, help='explicit frozen local appearance challenger profile')
    for name in ('upstream', 'weights', 'landmark-cache'):
        parser.add_argument('--appearance-' + name, type=Path)
    parser.add_argument('--appearance-device', choices=('cpu', 'mps'), default='cpu')
    parser.add_argument('--appearance-landmark-device', choices=('cpu', 'mps'), default='cpu')
    parser.add_argument('--appearance-assume-rectified', action='store_true')
    args = parser.parse_args()
    from .iphone_tracking import IPhoneGazeStream
    from .screen import pick
    display = pick()
    # Approximate angle only: 55 cm is an assumption, not measured phone depth.
    pt_per_deg = display.points_per_mm * 550 * math.tan(math.radians(1))
    bridge = IPhoneBridge(IPhoneGazeStream(display, lambda _: None, pt_per_deg), args.phone_host or discover_host(),
                         args.phone_port, token=os.environ.get('EYE_PAIRING_TOKEN'), extension_id=args.extension_id, capture_root=args.capture_root)
    if args.appearance_profile:
        if not all((args.appearance_upstream, args.appearance_weights, args.appearance_landmark_cache,
                    args.appearance_assume_rectified)):
            parser.error('appearance requires local model paths and --appearance-assume-rectified')
        from .iphone_appearance_profile import load_profile
        from .iphone_live_appearance import ImageInference, LiveAppearance
        profile = load_profile(args.appearance_profile)
        if any(profile.metadata['display'][k] != bridge.stream.display[k] for k in ('x','y','w','h','scale')):
            parser.error('appearance profile display differs from current display')
        bridge.appearance = LiveAppearance(
            infer=ImageInference(rotation=profile.metadata['rotationClockwise'], assume_rectified=True,
                upstream=args.appearance_upstream, weights=args.appearance_weights,
                landmark_cache=args.appearance_landmark_cache, device=args.appearance_device,
                landmark_device=args.appearance_landmark_device, camera_geometry=profile.metadata['cameraGeometry']),
            predict=profile.predict, display=bridge.stream.hello()['display'], emit=bridge.emit_appearance)
    try:
        asyncio.run(bridge.run(args.port))
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
