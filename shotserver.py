#!/usr/bin/env python3
"""Serve the build and accept POSTed canvas frames, so a headless review loop can
actually LOOK at what shipped instead of trusting pixel statistics."""
import argparse, base64, http.server, pathlib, socketserver

ROOT = pathlib.Path(__file__).parent
SHOTS = ROOT / "shots"
SHOTS.mkdir(exist_ok=True)


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(n).decode("utf8", "replace")
        name = self.path.strip("/").replace("/", "_") or "frame"
        if "," in raw:
            raw = raw.split(",", 1)[1]
        (SHOTS / f"{name}.png").write_bytes(base64.b64decode(raw))
        self.send_response(204)
        self.end_headers()

    def log_message(self, *a):
        pass


ap = argparse.ArgumentParser(description="serve the build (+ accept POSTed frames into shots/)")
ap.add_argument("--bind", default="127.0.0.1", help="address to listen on (default 127.0.0.1; use 0.0.0.0 for LAN/WireGuard)")
ap.add_argument("--port", type=int, default=8901, help="port (default 8901)")
args = ap.parse_args()
class Server(socketserver.ThreadingTCPServer):
    """Threaded on purpose: the stock TCPServer serves ONE request at a time, so a
    browser holding a connection open froze the page for everybody else."""
    allow_reuse_address = True
    daemon_threads = True


with Server((args.bind, args.port), H) as srv:
    print(f"serving {ROOT.name} on http://{args.bind}:{args.port}/test.html", flush=True)
    srv.serve_forever()
