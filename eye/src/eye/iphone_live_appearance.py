"""Explicit, isolated live appearance experiment; never emits normal gaze events.

A single worker processes one image and retains at most one newer pending image.
Validation labels only measure a frozen profile; they never update its weights.
"""
from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
import time

import numpy as np


class ImageInference:
    """Lazy local model loading and inference, called only on the worker thread."""
    def __init__(self, *, rotation, assume_rectified, upstream, weights, landmark_cache,
                 device='cpu', landmark_device='cpu', camera_geometry=None):
        if rotation not in (0, 90, 180, 270) or not assume_rectified:
            raise ValueError('explicit rotation and rectified-image assumption required')
        self.camera_geometry = camera_geometry
        self.rotation = rotation
        self.paths = dict(upstream=upstream, weights=weights, device=device)
        self.landmark_cache, self.landmark_device = landmark_cache, landmark_device
        self.frontend = self.backend = None

    def __call__(self, packet):
        import cv2
        from .iphone_capture import validate_packet_image
        from .iphone_appearance import rotate_camera, ray_to_arkit
        from .unigaze_backend import CameraCalibration, LandmarkFrontend, UniGazeBackend
        validate_packet_image(packet)
        image = packet['image']
        if self.camera_geometry is not None:
            # Factory intrinsics jitter slightly; permit 1% focal variation and
            # two sensor pixels principal-point variation, fixed image geometry.
            k = np.asarray(image['intrinsics']).reshape(3,3,order='F')
            compatible = False
            for saved in self.camera_geometry:
                if any(image[n] != saved[n] for n in ('width','height','mirrored','orientation')):
                    continue
                old = np.asarray(saved['intrinsics']).reshape(3,3,order='F')
                compatible |= bool(np.allclose(k[:2,:2], old[:2,:2], rtol=.01, atol=.01)
                                   and np.all(np.abs(k[:2,2]-old[:2,2]) <= 2))
            if not compatible:
                raise ValueError('profile camera geometry mismatch')
        from .iphone_capture import validate_phone_image
        jpeg = validate_phone_image(packet['image'])
        pixels = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR | cv2.IMREAD_IGNORE_ORIENTATION)
        if pixels is None:
            raise ValueError('image decode failed')
        matrix = np.asarray(packet['image']['intrinsics']).reshape(3, 3, order='F')
        pixels, matrix, rotation = rotate_camera(pixels, matrix, self.rotation)
        camera = CameraCalibration(matrix, np.zeros(5), pixels.shape[1], pixels.shape[0],
                                   'iphone-live-AR-intrinsics-assumed-rectified')
        if self.frontend is None:
            self.frontend = LandmarkFrontend(self.landmark_cache, self.landmark_device)
        if self.backend is None:
            self.backend = UniGazeBackend(camera=camera, **self.paths)
        self.backend.camera = camera
        ray = self.backend.infer(pixels, self.frontend.detect(pixels))
        return ray_to_arkit(ray, rotation)


