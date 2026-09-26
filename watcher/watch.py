#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# dependencies = ["pyobjc-framework-Cocoa"]
# ///
"""
Eve's desktop senses. Watches macOS app activity and what's playing, and posts
envelopes to the core bus (POST http://127.0.0.1:7777/emit):

  app.opened   {app, bundleId}          an app launched
  app.focused  {app, bundleId}          an app came to the front
  media.play   {track, artist}          Spotify / Music started a new track

Run:   uv run watcher/watch.py          (installs pyobjc on the fly)
  or:  python3 watcher/watch.py         (uses pyobjc if present, else polls lsappinfo)
Flags: --core URL, --poll (force the no-pyobjc path), --dry-run (print, don't post),
       --media-interval SECONDS (0 disables media), --once (one poll pass then exit)

No permissions needed: NSWorkspace notifications and lsappinfo are unprivileged.
Media polling asks each player only when it's already running, so it never launches one.
"""

import argparse
import json
import os
import random
import string
import subprocess
import sys
import time
import urllib.error
import urllib.request

SOURCE = "watcher"


def new_id(prefix="w"):
    tail = "".join(random.choice(string.ascii_lowercase + string.digits) for _ in range(6))
    return f"{prefix}_{int(time.time() * 1000):x}{tail}"


class Poster:
    def __init__(self, core, dry_run=False):
        self.url = core.rstrip("/") + "/emit"
        self.dry_run = dry_run
        self.down_since = None

    def emit(self, type_, data):
        env = {"type": type_, "ts": int(time.time() * 1000), "source": SOURCE, "id": new_id(), "data": data}
        if self.dry_run:
            print(json.dumps(env), flush=True)
            return True
        req = urllib.request.Request(self.url, data=json.dumps(env).encode(), headers={"content-type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=1.5) as r:
                r.read()
            if self.down_since is not None:
                log(f"core is back ({self.url})")
                self.down_since = None
            return True
        except (urllib.error.URLError, OSError) as e:
            if self.down_since is None:
                log(f"core unreachable at {self.url} ({e}), will keep trying quietly")
                self.down_since = time.time()
            return False


def log(msg):
    print(f"[watcher] {msg}", file=sys.stderr, flush=True)


def osascript(script, timeout=4):
    try:
        out = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=timeout)
        return out.stdout.strip() if out.returncode == 0 else ""
    except (subprocess.TimeoutExpired, OSError):
        return ""


PLAYERS = ("Spotify", "Music")


def now_playing():
    """(track, artist) of the first running player that is playing, else None."""
    for app in PLAYERS:
        script = (
            f'if application "{app}" is running then\n'
            f'  tell application "{app}"\n'
            f'    if player state is playing then return (name of current track) & "\\t" & (artist of current track)\n'
            f"  end tell\n"
            f"end if\n"
            f'return ""'
        )
        out = osascript(script)
        if out:
            track, _, artist = out.partition("\t")
            return track, artist
    return None


class MediaWatcher:
    def __init__(self, poster, interval):
        self.poster = poster
        self.interval = interval
        self.last = None
        self.next_at = 0.0

    def tick(self, force=False):
        if self.interval <= 0:
            return
        if not force and time.time() < self.next_at:
            return
        self.next_at = time.time() + self.interval
        np = now_playing()
        if np and np != self.last:
            track, artist = np
            data = {"track": track}
            if artist:
                data["artist"] = artist
            self.poster.emit("media.play", data)
        self.last = np


class AppTracker:
    """Dedupes focus events so a flicker doesn't spam the bus."""

    def __init__(self, poster):
        self.poster = poster
        self.front = None

    def launched(self, name, bundle):
        if name:
            self.poster.emit("app.opened", {"app": name, **({"bundleId": bundle} if bundle else {})})

    def focused(self, name, bundle):
        if name and name != self.front:
            self.front = name
            self.poster.emit("app.focused", {"app": name, **({"bundleId": bundle} if bundle else {})})


# ---------------------------------------------------------------------------
# pyobjc path: real NSWorkspace notifications
# ---------------------------------------------------------------------------


def run_pyobjc(tracker, media, once):
    from AppKit import NSWorkspace  # noqa: F401  (import error sends us to the poll path)
    from Foundation import NSDate, NSObject, NSRunLoop

    ws = NSWorkspace.sharedWorkspace()
    nc = ws.notificationCenter()

    def info(note):
        app = note.userInfo().get("NSWorkspaceApplicationKey")
        if app is None:
            return None, None
        return app.localizedName(), app.bundleIdentifier()

    class Observer(NSObject):
        def activated_(self, note):
            tracker.focused(*info(note))

        def launched_(self, note):
            tracker.launched(*info(note))

    obs = Observer.new()
    nc.addObserver_selector_name_object_(obs, "activated:", "NSWorkspaceDidActivateApplicationNotification", None)
    nc.addObserver_selector_name_object_(obs, "launched:", "NSWorkspaceDidLaunchApplicationNotification", None)

    front = ws.frontmostApplication()
    if front is not None:
        tracker.focused(front.localizedName(), front.bundleIdentifier())
    media.tick(force=True)
    log("watching apps via NSWorkspace notifications")
    if once:
        return
    loop = NSRunLoop.currentRunLoop()
    while True:
        loop.runUntilDate_(NSDate.dateWithTimeIntervalSinceNow_(0.5))
        media.tick()


# ---------------------------------------------------------------------------
# fallback: poll lsappinfo (ships with macOS, no permissions)
# ---------------------------------------------------------------------------


def lsappinfo(*args):
    try:
        return subprocess.run(["lsappinfo", *args], capture_output=True, text=True, timeout=2).stdout
    except (subprocess.TimeoutExpired, OSError):
        return ""


def parse_lsappinfo_field(out, key):
    # lines look like: "LSDisplayName"="Safari"  or  "CFBundleIdentifier"="com.apple.Safari"
    for line in out.splitlines():
        if line.strip().startswith(f'"{key}"='):
            v = line.split("=", 1)[1].strip()
            return v.strip('"') if v not in ("[ NULL ]", "NULL") else None
    return None


def frontmost_via_lsappinfo():
    asn = lsappinfo("front").strip()
    if not asn:
        return None, None
    out = lsappinfo("info", "-only", "name", "-only", "bundleid", asn)
    name = parse_lsappinfo_field(out, "LSDisplayName") or parse_lsappinfo_field(out, "name")
    bundle = parse_lsappinfo_field(out, "CFBundleIdentifier") or parse_lsappinfo_field(out, "bundleid")
    return name, bundle


def running_apps():
    out = lsappinfo("list")
    names = set()
    for line in out.splitlines():
        line = line.strip()
        # e.g.  1) "Safari" ASN:0x0-0x1234: ...
        if ") \"" in line:
            names.add(line.split('"')[1])
    return names


def run_poll(tracker, media, once):
    log("polling lsappinfo every second (no pyobjc, or --poll)")
    seen = running_apps()
    while True:
        name, bundle = frontmost_via_lsappinfo()
        now_running = running_apps()
        for app in sorted(now_running - seen):
            tracker.launched(app, None)
        seen = now_running or seen
        tracker.focused(name, bundle)
        media.tick()
        if once:
            return
        time.sleep(1.0)


def main():
    ap = argparse.ArgumentParser(description="Eve's macOS app + media watcher")
    ap.add_argument("--core", default=os.environ.get("EIGEN_CORE", "http://127.0.0.1:7777"))
    ap.add_argument("--poll", action="store_true", help="force the lsappinfo polling path")
    ap.add_argument("--dry-run", action="store_true", help="print envelopes instead of posting")
    ap.add_argument("--media-interval", type=float, default=3.0)
    ap.add_argument("--once", action="store_true", help="one pass, then exit (for testing)")
    a = ap.parse_args()

    poster = Poster(a.core, dry_run=a.dry_run)
    tracker = AppTracker(poster)
    media = MediaWatcher(poster, a.media_interval)
    try:
        if not a.poll:
            try:
                run_pyobjc(tracker, media, a.once)
                return
            except ImportError:
                pass
        run_poll(tracker, media, a.once)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
