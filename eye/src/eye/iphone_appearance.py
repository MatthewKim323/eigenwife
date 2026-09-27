"""Offline iPhone RGB/UniGaze challenger. Never promotes a model or opens a camera.

Extract with explicit image rotation and rectification assumption, then benchmark
frozen personal mappings on recorded validation episodes. Cached models only.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import time

import cv2
import numpy as np
from .gaze_model import GazeModel
from .iphone_capture import validate_phone_image
from .iphone_models import fit_iphone_model, design
from .iphone_replay import load_capture, iter_capture
from .iphone_tracking import decode_iphone_frame
from .unigaze_backend import CameraCalibration, FINGERPRINT, LandmarkFrontend, UniGazeBackend

CV_TO_AR = np.diag([1., -1., -1.])


def rotate_camera(bgr, matrix, rotation):
    """Clockwise degrees. Return pixels, intrinsics and original→rotated axes.

    Pixel homography H and camera rotation R obey K_rot = H K R.T. This is
    necessary: rotating pixels alone invalidates PnP and gaze normalization.
    """
    h, w = bgr.shape[:2]
    if rotation == 0:
        H, R, pixels = np.eye(3), np.eye(3), bgr
    elif rotation == 90:
        H = np.array([[0., -1, h-1], [1, 0, 0], [0, 0, 1]])
        R = np.array([[0., -1, 0], [1, 0, 0], [0, 0, 1]])
        pixels = cv2.rotate(bgr, cv2.ROTATE_90_CLOCKWISE)
    elif rotation == 180:
        H = np.array([[-1., 0, w-1], [0, -1, h-1], [0, 0, 1]])
        R = np.diag([-1., -1., 1.])
        pixels = cv2.rotate(bgr, cv2.ROTATE_180)
    elif rotation == 270:
        H = np.array([[0., 1, 0], [-1, 0, w-1], [0, 0, 1]])
        R = np.array([[0., 1, 0], [-1, 0, 0], [0, 0, 1]])
        pixels = cv2.rotate(bgr, cv2.ROTATE_90_COUNTERCLOCKWISE)
    else:
        raise ValueError('rotation must be 0, 90, 180 or 270 clockwise')
    return pixels, H @ matrix @ R.T, R


def ray_to_arkit(ray, rotation):
    direction = CV_TO_AR @ rotation.T @ ray.direction_camera
    direction /= np.linalg.norm(direction)
    # Generic face-model origin is NOT a TrueDepth metric estimate.
    origin = CV_TO_AR @ rotation.T @ ray.origin_camera_mm / 1000
    return np.r_[direction, origin]


def capture_digest(path):
    return hashlib.sha256((Path(path)/'manifest.json').read_bytes()).hexdigest()


def extract(path, *, rotation, assume_rectified, frontend=None, backend_factory=None):
    if rotation not in (0, 90, 180, 270):
        raise ValueError('rotation must be 0, 90, 180 or 270 clockwise')
    if not assume_rectified:
        raise ValueError('AR image distortion coefficients unavailable: explicitly assume rectified to run this experiment')
    capture = load_capture(path)
    rows, backend = [], None
    if frontend is None or backend_factory is None:
        raise ValueError('explicit local frontend and backend factory required')
    for index, record in enumerate(iter_capture(path)):
        if record['kind'] != 'packet':
            continue
        packet = record['payload']
        row = dict(recordIndex=index, sessionId=packet.get('sessionId'), seq=packet.get('seq'),
                   timestamp=packet.get('timestamp'), received_t=record['received_t'], valid=False,
                   imageAvailable='image' in packet)
        try:
            frame = decode_iphone_frame(packet)
            if not frame.valid:
                raise ValueError(frame.reason)
            if 'image' not in packet:
                raise ValueError('image_unavailable')
            image = packet['image']
            jpeg = validate_phone_image(image)
            bgr = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR | cv2.IMREAD_IGNORE_ORIENTATION)
            K = np.asarray(image['intrinsics']).reshape(3, 3, order='F')
            bgr, K, R = rotate_camera(bgr, K, rotation)
            camera = CameraCalibration(K, np.zeros(5), bgr.shape[1], bgr.shape[0],
                                       'iphone-recorded-AR-intrinsics-assumed-rectified')
            if backend is None:
                # Expensive asset verification and weight loading occur once.
                try:
                    backend = backend_factory(camera)
                except Exception as exc:
                    raise RuntimeError('appearance backend initialization failed') from exc
            backend.camera = camera
            start = time.perf_counter()
            ray = backend.infer(bgr, frontend.detect(bgr))
            features = ray_to_arkit(ray, R)
            if not np.isfinite(features).all():
                raise ValueError('nonfinite appearance ray')
            row.update(valid=True, appearance=features.tolist(),
                       inferenceMs=(time.perf_counter()-start)*1000,
                       reprojectionErrorPx=float(ray.reprojection_error_px),
                       cameraFingerprint=camera.fingerprint)
        except (ValueError, cv2.error) as exc:
            row['reason'] = str(exc)
        rows.append(row)
    return dict(schema=1, complete=True, sourceManifestSHA256=capture_digest(path),
                modelFingerprint=FINGERPRINT, rotationClockwise=rotation,
                assumptions=['AR scaled intrinsics correspond to encoded sensor pixels',
                             'images assumed rectified; distortion coefficients unavailable',
                             'appearance origin uses a generic face model, not measured depth'],
                metadata=capture['metadata'], rows=rows)


def _fit_ridge(x, y, groups, weights, scale):
    # Same nested outer partitions as the geometry model; this fixed candidate
    # never chooses a representation using held-out validation labels.
    x, y, groups = np.asarray(x), np.asarray(y), np.asarray(groups)
    errors = np.empty(len(x))
    unique = np.unique(groups)
    def make():
        return GazeModel(degree=1, scale_floor=np.full(x.shape[1], .02), clip=20)
    for i in range(3):
        test = np.isin(groups, unique[i::3])
        model = make()
        model.fit(x[~test], y[~test], groups=groups[~test], weights=weights[~test], error_scale=scale)
        errors[test] = np.linalg.norm((model.predict(x[test])-y[test])*scale, axis=1)
    final = make()
    final.fit(x, y, groups=groups, weights=weights, error_scale=scale)
    return final, {'cvMeanPoints': float(np.average(errors, weights=weights)),
                   'evaluation': 'nested_target_grouped_development'}


def _summary(targets, name, scale):
    errors = [np.linalg.norm((np.array(p['predictions'][name])-p['xy'])*scale, axis=1)
              for p in targets if p['predictions'][name]]
    return dict(meanPoints=float(np.mean([e.mean() for e in errors])),
                p90Points=float(np.percentile(np.concatenate(errors), 90)),
                targetCount=len(errors), samples=sum(map(len, errors)), measurement='raw_unsmoothed')


def benchmark(path, bundle):
    capture = load_capture(path)
    if (bundle.get('schema') != 1 or bundle.get('complete') is not True or
            bundle.get('sourceManifestSHA256') != capture_digest(path) or bundle.get('modelFingerprint') != FINGERPRINT):
        raise ValueError('appearance bundle must be complete and match this capture and pinned model')
    packet_indices = [i for i, r in enumerate(capture['records']) if r['kind'] == 'packet']
    rows = bundle.get('rows', [])
    if [r.get('recordIndex') for r in rows] != packet_indices:
        raise ValueError('appearance rows must exactly cover capture packets in order')
    by_index = dict(zip(packet_indices, rows))
    display = capture['metadata']['display']
    scale = np.array([display['w'], display['h']])
    models, offsets, targets, collecting, session = {}, {}, [], None, None
    reports, last_seq, last_t = [], -1, -1
    rejected = {}
    for index, record in enumerate(capture['records']):
        kind, msg = record['kind'], record['payload']
        if kind == 'packet':
            row = by_index[index]
            if (any(row.get(k) != msg.get(k) for k in ('sessionId', 'seq', 'timestamp')) or
                    row.get('received_t') != record['received_t'] or row.get('imageAvailable') != ('image' in msg)):
                raise ValueError('appearance row identity/timestamp mismatch')
            frame = decode_iphone_frame(msg)
            if frame.session_id != session:
                models, offsets, targets, collecting = {}, {}, [], None
                session, last_seq, last_t = frame.session_id, -1, -1
            if frame.seq <= last_seq or frame.t <= last_t:
                if collecting is not None:
                    collecting['attempted'] += 1
                continue
            last_seq, last_t = frame.seq, frame.t
            if collecting is None:
                continue
            collecting['attempted'] += 1
            collecting['packets'] += 1
            collecting['images'] += int(row['imageAvailable'])
            if not frame.valid or row.get('valid') is not True:
                reason = frame.reason or row.get('reason', 'appearance_rejected')
                rejected[reason] = rejected.get(reason, 0)+1
                continue
            appearance = np.asarray(row.get('appearance'), dtype=float)
            if appearance.shape != (6,) or not np.isfinite(appearance).all() or not np.isclose(np.linalg.norm(appearance[:3]), 1, atol=1e-4):
                raise ValueError('invalid appearance ray')
            features = {'geometry': frame.geometry_features, 'appearance': appearance,
                        'fused': np.r_[frame.geometry_features, appearance]}
            # Diagnostic comparison measures the underlying mapping, including
            # extrapolation failures. Live posture abstention is reported apart
            # from raw accuracy so it cannot hide difficult validation samples.
            predictions = {n: (model.model.predict(design(features[n], model.name)) if n == 'geometry'
                              else model.predict(features[n]))[0]+offsets[n] for n, model in models.items()}
            if 'geometry' in models:
                collecting['geometrySupported'] += int(models['geometry'].supports(features['geometry'])[0])
            collecting['features'].append(features)
            if any(not np.isfinite(p).all() for p in predictions.values()):
                rejected['mapping_invalid'] = rejected.get('mapping_invalid', 0)+1
                continue
            for name, prediction in predictions.items():
                collecting['predictions'][name].append(prediction)
        elif kind == 'event' and msg.get('type') == 'gaze' and msg.get('reason') == 'iphone_disconnected':
            models, offsets, targets, collecting, session = {}, {}, [], None, None
        elif kind == 'event' and msg.get('type') == 'gaze' and msg.get('reason') in {
                'iphone_stale', 'invalid_iphone_packet', 'iphone_invalid_packet', 'iphone_out_of_order'}:
            # Receiver omits rejected packets but records these rejection events.
            # Blink/face-lost events correspond to recorded accepted packets and
            # must not be counted again here.
            if collecting is not None:
                collecting['attempted'] += 1
                reason = msg['reason']
                rejected[reason] = rejected.get(reason, 0)+1
        elif kind == 'command':
            cmd = msg.get('type')
            if cmd in ('calib_begin', 'calib_reset'):
                targets, collecting = [], None
                if cmd == 'calib_reset':
                    models, offsets = {}, {}
            elif cmd == 'calib_target':
                xy = np.array([msg['nx'], msg['ny']]) if 'nx' in msg else (np.array([msg['x'], msg['y']])-[display['x'], display['y']])/scale
                if not np.isfinite(xy).all() or np.any(xy < 0) or np.any(xy > 1):
                    raise ValueError('invalid recorded target')
                if msg.get('retry'):
                    if not targets or not np.allclose(targets[-1]['xy'], xy):
                        raise ValueError('invalid recorded retry')
                    collecting = targets[-1]
                else:
                    collecting = dict(xy=xy, features=[], predictions={n: [] for n in models}, attempted=0, packets=0, images=0, geometrySupported=0)
                    targets.append(collecting)
            elif cmd == 'calib_target_end':
                collecting = None
            elif cmd == 'calib_finish':
                validate, recenter = bool(msg.get('validateOnly')), bool(msg.get('recenterOnly'))
                mode = 'validation' if validate else 'recenter' if recenter else 'training'
                report = dict(mode=mode, recordIndex=index, ok=False, commonSamples=sum(len(p['features']) for p in targets),
                              attemptedPackets=sum(p['packets'] for p in targets), attemptedObservations=sum(p['attempted'] for p in targets), imagePackets=sum(p['images'] for p in targets))
                report['imageCoverage'] = report['commonSamples']/max(1, report['imagePackets'])
                report['packetCoverage'] = report['commonSamples']/max(1, report['attemptedPackets'])
                report['observationCoverage'] = report['commonSamples']/max(1, report['attemptedObservations'])
                report['geometrySupportedFraction'] = (sum(p['geometrySupported'] for p in targets)/max(1,report['commonSamples'])) if models else None
                minimum = 1 if recenter else 5 if validate else 9
                unique = np.unique(np.array([p['xy'] for p in targets]).round(5), axis=0) if targets else []
                good = (len(unique) >= minimum and all(len(p['features']) >= 3 and len(p['features'])/max(1,p['images']) >= .8 for p in targets))
                if not recenter and len(unique):
                    good = good and np.all(np.ptp(unique, axis=0) >= .5)
                if not good or (validate and recenter):
                    report['reason'] = 'insufficient distinct targets, screen span, or common image coverage'
                elif validate or recenter:
                    if not models or any(len(p['predictions'].get(n, [])) != len(p['features']) for p in targets for n in models):
                        report['reason'] = 'no frozen calibration for this session'
                    elif validate:
                        report.update(ok=True, models={n: _summary(targets, n, scale) for n in models})
                    else:
                        p = targets[0]
                        corrections, acceptable = {}, len(targets) == 1 and np.all(np.abs(p['xy']-.5) <= .15) and len(p['features']) >= 15
                        for n in models:
                            pred = np.array(p['predictions'][n]); center = np.median(pred, axis=0)
                            correction = p['xy']-center
                            jitter = np.sqrt(np.mean(np.sum(((pred-center)*scale)**2, axis=1)))
                            acceptable = acceptable and jitter <= 60 and np.linalg.norm(correction*scale) <= .3*np.linalg.norm(scale)
                            corrections[n] = correction
                        if acceptable:
                            for n in models:
                                offsets[n] += corrections[n]
                            report.update(ok=True, correctionsPoints={n: (v*scale).tolist() for n,v in corrections.items()})
                        else:
                            report['reason'] = 'recenter quality failed for at least one comparator; none updated'
                else:
                    labels = np.vstack([np.tile(p['xy'], (len(p['features']),1)) for p in targets])
                    _, groups = np.unique(labels.round(5), axis=0, return_inverse=True)
                    weights = np.array([1/np.count_nonzero(groups == g) for g in groups])
                    features = {n: np.vstack([f[n] for p in targets for f in p['features']]) for n in ('geometry','appearance','fused')}
                    geometry, stats = fit_iphone_model(features['geometry'], labels, groups, weights, scale)
                    models, offsets = {'geometry': geometry}, {n: np.zeros(2) for n in features}
                    diagnostics = {'geometry': stats}
                    for n in ('appearance','fused'):
                        models[n], diagnostics[n] = _fit_ridge(features[n], labels, groups, weights, scale)
                    report.update(ok=True, models=diagnostics)
                reports.append(report)
                targets, collecting = [], None
    latency = [r['inferenceMs'] for r in rows if r.get('valid') and 'inferenceMs' in r]
    return dict(schema=1, sourceManifestSHA256=bundle['sourceManifestSHA256'], modelFingerprint=FINGERPRINT,
                assumptions=bundle.get('assumptions'), rotationClockwise=bundle.get('rotationClockwise'),
                comparison='raw mappings on identical valid-image subset, before live posture abstention; geometrySupportedFraction separately reports support; independent of live full-rate accuracy',
                promoted=False, reports=reports, rejected=rejected,
                availability=dict(recordedPackets=len(rows), imagePackets=sum(bool(r.get('imageAvailable')) for r in rows),
                                  validAppearancePackets=sum(r.get('valid') is True for r in rows)),
                inferenceMedianMs=float(np.median(latency)) if latency else None,
                inferenceP95Ms=float(np.percentile(latency,95)) if latency else None,
                latencyScope='landmark detection + inference only; excludes capture/network/browser and model loading')


def write_output(path, value):
    raw = json.dumps(value, indent=2, allow_nan=False)
    with open(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as f:
        f.write(raw+'\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    subs = parser.add_subparsers(dest='command', required=True)
    ex = subs.add_parser('extract')
    ex.add_argument('--rotation', type=int, choices=(0,90,180,270), required=True, help='clockwise rotation making the recorded face upright')
    ex.add_argument('--assume-rectified', action='store_true', required=True)
    for name in ('upstream','weights','landmark-cache'):
        ex.add_argument('--'+name, type=Path, required=True)
    ex.add_argument('--device', choices=('cpu','mps'), default='cpu')
    ex.add_argument('--landmark-device', choices=('cpu','mps'), default='cpu')
    be = subs.add_parser('benchmark')
    be.add_argument('--rays', type=Path, required=True)
    for cmd in (ex, be):
        cmd.add_argument('capture', type=Path)
        cmd.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        parser.error('output already exists; choose a fresh filename')
    if args.command == 'extract':
        frontend = LandmarkFrontend(args.landmark_cache, args.landmark_device)
        result = extract(args.capture, rotation=args.rotation, assume_rectified=args.assume_rectified,
                         frontend=frontend, backend_factory=lambda camera: UniGazeBackend(
                             upstream=args.upstream, weights=args.weights, camera=camera, device=args.device))
    else:
        result = benchmark(args.capture, json.loads(args.rays.read_text()))
    write_output(args.output, result)
    print(args.output)


if __name__ == '__main__':
    main()
