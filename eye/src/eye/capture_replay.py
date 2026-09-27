"""Verify and replay local capture pixels without discarding difficult frames.

``python -m eye.capture_replay CAPTURE_DIR [--session relocated-session.npz]``
Never reruns landmark detection: image backends share the recorded FaceObs.
"""
from __future__ import annotations

import argparse
from collections import Counter
from dataclasses import dataclass
import hashlib
import json
from pathlib import Path

import cv2
import numpy as np

from . import calibration as cal
from .face import FaceObs


class CaptureIntegrityError(ValueError):
    pass


def _sha(data):
    return hashlib.sha256(data).hexdigest()


def _require(condition, message):
    if not condition:
        raise CaptureIntegrityError(message)


@dataclass(frozen=True)
class ReplayFrame:
    index: int
    seq: int
    t: float
    image: np.ndarray | None
    observation: FaceObs | None
    features: object
    timing: dict
    dropped: str | None


class CaptureReplay:
    """Strict, completed capture aligned one-to-one to its saved Recording.

    Images are checked before replay and rechecked when loaded so mutation cannot
    silently change inputs. ``frames`` includes capture drops and missing faces.
    A moved archive may be supplied explicitly; its original SHA must still match.
    """
    def __init__(self, directory, session_path=None):
        self.directory = Path(directory).resolve()
        try:
            self.manifest = json.loads((self.directory / 'manifest.json').read_text())
            _require(self.manifest.get('schema') == 'eye-image-capture-v1', 'unsupported capture schema')
            _require(self.manifest.get('encoding') == 'lossless-png-bgr', 'unsupported image encoding')
            _require(self.manifest.get('status') == 'complete', 'capture is not complete')
            session = self.manifest.get('session')
            _require(isinstance(session, dict), 'capture has no saved session')
            self.session_path = Path(session_path or session['path']).resolve()
            _require(_sha(self.session_path.read_bytes()) == session['sha256'], 'session SHA256 mismatch')
            self.recording, self.script, self.geometry, self.camera = cal.load_session(self.session_path)
            self.rows = [json.loads(line) for line in (self.directory / 'frames.jsonl').read_text().splitlines() if line.strip()]
            self._verify()
        except CaptureIntegrityError:
            raise
        except (OSError, ValueError, TypeError, KeyError) as exc:
            raise CaptureIntegrityError(f'invalid capture: {exc}') from exc

    def _image(self, row):
        filename = row['file']
        _require(isinstance(filename, str) and Path(filename).name == filename and filename.endswith('.png'),
                 'image path must be a PNG filename within the capture')
        path = self.directory / filename
        _require(not path.is_symlink() and path.resolve().parent == self.directory, 'image path escapes capture')
        data = path.read_bytes()
        _require(_sha(data) == row.get('sha256'), f'image SHA256 mismatch: {filename}')
        image = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_UNCHANGED)
        _require(image is not None and image.dtype == np.uint8 and image.ndim == 3 and image.shape[2] == 3,
                 f'image is not uint8 BGR: {filename}')
        _require([image.shape[1], image.shape[0]] == row['size'], f'image dimensions mismatch: {filename}')
        return image, len(data)

    def _verify(self):
        rec = self.recording
        _require(len(self.rows) == len(rec.t), 'ledger and recording frame counts differ')
        _require(len(set(rec.t)) == len(rec.t) and np.isfinite(rec.t).all(), 'recording timestamps must be finite and unique')
        _require(all(b > a for a, b in zip(rec.t, rec.t[1:])), 'recording timestamps must increase')
        for row in self.rows:
            _require(isinstance(row, dict), 'invalid ledger row')
            _require(type(row.get('seq')) is int and row['seq'] >= 0, 'frame seq must be a nonnegative integer')
            _require(isinstance(row.get('t'), (int, float)) and np.isfinite(row['t']), 'invalid frame timestamp')
            size = row.get('size')
            _require(isinstance(size, list) and len(size) == 2 and all(type(v) is int and v > 0 for v in size), 'invalid image size')
            _require(isinstance(row.get('timing', {}), dict), 'invalid timing metadata')
        self.rows.sort(key=lambda r: r['seq'])
        _require(len({r['seq'] for r in self.rows}) == len(self.rows), 'duplicate frame seq')
        _require([r['t'] for r in self.rows] == rec.t, 'ledger timestamps do not align with recording')
        written = size_bytes = 0
        reasons, files = Counter(), set()
        for row in self.rows:
            dropped = row.get('dropped')
            if dropped is not None:
                _require(isinstance(dropped, str) and bool(dropped), 'invalid drop reason')
                _require('file' not in row and 'sha256' not in row, 'dropped frame also declares an image')
                _require(not (self.directory / f"{row['seq']:09d}.png").exists(), 'dropped frame has undeclared image')
                reasons[dropped] += 1
            else:
                _require('file' in row and 'sha256' in row, 'frame has neither image nor drop reason')
                _require(row['file'] not in files, 'image reused by multiple frames')
                _, byte_count = self._image(row)
                files.add(row['file'])
                written += 1
                size_bytes += byte_count
        _require({p.name for p in self.directory.glob('*.png')} == files, 'capture contains unlisted images')
        _require(self.manifest.get('written') == written, 'manifest written count mismatch')
        _require(self.manifest.get('dropped') == sum(reasons.values()), 'manifest dropped count mismatch')
        _require(self.manifest.get('bytes_written') == size_bytes, 'manifest byte count mismatch')
        if self.manifest.get('clock') is not None:
            _require(np.array_equal(np.asarray(self.manifest['clock']), np.asarray(rec.clock)), 'manifest clock differs from session')
        if self.manifest.get('script') is not None:
            script = self.manifest['script']
            if isinstance(script, str):
                script = json.loads(script)
            _require(script == json.loads(self.script.to_json()), 'manifest script differs from session')
        self.report = dict(integrity='verified', schema=self.manifest['schema'],
                           capture=str(self.directory), session=str(self.session_path),
                           frames=len(self.rows), images=written, dropped=sum(reasons.values()),
                           image_coverage=written / len(self.rows) if self.rows else 0.,
                           dropped_reasons=dict(reasons),
                           no_face_frames=sum(f is None for f in rec.features),
                           bytes_written=size_bytes, writer_error=self.manifest.get('error'),
                           timestamps=self.manifest.get('timestamps'),
                           limitation='coverage includes captured session frames; camera frames skipped before tracking are not reconstructed')

    def frames(self):
        """Yield all records in capture order, including explicit capture drops."""
        for index, row in enumerate(self.rows):
            image = None if row.get('dropped') else self._image(row)[0]
            obs = None
            if self.recording.lm[index] is not None:
                obs = FaceObs(t=row['t'], size=tuple(row['size']), lm=self.recording.lm[index],
                              blend=self.recording.blend[index], matrix=self.recording.matrix[index])
            yield ReplayFrame(index, row['seq'], row['t'], image, obs, self.recording.features[index],
                              row.get('timing', {}), row.get('dropped'))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    parser.add_argument('--session', type=Path)
    args = parser.parse_args()
    try:
        report = CaptureReplay(args.directory, args.session).report
    except CaptureIntegrityError as exc:
        parser.exit(1, json.dumps({'integrity': 'failed', 'error': str(exc)}) + '\n')
    print(json.dumps(report, indent=2, allow_nan=False))


if __name__ == '__main__':
    main()
