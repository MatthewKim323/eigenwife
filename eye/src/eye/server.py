"""`eye serve`: gaze events over a localhost websocket, plus the web client files.

  ws://127.0.0.1:8765/ws     events out (see stream.py), commands in
  http://127.0.0.1:8765/     the demo page and eye-client.js

Every message is one JSON object with a "type". Frames never leave the machine;
only gaze coordinates go out, and only to localhost.
"""

from __future__ import annotations

import asyncio
import json
import mimetypes
from pathlib import Path

from websockets.asyncio.server import ServerConnection, broadcast, serve
from websockets.datastructures import Headers
from websockets.http11 import Request, Response

from . import paths
from .calibration import Calibration
from .config import Settings
from .screen import Display
from .stream import Correction, GazeStream
from .tracker import Tracker

WEB_DIR = Path(__file__).parent / "web"

def load_correction() -> Correction | None:
    path = paths.correction_file()
    if not path.exists():
        return None
    try:
        return Correction.from_json(path.read_text())
    except (ValueError, KeyError):
        return None


def _static(request: Request) -> Response | None:
    path = request.path.split("?", 1)[0]
    if path == "/ws":
        return None  # websocket handshake
    name = "index.html" if path in ("", "/") else path.lstrip("/")
    file = (WEB_DIR / name).resolve()
    if WEB_DIR.resolve() not in file.parents or not file.is_file():
        return Response(404, "Not Found", Headers({"Content-Type": "text/plain"}), b"not found\n")
    ctype = mimetypes.guess_type(file.name)[0] or "application/octet-stream"
    headers = Headers({"Content-Type": ctype, "Cache-Control": "no-store"})
    return Response(200, "OK", headers, file.read_bytes())


async def _serve(stream: GazeStream, tracker: Tracker, host: str, port: int) -> None:
    loop = asyncio.get_running_loop()
    clients: set[ServerConnection] = set()

    def emit(msg: dict) -> None:
        text = json.dumps(msg, separators=(",", ":"))
        loop.call_soon_threadsafe(broadcast, clients, text)

    stream.emit = emit

    async def handler(ws: ServerConnection) -> None:
        clients.add(ws)
        await ws.send(json.dumps(stream.hello()))
        try:
            async for text in ws:
                try:
                    msg = json.loads(text)
                except ValueError:
                    continue
                reply = stream.command(msg)
                if reply is None:
                    continue
                if reply.get("type") == "calib_result":
                    _persist(stream)
                    # Everyone hears it: other clients should know the mapping changed.
                    broadcast(clients, json.dumps(reply))
                else:
                    await ws.send(json.dumps(reply))
        finally:
            clients.discard(ws)

    async def process_request(connection: ServerConnection, request: Request):
        return _static(request)

    async with serve(handler, host, port, process_request=process_request) as server:
        tracker.start()
        print(f"eye serving on http://{host}:{port}/  (events at ws://{host}:{port}/ws)", flush=True)
        try:
            await server.serve_forever()
        finally:
            tracker.stop()


def _persist(stream: GazeStream) -> None:
    path = paths.correction_file()
    if stream.correction.identity:
        path.unlink(missing_ok=True)
    else:
        path.write_text(stream.correction.to_json())


def run(
    settings: Settings,
    display: Display,
    calib: Calibration | None,
    camera=None,
    host: str = "127.0.0.1",
    port: int = 8765,
    fresh: bool = False,
) -> None:
    correction = None if fresh else load_correction()

    stream = GazeStream(
        display,
        calib,
        emit=lambda msg: None,
        correction=correction,
        distance_cm=settings.pointer.distance_cm,
        fixation_radius_deg=settings.pointer.fixation_radius_deg,
    )
    tracker = Tracker(camera if camera is not None else settings.camera, on_frame=stream.on_frame)
    try:
        asyncio.run(_serve(stream, tracker, host, port))
    except KeyboardInterrupt:
        pass
