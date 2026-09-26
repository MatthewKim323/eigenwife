"""Short system sounds. Feedback you can hear matters when your eyes are shut."""

from __future__ import annotations

import threading
from collections import deque

import AppKit
from PyObjCTools import AppHelper

enabled = True
_playing: deque = deque(maxlen=8)  # NSSound stops if it's deallocated mid-play


def _play(name: str, volume: float) -> None:
    sound = AppKit.NSSound.alloc().initWithContentsOfFile_byReference_(f"/System/Library/Sounds/{name}.aiff", True)
    if sound is None:
        return
    sound.setVolume_(volume)
    sound.play()
    _playing.append(sound)


def play(name: str, volume: float = 0.35) -> None:
    """Play a system sound (Tink, Pop, Morse, Purr, Bottle, Glass, ...) from any thread."""
    if not enabled:
        return
    if threading.current_thread() is threading.main_thread():
        _play(name, volume)
    else:
        AppHelper.callAfter(_play, name, volume)
