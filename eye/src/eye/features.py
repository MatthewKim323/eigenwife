"""Per-frame eye and head measurements from face landmarks.

Sides are anatomical (the subject's own left/right). In a non-mirrored camera
image the subject's right eye shows up on the image's left: iris 468 sits
between corners 33 and 133, iris 473 between 362 and 263 (checked against real
Face Landmarker output, not just the docs).
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from .face import FaceObs


@dataclass(frozen=True)
class EyeIdx:
    a: int  # corner on the image-left side
    b: int  # corner on the image-right side
    iris: tuple[int, ...]  # center, then the 4 ring points
    lids: tuple[tuple[int, int], ...]  # (upper, lower) landmark pairs across the eye


@dataclass(frozen=True)
class BlendIdx:
    """Positions of the blendshapes we use, looked up by name once."""

    blink_l: int
    blink_r: int
    brow: int
    jaw: int
    smile_l: int
    smile_r: int

    @classmethod
    def from_names(cls, names: list[str]) -> "BlendIdx":
        i = names.index
        return cls(i("eyeBlinkLeft"), i("eyeBlinkRight"), i("browInnerUp"), i("jawOpen"), i("mouthSmileLeft"), i("mouthSmileRight"))


RIGHT_EYE = EyeIdx(a=33, b=133, iris=(468, 469, 470, 471, 472), lids=((160, 144), (159, 145), (158, 153)))
LEFT_EYE = EyeIdx(a=362, b=263, iris=(473, 474, 475, 476, 477), lids=((385, 380), (386, 374), (387, 373)))
NOSE_TIP = 1


@dataclass
class Eye:
    u: float  # iris offset from the eye center along the face's horizontal axis, in eye widths
    v: float  # iris offset along the face's vertical axis (up positive), in eye widths
    lid: float  # upper lid height above the eye center, in eye widths (face frame)
    ear: float  # mean lid gap over eye width in the image (eye aspect ratio)
    width: float  # corner-to-corner distance in pixels
    iris: tuple[float, float]  # iris center in pixels
    height: float = 0.5  # iris height within the lid aperture, 0 at the lower lid, 1 at the upper (face frame)
    aperture: float = 0.0  # upper to lower lid distance, in eye widths (face frame)


@dataclass
class Features:
    t: float
    left: Eye
    right: Eye
    yaw: float  # degrees
    pitch: float
    roll: float
    pos: tuple[float, float, float]  # head translation in camera space, cm (z < 0 in front)
    bs_blink: tuple[float, float]  # blendshapes (eyeBlinkLeft, eyeBlinkRight), MediaPipe naming
    nose: tuple[float, float]  # nose tip, pixels
    brow: float = 0.0  # browInnerUp
    jaw: float = 0.0  # jawOpen
    smile: float = 0.0  # mean of mouthSmileLeft/Right


FOREHEAD = 10


def face_frame(lm: np.ndarray) -> np.ndarray:
    """Landmarks rotated into a face-aligned frame and scaled by eye-corner distance.

    Origin between the outer eye corners, x toward the image-right corner, y
    toward the forehead. Iris offsets measured here are eye-in-head, with the
    head's own rotation mostly taken out (same frame EyeTrax uses).
    """
    c = (lm[33] + lm[263]) / 2
    x = lm[263] - lm[33]
    s = float(np.linalg.norm(x)) or 1.0
    x = x / s
    y = lm[FOREHEAD] - c
    y = y - (y @ x) * x
    y = y / (float(np.linalg.norm(y)) or 1.0)
    return (lm - c) @ np.stack([x, y, np.cross(x, y)], axis=1) / s


def measure_eye(lm: np.ndarray, q: np.ndarray, idx: EyeIdx) -> Eye:
    """lm: image-space landmarks (pixels), q: the same landmarks in the face frame."""
    center = (q[idx.a] + q[idx.b]) / 2
    width_q = float(np.linalg.norm(q[idx.b] - q[idx.a])) or 1.0
    iris = q[list(idx.iris)].mean(axis=0)
    upper = q[[p for p, _ in idx.lids]].mean(axis=0)
    lower = q[[p for _, p in idx.lids]].mean(axis=0)
    aperture = float(upper[1] - lower[1])
    a, b = lm[idx.a, :2], lm[idx.b, :2]
    width = float(np.hypot(*(b - a))) or 1.0
    gaps = np.linalg.norm(lm[[p for p, _ in idx.lids], :2] - lm[[q_ for _, q_ in idx.lids], :2], axis=1)
    iris_px = lm[idx.iris[0], :2]
    return Eye(
        u=float((iris[0] - center[0]) / width_q),
        v=float((iris[1] - center[1]) / width_q),
        lid=float((upper[1] - center[1]) / width_q),
        ear=float(gaps.mean() / width),
        width=width,
        iris=(float(iris_px[0]), float(iris_px[1])),
        height=float((iris[1] - lower[1]) / max(aperture, 1e-3)),
        aperture=float(aperture / width_q),
    )


def head_pose(matrix: np.ndarray) -> tuple[float, float, float, tuple[float, float, float]]:
    """(yaw, pitch, roll) in degrees plus translation (cm) from the facial transformation matrix."""
    r = matrix[:3, :3]
    yaw = math.degrees(math.atan2(r[0, 2], r[2, 2]))
    pitch = math.degrees(math.asin(max(-1.0, min(1.0, -r[1, 2]))))
    roll = math.degrees(math.atan2(r[1, 0], r[1, 1]))
    pos = tuple(float(v) for v in matrix[:3, 3])
    return yaw, pitch, roll, pos


def extract(obs: FaceObs, idx: BlendIdx) -> Features:
    yaw, pitch, roll, pos = head_pose(obs.matrix)
    q = face_frame(obs.lm.astype(np.float64))
    return Features(
        t=obs.t,
        left=measure_eye(obs.lm, q, LEFT_EYE),
        right=measure_eye(obs.lm, q, RIGHT_EYE),
        yaw=yaw,
        pitch=pitch,
        roll=roll,
        pos=pos,
        bs_blink=(float(obs.blend[idx.blink_l]), float(obs.blend[idx.blink_r])),
        nose=(float(obs.lm[NOSE_TIP, 0]), float(obs.lm[NOSE_TIP, 1])),
        brow=float(obs.blend[idx.brow]),
        jaw=float(obs.blend[idx.jaw]),
        smile=float(obs.blend[idx.smile_l] + obs.blend[idx.smile_r]) / 2,
    )


# Gaze regression inputs: eye-in-head terms (iris offsets, lids) then head pose,
# so the model can learn how head rotation/translation shifts the gaze point,
# then where the iris sits between the lids. Vertical iris offset alone is a weak
# signal (the eye moves less up and down than sideways, and the lids follow it);
# iris height inside the aperture carries most of the vertical gaze. On a real
# session it cut validation error from 188 to 117 pt and error with a moving
# head from ~1000 to ~330 pt.
#
# Features are only ever appended, never reordered: a model fitted on an older,
# shorter vector keeps working because GazeModel uses the leading columns.
GAZE_FEATURES = (
    "lu", "lv", "ru", "rv", "llid", "rlid", "yaw", "pitch", "roll", "hx", "hy", "hz",
    "lheight", "laperture", "rheight", "raperture",
)
EYE_TERMS = 6

# Smallest standard deviation each feature is normalized by. If calibration
# barely exercised a feature (say the head never moved), dividing by its tiny
# std would blow up normal runtime variation into huge inputs.
GAZE_SCALE_FLOOR = np.array([0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 1.5, 1.5, 1.5, 0.02, 0.02, 1.5, 0.01, 0.01, 0.01, 0.01])


def gaze_vector(f: Features) -> np.ndarray:
    z = -f.pos[2] if f.pos[2] < -1 else 1.0
    return np.array(
        [
            f.left.u,
            f.left.v,
            f.right.u,
            f.right.v,
            f.left.lid,
            f.right.lid,
            f.yaw,
            f.pitch,
            f.roll,
            f.pos[0] / z,
            f.pos[1] / z,
            z,
            f.left.height,
            f.left.aperture,
            f.right.height,
            f.right.aperture,
        ],
        dtype=np.float64,
    )
