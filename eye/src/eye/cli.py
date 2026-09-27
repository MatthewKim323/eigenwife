"""Command line entry point."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

HELP = """webcam eye cursor for macOS

  eye doctor       check permissions, cameras, displays, calibration
  eye debug        camera preview with landmarks and live blink signals
  eye calibrate    fullscreen calibration (~1 min)
  eye run          start the eye cursor
  eye serve        stream gaze events to apps over a localhost websocket

gestures (defaults, see ~/.eye/config.json):
  wink left        left click (twice quickly = double click)
  wink right       right click
  long blink       left click (~0.4-1.2s, for when winking is hard)
  hold left wink   start a drag, wink again to drop
  hold right wink  scroll mode: tilt head up/down, any wink exits
  eyes shut ~1.6s  pause / resume
  touch trackpad   eye backs off for 1.5s
"""


def cmd_doctor(args) -> int:
    import importlib.metadata as md

    import AVFoundation as AV

    from . import calibration, camera, paths, screen
    from .mouse import accessibility_trusted

    ok = True
    mp_version = md.version("mediapipe")
    print(f"python      {sys.version.split()[0]}")
    print(f"mediapipe   {mp_version}{'  (1.0.1 crashes on macOS, use 1.0.0)' if mp_version == '1.0.1' else ''}")
    print(f"model       {paths.model_file()}")
    trusted = accessibility_trusted(prompt=args.prompt)
    ok &= trusted
    print(f"accessibility  {'ok' if trusted else 'MISSING: System Settings > Privacy & Security > Accessibility, enable your terminal app'}")
    status = AV.AVCaptureDevice.authorizationStatusForMediaType_(AV.AVMediaTypeVideo)
    labels = {0: "not asked yet (you'll get a prompt on first use)", 1: "restricted", 2: "DENIED: System Settings > Privacy & Security > Camera", 3: "ok"}
    print(f"camera access  {labels.get(int(status), status)}")
    ok &= int(status) != 2
    default_cam = camera.resolve_camera(None)
    for c in camera.list_cameras():
        mark = "*" if c == default_cam else " "
        print(f"  {mark} camera {c.index}: {c.name}{'  (built-in)' if c.builtin else ''}")
    default_disp = screen.pick()
    for i, d in enumerate(screen.displays()):
        mark = "*" if d == default_disp else " "
        print(f"  {mark} display {i}: {d.name}  {d.w:.0f}x{d.h:.0f} pt @{d.scale:.0f}x  {d.mm[0]:.0f}x{d.mm[1]:.0f} mm")
    calib = calibration.load()
    if calib is None:
        print("calibration none yet: run `eye calibrate` (head mode works without it)")
    else:
        st = calib.meta.get("stats", {})
        acc = f"~{st['validation_deg']:.1f}° ({st['validation_points']:.0f} pt)" if "validation_deg" in st else "?"
        print(f"calibration {calib.meta.get('created')}  accuracy {acc}  on {calib.meta['display']['name']} with {calib.meta.get('camera')}")
    return 0 if ok else 1


def cmd_debug(args) -> int:
    from . import debug_view

    debug_view.run(camera=args.camera, mirror=not args.no_mirror)
    return 0


def cmd_calibrate(args) -> int:
    from . import config, screen
    from .ui import calibrate

    settings = config.load()
    display = screen.pick(args.display if args.display is not None else settings.display)
    ui = calibrate.run(display, args.camera or settings.camera, quick=args.quick, expressions=not args.no_expressions,
                       backend=args.backend, capture_root=args.record_images, candidate_only=args.candidate_only,
                       capture_max_bytes=args.capture_max_mb * 1_000_000,
                       width=args.width, height=args.height)
    if ui.saved_path is None:
        print("calibration discarded" if ui.cancelled else "calibration not saved")
        if args.serve_after:
            from . import calibration, server
            server.run(settings, display, calibration.load(), camera=args.camera or settings.camera)
        return 1
    st = ui.result.stats
    print(f"saved {'candidate (active calibration unchanged)' if args.candidate_only else 'calibration'}: {ui.saved_path}")
    for capture_path in ui.capture_paths:
        print(f"local image capture: {capture_path}")
    print(f"raw session {ui.session_path}")
    if "validation_deg" in st:
        print(f"held-out frame error: mean {st['validation_frame_mean_points']:.0f} pt, p90 {st['validation_frame_p90_points']:.0f} pt, coverage {st['validation_coverage']:.0%}; {st['samples']} training samples")
    p = ui.result.profile
    print(f"winks: left {'ok' if p.wink_l else 'not detected'}, right {'ok' if p.wink_r else 'not detected'}")
    if args.serve_after:
        from . import calibration, server
        server.run(settings, display, calibration.load(), camera=args.camera or settings.camera)
    return 0


def cmd_prepare_appearance(args) -> int:
    from .appearance import prepare_model
    print(f"verified research/noncommercial MGazeNet weights: {prepare_model(download=True)}")
    print("start with: uv run --extra appearance eye calibrate --backend appearance --no-expressions --serve-after")
    return 0


def cmd_run(args) -> int:
    from . import app, calibration, config, screen
    from .mouse import accessibility_trusted

    settings = config.load()
    if args.mode:
        settings.pointer.mode = args.mode
    if not args.dry_run and not accessibility_trusted(prompt=True):
        print("eye needs Accessibility to move and click: System Settings > Privacy & Security > Accessibility")
        return 1
    display = screen.pick(args.display if args.display is not None else settings.display)
    calib = calibration.load()
    if calib is None:
        print("no calibration yet, starting in head mode. run `eye calibrate` for gaze")
    elif calib.meta["display"]["name"] != display.name:
        print(f"warning: calibrated on {calib.meta['display']['name']}, running on {display.name}")
    print("eye is running. menu bar icon to pause/quit, ctrl-c here to stop")
    app.run(settings, display, calib, camera=args.camera, dry_run=args.dry_run, debug=args.debug)
    return 0


def cmd_serve(args) -> int:
    from . import calibration, config, screen, server

    settings = config.load()
    display = screen.pick(args.display if args.display is not None else settings.display)
    calib = calibration.load()
    if calib is None:
        print("no calibration yet: run `eye calibrate` first")
        return 1
    elif calib.meta["display"]["name"] != display.name:
        print(f"warning: calibrated on {calib.meta['display']['name']}, serving for {display.name}")
    server.run(
        settings,
        display,
        calib,
        camera=args.camera,
        host=args.host,
        port=args.port,
        fresh=args.fresh,
        extension_id=args.extension_id,
    )
    return 0


def cmd_fit(args) -> int:
    from . import calibration, paths
    from .screen import Display

    path = Path(args.session) if args.session else max(paths.sessions_dir().glob("calib-*.npz"), default=None)
    if path is None:
        print("no saved sessions")
        return 1
    rec, script, disp, camera_name = calibration.load_session(path)
    display = Display(0, disp["name"], 0, 0, disp["w"], disp["h"], 2.0, True, tuple(disp["mm"]))
    result = calibration.fit(rec, script, display)
    from .validation_recovery import evaluate
    evaluate(result, rec, script, display)
    st = result.stats
    print(f"{path.name}: held-out frame mean {st.get('validation_frame_mean_points', float('nan')):.1f} pt, "
          f"p90 {st.get('validation_frame_p90_points', float('nan')):.1f} pt, "
          f"coverage {st.get('validation_coverage', 0):.1%}, complete={st.get('validation_complete', False)}; "
          f"training CV {st['cv_error']}, alpha {st['alpha']:g}")
    if args.save:
        print(f"saved {calibration.save(result, display, camera_name)}")
    return 0


def cmd_config(args) -> int:
    from . import config, paths

    print(f"# {paths.config_file()} (only the keys you want to change are needed)")
    print(config.dump(config.load()))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="eye", description=HELP, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", metavar="command")

    p = sub.add_parser("doctor", help="check permissions, cameras, displays, calibration")
    p.add_argument("--prompt", action="store_true", help="show the Accessibility permission prompt if missing")
    p.set_defaults(fn=cmd_doctor)

    p = sub.add_parser("debug", help="camera preview with landmarks and live signals")
    p.add_argument("--camera", help="camera name substring or index (default: built-in)")
    p.add_argument("--no-mirror", action="store_true")
    p.set_defaults(fn=cmd_debug)

    p = sub.add_parser("calibrate", help="fullscreen gaze + blink calibration")
    p.add_argument("--camera")
    p.add_argument("--display", help="display name substring or index (default: built-in)")
    p.add_argument("--quick", action="store_true", help="9 points only, skip the sweep and head motion")
    p.add_argument("--no-expressions", action="store_true", help="skip the blink, wink, brow and mouth steps")
    p.add_argument("--backend", choices=("landmarks", "appearance"), default="landmarks",
                   help="appearance uses optional local MGazeNet research features and compares a landmark baseline")
    p.add_argument("--record-images", type=Path, metavar="DIRECTORY",
                   help="explicitly save local lossless camera images for model comparisons (also kept on cancel)")
    p.add_argument("--capture-max-mb", type=int, default=2000, help="image storage limit per attempt; dropped frames stay in ledger")
    p.add_argument("--candidate-only", action="store_true", help="save a separate candidate without replacing the active model")
    p.add_argument("--width", type=int, default=1280, help="requested capture width (actual size recorded with image capture)")
    p.add_argument("--height", type=int, default=720, help="requested capture height")
    p.add_argument("--serve-after", action="store_true", help="start the app gaze server after saving (or restore it after cancel)")
    p.set_defaults(fn=cmd_calibrate)

    p = sub.add_parser("prepare-appearance", help="download and verify the optional noncommercial image model")
    p.set_defaults(fn=cmd_prepare_appearance)

    p = sub.add_parser("run", help="start the eye cursor")
    p.add_argument("--mode", choices=("hybrid", "gaze", "head"))
    p.add_argument("--camera")
    p.add_argument("--display")
    p.add_argument("--dry-run", action="store_true", help="track and draw, but never move or click")
    p.add_argument("--debug", action="store_true", help="draw the raw gaze estimate on the overlay")
    p.set_defaults(fn=cmd_run)

    p = sub.add_parser("serve", help="stream gaze events to apps (no mouse control)")
    p.add_argument("--camera")
    p.add_argument("--display")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--fresh", action="store_true", help="ignore the saved drift correction")
    p.add_argument("--extension-id", help="allow this specific Chrome extension to read gaze and calibrate")
    p.set_defaults(fn=cmd_serve)

    p = sub.add_parser("fit", help="refit the gaze model from a saved calibration session")
    p.add_argument("session", nargs="?", help="session .npz (default: newest)")
    p.add_argument("--save", action="store_true", help="make the refit the active calibration")
    p.set_defaults(fn=cmd_fit)

    p = sub.add_parser("config", help="print the effective settings")
    p.set_defaults(fn=cmd_config)

    args = parser.parse_args(argv)
    if args.cmd == "calibrate" and min(args.width, args.height, args.capture_max_mb) <= 0:
        parser.error("capture dimensions and storage limit must be positive")
    if not getattr(args, "fn", None):
        parser.print_help()
        return 0
    return args.fn(args)
