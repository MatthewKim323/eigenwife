"""Integrity-checked offline iPhone capture replay. Does not access a camera."""
from __future__ import annotations
import argparse
import base64
import hashlib
import json
import math
from pathlib import Path

from .iphone_capture import validate_phone_image


def load_capture(path):
    root = Path(path).resolve()
    manifest_path = root / 'manifest.json'
    if not manifest_path.is_file() or manifest_path.is_symlink() or manifest_path.stat().st_size > 16*1024*1024:
        raise ValueError('capture is incomplete: missing or invalid manifest')
    manifest = json.loads(manifest_path.read_text())
    if manifest.get('schema') != 1 or manifest.get('complete') is not True:
        raise ValueError('capture is incomplete or unsupported')
    files = manifest.get('files')
    if not isinstance(files, dict) or 'records.jsonl' not in files or len(files) > 60001:
        raise ValueError('invalid capture file list')
    total = 0
    for relative, info in files.items():
        p = Path(relative)
        if p.is_absolute() or '..' in p.parts or (relative != 'records.jsonl' and (len(p.parts) != 2 or p.parts[0] != 'images' or p.suffix != '.jpg')):
            raise ValueError('invalid capture path')
        file = root / p
        if file.is_symlink() or file.parent.is_symlink() or not file.is_file():
            raise ValueError('missing or unsafe capture file')
        size = file.stat().st_size
        total += size
        if size != info.get('bytes') or total > 512*1024*1024:
            raise ValueError('capture size mismatch or limit exceeded')
        digest = hashlib.sha256()
        with file.open('rb') as f:
            while chunk := f.read(1024*1024):
                digest.update(chunk)
        if digest.hexdigest() != info.get('sha256'):
            raise ValueError('capture checksum mismatch')
    if total != manifest.get('bytes'):
        raise ValueError('capture total size mismatch')
    records = []
    with (root/'records.jsonl').open() as f:
        for line in f:
            if len(line) > 256*1024 or len(records) >= 60000:
                raise ValueError('record limit exceeded')
            record = json.loads(line)
            if (not isinstance(record, dict) or record.get('kind') not in ('packet', 'command', 'event') or
                    not isinstance(record.get('payload'), dict) or
                    type(record.get('received_t')) not in (int, float) or
                    not math.isfinite(record['received_t']) or record['received_t'] < 0):
                raise ValueError('invalid capture record')
            image = record['payload'].get('image') if record['kind'] == 'packet' else None
            if image is not None:
                if (not isinstance(image, dict) or not isinstance(image.get('path'), str) or
                        not image['path'].startswith('images/') or image['path'] not in files or
                        image.get('sha256') != files[image['path']]['sha256']):
                    raise ValueError('unlisted image or image checksum mismatch')
            records.append(record)
    if len(records) != manifest.get('records'):
        raise ValueError('capture record count mismatch')
    return {'metadata': manifest['metadata'], 'records': records, 'manifest': manifest}


def iter_capture(path, include_images=True):
    capture = load_capture(path)
    root = Path(path)
    for record in capture['records']:
        image = record['payload'].get('image') if record['kind'] == 'packet' else None
        if image is not None:
            if include_images:
                raw = (root/image.pop('path')).read_bytes()
                image.pop('sha256')
                image['data'] = base64.b64encode(raw).decode('ascii')
                validate_phone_image(image)
            else:
                record['payload'].pop('image')
        yield record


def replay_numeric(path):
    from .iphone_tracking import IPhoneGazeStream
    capture = load_capture(path)
    display = capture['metadata']['display']
    stream = IPhoneGazeStream(display, lambda event: None, pt_per_deg=display.get('ptPerDeg', 49.0))
    results = []
    packets = 0
    for record in iter_capture(path, include_images=False):
        kind, payload = record['kind'], record['payload']
        if kind == 'packet':
            stream.handle_frame(payload, received_t=record['received_t'])
            packets += 1
        elif kind == 'event' and payload.get('type') == 'gaze' and payload.get('reason') in {'iphone_stale', 'iphone_disconnected', 'invalid_iphone_packet', 'iphone_invalid_packet'}:
            # These loss transitions originate in the receiver, not a packet.
            stream.lost(payload['reason'], received_t=record['received_t'])
        elif kind == 'event' and payload.get('type') == 'gaze' and payload.get('reason') == 'iphone_out_of_order':
            # Rejected packets are not recorded; retain their coverage penalty.
            stream._reject('iphone_out_of_order', record['received_t'])
        elif kind == 'command' and payload.get('type') in {'hello', 'calib_begin', 'calib_target', 'calib_target_end', 'calib_reset', 'calib_finish'}:
            result = stream.command(payload)
            if result and result.get('type') == 'calib_result':
                results.append(result)
    return {'packets': packets, 'results': results, 'finalState': stream.hello()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('capture')
    parser.add_argument('--numeric', action='store_true', help='replay recorded calibration and validation without sleeping')
    args = parser.parse_args()
    output = replay_numeric(args.capture) if args.numeric else {k: v for k, v in load_capture(args.capture).items() if k != 'records'}
    print(json.dumps(output, indent=2, allow_nan=False))


if __name__ == '__main__':
    main()
