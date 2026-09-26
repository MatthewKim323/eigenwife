"""Starting and stopping the AppKit event loop.

PyObjC's AppHelper.stopEventLoop() only works under its console run loop;
under NSApp.run() it falls through to NSApp.terminate_(), which kills the
process on the spot, skipping our cleanup (a held mouse button would stay
held, and the calibration summary would never print). NSApp.stop_() is the
right call, but it only takes effect once the app processes another event, so
we hand it one.
"""

from __future__ import annotations

import AppKit


def stop() -> None:
    app = AppKit.NSApplication.sharedApplication()
    app.stop_(None)
    event = AppKit.NSEvent.otherEventWithType_location_modifierFlags_timestamp_windowNumber_context_subtype_data1_data2_(
        AppKit.NSEventTypeApplicationDefined, (0.0, 0.0), 0, 0.0, 0, None, 0, 0, 0
    )
    app.postEvent_atStart_(event, True)
