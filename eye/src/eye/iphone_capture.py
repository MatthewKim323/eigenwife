"""Explicit, bounded iPhone experiment capture. Never records pairing credentials."""
from __future__ import annotations

import base64
import hashlib
import json
import math
import os
from pathlib import Path
import time
import uuid

import cv2
import numpy as np

MAX_IMAGE_BYTES = 512 * 1024
MAX_IMAGE_PIXELS = 2_000_000
PACKET_KEYS = set('type schema sessionId seq timestamp tracked reason cameraTransform faceTransform leftEyeTransform rightEyeTransform lookAtPoint intrinsics imageSize blinkLeft blinkRight depthAvailable depthTimestamp depthCentralM image'.split())
SECRET_WORDS = ('token', 'secret', 'password', 'authorization', 'pairing', 'credential')


def _safe(value):
    """Reject secret-bearing fields instead of quietly persisting them."""
    if isinstance(value, dict):
        for key, child in value.items():
            if not isinstance(key, str) or any(word in key.lower() for word in SECRET_WORDS):
                raise ValueError('capture excludes credentials')
            _safe(child)
    elif isinstance(value, list):
        for child in value:
            _safe(child)
    # Also rejects NaN and non-JSON types.
    json.dumps(value, allow_nan=False)
    return value


def validate_phone_image(image):
    """Validate the optional sensor-oriented JPEG; return decoded JPEG bytes.

    The matrix belongs to this encoded image, not the original ARFrame size.
    No EXIF orientation or mirroring is applied by the decoder.
    """
    if not isinstance(image, dict) or set(image) != {'encoding', 'data', 'width', 'height', 'intrinsics', 'mirrored', 'orientation'}:
        raise ValueError('invalid image fields')
    w, h = image['width'], image['height']
    if (type(w) is not int or type(h) is not int or min(w, h) < 16 or max(w, h) > 1280 or w*h > MAX_IMAGE_PIXELS):
        raise ValueError('image dimensions exceed bounds')
    if image['encoding'] != 'jpeg' or image['mirrored'] is not False or image['orientation'] != 'sensor':
        raise ValueError('image must be an unmirrored sensor-oriented JPEG')
    k = image['intrinsics']
    if not isinstance(k, list) or len(k) != 9 or any(type(v) not in (int, float) or not math.isfinite(v) for v in k):
        raise ValueError('invalid image intrinsics')
    k = np.array(k).reshape(3, 3, order='F')
    if k[0, 0] <= 0 or k[1, 1] <= 0 or not np.allclose(k[2], [0, 0, 1], atol=1e-5) or not (0 <= k[0, 2] < w and 0 <= k[1, 2] < h):
        raise ValueError('invalid image intrinsics')
    encoded = image['data']
    if not isinstance(encoded, str) or len(encoded) > 4*((MAX_IMAGE_BYTES+2)//3):
        raise ValueError('image data exceeds bounds')
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (ValueError, base64.binascii.Error) as exc:
        raise ValueError('invalid image base64') from exc
    if not raw or len(raw) > MAX_IMAGE_BYTES or not raw.startswith(b'\xff\xd8') or not raw.endswith(b'\xff\xd9'):
        raise ValueError('invalid JPEG')
    # Read JPEG SOF dimensions before OpenCV allocates its decoded pixel buffer.
    pos, dimensions = 2, None
    while pos < len(raw):
        if raw[pos] != 255:
            raise ValueError('invalid JPEG marker')
        while pos < len(raw) and raw[pos] == 255:
            pos += 1
        if pos >= len(raw):
            break
        marker = raw[pos]; pos += 1
        if marker in (0xD9, 0xDA):
            break
        if marker in range(0xD0, 0xD8) or marker == 1:
            continue
        if pos+2 > len(raw):
            raise ValueError('truncated JPEG')
        length = int.from_bytes(raw[pos:pos+2], 'big')
        if length < 2 or pos+length > len(raw):
            raise ValueError('invalid JPEG segment')
        if marker in (0xC0, 0xC1, 0xC2):
            if length < 8:
                raise ValueError('invalid JPEG dimensions')
            dimensions = (int.from_bytes(raw[pos+5:pos+7], 'big'), int.from_bytes(raw[pos+3:pos+5], 'big'))
            break
        pos += length
    if dimensions != (w, h):
        raise ValueError('JPEG dimensions differ from metadata')
    pixels = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR | cv2.IMREAD_IGNORE_ORIENTATION)
    if pixels is None or pixels.shape[:2] != (h, w):
        raise ValueError('JPEG cannot be decoded')
    return raw



