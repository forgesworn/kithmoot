#!/usr/bin/env python3
"""Serve only the built /j/ app on loopback, without certificate exceptions."""
import argparse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1] / "app/dist"


class App(SimpleHTTPRequestHandler):
    def translate_path(self, path):
        path = unquote(urlsplit(path).path)
        if not path.startswith("/j/"):
            return str(ROOT / ".not-served")
        candidate = (ROOT / path[3:]).resolve()
        if not candidate.is_relative_to(ROOT.resolve()):
            return str(ROOT / ".not-served")
        return str(candidate)

    def list_directory(self, path):
        self.send_error(404)

    def log_message(self, *_args):
        pass


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), App)
    try:
        server.serve_forever()
    finally:
        server.server_close()
