"""Export an explicit local appearance challenger; never promote or start tracking."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
import uuid
from pathlib import Path
import numpy as np
from .iphone_appearance import benchmark, _fit_ridge
from .iphone_replay import load_capture
from .iphone_tracking import decode_iphone_frame
from .unigaze_backend import FINGERPRINT


class AppearanceProfile:
    def __init__(self, metadata, arrays):
        self.metadata = metadata
        self.arrays = {k: np.asarray(v, dtype=float) for k, v in arrays.items()}
        shapes = dict(x_mean=(6,), x_scale=(6,), coef=(6,2), p_mean=(6,), y_mean=(2,), offset=(2,), feature_min=(6,), feature_max=(6,))
        if set(self.arrays) != set(shapes) or any(self.arrays[k].shape != shape or not np.isfinite(self.arrays[k]).all() for k,shape in shapes.items()):
            raise ValueError('invalid appearance profile arrays')
        if np.any(self.arrays['x_scale'] <= 0) or np.any(self.arrays['feature_min'] > self.arrays['feature_max']):
            raise ValueError('invalid appearance profile scale/bounds')
        if metadata.get('modelFingerprint') != FINGERPRINT or metadata.get('rotationClockwise') not in (0,90,180,270) or metadata.get('promoted') is not False:
            raise ValueError('unsupported appearance profile identity')
        d = metadata.get('display', {})
        if any(type(d.get(k)) not in (int,float) or not np.isfinite(d[k]) for k in ('x','y','w','h','scale')) or min(d['w'],d['h'],d['scale']) <= 0:
            raise ValueError('invalid profile display')
        try:
            uuid.UUID(metadata['sessionId'])
            digest = metadata['sourceManifestSHA256']
            if len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest): raise ValueError()
            if not metadata['assumptions'] or not metadata['cameraFingerprints'] or not metadata['cameraGeometry']: raise ValueError()
            if any(not isinstance(v,str) or not v for v in metadata['cameraFingerprints']): raise ValueError()
            if type(metadata['trainingSamples']) is not int or metadata['trainingSamples'] < 27: raise ValueError()
            for camera in metadata['cameraGeometry']:
                k = np.asarray(camera['intrinsics'],dtype=float).reshape(3,3,order='F')
                if (not np.isfinite(k).all() or k[0,0] <= 0 or k[1,1] <= 0 or
                        not np.allclose(k[2],[0,0,1]) or
                        any(type(camera[v]) is not int or camera[v] <= 0 for v in ('width','height')) or
                        camera['mirrored'] is not False or camera['orientation'] != 'sensor'):
                    raise ValueError()
        except (KeyError, TypeError, ValueError, AttributeError) as exc:
            raise ValueError('invalid profile provenance/camera metadata') from exc

    def predict(self, features):
        x = np.atleast_2d(np.asarray(features, dtype=float))
        if x.shape[1] != 6 or not np.isfinite(x).all() or not np.allclose(np.linalg.norm(x[:,:3],axis=1),1,atol=1e-4):
            raise ValueError('expected finite six-feature unit gaze rays')
        a = self.arrays
        z = np.clip((x-a['x_mean'])/a['x_scale'], -20, 20)
        return (z-a['p_mean'])@a['coef']+a['y_mean']+a['offset']


def fit_profile(capture_path, rays):
    """Replay benchmark acceptance/reset/recenter semantics; fit training labels only.

    Successful benchmark recenter corrections are copied exactly, including its
    all-comparators quality gate. Validation labels never update this mapping.
    """
    report = benchmark(capture_path, rays)  # verifies manifest, packet identity, pinned model
    if rays.get('rotationClockwise') not in (0,90,180,270) or not rays.get('assumptions'):
        raise ValueError('explicit camera rotation and assumptions required')
    capture = load_capture(capture_path)
    display = capture['metadata']['display']; scale = np.array([display['w'],display['h']])
    by_index = {r['recordIndex']: r for r in rays['rows']}
    reports = {r['recordIndex']: r for r in report['reports']}
    session = None; seq = timestamp = -1
    targets=[]; collecting=None; active=None; pending=False
    camera_fingerprints=set(); selected_cameras=[]
    for index, record in enumerate(capture['records']):
        kind, msg = record['kind'], record['payload']
        if kind == 'packet':
            f=decode_iphone_frame(msg)
            if f.session_id != session:
                session=f.session_id;seq=timestamp=-1;active=None;targets=[];collecting=None;pending=False
            if f.seq <= seq or f.t <= timestamp: continue
            seq,timestamp=f.seq,f.t
            row=by_index[index]
            if collecting is not None and f.valid and row.get('valid') is True:
                collecting['x'].append(row['appearance'])
                collecting['cameras'].append(row.get('cameraFingerprint'))
                collecting['imageGeometry'].append({k:msg['image'][k] for k in ('width','height','intrinsics','mirrored','orientation')})
        elif kind == 'event' and msg.get('type') == 'gaze' and msg.get('reason') == 'iphone_disconnected':
            active=None;targets=[];collecting=None;pending=False;session=None
        elif kind == 'command':
            cmd=msg.get('type')
            if cmd in ('calib_begin','calib_reset'):
                targets=[];collecting=None;pending=cmd=='calib_begin'
                if cmd=='calib_reset':active=None
            elif cmd=='calib_target':
                pending=True
                xy=np.array([msg['nx'],msg['ny']]) if 'nx' in msg else (np.array([msg['x'],msg['y']])-[display['x'],display['y']])/scale
                if msg.get('retry'):collecting=targets[-1]
                else:
                    collecting=dict(xy=xy,x=[],cameras=[],imageGeometry=[]);targets.append(collecting)
            elif cmd=='calib_target_end':collecting=None
            elif cmd=='calib_finish':
                result=reports[index];pending=False
                if result['mode']=='training':
                    if not result['ok']:
                        active=None
                    else:
                        x=np.vstack([p['x'] for p in targets])
                        if len(x)!=result['commonSamples']:raise ValueError('ambiguous training sample replay')
                        y=np.vstack([np.tile(p['xy'],(len(p['x']),1)) for p in targets])
                        _,groups=np.unique(y.round(5),axis=0,return_inverse=True)
                        weights=np.array([1/np.count_nonzero(groups==g) for g in groups])
                        model,stats=_fit_ridge(x,y,groups,weights,scale)
                        active=dict(model=model,offset=np.zeros(2),x=x,index=index,stats=stats,session=session)
                        camera_fingerprints={v for p in targets for v in p['cameras']}
                        selected_cameras=[v for p in targets for v in p['imageGeometry']]
                elif result['mode']=='recenter' and result['ok']:
                    if active is None:raise ValueError('recenter without exportable calibration')
                    active['offset']+=np.array(result['correctionsPoints']['appearance'])/scale
                targets=[];collecting=None
    if active is None or pending:
        raise ValueError('no complete current training model, or unfinished calibration episode')
    if not camera_fingerprints or any(not isinstance(v,str) or not v for v in camera_fingerprints):
        raise ValueError('training camera fingerprints missing')
    camera_geometry=list({json.dumps(v,sort_keys=True):v for v in selected_cameras}.values())
    model=active['model']; x=active['x']
    metadata=dict(schema=1, modelFingerprint=FINGERPRINT, sourceManifestSHA256=rays['sourceManifestSHA256'],
                  rotationClockwise=rays['rotationClockwise'], assumptions=rays['assumptions'], display=display,
                  cameraFingerprints=sorted(camera_fingerprints), cameraGeometry=camera_geometry,
                  sessionId=active['session'], trainingFinishRecordIndex=active['index'], trainingSamples=len(x),
                  trainingDiagnostics=active['stats'], alpha=float(model.alpha), promoted=False,
                  featureSchema='unigaze_camera_direction_xyz_generic_origin_m_xyz',
                  supportPolicy='bounds describe calibration only; no accuracy guarantee or automatic promotion',
                  evaluation='challenger; validation labels excluded from fitting')
    arrays={k:getattr(model,k) for k in ('x_mean','x_scale','coef','p_mean','y_mean')}
    arrays.update(offset=active['offset'],feature_min=x.min(0),feature_max=x.max(0))
    return AppearanceProfile(metadata,arrays)


def _payload(profile):
    return dict(schema=1,metadata=profile.metadata,arrays={k:v.tolist() for k,v in profile.arrays.items()})


def _digest(payload):
    return hashlib.sha256(json.dumps(payload,sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest()


def export_profile(profile, path):
    payload=_payload(profile)
    raw=json.dumps(dict(payload=payload,sha256=_digest(payload)),indent=2,allow_nan=False)+'\n'
    with open(os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'w') as file:file.write(raw)
    return Path(path)


def load_profile(path):
    path=Path(path)
    if path.is_symlink() or path.stat().st_size>2_000_000:raise ValueError('invalid profile file')
    envelope=json.loads(path.read_text()); payload=envelope.get('payload',{})
    if payload.get('schema')!=1 or envelope.get('sha256')!=_digest(payload):raise ValueError('profile digest/schema mismatch')
    return AppearanceProfile(payload['metadata'],payload['arrays'])


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('capture',type=Path);parser.add_argument('--rays',type=Path,required=True)
    parser.add_argument('--output',type=Path,help='defaults to appearance-challenger.json inside capture; never overwrites')
    args=parser.parse_args()
    profile=fit_profile(args.capture,json.loads(args.rays.read_text()))
    path=export_profile(profile,args.output or args.capture/'appearance-challenger.json')
    print(json.dumps(dict(path=str(path),promoted=False,trainingSamples=profile.metadata['trainingSamples'])))


if __name__=='__main__':main()
