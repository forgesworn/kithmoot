#!/usr/bin/env python3
"""Loopback-only coturn fixture. Removes its container and files on shutdown."""
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
from http.server import BaseHTTPRequestHandler, HTTPServer
import shutil

module_path = Path(__file__).resolve().parents[1] / "deploy/private-call-relay/prepare.py"
spec = importlib.util.spec_from_file_location("prepare_relay", module_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
root = Path(tempfile.mkdtemp(prefix="kithmoot-call-relay-"))
name = f"kithmoot-call-relay-test-{os.getpid()}"
port = int(os.environ.get("E2E_TURN_PORT", "3479"))
api_port = int(os.environ.get("E2E_TURN_FIXTURE_PORT", "7788"))


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        if self.path not in ["/", "/you", "/friend"]:
            self.send_error(404)
            return
        value = {"ok": True} if self.path == "/" else json.loads((root / "config" / f"{self.path[1:]}.json").read_text())
        if "urls" in value:
            value["urls"] = [f"turn:127.0.0.1:{port}?transport=tcp"]
        body = json.dumps(value).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


def stop(*_):
    raise SystemExit(0)


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
try:
    module.prepare(root / "config", "127.0.0.1", "127.0.0.1", local=True)
    args = ["docker", "run", "--rm", "-d", "--name", name, "--log-driver", "none", "--user", "0:0",
            "-v", f"{root}/config/turnserver.conf:/etc/coturn/turnserver.conf:ro",
            "-p", f"127.0.0.1:{port}:3478/tcp", "-p", f"127.0.0.1:{port}:3478/udp",
            "-p", "127.0.0.1:49180-49211:49180-49211/udp", "coturn/coturn:4.17.2-r0",
            "-c", "/etc/coturn/turnserver.conf", "--proc-user=nobody", "--proc-group=nogroup"]
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL)
    HTTPServer(("127.0.0.1", api_port), Handler).serve_forever()
finally:
    subprocess.run(["docker", "rm", "-f", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    shutil.rmtree(root)