class LiveAppearance:
    """Frozen predictor protocol: callable(features6) -> normalized xy.

    Caller feeds only accepted phone packets. Results stay explicitly named and
    cannot accidentally replace the production ARKit stream. All methods except
    infer run on the receiver event loop. Receipt age is not end-to-end latency.
    """
    def __init__(self, *, infer, predict, display, emit, session_id=None,
                 max_age=.5, clock=time.monotonic):
        if not 0 < max_age <= 2:
            raise ValueError('max age must be in (0, 2] seconds')
        self.infer, self.predict, self.display, self.emit = infer, predict, display, emit
        self.required_session, self.session = session_id, None
        self.max_age, self.clock = max_age, clock
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='iphone-appearance')
        self.task, self.pending = None, None
        self.epoch = self.seq = 0
        self.last_seq, self.last_t = -1, -1
        self.closed = False
        self.counts = dict(packets=0, images=0, replaced=0, processed=0, valid=0, stale=0, failed=0)
        self.targets, self.target, self.validating = [], None, False
        self.target_serial = 0
        self.validation = None
        self.last_output = None
        self.face = False

    def _invalid(self, reason):
        self.face = False
        self.emit(dict(type='face', present=False, t=self.clock()*1000))
        self.emit(dict(type='appearance_gaze', source='UniGaze frozen personal profile', valid=False,
                       reason=reason, t=self.clock()*1000))

    def reset(self, reason='iphone_disconnected'):
        self.epoch += 1
        self.validation = None
        self.pending = None
        self.session = None
        self.last_seq, self.last_t = -1, -1
        self.target = None
        if self.validating:
            self.validating = False
            self.emit(dict(type='appearance_validation', ok=False, reason=reason))
        self._invalid(reason)
        self.emit(self.hello())

    def submit(self, packet, received_t=None):
        if self.closed:
            return
        from .iphone_tracking import decode_iphone_frame
        frame = decode_iphone_frame(packet)
        now = self.clock() if received_t is None else received_t
        if frame.session_id != self.session:
            self.reset('iphone_session_changed')
            self.session = frame.session_id
        if frame.seq <= self.last_seq or frame.t <= self.last_t:
            return
        self.last_seq, self.last_t = frame.seq, frame.t
        self.counts['packets'] += 1
        if self.required_session is not None and self.session != self.required_session:
            self._invalid('profile_session_mismatch')
            return
        if 'image' in packet and self.target is not None:
            self.target['attemptedImages'] += 1
        if not frame.valid:
            self.epoch += 1
            self.pending = None
            self._invalid(frame.reason)
            return
        if 'image' not in packet:
            return
        self.counts['images'] += 1
        target = self.target
        if self.pending is not None:
            self.counts['replaced'] += 1
        self.pending = (packet, now, self.epoch, target)
        if self.task is None or self.task.done():
            self.task = asyncio.create_task(self._run())

    async def _run(self):
        loop = asyncio.get_running_loop()
        while self.pending is not None and not self.closed:
            packet, received, epoch, target = self.pending
            self.pending = None
            start = self.clock()
            try:
                features = await loop.run_in_executor(self.executor, self.infer, packet)
                self.counts['processed'] += 1
                xy = np.asarray(self.predict(features), dtype=float).reshape(-1)
                if xy.shape != (2,) or not np.isfinite(xy).all():
                    raise ValueError('invalid profile prediction')
            except Exception as exc:
                self.counts['failed'] += 1
                if epoch == self.epoch and not self.closed:
                    self._invalid(type(exc).__name__ + ': ' + str(exc)[:160])
                continue
            age = self.clock()-received
            if epoch != self.epoch or self.closed:
                continue
            if age < 0 or age > self.max_age:
                self.counts['stale'] += 1
                self._invalid('appearance_result_stale')
                continue
            self.counts['valid'] += 1
            self.last_output = self.clock()
            self.face = True
            self.emit(dict(type='face', present=True, t=self.clock()*1000))
            # Associate observations with their receipt-time target, never a
            # subsequent target that appeared while inference was running.
            if target is not None and self.validating and target in self.targets and not target.get('closed'):
                target['predictions'].append(xy.tolist())
            d = self.display
            self.emit(dict(type='appearance_gaze', source='UniGaze frozen personal profile', valid=True,
                           t=self.clock()*1000, nx=float(xy[0]), ny=float(xy[1]),
                           x=float(d['x']+xy[0]*d['w']), y=float(d['y']+xy[1]*d['h']),
                           sessionId=packet['sessionId'], seq=packet['seq'],
                           receiptAgeMs=age*1000, processingMs=(self.clock()-start)*1000,
                           latencyScope='receiver receipt to result; excludes capture and network',
                           counts=dict(self.counts)))

    def command(self, msg):
        cmd = msg.get('type')
        if cmd == 'appearance_validate_begin':
            self.targets, self.target, self.validating = [], None, True
        elif cmd == 'appearance_validate_target':
            if not self.validating or self.target is not None:
                raise ValueError('begin validation and end previous target first')
            xy = np.asarray([msg['nx'], msg['ny']], dtype=float)
            if not np.isfinite(xy).all() or np.any(xy < 0) or np.any(xy > 1):
                raise ValueError('validation target must be inside display')
            self.target_serial += 1
            self.target = dict(id=self.target_serial, xy=xy.tolist(), predictions=[], attemptedImages=0)
            self.targets.append(self.target)
        elif cmd == 'appearance_validate_target_end':
            if self.target is not None:
                self.target['closed'] = True
            self.target = None
        elif cmd == 'appearance_validate_finish':
            if not self.validating:
                raise ValueError('no active appearance validation')
            self.target = None
            self.validating = False
            scale = np.array([self.display['w'], self.display['h']])
            rows = []
            for target in self.targets:
                pred = np.array(target['predictions'])
                errors = np.linalg.norm((pred-target['xy'])*scale, axis=1) if len(pred) else np.array([])
                residual = (pred-target['xy'])*scale if len(pred) else None
                rows.append(dict(nx=target['xy'][0], ny=target['xy'][1], samples=len(pred),
                                 attemptedImages=target['attemptedImages'],
                                 coverage=len(pred)/max(1,target['attemptedImages']),
                                 meanPoints=float(errors.mean()) if len(errors) else None,
                                 p90Points=float(np.percentile(errors,90)) if len(errors) else None,
                                 biasXPoints=float(residual[:,0].mean()) if residual is not None else None,
                                 biasYPoints=float(residual[:,1].mean()) if residual is not None else None,
                                 jitterRmsPoints=float(np.sqrt(np.mean(np.sum((residual-residual.mean(axis=0))**2,axis=1)))) if residual is not None else None,
                                 errors=errors.tolist()))
            unique = np.unique(np.array([t['xy'] for t in self.targets]), axis=0) if self.targets else []
            ok = (len(unique) >= 5 and np.all(np.ptp(unique, axis=0) >= .5)
                  and all(r['samples'] >= 5 and r['coverage'] >= .8 for r in rows))
            errors = [e for r in rows for e in r.pop('errors')]
            result = dict(type='appearance_validation', source='UniGaze frozen personal profile', ok=bool(ok),
                          measurement='raw_unsmoothed', targets=rows,
                          imageCoverage=sum(r['samples'] for r in rows)/max(1,sum(r['attemptedImages'] for r in rows)),
                          meanPoints=float(np.mean([r['meanPoints'] for r in rows if r['samples']])) if errors else None,
                          p90Points=float(np.percentile(errors, 90)) if errors else None)
            if not ok:
                result['reason'] = 'need five distinct targets spanning screen, five samples each and 80% image coverage'
            self.emit(result)
            return result
        else:
            raise ValueError('unknown appearance validation command')

    async def close(self):
        self.closed = True
        self.epoch += 1
        self.pending = None
        if self.task is not None:
            await self.task
        self.executor.shutdown(wait=False, cancel_futures=True)

    def tick(self):
        if self.last_output is not None and self.clock()-self.last_output > self.max_age:
            self.last_output = None
            self._invalid('appearance_frames_stale')

    def hello(self):
        return dict(type='hello', display=self.display, face=self.face, calibrated=True,
                    canCalibrate=False, corrected=False, backend=dict(name='iphone-appearance-frozen', features=6),
                    accuracyValidated=self.validation is not None,
                    uncertaintyDeg=self.validation.get('p90Deg') if self.validation else None,
                    accuracyDeg=self.validation.get('meanDeg') if self.validation else None,
                    uncertaintySource='current_live_validation' if self.validation else 'not_yet_independently_validated',
                    angularAssumption='approximate; display points per degree assumes viewing distance', depthAvailable=False)

    async def drain_target(self):
        """Close receipt window, then allow already-received inference to settle."""
        target, self.target = self.target, None
        deadline = asyncio.get_running_loop().time() + self.max_age
        while self.task is not None and not self.task.done():
            remaining = deadline-asyncio.get_running_loop().time()
            if remaining <= 0:
                break
            await asyncio.wait({self.task}, timeout=remaining)
        self.target = target

    def browser_command(self, msg):
        """Standard EyeClient protocol, strictly validation-only on isolated WS."""
        kind = msg.get('type')
        result = None
        if kind == 'hello':
            result = self.hello()
        elif kind == 'calib_begin':
            if not msg.get('validateOnly') or msg.get('recenterOnly'):
                raise ValueError('frozen appearance profile supports independent validation only')
            self.command(dict(type='appearance_validate_begin'))
            result = dict(type='calib_begin')
        elif kind == 'calib_target':
            if 'nx' not in msg:
                msg = {**msg, 'nx': (float(msg['x'])-self.display['x'])/self.display['w'],
                       'ny': (float(msg['y'])-self.display['y'])/self.display['h']}
            if msg.get('retry'):
                if not self.targets or not np.allclose(self.targets[-1]['xy'], [msg['nx'], msg['ny']]):
                    raise ValueError('retry must match previous target')
                self.target = self.targets[-1]
                self.target['closed'] = False
            else:
                self.command(dict(type='appearance_validate_target', nx=msg['nx'], ny=msg['ny']))
        elif kind == 'calib_target_end':
            p = self.target
            self.command(dict(type='appearance_validate_target_end'))
            n, attempted = (len(p['predictions']), p['attemptedImages']) if p else (0, 0)
            coverage = n/max(1, attempted)
            result = dict(type='calib_point', index=len(self.targets)-1, samples=n,
                          attempted=attempted, coverage=coverage, ok=n >= 5 and coverage >= .8)
        elif kind == 'calib_finish':
            if not msg.get('validateOnly') or msg.get('recenterOnly'):
                raise ValueError('frozen appearance profile cannot be trained or recentered')
            result = self.command(dict(type='appearance_validate_finish'))
            result = {**result, 'type': 'calib_result', 'validateOnly': True,
                      'accuracyValidated': result['ok'], 'coverage': result['imageCoverage']}
            if result['ok'] and self.display.get('ptPerDeg', 0) > 0:
                result.update(meanDeg=result['meanPoints']/self.display['ptPerDeg'],
                              p90Deg=result['p90Points']/self.display['ptPerDeg'],
                              uncertaintyDeg=result['p90Points']/self.display['ptPerDeg'],
                              uncertaintySource='current_live_validation')
            self.validation = result if result['ok'] else None
            result['perTarget'] = [{**r, 'errorPx': r['meanPoints']} for r in result['targets']]
            result['targets'] = len(result['perTarget'])
            if not result['ok']:
                result['error'] = result['reason']
        else:
            raise ValueError('unsupported frozen appearance command')
        if result is not None and 'requestId' in msg:
            result['requestId'] = msg['requestId']
        return result
