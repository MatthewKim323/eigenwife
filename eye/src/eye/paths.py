"""Where eye keeps its files, plus the face landmarker model download."""

from __future__ import annotations

import hashlib
import os
import ssl
import sys
import urllib.request
from pathlib import Path

MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/"
    "face_landmarker/float16/1/face_landmarker.task"
)
MODEL_SHA256 = "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff"


def home() -> Path:
    root = Path(os.environ.get("EYE_HOME", Path.home() / ".eye"))
    root.mkdir(parents=True, exist_ok=True)
    return root


def calibration_file() -> Path:
    """The active calibration (gaze model + blink profile)."""
    return home() / "calibration.npz"


def config_file() -> Path:
    return home() / "config.json"


def sessions_dir() -> Path:
    """Raw per-frame recordings from calibration runs, kept for offline refits."""
    path = home() / "sessions"
    path.mkdir(exist_ok=True)
    return path


def model_file() -> Path:
    path = home() / "models" / "face_landmarker.task"
    if path.exists():
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    print(f"downloading face landmarker model to {path}", file=sys.stderr)
    try:
        import certifi

        context = ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        context = ssl.create_default_context()
    tmp = path.with_suffix(".part")
    with urllib.request.urlopen(MODEL_URL, timeout=60, context=context) as resp:
        tmp.write_bytes(resp.read())
    digest = hashlib.sha256(tmp.read_bytes()).hexdigest()
    if digest != MODEL_SHA256:
        tmp.unlink(missing_ok=True)
        raise RuntimeError(f"face landmarker checksum mismatch ({digest})")
    tmp.rename(path)
    return path
