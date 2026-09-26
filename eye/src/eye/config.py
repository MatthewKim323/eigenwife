"""User settings, optionally overridden by ~/.eye/config.json."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field, fields, is_dataclass

from . import paths
from .gestures import GestureConfig
from .pointer import PointerConfig

ACTIONS = ("left_click", "right_click", "double_click", "drag", "scroll", "pause", "none")

DEFAULT_ACTIONS = {
    "long_blink": "left_click",  # eyes shut past the first tone
    "longer_blink": "right_click",  # ...past the second tone
    "long_close": "pause",  # ...shut ~2.5s: pause / resume everything
    "wink_left": "left_click",  # only if calibration proved you can wink
    "wink_right": "right_click",
    "brow_hold": "drag",  # raise brows: grab, again to drop
    "mouth_hold": "scroll",  # open mouth: tilt head to scroll, again to exit
}


@dataclass
class Settings:
    camera: str | None = None
    display: str | None = None
    pointer: PointerConfig = field(default_factory=PointerConfig)
    gestures: GestureConfig = field(default_factory=GestureConfig)
    actions: dict[str, str] = field(default_factory=lambda: dict(DEFAULT_ACTIONS))
    sounds: bool = True
    learn_from_clicks: bool = True  # hybrid mode: every click becomes a calibration sample
    snap: bool = True  # land clicks on the nearest accessibility target
    snap_radius: float = 150.0  # points
    scroll_speed: float = 70.0  # pixels/s per degree of head tilt past the dead zone
    scroll_deadzone_deg: float = 3.0
    drag_settle_s: float = 0.8  # hold still after grabbing, so the gesture itself doesn't drag
    max_head_speed: float = 60.0  # deg/s above which gestures are ignored (you're moving, not clicking)
    wink_max_yaw: float = 20.0  # winks get unreliable past this much head turn


def _merge(obj, data: dict):
    for f in fields(obj):
        if f.name not in data:
            continue
        cur = getattr(obj, f.name)
        if is_dataclass(cur) and isinstance(data[f.name], dict):
            _merge(cur, data[f.name])
        elif isinstance(cur, dict) and isinstance(data[f.name], dict):
            cur.update(data[f.name])
        else:
            setattr(obj, f.name, data[f.name])
    return obj


def load() -> Settings:
    settings = Settings()
    path = paths.config_file()
    if path.exists():
        _merge(settings, json.loads(path.read_text()))
    for gesture, action in settings.actions.items():
        if action not in ACTIONS:
            raise ValueError(f"unknown action {action!r} for {gesture} in {path}")
    return settings


def dump(settings: Settings) -> str:
    return json.dumps(asdict(settings), indent=2)