def validate_packet_image(packet):
    """Require JPEG intrinsics to match a resize of the ARFrame sensor image."""
    if not isinstance(packet, dict) or 'image' not in packet:
        raise ValueError('packet image required')
    raw = validate_phone_image(packet['image'])
    original = packet.get('intrinsics')
    size = packet.get('imageSize')
    if (not isinstance(original, list) or len(original) != 9 or
            any(type(v) not in (int, float) or not math.isfinite(v) for v in original) or
            not isinstance(size, list) or len(size) != 2 or
            any(type(v) not in (int, float) or not math.isfinite(v) or v <= 0 or v != int(v) for v in size)):
        raise ValueError('source image geometry required')
    source_k = np.array(original).reshape(3, 3, order='F')
    if (source_k[0, 0] <= 0 or source_k[1, 1] <= 0 or
            not np.allclose(source_k[2], [0, 0, 1], atol=1e-5) or
            not (0 <= source_k[0, 2] < size[0] and 0 <= source_k[1, 2] < size[1])):
        raise ValueError('invalid source image intrinsics')
    image = packet['image']
    expected = np.diag([image['width']/size[0], image['height']/size[1], 1.0]) @ source_k
    actual = np.array(image['intrinsics']).reshape(3, 3, order='F')
    if not np.allclose(actual, expected, atol=1e-4, rtol=1e-5):
        raise ValueError('image intrinsics must scale from source sensor geometry')
    return raw


def _write_private(path, raw):
    with open(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as f:
        f.write(raw)
        f.flush()
        os.fsync(f.fileno())


class IPhoneCapture:
    def __init__(self, directory, metadata, *, max_bytes=512*1024*1024, max_duration=1200, max_records=60000):
        metadata_raw = json.dumps(_safe(metadata), allow_nan=False)
        if not isinstance(metadata, dict) or len(metadata_raw.encode()) > 64*1024:
            raise ValueError('capture metadata must be a bounded object')
        self.metadata = json.loads(metadata_raw)
        if (type(max_bytes) is not int or type(max_records) is not int or
                not math.isfinite(max_duration) or max_bytes <= 0 or max_duration <= 0 or max_records <= 0):
            raise ValueError('capture bounds must be positive')
        self.max_bytes, self.max_duration, self.max_records = max_bytes, max_duration, max_records
        root = Path(directory)
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path = root / ('iphone-' + time.strftime('%Y%m%d-%H%M%S') + '-' + uuid.uuid4().hex[:12])
        self.path.mkdir(mode=0o700)
        (self.path / 'images').mkdir(mode=0o700)
        self.started = time.monotonic()
        self.bytes = self.count = 0
        self.closed = False
        self.first_received = None
        self.files = {}
        self._digest = hashlib.sha256()
        self._log = open(os.open(self.path / 'records.jsonl', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb')

    def _record(self, kind, msg, received_t):
        if self.closed:
            raise ValueError('capture is closed')
        if type(received_t) not in (int, float) or not math.isfinite(received_t) or received_t < 0:
            raise ValueError('invalid receive timestamp')
        if self.first_received is None:
            self.first_received = received_t
        if time.monotonic()-self.started > self.max_duration or received_t-self.first_received > self.max_duration or self.count >= self.max_records:
            raise ValueError('capture duration or record limit reached')
        if not isinstance(msg, dict):
            raise ValueError('capture payload must be an object')
        msg = json.loads(json.dumps(_safe(msg), allow_nan=False))
        image_raw = None
        if kind == 'packet' and 'image' in msg:
            image_raw = validate_phone_image(msg['image'])
            relative = f'images/{self.count:06d}.jpg'
            msg['image'].pop('data')
            msg['image']['path'] = relative
            msg['image']['sha256'] = hashlib.sha256(image_raw).hexdigest()
        line = (json.dumps({'kind': kind, 'received_t': received_t, 'payload': msg}, allow_nan=False, separators=(',', ':'))+'\n').encode()
        extra = len(line) + (len(image_raw) if image_raw else 0)
        if len(line) > 256*1024 or self.bytes+extra > self.max_bytes:
            raise ValueError('capture byte limit reached')
        if image_raw:
            _write_private(self.path / relative, image_raw)
            self.files[relative] = {'bytes': len(image_raw), 'sha256': msg['image']['sha256']}
        self._log.write(line)
        self._log.flush()
        self._digest.update(line)
        self.count += 1
        self.bytes += extra

    def record_packet(self, packet, received_t):
        if not isinstance(packet, dict):
            raise ValueError('packet must be an object')
        _safe(packet)
        self._record('packet', {k: v for k, v in packet.items() if k in PACKET_KEYS}, received_t)

    def record_command(self, msg, received_t):
        self._record('command', msg, received_t)

    def record_event(self, msg, received_t):
        self._record('event', msg, received_t)

    def close(self):
        if self.closed:
            return self.manifest
        self._log.flush(); os.fsync(self._log.fileno()); self._log.close()
        self.files['records.jsonl'] = {'bytes': (self.path/'records.jsonl').stat().st_size, 'sha256': self._digest.hexdigest()}
        self.manifest = {'schema': 1, 'complete': True, 'records': self.count, 'bytes': self.bytes,
                         'metadata': self.metadata, 'files': self.files}
        raw = json.dumps(self.manifest, allow_nan=False, indent=2).encode()
        _write_private(self.path/'manifest.json', raw)
        self.closed = True
        return self.manifest
